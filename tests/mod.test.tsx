import type { Args, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  FAILED_BUILD_LOG,
  FAILED_BUILD_RESULTS,
  FAILED_TEST_LOG,
  FAILED_TEST_SUMMARY,
  MCP_BUILD_LOG,
  MCP_FAILED_BUILD,
  MCP_FAILED_TESTS,
  SUCCEEDED_BUILD_LOG,
  SUCCEEDED_BUILD_RESULTS,
  TEST_DETAILS,
} from './fixtures'

const PLUGIN = 'xcpane'
const SURFACES = ['terminal', 'desktop'] as const
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'xcpane',
  props: {
    title: 'Xcode build',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 160, rows: 40 },
} as const

type SessionAppendMessage = Args<'session.append'>['message']

type World = {
  /** What the Bash tool answers, as core does: an errored call's `result` is the text the model read. */
  bash: { text: string; isError?: true }
  /** `xcresulttool get <query>` output by query, or null when no bundle was written. */
  bundle: Record<string, string> | null
  /** What an Xcode MCP tool answers, as its structured result in JSON. */
  mcp?: string
}

/** Calls a tool the type declarations do not list: an MCP server's, or the mod's own. */
const callTool = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call(input as never) as Promise<{ result?: unknown; isError?: true }>

const failed = (log: string) => ({ text: `Exit code 65\n${log}`, isError: true }) as const

const world = (on: On, { bash, bundle, mcp }: World) => {
  const seen = {
    commands: [] as string[],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    opened: [] as string[],
    ran: [] as string[],
    asked: [] as string[],
    rows: [] as SessionAppendMessage[],
  }
  mock.clock(on, { now: 1_000 })
  mock.env(on, { TMPDIR: '/tmp/t/' })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('tool.call', { tool: /^mcp__xcode__/ }, () => ({
    result: { content: [{ type: 'text', text: mcp ?? '' }], structuredContent: JSON.parse(mcp ?? '{}'), isError: false },
    text: mcp ?? '',
  }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.commands.push(e.command)

    return bash.isError === true
      ? { isError: true, result: bash.text, text: bash.text }
      : { result: { stdout: bash.text, stderr: '', interrupted: false }, text: bash.text }
  })
  on('mcp.call', (_$, e) => {
    seen.asked.push(`${e.server} ${e.tool} ${JSON.stringify(e.args)}`)

    return { value: { content: [{ type: 'text', text: MCP_BUILD_LOG }], isError: false } }
  })
  on('fs.exists', (_$, e) => ({ value: bundle !== null && seen.commands.some(command => command.includes(e.path)) }))
  on('process.run', (_$, e) => {
    const query = e.argv.slice(3, e.argv.indexOf('--path')).join(' ')
    seen.ran.push(e.argv.slice(0, 2).join(' '))

    return {
      value: {
        exitCode: bundle?.[query] === undefined ? 1 : 0,
        stdout: bundle?.[query] ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  // The store itself is the engine's: a hook may only relay it, so the test
  // records the row that reached the bottom and lets `next` fail beneath it.
  on('session.append', (_$, e, next) => {
    seen.rows.push(e.message)

    return next(e)
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>the raw log</Text>
  })

  return seen
}

/** Appends a Bash call's result row as the engine does and answers what the model would read of it. */
const modelReads = async ($: Engine, seen: ReturnType<typeof world>, id: string, text: string) => {
  await $.session
    .append({
      message: {
        type: 'user',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: `row-${id}`,
    })
    .catch(() => undefined)

  return seen.rows.at(-1)?.content[0]
}

test('a failing build: the bundle is asked for, the pane lists the errors, Claude reads them', async ($, on) => {
  const bash = failed(FAILED_BUILD_LOG)
  const seen = world(on, { bash, bundle: { 'build-results': FAILED_BUILD_RESULTS } })

  const ran = await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme Demo build 2>&1', tool_use_id: 'toolu_1' })

  expect(ran.isError).toBe(true)
  expect(seen.commands).toEqual([
    "xcodebuild -scheme Demo build -resultBundlePath '/tmp/t/xcpane/toolu_1.xcresult' 2>&1",
  ])
  expect(seen.opened).toEqual(['xcpane'])
  expect(seen.statuses.at(-1)).toBe('✗ Demo: 1 error · 1 warning')
  expect(seen.ran).toContain('/bin/rm -rf')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /BUILD FAILED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Maths.swift' })).toMatchObject({ props: { bold: true } })
    expect(await ui.find({ type: 'Text', text: /Cannot convert value of type 'Int'/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /is deprecated/ })).toBeUndefined()

    await ui.press({ key: 'warnings' })
    expect(await ui.find({ type: 'Text', text: /is deprecated/ })).toBeDefined()
    await ui.press({ key: 'warnings' })
    await ui.unmount()
  }

  const block = await modelReads($, seen, 'toolu_1', bash.text)
  expect(block).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true })
  expect(block?.content).toContain('xcodebuild build, scheme Demo: BUILD FAILED')
  expect(block?.content).toContain("Maths.swift:3:31: error: Cannot convert value of type 'Int' to specified type 'String'")
  expect(block?.content).toContain('(exit code 65)')
  expect(String(block?.content).length).toBeLessThan(bash.text.length / 10)
})

test('a failing build draws its verdict in the transcript row, and other rows are left alone', async ($, on) => {
  world(on, { bash: failed(FAILED_BUILD_LOG), bundle: { 'build-results': FAILED_BUILD_RESULTS } })
  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme Demo build', tool_use_id: 'toolu_1' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const row = (id: string) =>
      $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'ToolResult',
        requestId: id,
        props: { tool_use_id: id, tool: 'Bash', output: 'Exit code 65', isErrored: true },
      })
    const build = await row('toolu_1')
    expect(await build.find({ type: 'Text', text: /✗ BUILD FAILED/ })).toBeDefined()
    expect(await build.find({ type: 'Text', text: /Maths\.swift:3:31 {2}Cannot convert/ })).toBeDefined()
    await build.unmount()

    const other = await row('toolu_other')
    expect((await other.find({ type: 'Text' }))?.text).toBe('the raw log')
    await other.unmount()
  }
})

