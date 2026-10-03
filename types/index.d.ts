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

export type Tests = {
  total: number
  passed: number
  failed: number
  skipped: number
  failures: TestFailure[]
}

export type Build = {
  id: string
  tool: 'xcodebuild' | 'swift'
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
  failedCommands: string[]
  source: 'xcresult' | 'log' | 'none'
  logLines: number
  isCondensed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'xcode-build': {
      builds: Build[]
      isShowingWarnings: boolean
      now: number
    }
  }
}
