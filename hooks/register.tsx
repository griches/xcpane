import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Build, Issue } from '../types'
import { basename, byFile, condense, location, plural, seconds, subject, tally, verdict } from './format'
import { parseLog } from './log'
import { findInvocations, withResultBundle } from './shell'
import { parseBuildResults, parseTestSummary } from './xcresult'

const PANE = 'xcode-build'
const TITLE = 'Xcode build'
const COMMAND = 'xcode-build'
const KEPT_BUILDS = 20
const KEPT_ISSUES = 300
const PANE_ISSUES = 60
const ROW_ERRORS = 3

const builds = atom({ plugin: 'xcode-build', key: 'builds' } as const, [])
const isShowingWarnings = atom({ plugin: 'xcode-build', key: 'isShowingWarnings' } as const, false)
const now = atom({ plugin: 'xcode-build', key: 'now' } as const, 0)

const GLYPH = { running: '●', succeeded: '✓', failed: '✗', cancelled: '◌' } as const
const TONE = { running: 'warning', succeeded: 'success', failed: 'error', cancelled: undefined } as const

const isError = (issue: Issue) => issue.severity === 'error'

const xcresult = async ($: EngineInterface, path: string, query: readonly string[]) => {
  const ran = await $.process.run(['xcrun', 'xcresulttool', 'get', ...query, '--path', path, '--compact'], {
    timeoutMs: 20_000,
  })

  return ran.exitCode === 0 ? ran.stdout : ''
}

const readBundle = async ($: EngineInterface, path: string, hasTests: boolean) => {
  try {
    if (!(await $.fs.exists(path))) {
      return null
    }

    const built = parseBuildResults(await xcresult($, path, ['build-results']))
    const tests = hasTests ? parseTestSummary(await xcresult($, path, ['test-results', 'summary'])) : null

    return built === null ? null : { built, tests }
  } catch {
    return null
  }
}

