import type { Issue, TestFailure } from '../types'

export type LogReport = {
  issues: Issue[]
  failures: TestFailure[]
  passedTests: number
  failedTests: number
  skippedTests: number
  marker: 'succeeded' | 'failed' | null
  failedCommands: string[]
  lines: number
  isCut: boolean
}

const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const LOCATED = /^([^\s:][^:]*\.[A-Za-z0-9+]+):(\d+)(?::(\d+))?: (error|warning|fatal error): (.*)$/
const UNLOCATED = /^(?:([A-Za-z0-9_+.-]+): )?(error|warning|fatal error): (.+)$/
const NOISE = /failed with a nonzero exit code|^Build failed$|^fatalError$|command failed due to signal|^(?:emit-module|compile) command failed/
const XCTEST_FAILURE = /^-\[(\S+) (\S+)\] : (.*)$/
const XCTEST_CASE = /^Test [Cc]ase '(.+?)' (passed|failed|skipped)\b/
const SWIFT_TESTING_ISSUE = /^\S+ +Test (?:"(.+?)"|(\S+)) recorded an issue at (.+?):(\d+):\d+: (.*)$/
const SWIFT_TESTING_CASE = /^\S+ +Test (?!run\b|Case\b|Suite\b)(?:"(.+?)"|(\S+)) (passed|failed|skipped) after /
const MARKER = /^\*\* [A-Z ]+? (SUCCEEDED|FAILED) \*\*/
const UNDEFINED_SYMBOLS = /^Undefined symbols?(?: for architecture \w+)?:/
const TAG = /\s*\[#\w+\]$/
const CUT = /\[\d+ (?:characters|lines) truncated\]|^<persisted-output>/m

const testName = (suite: string, test: string) => `${suite.slice(suite.lastIndexOf('.') + 1)}/${test}`

const caseName = (name: string) => {
  const objc = /^-\[(\S+) (\S+)\]$/.exec(name)

  return objc === null ? name : testName(objc[1] ?? '', objc[2] ?? '')
}

/**
 * Reads what xcodebuild, swift build and swift test print: compiler and linker
 * diagnostics, test results, the closing verdict and the commands that failed.
 */
export const parseLog = (text: string): LogReport => {
  const lines = text.replace(ESCAPES, '').split(/\r?\n/)
  const issues = new Map<string, Issue>()
  const failures = new Map<string, TestFailure>()
  const outcomes = new Map<string, string>()
  const failedCommands: string[] = []
  let marker: LogReport['marker'] = null
  let isListingFailedCommands = false

  const report = (issue: Issue) => {
    issues.set([issue.severity, issue.file, issue.line, issue.column, issue.message].join('|'), issue)
  }

  for (const [index, line] of lines.entries()) {
    const located = LOCATED.exec(line)
    const unlocated = located === null ? UNLOCATED.exec(line) : null
    const verdict = MARKER.exec(line)
    const xctestCase = XCTEST_CASE.exec(line)
    const swiftCase = SWIFT_TESTING_CASE.exec(line)
    const swiftIssue = SWIFT_TESTING_ISSUE.exec(line)

    if (isListingFailedCommands) {
      isListingFailedCommands = /^\s+\S/.test(line)

      if (isListingFailedCommands) {
        failedCommands.push(line.trim())
      }
    } else if (located !== null) {
      const file = located[1] ?? ''
      const row = Number(located[2])
      const message = (located[5] ?? '').replace(TAG, '')
      const failed = XCTEST_FAILURE.exec(message)

      if (failed === null) {
        report({
          severity: located[4] === 'warning' ? 'warning' : 'error',
          file,
          line: row,
          column: located[3] === undefined ? null : Number(located[3]),
          message,
        })
      } else {
        const name = testName(failed[1] ?? '', failed[2] ?? '')
        failures.set(name, { name, message: failed[3] ?? '', file, line: row })
      }
    } else if (unlocated !== null) {
      const message = unlocated[3] ?? ''

      if (message === 'Build failed') {
        marker = 'failed'
      }

      if (!NOISE.test(message)) {
        report({
          severity: unlocated[2] === 'warning' ? 'warning' : 'error',
          file: null,
          line: null,
          column: null,
          message: unlocated[1] === undefined ? message : `${unlocated[1]}: ${message}`,
        })
      }
    } else if (UNDEFINED_SYMBOLS.test(line)) {
      const symbols = lines.slice(index + 1, index + 9).filter(one => /^\s+\S/.test(one))
      report({ severity: 'error', file: null, line: null, column: null, message: [line, ...symbols].join('\n') })
    } else if (verdict !== null) {
      marker = verdict[1] === 'FAILED' || marker === 'failed' ? 'failed' : 'succeeded'
    } else if (line.startsWith('Build complete!')) {
      marker ??= 'succeeded'
    } else if (line.startsWith('The following build commands failed:')) {
      isListingFailedCommands = true
    } else if (xctestCase !== null) {
      outcomes.set(caseName(xctestCase[1] ?? ''), xctestCase[2] ?? '')
    } else if (swiftCase !== null) {
      outcomes.set(swiftCase[1] ?? swiftCase[2] ?? '', swiftCase[3] ?? '')
    } else if (swiftIssue !== null) {
      const name = swiftIssue[1] ?? swiftIssue[2] ?? ''
      failures.set(name, { name, message: swiftIssue[5] ?? '', file: swiftIssue[3] ?? null, line: Number(swiftIssue[4]) })
    }
  }

  for (const [name, outcome] of outcomes) {
    if (outcome === 'failed' && !failures.has(name)) {
      failures.set(name, { name, message: 'failed', file: null, line: null })
    }
  }

  const outcome = (wanted: string) => [...outcomes.values()].filter(one => one === wanted).length

  return {
    issues: [...issues.values()],
    failures: [...failures.values()],
    passedTests: outcome('passed'),
    failedTests: Math.max(outcome('failed'), failures.size),
    skippedTests: outcome('skipped'),
    marker,
    failedCommands,
    lines: lines.length,
    isCut: CUT.test(text),
  }
}
