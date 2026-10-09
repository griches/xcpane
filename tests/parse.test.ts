import { describe, expect, test } from 'claude-code/testing'

import { byFile, condense, details, seconds } from '../hooks/format'
import { parseMcpBuild, parseMcpBuildLog, parseMcpTests, structuredOf } from '../hooks/mcp'
import { parseLog } from '../hooks/log'
import { findInvocations, mixedWith, withResultBundle } from '../hooks/shell'
import { parseBuildResults, parseCoverage, parseTestDetails, parseTestSummary } from '../hooks/xcresult'
import type { Build } from '../types'
import {
  COVERAGE,
  FAILED_BUILD_LOG,
  FAILED_BUILD_RESULTS,
  FAILED_SWIFT_BUILD_LOG,
  FAILED_TEST_LOG,
  FAILED_TEST_SUMMARY,
  MCP_BUILD_LOG,
  MCP_FAILED_BUILD,
  MCP_FAILED_TESTS,
  MCP_SUCCEEDED_BUILD,
  SUCCEEDED_BUILD_LOG,
  SUCCEEDED_BUILD_RESULTS,
  TEST_DETAILS,
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

describe('test details and coverage', () => {
  test('reads the slowest tests and where a failed test failed', () => {
    const found = parseTestDetails(TEST_DETAILS)
    expect(found?.slowest.map(test => test.name)).toEqual([
      'TideChartModelTests/testLabelUsesUnitSymbol()',
      'TideChartModelTests/testHighestInMetres()',
    ])
    expect(found?.locations.get('TideChartModelTests/testLabelUsesUnitSymbol()')).toEqual({
      file: '/Users/dev/Tideline/Tests/TidelineTests/TideChartModelTests.swift',
      line: 16,
    })
    expect(parseTestDetails('not json')).toBeNull()
  })

  test('reads line coverage, leaving the test bundle out', () => {
    expect(parseCoverage(COVERAGE)).toBeNull()
    expect(
      parseCoverage(
        JSON.stringify([
          { name: 'App', buildProductPath: '/p/App.app/App', coveredLines: 30, executableLines: 40 },
          { name: 'Kit', buildProductPath: '/p/Kit.framework/Kit', coveredLines: 30, executableLines: 60 },
          { name: 'AppTests', buildProductPath: '/p/AppTests.xctest/AppTests', coveredLines: 50, executableLines: 50 },
        ]),
      ),
    ).toBe(0.6)
    expect(parseCoverage('')).toBeNull()
  })
})

describe('Xcode MCP results', () => {
  test('reads a failed BuildProject result', () => {
    const report = parseMcpBuild(JSON.parse(MCP_FAILED_BUILD))
    expect(report).toMatchObject({ status: 'failed', durationMs: 1386, tests: null })
    expect(report?.issues).toEqual([
      {
        severity: 'error',
        file: '/Users/dev/Tideline/Sources/Tideline/TideChartModel.swift',
        line: 13,
        column: null,
        message: "No 'max' candidates produce the expected contextual result type 'Double'",
      },
      {
        severity: 'error',
        file: '/Users/dev/Tideline/Sources/Tideline/TideChartModel.swift',
        line: 23,
        column: null,
        message: "Cannot convert value of type 'String' to specified type 'Double'",
      },
    ])
  })

  test('reads a succeeded BuildProject result', () => {
    expect(parseMcpBuild(JSON.parse(MCP_SUCCEEDED_BUILD))).toMatchObject({ status: 'succeeded', issues: [] })
  })

  test('reads a RunAllTests result with a failed test', () => {
    const report = parseMcpTests(JSON.parse(MCP_FAILED_TESTS))
    expect(report).toMatchObject({ status: 'failed', scheme: 'Tideline' })
    expect(report?.tests).toMatchObject({ total: 2, passed: 1, failed: 1, skipped: 0 })
    expect(report?.tests?.failures).toEqual([
      {
        name: 'TideChartModelTests/testLabelUsesUnitSymbol()',
        message: 'XCTAssertEqual failed: ("15.1 ft") is not equal to ("15.1ft")',
        file: 'Tideline/Tests/TidelineTests/TideChartModelTests.swift',
        line: 16,
      },
    ])
    expect(report?.bundlePath).toMatch(/\.xcresult$/)
  })

  test('finds the structured result wherever the engine put it', () => {
    const data = JSON.parse(MCP_SUCCEEDED_BUILD)
    expect(structuredOf({ result: { structuredContent: data } })).toEqual(data)
    expect(structuredOf({ result: { content: [{ type: 'text', text: MCP_SUCCEEDED_BUILD }] } })).toEqual(data)
    expect(structuredOf({ result: MCP_SUCCEEDED_BUILD })).toEqual(data)
    expect(structuredOf({ text: MCP_SUCCEEDED_BUILD })).toEqual(data)
    expect(structuredOf({ text: 'Build action failed.' })).toBeNull()
  })

  test('reads the warnings BuildProject leaves out from GetBuildLog, one per issue', () => {
    const issues = parseMcpBuildLog(JSON.parse(MCP_BUILD_LOG))
    expect(issues?.map(issue => `${issue.severity} ${issue.file?.split('/').at(-1)}:${issue.line}`)).toEqual([
      'warning HeightUnit.swift:13',
      'warning ForecastService.swift:14',
      'warning ForecastService.swift:23',
      'warning ForecastService.swift:23',
      'warning TideChartModel.swift:18',
    ])
    expect(parseMcpBuildLog({ type: 'error' })).toBeNull()
  })

  test('answers null for a result of another shape', () => {
    expect(parseMcpBuild({ type: 'error', data: 'nope' })).toBeNull()
    expect(parseMcpTests({ type: 'error', data: 'nope' })).toBeNull()
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
    coverage: null,
    logPath: null,
    failedCommands: [],
    source: 'xcresult',
    logLines: 288,
    isCondensed: false,
  }
  const settings = { warnings: 'count', exitCode: 65, isLogCut: false, detailsTool: 'mcp__xcpane__details' } as const

  test('lists every error and counts the warnings', () => {
    expect(condense(build, settings)).toBe(
      [
        'xcodebuild build, scheme Demo: BUILD FAILED in 9.8s (exit code 65)',
        '1 error · 1 warning',
        '',
        `${MATHS}:3:31: error: Cannot convert value of type 'Int' to specified type 'String'`,
        '',
        '1 warning not listed: Maths.swift (1). Call mcp__xcpane__details to list them.',
        '',
        "[xcpane: summarised from Xcode's result bundle; 288 lines of raw log omitted.]",
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
      slowest: [{ name: 'DemoTests/testGreet()', seconds: 0.4281 }],
    }
    const text = condense({ ...build, hasTests: true, errorCount: 0, warningCount: 0, issues: [], tests }, settings)
    expect(text).toContain('TEST FAILED')
    expect(text).toContain('0 errors · 0 warnings · 2 tests, 1 failed')
    expect(text).toContain('/T.swift:6: DemoTests/testGreet(): XCTAssertEqual failed')

    const full = details({ ...build, hasTests: true, errorCount: 0, issues: [], tests, coverage: 0.874 }, 'all')
    expect(full).toContain('2 tests: 1 passed, 1 failed, 0 skipped')
    expect(full).toContain('  DemoTests/testGreet(): 0.43s')
    expect(full).toContain('Line coverage: 87%')
  })

  test('the details view lists what the summary only counted', () => {
    expect(details(build, 'warnings')).toBe(
      [
        'xcodebuild build, scheme Demo: BUILD FAILED in 9.8s',
        '1 error · 1 warning',
        '',
        `${MATHS}:4:26: warning: 'hello()' is deprecated: use greet(_:)`,
      ].join('\n'),
    )
    expect(details(build, 'tests')).toContain('This build ran no tests.')
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

describe('mixedWith', () => {
  test('a line that prints something else as well is told apart', () => {
    expect(mixedWith('xcodebuild -scheme Demo build && cat project-config.json')).toEqual(['cat'])
    expect(mixedWith('ls -la && swift build')).toEqual(['ls'])
    expect(mixedWith('xcodebuild test; echo "exit $?"')).toEqual(['echo'])
  })

  test('a build with only filters and quiet commands around it is not mixed', () => {
    expect(mixedWith('cd App && xcodebuild -scheme Demo build 2>&1 | tail -80')).toEqual([])
    expect(mixedWith('set -o pipefail && xcrun xcodebuild build | xcbeautify')).toEqual([])
    expect(mixedWith('swift build 2>&1 | grep -E "error|warning" | head -40')).toEqual([])
  })
})
