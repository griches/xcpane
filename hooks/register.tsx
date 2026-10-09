import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Build, Issue, Tests } from '../types'
import {
  basename,
  byFile,
  condense,
  details,
  location,
  percent,
  plural,
  seconds,
  subject,
  tally,
  verdict,
} from './format'
import type { Detail } from './format'
import { parseLog } from './log'
import { parseMcpBuild, parseMcpBuildLog, parseMcpTests, structuredOf } from './mcp'
import { findInvocations, withResultBundle } from './shell'
import { parseBuildResults, parseCoverage, parseTestDetails, parseTestSummary } from './xcresult'

const PANE = 'xcpane'
const TITLE = 'Xcode build'
const COMMAND = 'xcpane'
const DETAILS_TOOL = 'mcp__xcpane__details'
const KEPT_BUILDS = 20
const KEPT_ISSUES = 300
const PANE_ISSUES = 60
const ROW_ERRORS = 3

type AutoOpen = 'always' | 'failure' | 'never'

const builds = atom({ plugin: 'xcpane', key: 'builds' } as const, [])
const isShowingWarnings = atom({ plugin: 'xcpane', key: 'isShowingWarnings' } as const, false)
const now = atom({ plugin: 'xcpane', key: 'now' } as const, 0)

const GLYPH = { running: '●', succeeded: '✓', failed: '✗', cancelled: '◌' } as const
const TONE = { running: 'warning', succeeded: 'success', failed: 'error', cancelled: undefined } as const

const isError = (issue: Issue) => issue.severity === 'error'

const bare = (name: string) => name.replace(/\(\)$/, '')

const run = async ($: EngineInterface, argv: readonly string[]) => {
  const ran = await $.process.run(argv, { timeoutMs: 20_000 })

  return ran.exitCode === 0 && !ran.isStdoutTruncated ? ran.stdout : ''
}

const xcresult = ($: EngineInterface, path: string, query: readonly string[]) =>
  run($, ['xcrun', 'xcresulttool', 'get', ...query, '--path', path, '--compact'])

/** What a result bundle says of its tests: the summary, with locations, the slowest tests and coverage added. */
const readTests = async ($: EngineInterface, path: string, summary: Tests | null) => {
  const found = parseTestDetails(await xcresult($, path, ['test-results', 'tests']))
  const coverage = parseCoverage(await run($, ['xcrun', 'xccov', 'view', '--report', '--only-targets', '--json', path]))
  const tests =
    summary === null || found === null
      ? summary
      : {
          ...summary,
          slowest: found.slowest,
          failures: summary.failures.map(failure => ({ ...failure, ...found.locations.get(failure.name) })),
        }

  return { tests, coverage }
}

const readBundle = async ($: EngineInterface, path: string, hasTests: boolean) => {
  try {
    if (!(await $.fs.exists(path))) {
      return null
    }

    const built = parseBuildResults(await xcresult($, path, ['build-results']))
    const summary = hasTests ? parseTestSummary(await xcresult($, path, ['test-results', 'summary'])) : null

    return built === null ? null : { built, ...(await readTests($, path, summary)) }
  } catch {
    return null
  }
}

/**
 * The warnings of the build an Xcode MCP server just ran. Its `BuildProject`
 * result lists errors only, so they are asked for from its build log.
 */
const mcpWarnings = async ($: EngineInterface, tool: string, workspace: unknown): Promise<Issue[]> => {
  try {
    const server = tool.split('__')[1] ?? ''
    const args = typeof workspace === 'string' ? { severity: 'warning', workspaceIdentifier: workspace } : { severity: 'warning' }
    const log = structuredOf({ result: await $.mcp.call(server, 'GetBuildLog', args) })

    return (log === null ? null : parseMcpBuildLog(log))?.filter(one => !isError(one)) ?? []
  } catch {
    return []
  }
}

