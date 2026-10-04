import type { Build, Issue } from '../types'

export type FileGroup = { file: string | null; issues: Issue[] }

export type CondenseSettings = {
  warnings: 'count' | 'list'
  exitCode: number | null
  isLogCut: boolean
  /** The tool the model can call for what the summary leaves out, when there is one. */
  detailsTool: string | null
}

export type Detail = 'all' | 'errors' | 'warnings' | 'tests'

const LISTED = 50

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export const seconds = (ms: number) => {
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }

  const whole = Math.round(ms / 1000)

  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`
}

const noun = (build: Build) => {
  if (build.hasTests) {
    return 'TEST'
  }

  if (build.action.includes('archive')) {
    return 'ARCHIVE'
  }

  if (build.action.includes('analyze')) {
    return 'ANALYZE'
  }

  return build.action === 'clean' ? 'CLEAN' : 'BUILD'
}

/** `BUILD FAILED`, `TEST SUCCEEDED`: the verdict as xcodebuild words it. */
export const verdict = (build: Build) => `${noun(build)} ${build.status.toUpperCase()}`

/** `xcodebuild test, scheme Demo`: what ran. */
export const subject = (build: Build) => {
  const command = { swift: `swift ${build.action}`, xcodebuild: `xcodebuild ${build.action}`, xcode: `Xcode ${build.action} (MCP)` }[
    build.tool
  ]

  return build.scheme === null ? command : `${command}, scheme ${build.scheme}`
}

/** `1 error · 3 warnings · 12 tests, 1 failed`. */
export const tally = (build: Build) => {
  const parts = [plural(build.errorCount, 'error'), plural(build.warningCount, 'warning')]

  if (build.tests !== null) {
    parts.push(`${plural(build.tests.total, 'test')}, ${build.tests.failed} failed`)
  }

  return parts.join(' · ')
}

export const location = (issue: Pick<Issue, 'line' | 'column'>) => {
  if (issue.line === null) {
    return ''
  }

  return issue.column === null ? `${issue.line}` : `${issue.line}:${issue.column}`
}

/** The issues grouped by file in first-seen order, errors ahead of warnings in each. */
export const byFile = (issues: readonly Issue[]): FileGroup[] => {
  const groups = new Map<string | null, Issue[]>()

  for (const issue of issues) {
    groups.set(issue.file, [...(groups.get(issue.file) ?? []), issue])
  }

  return [...groups].map(([file, own]) => ({
    file,
    issues: [...own.filter(one => one.severity === 'error'), ...own.filter(one => one.severity === 'warning')],
  }))
}

export const percent = (fraction: number) => `${Math.round(fraction * 100)}%`

const diagnostic = (issue: Issue) => {
  const where = issue.file === null ? '' : `${[issue.file, location(issue)].filter(Boolean).join(':')}: `

  return `${where}${issue.severity}: ${issue.message}`
}

const failedTests = (build: Build, limit: number) =>
  (build.tests?.failures ?? []).slice(0, limit).map(failure => {
    const where = failure.file === null ? '' : `${[failure.file, failure.line].filter(Boolean).join(':')}: `

    return `${where}${failure.name}: ${failure.message}`
  })

const listed = (lines: string[], total: number, word: string) =>
  total > lines.length ? [...lines, `(+${plural(total - lines.length, `more ${word}`)})`] : lines

/**
 * The build as the model reads it in place of the raw log: the verdict, every
 * error in `file:line:column: error: message` form, warnings counted or listed,
 * and the failed tests.
 */
export const condense = (build: Build, settings: CondenseSettings): string => {
  const errors = build.issues.filter(one => one.severity === 'error')
  const warnings = build.issues.filter(one => one.severity === 'warning')
  const took = build.durationMs === null ? '' : ` in ${seconds(build.durationMs)}`
  const exit = settings.exitCode === null ? '' : ` (exit code ${settings.exitCode})`
  const blocks: string[][] = [[`${subject(build)}: ${verdict(build)}${took}${exit}`, tally(build)]]

  if (errors.length > 0) {
    blocks.push(listed(errors.slice(0, LISTED).map(diagnostic), build.errorCount, 'error'))
  }

  if (build.tests !== null && build.tests.failures.length > 0) {
    blocks.push(['Failed tests:', ...listed(failedTests(build, LISTED), build.tests.failed, 'failed test')])
  }

  if (build.coverage !== null) {
    blocks.push([`Line coverage: ${percent(build.coverage)}`])
  }

  if (build.warningCount > 0 && settings.warnings === 'list') {
    blocks.push(listed(warnings.slice(0, LISTED).map(diagnostic), build.warningCount, 'warning'))
  } else if (build.warningCount > 0) {
    const files = byFile(warnings)
      .slice(0, 8)
      .map(group => `${group.file === null ? 'no file' : basename(group.file)} (${group.issues.length})`)
    const hint = settings.detailsTool === null ? '' : ` Call ${settings.detailsTool} to list them.`
    blocks.push([`${plural(build.warningCount, 'warning')} not listed: ${files.join(', ')}.${hint}`])
  }

  const from = build.source === 'xcresult' ? "Xcode's result bundle" : 'the build log'
  const notes = [`[xcpane: summarised from ${from}; ${plural(build.logLines, 'line')} of raw log omitted.`]

  if (settings.isLogCut && build.source === 'log') {
    notes.push('The captured log was cut short, so later diagnostics may be missing.')
  }

  if (build.logPath !== null) {
    notes.push(`Full log: ${build.logPath}`)
  }

  blocks.push([`${notes.join(' ')}]`])

  return blocks.map(block => block.join('\n')).join('\n\n')
}

/**
 * A build in full, for the details tool: every stored error and warning with
 * its location, the failed and slowest tests, and coverage.
 */
export const details = (build: Build, show: Detail): string => {
  const wants = (one: Detail) => show === 'all' || show === one
  const of = (severity: Issue['severity']) => build.issues.filter(one => one.severity === severity).map(diagnostic)
  const took = build.durationMs === null ? '' : ` in ${seconds(build.durationMs)}`
  const blocks: string[][] = [[`${subject(build)}: ${verdict(build)}${took}`, tally(build)]]

  if (wants('errors')) {
    blocks.push(build.errorCount === 0 ? ['No errors.'] : listed(of('error'), build.errorCount, 'error'))
  }

  if (wants('warnings')) {
    blocks.push(build.warningCount === 0 ? ['No warnings.'] : listed(of('warning'), build.warningCount, 'warning'))
  }

  if (wants('tests') && build.tests !== null) {
    const { tests } = build
    const slowest = tests.slowest.map(test => `  ${test.name}: ${test.seconds.toFixed(2)}s`)
    blocks.push([
      `${plural(tests.total, 'test')}: ${tests.passed} passed, ${tests.failed} failed, ${tests.skipped} skipped`,
      ...listed(failedTests(build, tests.failures.length), tests.failed, 'failed test'),
    ])

    if (slowest.length > 0) {
      blocks.push(['Slowest tests:', ...slowest])
    }
  } else if (show === 'tests') {
    blocks.push(['This build ran no tests.'])
  }

  if (show === 'all' && build.coverage !== null) {
    blocks.push([`Line coverage: ${percent(build.coverage)}`])
  }

  if (show === 'all' && build.logPath !== null) {
    blocks.push([`Full log: ${build.logPath}`])
  }

  return blocks.map(block => block.join('\n')).join('\n\n')
}
