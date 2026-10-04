import type { Issue, Tests } from '../types'

export type McpReport = {
  status: 'succeeded' | 'failed'
  scheme: string | null
  issues: Issue[]
  tests: Tests | null
  logPath: string | null
  bundlePath: string | null
  durationMs: number | null
}

type Json = Record<string, unknown>

const object = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null

const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.map(object).filter(one => one !== null) : [])

const text = (value: unknown) => (typeof value === 'string' ? value : null)

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const parsed = (json: unknown): Json | null => {
  try {
    return typeof json === 'string' ? object(JSON.parse(json)) : null
  } catch {
    return null
  }
}

/**
 * The structured result of an Xcode MCP tool call, wherever the engine put it:
 * `structuredContent`, the first text block, or the text the model read.
 */
export const structuredOf = (ran: { result?: unknown; text?: string }): Json | null => {
  const result = object(ran.result)
  const block = objects(result?.content).find(one => typeof one.text === 'string')

  return object(result?.structuredContent) ?? parsed(block?.text) ?? parsed(ran.result) ?? parsed(ran.text) ?? result
}

/** Reads the result of Xcode MCP's `BuildProject`. */
export const parseMcpBuild = (data: Json): McpReport | null => {
  if (!('buildResult' in data) && !('errors' in data)) {
    return null
  }

  const issues = objects(data.errors).map(
    (entry): Issue => ({
      severity: entry.classification === 'warning' ? 'warning' : 'error',
      file: text(entry.filePath),
      line: typeof entry.lineNumber === 'number' ? entry.lineNumber : null,
      column: null,
      message: text(entry.message) ?? 'Unknown issue',
    }),
  )
  const hasFailed = issues.some(one => one.severity === 'error') || /fail/i.test(text(data.buildResult) ?? '')

  return {
    status: hasFailed ? 'failed' : 'succeeded',
    scheme: null,
    issues,
    tests: null,
    logPath: text(data.fullLogPath),
    bundlePath: null,
    durationMs: typeof data.elapsedTime === 'number' ? Math.round(data.elapsedTime * 1000) : null,
  }
}

const FAILURE = /^(\S+?):(\d+) \S+: (.*)$/s

/** Reads the result of Xcode MCP's `RunAllTests` and `RunSomeTests`. */
export const parseMcpTests = (data: Json): McpReport | null => {
  const counts = object(data.counts)

  if (counts === null) {
    return null
  }

  const failures = objects(data.results)
    .filter(one => one.state === 'Failed')
    .map(one => {
      const message = (Array.isArray(one.errorMessages) ? one.errorMessages : []).filter(each => typeof each === 'string')
      const located = FAILURE.exec(message[0] ?? '')

      return {
        name: text(one.identifier) ?? text(one.displayName) ?? 'Unknown test',
        message: located?.[3] ?? (message.join('; ') || 'failed'),
        file: located?.[1] ?? null,
        line: located === null ? null : Number(located[2]),
      }
    })

  return {
    status: count(counts.failed) > 0 ? 'failed' : 'succeeded',
    scheme: text(data.schemeName),
    issues: [],
    tests: {
      total: count(counts.total),
      passed: count(counts.passed),
      failed: count(counts.failed),
      skipped: count(counts.skipped),
      failures,
      slowest: [],
    },
    logPath: text(data.fullSummaryPath),
    bundlePath: text(data.xcresultBundlePath),
    durationMs: null,
  }
}
