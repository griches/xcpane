import { describe, expect, test } from 'claude-code/testing'

import { byFile, condense, seconds } from '../hooks/format'
import { parseLog } from '../hooks/log'
import { findInvocations, withResultBundle } from '../hooks/shell'
import { parseBuildResults, parseTestSummary } from '../hooks/xcresult'
import type { Build } from '../types'
import {
  FAILED_BUILD_LOG,
  FAILED_BUILD_RESULTS,
  FAILED_SWIFT_BUILD_LOG,
  FAILED_TEST_LOG,
  FAILED_TEST_SUMMARY,
  SUCCEEDED_BUILD_LOG,
  SUCCEEDED_BUILD_RESULTS,
} from './fixtures'

const MATHS = '/Users/dev/Demo/Sources/Demo/Maths.swift'

const only = (command: string) => {
  const found = findInvocations(command)
  expect(found).toHaveLength(1)

  return found[0]!
}

describe('findInvocations', () => {
  test('reads the action and scheme of a plain build', () => {
    expect(only('xcodebuild -scheme Demo build')).toMatchObject({
      tool: 'xcodebuild',
      action: 'build',
      scheme: 'Demo',
      hasTests: false,
      isInfoOnly: false,
    })
  })

  test('defaults to build and joins several actions', () => {
    expect(only('xcodebuild -project App.xcodeproj -target App').action).toBe('build')
    expect(only('NSUnbufferedIO=YES xcrun xcodebuild clean build -workspace A.xcworkspace -scheme A').action).toBe(
      'clean build',
    )
  })

  test('does not take a flag value or a build setting for an action', () => {
    const found = only('xcodebuild -scheme test -configuration Debug ONLY_ACTIVE_ARCH=NO archive')
    expect(found).toMatchObject({ action: 'archive', scheme: 'test', hasTests: false })
  })

  test('finds a build behind cd, quotes and a pipe', () => {
    const command =
      "cd App && xcodebuild -scheme \"My App\" -destination 'platform=iOS Simulator,name=iPhone 16' test 2>&1 | xcbeautify"
    expect(only(command)).toMatchObject({ scheme: 'My App', action: 'test', hasTests: true })
  })

  test('adds the result bundle after the last argument, ahead of redirects and pipes', () => {
    const command = 'cd App && xcodebuild -scheme Demo test 2>&1 | tail -n 40'
    expect(withResultBundle(command, only(command), "/tmp/a b/it's.xcresult")).toBe(
      "cd App && xcodebuild -scheme Demo test -resultBundlePath '/tmp/a b/it'\\''s.xcresult' 2>&1 | tail -n 40",
    )
  })

  test('adds the result bundle after a continued line', () => {
    const command = 'xcodebuild -scheme Demo \\\n  build > build.log'
    expect(withResultBundle(command, only(command), '/tmp/x.xcresult')).toBe(
      "xcodebuild -scheme Demo \\\n  build -resultBundlePath '/tmp/x.xcresult' > build.log",
    )
  })

  test('reads a result bundle path the command already names', () => {
    expect(only('xcodebuild build -resultBundlePath /tmp/mine.xcresult')).toMatchObject({
      hasResultBundleFlag: true,
      resultBundlePath: '/tmp/mine.xcresult',
    })
    expect(only('xcodebuild build -resultBundlePath "$TMPDIR/mine.xcresult"')).toMatchObject({
      hasResultBundleFlag: true,
      resultBundlePath: null,
    })
  })

  test('marks a query that builds nothing', () => {
    expect(only('xcodebuild -showBuildSettings -scheme Demo').isInfoOnly).toBe(true)
    expect(only('xcodebuild -version').isInfoOnly).toBe(true)
  })

  test('reads swift build and swift test, and no other swift command', () => {
    expect(only('swift build -c release')).toMatchObject({ tool: 'swift', action: 'build', hasTests: false })
    expect(only('swift test --filter DemoTests')).toMatchObject({ tool: 'swift', action: 'test', hasTests: true })
    expect(findInvocations('swift package resolve')).toHaveLength(0)
  })

  test('ignores xcodebuild as text', () => {
    expect(findInvocations('git commit -m "fix xcodebuild build flags"')).toHaveLength(0)
    expect(findInvocations('grep -r xcodebuild scripts/')).toHaveLength(0)
    expect(findInvocations('SETTINGS=$(xcodebuild -scheme Demo build)')).toHaveLength(0)
    expect(findInvocations("cat > build.sh <<'EOF'\nxcodebuild -scheme Demo build\nEOF")).toHaveLength(0)
  })
})

