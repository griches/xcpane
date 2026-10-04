export type Issue = {
  severity: 'error' | 'warning'
  file: string | null
  line: number | null
  column: number | null
  message: string
}

export type TestFailure = {
  name: string
  message: string
  file: string | null
  line: number | null
}

export type SlowTest = { name: string; seconds: number }

export type Tests = {
  total: number
  passed: number
  failed: number
  skipped: number
  failures: TestFailure[]
  slowest: SlowTest[]
}

export type Build = {
  id: string
  /** `xcode` is a build run through Xcode's MCP server. */
  tool: 'xcodebuild' | 'swift' | 'xcode'
  action: string
  hasTests: boolean
  scheme: string | null
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: number
  durationMs: number | null
  errorCount: number
  warningCount: number
  issues: Issue[]
  tests: Tests | null
  /** Line coverage from 0 to 1, when the run collected it. */
  coverage: number | null
  logPath: string | null
  failedCommands: string[]
  source: 'xcresult' | 'log' | 'none'
  logLines: number
  isCondensed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'xcpane': {
      builds: Build[]
      isShowingWarnings: boolean
      now: number
    }
  }
}
