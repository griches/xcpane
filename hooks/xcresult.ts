import type { Issue, Tests } from '../types'

export type BundleReport = {
  status: 'succeeded' | 'failed' | null
  issues: Issue[]
  errorCount: number
  warningCount: number
}

type Json = Record<string, unknown>

const object = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null

const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.map(object).filter(one => one !== null) : [])

const count = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

const parse = (json: string): Json | null => {
  try {
    return object(JSON.parse(json))
  } catch {
    return null
  }
}

const decoded = (path: string) => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

const oneBased = (fragment: string, name: string) => {
  const found = new RegExp(`(?:^|&)${name}=(\\d+)`).exec(fragment)

  return found === null ? null : Number(found[1]) + 1
}

const issue = (severity: Issue['severity'], entry: Json): Issue => {
  const url = typeof entry.sourceURL === 'string' && entry.sourceURL.startsWith('file://') ? entry.sourceURL : null
  const hash = url?.indexOf('#') ?? -1
  const fragment = url === null || hash < 0 ? '' : url.slice(hash + 1)

  return {
    severity,
    file: url === null ? null : decoded(url.slice('file://'.length, hash < 0 ? undefined : hash)),
    line: oneBased(fragment, 'StartingLineNumber'),
    column: oneBased(fragment, 'StartingColumnNumber'),
    message: typeof entry.message === 'string' ? entry.message : String(entry.issueType ?? 'Unknown issue'),
  }
}

/**
 * Reads `xcrun xcresulttool get build-results`: the build's verdict and its
 * errors and warnings, whose line and column the bundle counts from zero.
 *
 * Null for the bundle xcodebuild leaves when it stopped before building
 * (status `notRequested`, no issues): the log has what went wrong.
 */
export const parseBuildResults = (json: string): BundleReport | null => {
  const root = parse(json)

  if (root === null || !('errors' in root || 'status' in root)) {
    return null
  }

  const errors = objects(root.errors).map(entry => issue('error', entry))
  const warnings = [...objects(root.warnings), ...objects(root.analyzerWarnings)].map(entry => issue('warning', entry))
  const errorCount = count(root.errorCount, errors.length)
  const status = root.status === 'failed' || errorCount > 0 ? 'failed' : root.status === 'succeeded' ? 'succeeded' : null

  if (status === null && warnings.length === 0) {
    return null
  }

  return {
    status,
    issues: [...errors, ...warnings],
    errorCount,
    warningCount: count(root.warningCount, 0) + count(root.analyzerWarningCount, 0),
  }
}

/**
 * Reads `xcrun xcresulttool get test-results summary`; null for a bundle that
 * ran no tests.
 */
export const parseTestSummary = (json: string): Tests | null => {
  const root = parse(json)
  const total = count(root?.totalTestCount, 0)

  if (root === null || total === 0) {
    return null
  }

  return {
    total,
    passed: count(root.passedTests, 0),
    failed: count(root.failedTests, 0),
    skipped: count(root.skippedTests, 0),
    failures: objects(root.testFailures).map(entry => ({
      name: String(entry.testIdentifierString ?? entry.testName ?? 'Unknown test'),
      message: String(entry.failureText ?? 'failed'),
      file: null,
      line: null,
    })),
  }
}