const openPane = ($: EngineInterface) => {
  void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

const store = ($: EngineInterface, build: Build) =>
  update($, builds, list => [...list.filter(one => one.id !== build.id), build].slice(-KEPT_BUILDS))

const drop = ($: EngineInterface, id: string) => update($, builds, list => list.filter(one => one.id !== id))

/** Moves the pane's clock on, so a running timer redraws. */
const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, now, () => at)
}

/** Shows `running` in the pane with a ticking timer for as long as `work` takes. */
const track = async <T,>($: EngineInterface, running: Build, autoOpen: AutoOpen, work: () => Promise<T>): Promise<T> => {
  await update($, now, () => running.startedAt)
  await store($, running)

  if (autoOpen === 'always') {
    openPane($)
  }

  const ticker = $.clock.every(1000, () => {
    void tick($).catch(() => undefined)
  })

  try {
    return await work()
  } catch (error) {
    await drop($, running.id)
    throw error
  } finally {
    ticker.cancel()
  }
}

/** Stores a finished build and says how it went: the status line on a failure, a toast on a success. */
const announce = async ($: EngineInterface, finished: Build, autoOpen: AutoOpen) => {
  await store($, finished)

  if (finished.status === 'failed') {
    $.ui.status(`${GLYPH.failed} ${finished.scheme ?? (finished.tool === 'xcode' ? 'Xcode' : finished.tool)}: ${tally(finished)}`)

    if (autoOpen === 'failure') {
      openPane($)
    }
  } else {
    $.ui.status(undefined)
  }

  if (finished.status === 'succeeded') {
    $.ui.toast(`${GLYPH.succeeded} ${verdict(finished)} · ${tally(finished)} · ${seconds(finished.durationMs ?? 0)}`)
  }
}

const started = (id: string, startedAt: number, facts: Pick<Build, 'tool' | 'action' | 'hasTests' | 'scheme'>): Build => ({
  ...facts,
  id,
  status: 'running',
  startedAt,
  durationMs: null,
  errorCount: 0,
  warningCount: 0,
  issues: [],
  tests: null,
  coverage: null,
  logPath: null,
  failedCommands: [],
  source: 'none',
  logLines: 0,
  isCondensed: false,
})

const sorted = (issues: readonly Issue[]) =>
  [...issues.filter(isError), ...issues.filter(one => !isError(one))].slice(0, KEPT_ISSUES)