describe('parseLog', () => {
  test('reads a failed xcodebuild log', () => {
    const log = parseLog(FAILED_BUILD_LOG)
    expect(log.marker).toBe('failed')
    expect(log.issues).toEqual([
      {
        severity: 'error',
        file: MATHS,
        line: 3,
        column: 31,
        message: "cannot convert value of type 'Int' to specified type 'String'",
      },
      { severity: 'warning', file: MATHS, line: 4, column: 26, message: "'hello()' is deprecated: use greet(_:)" },
    ])
    expect(log.failedCommands).toHaveLength(3)
  })

  test('reads a succeeded build and its warnings once each', () => {
    const log = parseLog(SUCCEEDED_BUILD_LOG)
    expect(log.marker).toBe('succeeded')
    expect(log.issues.map(issue => issue.severity)).toEqual(['warning', 'warning', 'warning'])
  })

  test('reads XCTest results and keeps a failed assertion out of the compiler errors', () => {
    const log = parseLog(FAILED_TEST_LOG)
    expect(log).toMatchObject({ marker: 'failed', passedTests: 1, failedTests: 1, issues: [] })
    expect(log.failures).toEqual([
      {
        name: 'DemoTests/testGreet',
        message: 'XCTAssertEqual failed: ("Hello, Bob!") is not equal to ("Hello, Bob")',
        file: '/Users/dev/Demo/Tests/DemoTests/DemoTests.swift',
        line: 6,
      },
    ])
  })

  test('reads swift build output through its color codes', () => {
    const log = parseLog(FAILED_SWIFT_BUILD_LOG)
    expect(log.marker).toBe('failed')
    expect(log.issues.filter(issue => issue.severity === 'error')).toEqual([
      {
        severity: 'error',
        file: MATHS,
        line: 3,
        column: 31,
        message: "cannot convert value of type 'Int' to specified type 'String'",
      },
    ])
  })

  test('reads errors that name no file', () => {
    const log = parseLog(
      [
        'xcodebuild: error: Scheme Nope is not currently configured for the build action.',
        'Undefined symbols for architecture arm64:',
        '  "_missing", referenced from:',
        '      _main in main.o',
        'ld: symbol(s) not found for architecture arm64',
        'clang: error: linker command failed with exit code 1 (use -v to see invocation)',
      ].join('\n'),
    )
    expect(log.issues.map(issue => issue.message)).toEqual([
      'xcodebuild: Scheme Nope is not currently configured for the build action.',
      'Undefined symbols for architecture arm64:\n  "_missing", referenced from:\n      _main in main.o',
      'clang: linker command failed with exit code 1 (use -v to see invocation)',
    ])
  })

  test('reads Swift Testing results', () => {
    const log = parseLog(
      [
        '◇ Test run started.',
        '◇ Test adds() started.',
        '✔ Test adds() passed after 0.001 seconds.',
        '◇ Test "greets politely" started.',
        '✘ Test "greets politely" recorded an issue at DemoTests.swift:12:5: Expectation failed: (greeting → "Hi") == "Hello"',
        '✘ Test "greets politely" failed after 0.002 seconds with 1 issue.',
        '✘ Test run with 2 tests failed after 0.003 seconds with 1 issue.',
      ].join('\n'),
    )
    expect(log).toMatchObject({ passedTests: 1, failedTests: 1 })
    expect(log.failures).toEqual([
      {
        name: 'greets politely',
        message: 'Expectation failed: (greeting → "Hi") == "Hello"',
        file: 'DemoTests.swift',
        line: 12,
      },
    ])
  })

  test('says when Claude Code cut the log short', () => {
    expect(parseLog('CompileSwift normal\n\n... [20013 characters truncated] ...\n\nCompileSwift').isCut).toBe(true)
    expect(parseLog(FAILED_BUILD_LOG).isCut).toBe(false)
  })
})