test('without a result bundle the log is read instead', async ($, on) => {
  const bash = failed(FAILED_BUILD_LOG)
  const seen = world(on, { bash, bundle: null })

  await $.tool.call({ tool: 'Bash', command: 'swift build', tool_use_id: 'toolu_2' })

  expect(seen.commands).toEqual(['swift build'])
  const block = await modelReads($, seen, 'toolu_2', bash.text)
  expect(block?.content).toContain(
    "Maths.swift:3:31: error: cannot convert value of type 'Int' to specified type 'String'",
  )
  expect(block?.content).toContain('summarised from the build log')
})

test('a succeeding build clears the status line and says so in a toast', async ($, on) => {
  const seen = world(on, { bash: { text: SUCCEEDED_BUILD_LOG }, bundle: { 'build-results': SUCCEEDED_BUILD_RESULTS } })

  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme Demo build', tool_use_id: 'toolu_3' })

  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(seen.toasts).toEqual(['✓ BUILD SUCCEEDED · 0 errors · 3 warnings · 0.0s'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ BUILD SUCCEEDED/ })).toBeDefined()
  expect(await ui.find({ key: 'warnings' })).toMatchObject({ props: { label: 'Show 3 warnings' } })
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /No builds yet/ })).toBeDefined()
  await ui.unmount()
})

test('failed tests are listed with where they failed', async ($, on) => {
  const bash = failed(FAILED_TEST_LOG)
  const seen = world(on, {
    bash,
    bundle: {
      'build-results': SUCCEEDED_BUILD_RESULTS,
      'test-results summary': FAILED_TEST_SUMMARY,
    },
  })

  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme Demo test', tool_use_id: 'toolu_4' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✗ TEST FAILED/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /DemoTests\/testGreet\(\)/ })).toBeDefined()
  await ui.unmount()

  expect((await modelReads($, seen, 'toolu_4', bash.text))?.content).toContain(
    '/Users/dev/Demo/Tests/DemoTests/DemoTests.swift:6: DemoTests/testGreet(): XCTAssertEqual failed',
  )
})

test('a command that builds nothing passes through untouched', async ($, on) => {
  const seen = world(on, { bash: { text: 'Xcode 27.1' }, bundle: null })

  for (const command of ['ls -la', 'xcodebuild -version', 'git commit -m "fix xcodebuild"']) {
    await $.tool.call({ tool: 'Bash', command, tool_use_id: 'toolu_5' })
  }

  expect(seen.commands).toEqual(['ls -la', 'xcodebuild -version', 'git commit -m "fix xcodebuild"'])
  expect(seen.opened).toEqual([])
  expect((await modelReads($, seen, 'toolu_5', 'Xcode 27.1'))?.content).toBe('Xcode 27.1')
})