export const register: Register = (on, options) => {
  const wantsCondense = options.condense !== false
  const wantsBundle = options.resultBundle !== false
  const wantsCompactRow = options.compactRow !== false
  const warnings = options.warnings === 'list' ? 'list' : 'count'
  const autoOpen: AutoOpen = options.autoOpen === 'failure' || options.autoOpen === 'never' ? options.autoOpen : 'always'
  const condensed = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the Xcode build pane: errors by file, warnings, failed tests (clear: forget the builds)',
    })
    await $.tool.register({
      name: 'details',
      description:
        'Lists what the most recent xcodebuild, swift build or Xcode MCP build reported, in full: every error and warning with its file, line and message, the failed and slowest tests, and line coverage. Call it when a build summary counted warnings without listing them. It reads stored results and runs no build.',
      inputSchema: {
        type: 'object',
        properties: {
          show: {
            type: 'string',
            enum: ['all', 'errors', 'warnings', 'tests'],
            description: 'Which part to list; all by default.',
          },
        },
      },
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

  on('tool.call', { tool: /^mcp__xcpane__details$/ }, async ($, e) => {
    const latest = (await read($, builds)).findLast(one => one.status !== 'running')
    const asked = (e as { show?: unknown }).show
    const show: Detail = asked === 'errors' || asked === 'warnings' || asked === 'tests' ? asked : 'all'

    return { result: latest === undefined ? 'No build has finished in this session yet.' : details(latest, show) }
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
      bundle = `${temporary}/xcpane/${id.replace(/[^A-Za-z0-9_-]/g, '')}.xcresult`
      command = withResultBundle(e.command, invocation, bundle)
      isOwnBundle = true
    }

    const startedAt = await $.clock.now()
    const running = started(id, startedAt, {
      tool: invocation.tool,
      action: invocation.action,
      hasTests: invocation.hasTests,
      scheme: invocation.scheme,
    })
    const ran = await track($, running, autoOpen, () => next(command === e.command ? e : { ...e, command }))

    if (ran.deny !== undefined) {
      await drop($, id)

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
    const located = new Map(log.failures.map(failure => [bare(failure.name), failure]))
    const logTests = log.passedTests + log.failedTests + log.skippedTests
    const tests: Tests | null =
      bundled?.tests ??
      (logTests === 0
        ? null
        : {
            total: logTests,
            passed: log.passedTests,
            failed: log.failedTests,
            skipped: log.skippedTests,
            failures: log.failures,
            slowest: [],
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
      issues: sorted(issues),
      tests:
        tests === null
          ? null
          : {
              ...tests,
              failures: tests.failures.map(failure => {
                const where = failure.file === null ? located.get(bare(failure.name)) : undefined

                return where === undefined ? failure : { ...failure, file: where.file, line: where.line }
              }),
            },
      coverage: bundled?.coverage ?? null,
      logPath,
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
        isLogCut: log.isCut || (ran.isError === true && log.marker === null),
        detailsTool: DETAILS_TOOL,
      })

      if (summary.length < ran.text.length) {
        condensed.set(id, summary)
        finished.isCondensed = true
      }
    }

    await announce($, finished, autoOpen)

    if (isOwnBundle && bundle !== null) {
      void $.process.run(['/bin/rm', '-rf', bundle]).catch(() => undefined)
    }

    return ran
  })

  // A build Claude runs through Xcode's own MCP server already comes back
  // structured, so it is left as it is and only shown: pane, status, toast.
  on('tool.call', { tool: /^mcp__.+__(BuildProject|RunAllTests|RunSomeTests)$/ }, async ($, e, next) => {
    const id = e.tool_use_id
    const hasTests = !e.tool.endsWith('__BuildProject')
    const startedAt = await $.clock.now()
    const running = started(id, startedAt, { tool: 'xcode', action: hasTests ? 'test' : 'build', hasTests, scheme: null })
    const ran = await track($, running, autoOpen, () => next(e))

    if (ran.deny !== undefined) {
      await drop($, id)

      return ran
    }

    const data = structuredOf(ran)
    const report = data === null ? null : hasTests ? parseMcpTests(data) : parseMcpBuild(data)
    const elapsed = (await $.clock.now()) - startedAt

    if (report === null) {
      await announce($, { ...running, status: 'failed', durationMs: elapsed }, autoOpen)

      return ran
    }

    const bundled =
      report.bundlePath === null ? null : await readTests($, report.bundlePath, report.tests).catch(() => null)
    const issues = hasTests
      ? report.issues
      : [...report.issues, ...(await mcpWarnings($, e.tool, (e as { workspaceIdentifier?: unknown }).workspaceIdentifier))]

    await announce(
      $,
      {
        ...running,
        scheme: report.scheme,
        status: report.status,
        durationMs: report.durationMs ?? elapsed,
        errorCount: issues.filter(isError).length,
        warningCount: issues.filter(one => !isError(one)).length,
        issues: sorted(issues),
        tests: bundled?.tests ?? report.tests,
        coverage: bundled?.coverage ?? null,
        logPath: report.logPath,
        source: 'xcresult',
      },
      autoOpen,
    )

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
    const slowest = latest.tests?.slowest ?? []
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
        {latest.coverage !== null && <Text dimColor>{`Line coverage ${percent(latest.coverage)}`}</Text>}
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
        {slowest.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Slowest tests</Text>
            {slowest.map(test => (
              <Text dimColor>{`  ${test.seconds.toFixed(2)}s  ${test.name}`}</Text>
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