const openPane = ($: EngineInterface) => {
  void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const wantsCondense = options.condense !== false
  const wantsBundle = options.resultBundle !== false
  const wantsCompactRow = options.compactRow !== false
  const warnings = options.warnings === 'list' ? 'list' : 'count'
  const autoOpen = options.autoOpen === 'failure' || options.autoOpen === 'never' ? options.autoOpen : 'always'
  const condensed = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the Xcode build pane: errors by file, warnings, failed tests (clear: forget the builds)',
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, builds, () => [])
      $.ui.status(undefined)

      return { text: 'Xcode build history cleared.' }
    }

    await $.ui.open({ id: PANE, title: TITLE })
    const latest = (await read($, builds)).at(-1)

    return {
      text:
        latest === undefined
          ? 'Xcode build pane opened. No builds yet.'
          : `Xcode build pane opened. Last: ${subject(latest)}: ${verdict(latest)} · ${tally(latest)}`,
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = findInvocations(e.command).filter(one => !one.isInfoOnly)
    const invocation = found[0]

    if (invocation === undefined || e.run_in_background === true) {
      return next(e)
    }

    const id = e.tool_use_id
    const isAlone = found.length === 1 && invocation.tool === 'xcodebuild'
    let command = e.command
    let bundle: string | null = null
    let isOwnBundle = false

    if (wantsBundle && isAlone && invocation.resultBundlePath !== null) {
      const isStale = await $.fs.exists(invocation.resultBundlePath).catch(() => true)
      bundle = isStale ? null : invocation.resultBundlePath
    } else if (wantsBundle && isAlone && !invocation.hasResultBundleFlag && invocation.action !== 'clean') {
      const temporary = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
      bundle = `${temporary}/claude-xcode-build/${id.replace(/[^A-Za-z0-9_-]/g, '')}.xcresult`
      command = withResultBundle(e.command, invocation, bundle)
      isOwnBundle = true
    }

    const startedAt = await $.clock.now()
    const running: Build = {
      id,
      tool: invocation.tool,
      action: invocation.action,
      hasTests: invocation.hasTests,
      scheme: invocation.scheme,
      status: 'running',
      startedAt,
      durationMs: null,
      errorCount: 0,
      warningCount: 0,
      issues: [],
      tests: null,
      failedCommands: [],
      source: 'none',
      logLines: 0,
      isCondensed: false,
    }
    const store = (build: Build) =>
      update($, builds, list => [...list.filter(one => one.id !== id), build].slice(-KEPT_BUILDS))

    await update($, now, () => startedAt)
    await store(running)

    if (autoOpen === 'always') {
      openPane($)
    }

    const ticker = $.clock.every(1000, () => {
      void $.clock
        .now()
        .then(at => update($, now, () => at))
        .catch(() => undefined)
    })
    const ran = await next(command === e.command ? e : { ...e, command })
      .catch(async (error: unknown) => {
        await update($, builds, list => list.filter(one => one.id !== id))
        throw error
      })
      .finally(() => ticker.cancel())

    if (ran.deny !== undefined) {
      await update($, builds, list => list.filter(one => one.id !== id))

      return ran
    }

    const shown = ran.text ?? ''
    let raw = shown
    let logPath: string | null = null
    let isStopped = false

    if (ran.isError === true) {
      raw = typeof ran.result === 'string' ? ran.result : shown
    } else {
      const persisted = ran.result.persistedOutputPath
      raw = [ran.result.stdout, ran.result.stderr].filter(Boolean).join('\n')
      isStopped = ran.result.interrupted || ran.result.backgroundTaskId !== undefined

      if (persisted !== undefined) {
        logPath = persisted
        raw = await $.fs.read(persisted).catch(() => raw)
      }
    }

    const log = parseLog(raw)
    const bundled = bundle === null || isStopped ? null : await readBundle($, bundle, invocation.hasTests)
    const located = new Map(log.failures.map(failure => [failure.name.replace(/\(\)$/, ''), failure]))
    const logTests = log.passedTests + log.failedTests + log.skippedTests
    const tests =
      bundled?.tests ??
      (logTests === 0
        ? null
        : {
            total: logTests,
            passed: log.passedTests,
            failed: log.failedTests,
            skipped: log.skippedTests,
            failures: log.failures,
          })
    const issues = bundled?.built.issues ?? log.issues
    const errorCount = bundled?.built.errorCount ?? issues.filter(isError).length
    const hasFailed =
      ran.isError === true ||
      bundled?.built.status === 'failed' ||
      log.marker === 'failed' ||
      errorCount > 0 ||
      (tests?.failed ?? 0) > 0
    const hasEvidence = bundled !== null || log.marker !== null || log.issues.length > 0 || log.failures.length > 0
    const finished: Build = {
      ...running,
      status: isStopped ? 'cancelled' : hasFailed ? 'failed' : 'succeeded',
      durationMs: (await $.clock.now()) - startedAt,
      errorCount,
      warningCount: bundled?.built.warningCount ?? issues.filter(one => !isError(one)).length,
      issues: [...issues.filter(isError), ...issues.filter(one => !isError(one))].slice(0, KEPT_ISSUES),
      tests:
        tests === null
          ? null
          : {
              ...tests,
              failures: tests.failures.map(failure => {
                const where = located.get(failure.name.replace(/\(\)$/, ''))

                return where === undefined ? failure : { ...failure, file: where.file, line: where.line }
              }),
            },
      failedCommands: log.failedCommands.slice(0, 10),
      source: bundled !== null ? 'xcresult' : hasEvidence ? 'log' : 'none',
      logLines: log.lines,
    }
    const hasFindings = finished.errorCount > 0 || (finished.tests?.failed ?? 0) > 0
    const isReadable = finished.source !== 'none' && (finished.status === 'succeeded' || hasFindings)

    if (wantsCondense && isReadable && !isStopped && ran.text !== undefined) {
      const exit = /^Exit code (\d+)/.exec(shown)
      const summary = condense(finished, {
        warnings,
        exitCode: exit === null ? null : Number(exit[1]),
        logPath,
        isLogCut: log.isCut || (ran.isError === true && log.marker === null),
      })

      if (summary.length < ran.text.length) {
        condensed.set(id, summary)
        finished.isCondensed = true
      }
    }

    await store(finished)

    if (isOwnBundle && bundle !== null) {
      void $.process.run(['/bin/rm', '-rf', bundle]).catch(() => undefined)
    }

    if (finished.status === 'failed') {
      $.ui.status(`${GLYPH.failed} ${finished.scheme ?? finished.tool}: ${tally(finished)}`)

      if (autoOpen === 'failure') {
        openPane($)
      }
    } else {
      $.ui.status(undefined)
    }

    if (finished.status === 'succeeded') {
      $.ui.toast(`${GLYPH.succeeded} ${verdict(finished)} · ${tally(finished)} · ${seconds(finished.durationMs ?? 0)}`)
    }

    return ran
  })

  on('session.append', { door: 'tool-result' }, ($, e, next) => {
    let isRewritten = false
    const content = e.message.content.map(block => {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const summary = block.type === 'tool_result' ? condensed.get(id) : undefined

      if (summary === undefined) {
        return block
      }

      condensed.delete(id)
      isRewritten = true

      return { ...block, content: typeof block.content === 'string' ? summary : [{ type: 'text', text: summary }] }
    })

    return isRewritten ? next({ ...e, message: { ...e.message, content } }) : next(e)
  })

  on('ui.render', { component: 'ToolResult', props: { tool: 'Bash' } }, async ($, e, next) => {
    const build = wantsCompactRow ? (await read($, builds)).find(one => one.id === e.requestId) : undefined

    if (build === undefined || build.status === 'running' || build.source === 'none') {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const errors = build.issues.filter(isError)
    const failures = build.tests?.failures ?? []
    const facts = [tally(build), seconds(build.durationMs ?? 0), `${plural(build.logLines, 'log line')} folded`]

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{'  ⎿  '}</Text>
          <Text bold color={TONE[build.status]}>{`${GLYPH[build.status]} ${verdict(build)}`}</Text>
          <Text dimColor>{` · ${facts.join(' · ')}`}</Text>
        </Box>
        {errors.slice(0, ROW_ERRORS).map(issue => (
          <Text wrap="truncate-end">
            {`     ${[issue.file === null ? null : basename(issue.file), location(issue)].filter(Boolean).join(':')}  ${issue.message}`}
          </Text>
        ))}
        {errors.length === 0 &&
          failures
            .slice(0, ROW_ERRORS)
            .map(failure => <Text wrap="truncate-end">{`     ${failure.name}  ${failure.message}`}</Text>)}
        {errors.length > ROW_ERRORS && (
          <Text dimColor>{`     +${plural(build.errorCount - ROW_ERRORS, 'more error')} · /${COMMAND} shows them all`}</Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, builds)
    const latest = list.at(-1)

    if (latest === undefined) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No builds yet.</Text>
          <Text dimColor>Ask Claude to run xcodebuild, swift build or swift test.</Text>
        </Box>
      )
    }

    const showsWarnings = await read($, isShowingWarnings)
    const elapsed =
      latest.status === 'running' ? Math.max(0, (await read($, now)) - latest.startedAt) : (latest.durationMs ?? 0)
    const visible = latest.issues.filter(one => showsWarnings || isError(one))
    const groups = byFile(visible.slice(0, PANE_ISSUES))
    const failures = latest.tests?.failures ?? []
    const earlier = list.slice(0, -1).slice(-5).reverse()
    const hasNothingToShow = latest.status === 'failed' && latest.errorCount === 0 && failures.length === 0

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold color={TONE[latest.status]}>{`${GLYPH[latest.status]} ${verdict(latest)}`}</Text>
          <Text dimColor>{`  ${seconds(elapsed)}`}</Text>
        </Box>
        <Text dimColor>{subject(latest)}</Text>
        {latest.status !== 'running' && <Text>{tally(latest)}</Text>}
        {groups.map(group => (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              <Text bold>{group.file === null ? 'Project' : basename(group.file)}</Text>
              <Text dimColor>{`  ${plural(group.issues.length, 'issue')}`}</Text>
            </Box>
            {group.issues.map(issue => (
              <Box flexDirection="row">
                <Box width={9} flexShrink={0}>
                  <Text color={isError(issue) ? 'error' : 'warning'}>{`  ${location(issue) || (isError(issue) ? 'error' : 'warn')}`}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text>{issue.message}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
        {visible.length > PANE_ISSUES && <Text dimColor>{`+${plural(visible.length - PANE_ISSUES, 'more issue')}`}</Text>}
        {failures.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Failed tests</Text>
            {failures.slice(0, PANE_ISSUES).map(failure => (
              <Box flexDirection="column">
                <Text color="error">{`  ${GLYPH.failed} ${failure.name}`}</Text>
                <Text>{`    ${failure.message}`}</Text>
              </Box>
            ))}
          </Box>
        )}
        {hasNothingToShow && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>No diagnostics found in the output; Claude read the raw log.</Text>
            {latest.failedCommands.slice(0, 5).map(failed => (
              <Text wrap="truncate-end">{`  ${failed}`}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={2} marginTop={1}>
          {latest.warningCount > 0 && (
            <Button
              key="warnings"
              hotkey="w"
              plain
              label={showsWarnings ? 'Hide warnings' : `Show ${plural(latest.warningCount, 'warning')}`}
              onPress={() => update($, isShowingWarnings, shows => !shows)}
            />
          )}
          <Button key="clear" hotkey="c" plain label="Clear" onPress={() => update($, builds, () => [])} />
        </Box>
        {earlier.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Earlier</Text>
            {earlier.map(build => (
              <Box flexDirection="row">
                <Text color={TONE[build.status]}>{`  ${GLYPH[build.status]} `}</Text>
                <Text dimColor>{`${build.action} · ${tally(build)} · ${seconds(build.durationMs ?? 0)}`}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