describe('result bundle', () => {
  test('reads errors and warnings, counting lines and columns from one', () => {
    const report = parseBuildResults(FAILED_BUILD_RESULTS)
    expect(report).toMatchObject({ status: 'failed', errorCount: 1, warningCount: 1 })
    expect(report?.issues[0]).toEqual({
      severity: 'error',
      file: MATHS,
      line: 3,
      column: 31,
      message: "Cannot convert value of type 'Int' to specified type 'String'",
    })
  })

  test('reads a succeeded build', () => {
    expect(parseBuildResults(SUCCEEDED_BUILD_RESULTS)).toMatchObject({ status: 'succeeded', errorCount: 0, warningCount: 3 })
  })

  test('reads a test summary, and none from a bundle without tests', () => {
    expect(parseTestSummary(FAILED_TEST_SUMMARY)).toMatchObject({
      total: 2,
      passed: 1,
      failed: 1,
      failures: [{ name: 'DemoTests/testGreet()' }],
    })
    expect(parseTestSummary('{"totalTestCount":0,"result":"unknown"}')).toBeNull()
  })

  test('answers null for what is not a report', () => {
    expect(parseBuildResults('')).toBeNull()
    expect(parseBuildResults('Error: unknown subcommand')).toBeNull()
    expect(parseBuildResults('[]')).toBeNull()
    expect(parseBuildResults('{"status":"notRequested","errorCount":0,"errors":[],"warnings":[]}')).toBeNull()
  })
})

describe('condense', () => {
  const report = parseBuildResults(FAILED_BUILD_RESULTS)
  const build: Build = {
    id: 'toolu_1',
    tool: 'xcodebuild',
    action: 'build',
    hasTests: false,
    scheme: 'Demo',
    status: 'failed',
    startedAt: 0,
    durationMs: 9800,
    errorCount: 1,
    warningCount: 1,
    issues: report?.issues ?? [],
    tests: null,
    failedCommands: [],
    source: 'xcresult',
    logLines: 288,
    isCondensed: false,
  }
  const settings = { warnings: 'count', exitCode: 65, logPath: null, isLogCut: false } as const

  test('lists every error and counts the warnings', () => {
    expect(condense(build, settings)).toBe(
      [
        'xcodebuild build, scheme Demo: BUILD FAILED in 9.8s (exit code 65)',
        '1 error · 1 warning',
        '',
        `${MATHS}:3:31: error: Cannot convert value of type 'Int' to specified type 'String'`,
        '',
        '1 warning not listed: Maths.swift (1)',
        '',
        "[xcode-build mod: summarised from Xcode's result bundle; 288 lines of raw log omitted.]",
      ].join('\n'),
    )
  })

  test('lists the warnings when asked', () => {
    expect(condense(build, { ...settings, warnings: 'list' })).toContain(
      `${MATHS}:4:26: warning: 'hello()' is deprecated: use greet(_:)`,
    )
  })

  test('lists failed tests with where they failed', () => {
    const tests = {
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [{ name: 'DemoTests/testGreet()', message: 'XCTAssertEqual failed', file: '/T.swift', line: 6 }],
    }
    const text = condense({ ...build, hasTests: true, errorCount: 0, warningCount: 0, issues: [], tests }, settings)
    expect(text).toContain('TEST FAILED')
    expect(text).toContain('0 errors · 0 warnings · 2 tests, 1 failed')
    expect(text).toContain('/T.swift:6: DemoTests/testGreet(): XCTAssertEqual failed')
  })
})

describe('format', () => {
  test('groups issues by file, errors first', () => {
    const groups = byFile(parseBuildResults(FAILED_BUILD_RESULTS)?.issues ?? [])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.issues.map(issue => issue.severity)).toEqual(['error', 'warning'])
  })

  test('words a duration', () => {
    expect([seconds(900), seconds(42_400), seconds(125_000)]).toEqual(['0.9s', '42s', '2m 5s'])
  })
})