test(
  'with condense and resultBundle off, the command and what Claude reads are unchanged',
  { options: { condense: false, resultBundle: false, autoOpen: 'never' } },
  async ($, on) => {
    const bash = failed(FAILED_BUILD_LOG)
    const seen = world(on, { bash, bundle: null })

    await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme Demo build', tool_use_id: 'toolu_6' })

    expect(seen.commands).toEqual(['xcodebuild -scheme Demo build'])
    expect(seen.opened).toEqual([])
    expect((await modelReads($, seen, 'toolu_6', bash.text))?.content).toBe(bash.text)
  },
)

test('a result bundle the command names is read and left in place', async ($, on) => {
  const seen = world(on, { bash: failed(FAILED_BUILD_LOG), bundle: null })
  const command = 'xcodebuild -scheme Demo build -resultBundlePath /tmp/mine.xcresult'

  await $.tool.call({ tool: 'Bash', command, tool_use_id: 'toolu_7' })

  expect(seen.commands).toEqual([command])
  expect(seen.ran).not.toContain('/bin/rm -rf')
})

test('a build through Xcode\'s MCP server reaches the pane and is handed back unchanged', async ($, on) => {
  const seen = world(on, { bash: { text: '' }, bundle: null, mcp: MCP_FAILED_BUILD })

  const ran = await callTool($, { tool: 'mcp__xcode__BuildProject', workspaceIdentifier: 'workspace1', tool_use_id: 'toolu_m1' })

  expect(ran.result).toMatchObject({ structuredContent: JSON.parse(MCP_FAILED_BUILD) })
  expect(seen.statuses.at(-1)).toBe('✗ Xcode: 2 errors · 5 warnings')
  expect(seen.asked).toEqual(['xcode GetBuildLog {"severity":"warning","workspaceIdentifier":"workspace1"}'])
  expect(seen.commands).toEqual([])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /✗ BUILD FAILED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Xcode build (MCP)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No 'max' candidates/ })).toBeDefined()
    expect(await ui.find({ key: 'warnings' })).toMatchObject({ props: { label: 'Show 5 warnings' } })
    await ui.press({ key: 'warnings' })
    expect(await ui.find({ type: 'Text', text: /'suffix' was never mutated/ })).toBeDefined()
    await ui.press({ key: 'warnings' })
    await ui.unmount()
  }

  expect((await modelReads($, seen, 'toolu_m1', MCP_FAILED_BUILD))?.content).toBe(MCP_FAILED_BUILD)
})

test('tests run through Xcode\'s MCP server show the failed and the slowest tests', async ($, on) => {
  const seen = world(on, {
    bash: { text: '' },
    bundle: { 'test-results tests': TEST_DETAILS },
    mcp: MCP_FAILED_TESTS,
  })

  await callTool($, { tool: 'mcp__xcode__RunAllTests', tool_use_id: 'toolu_m2' })

  expect(seen.statuses.at(-1)).toBe('✗ Tideline: 0 errors · 0 warnings · 2 tests, 1 failed')
  expect(seen.ran).not.toContain('/bin/rm -rf')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✗ TEST FAILED/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /testLabelUsesUnitSymbol\(\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Slowest tests' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0\.37s {2}TideChartModelTests\/testLabelUsesUnitSymbol/ })).toBeDefined()
  await ui.unmount()
})

test('the details tool lists the warnings a summary only counted', async ($, on) => {
  world(on, { bash: failed(FAILED_BUILD_LOG), bundle: { 'build-results': FAILED_BUILD_RESULTS } })

  const before = await callTool($, { tool: 'mcp__xcpane__details', tool_use_id: 'toolu_d0' })
  expect(before.result).toBe('No build has finished in this session yet.')

  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme Demo build', tool_use_id: 'toolu_d1' })
  const after = await callTool($, { tool: 'mcp__xcpane__details', show: 'warnings', tool_use_id: 'toolu_d2' })

  expect(after.result).toContain("Maths.swift:4:26: warning: 'hello()' is deprecated: use greet(_:)")
  expect(after.result).not.toContain(': error: ')
})
