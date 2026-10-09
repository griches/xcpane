export type Invocation = {
  tool: 'xcodebuild' | 'swift'
  action: string
  hasTests: boolean
  scheme: string | null
  isInfoOnly: boolean
  hasResultBundleFlag: boolean
  resultBundlePath: string | null
  insertAt: number
}

type Word = {
  text: string
  start: number
  end: number
  isRedirect: boolean
  isDynamic: boolean
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPERS = new Set([
  'time',
  'command',
  'exec',
  'env',
  'nohup',
  'xcrun',
  'arch',
  'caffeinate',
  '{',
  '!',
  'if',
  'then',
  'else',
  'do',
  'while',
])
const VALUED_WRAPPER_FLAGS = new Set(['-sdk', '--sdk', '-toolchain', '--toolchain'])
const ACTIONS = new Set([
  'build',
  'build-for-testing',
  'analyze',
  'archive',
  'test',
  'test-without-building',
  'docbuild',
  'install',
  'installsrc',
  'clean',
])
const TEST_ACTIONS = new Set(['test', 'test-without-building'])
const BOOLEAN_FLAGS = new Set([
  '-quiet',
  '-verbose',
  '-json',
  '-alltargets',
  '-allowProvisioningUpdates',
  '-allowProvisioningDeviceRegistration',
  '-hideShellScriptEnvironment',
  '-showBuildTimingSummary',
  '-skipPackagePluginValidation',
  '-skipMacroValidation',
  '-skipPackageUpdates',
  '-skipUnavailableActions',
  '-disableAutomaticPackageResolution',
  '-onlyUsePackageVersionsFromResolvedFile',
  '-retry-tests-on-failure',
  '-run-tests-until-failure',
])
const INFO_FLAGS = new Set([
  '-version',
  '-usage',
  '-help',
  '-license',
  '-list',
  '-showsdks',
  '-showdestinations',
  '-showBuildSettings',
  '-showTestPlans',
  '-showComponent',
  '-checkFirstLaunchStatus',
  '-runFirstLaunch',
  '-downloadPlatform',
  '-downloadAllPlatforms',
  '-downloadComponent',
  '-importPlatform',
  '-exportArchive',
  '-exportLocalizations',
  '-importLocalizations',
  '-exportNotarizedApp',
  '-resolvePackageDependencies',
  '-create-xcframework',
  '-find-executable',
  '-find-library',
  '-enumerate-tests',
  '-dry-run',
  '-n',
])

const split = (command: string): Word[][] => {
  const segments: Word[][] = []
  let words: Word[] = []
  let word: Word | null = null
  const open = (at: number): Word => {
    word ??= { text: '', start: at, end: at, isRedirect: false, isDynamic: false }

    return word
  }
  const push = (at: number) => {
    if (word !== null) {
      word.end = at
      words.push(word)
      word = null
    }
  }
  const cut = (at: number) => {
    push(at)

    if (words.length > 0) {
      segments.push(words)
    }

    words = []
  }
  const size = command.length
  let i = 0

  while (i < size) {
    const c = command.charAt(i)
    const following = command.charAt(i + 1)

    if (c === '\\') {
      if (following !== '\n') {
        open(i).text += following
      }

      i += 2
    } else if (c === "'") {
      const close = command.indexOf("'", i + 1)
      const stop = close < 0 ? size : close
      open(i).text += command.slice(i + 1, stop)
      i = stop + 1
    } else if (c === '"') {
      const quoted = open(i)
      i += 1

      while (i < size && command.charAt(i) !== '"') {
        const inner = command.charAt(i)
        const escaped = command.charAt(i + 1)

        if (inner === '\\' && '\\"$`\n'.includes(escaped) && escaped !== '') {
          quoted.text += escaped === '\n' ? '' : escaped
          i += 2
        } else {
          quoted.isDynamic ||= inner === '$' || inner === '`'
          quoted.text += inner
          i += 1
        }
      }

      i += 1
    } else if (c === '$' && following === '(') {
      const substituted = open(i)
      let depth = 0
      let stop = i + 1

      for (; stop < size; stop += 1) {
        const inner = command.charAt(stop)
        depth += inner === '(' ? 1 : inner === ')' ? -1 : 0

        if (depth === 0) {
          break
        }
      }

      substituted.isDynamic = true
      substituted.text += command.slice(i, stop + 1)
      i = stop + 1
    } else if (c === '`') {
      const close = command.indexOf('`', i + 1)
      const stop = close < 0 ? size : close
      const substituted = open(i)
      substituted.isDynamic = true
      substituted.text += command.slice(i, stop + 1)
      i = stop + 1
    } else if (c === '#' && word === null) {
      const newline = command.indexOf('\n', i)
      i = newline < 0 ? size : newline
    } else if (c === ' ' || c === '\t') {
      push(i)
      i += 1
    } else if (c === '>' || c === '<') {
      const redirect = open(i)
      redirect.isRedirect = true
      redirect.text += c
      i += 1
    } else if (c === '&' && ('<>'.includes(command.charAt(i - 1) || ' ') || following === '>')) {
      const redirect = open(i)
      redirect.isRedirect = true
      redirect.text += c
      i += 1
    } else if (';\n|&()'.includes(c)) {
      cut(i)
      i += 1
    } else {
      const plain = open(i)
      plain.isDynamic ||= c === '$'
      plain.text += c
      i += 1
    }
  }

  cut(size)

  return segments
}

const xcodebuild = (args: Word[], insertAt: number): Invocation => {
  const actions: string[] = []
  let scheme: string | null = null
  let target: string | null = null
  let isInfoOnly = false
  let hasResultBundleFlag = false
  let resultBundlePath: string | null = null

  for (let k = 0; k < args.length; k += 1) {
    const text = args[k]?.text ?? ''
    const value = args[k + 1]

    if (!text.startsWith('-')) {
      if (!text.includes('=') && ACTIONS.has(text)) {
        actions.push(text)
      }
    } else if (INFO_FLAGS.has(text)) {
      isInfoOnly = true
    } else if (!BOOLEAN_FLAGS.has(text)) {
      hasResultBundleFlag ||= text === '-resultBundlePath'

      if (value !== undefined && !value.text.startsWith('-')) {
        scheme = text === '-scheme' ? value.text : scheme
        target = text === '-target' ? value.text : target

        if (text === '-resultBundlePath' && !value.isDynamic && value.text.startsWith('/')) {
          resultBundlePath = value.text
        }

        k += 1
      }
    }
  }

  return {
    tool: 'xcodebuild',
    action: actions.length > 0 ? actions.join(' ') : 'build',
    hasTests: actions.some(action => TEST_ACTIONS.has(action)),
    scheme: scheme ?? target,
    isInfoOnly,
    hasResultBundleFlag,
    resultBundlePath,
    insertAt,
  }
}

const analyse = (words: Word[]): Invocation | null => {
  let i = 0

  while (i < words.length) {
    const text = words[i]?.text ?? ''

    if (ASSIGNMENT.test(text)) {
      i += 1
    } else if (WRAPPERS.has(text)) {
      i += 1

      while (words[i]?.text.startsWith('-') === true) {
        i += VALUED_WRAPPER_FLAGS.has(words[i]?.text ?? '') ? 2 : 1
      }
    } else {
      break
    }
  }

  const head = words[i]

  if (head === undefined || head.isRedirect || head.isDynamic) {
    return null
  }

  const rest = words.slice(i + 1)
  const redirect = rest.findIndex(one => one.isRedirect)
  const args = redirect < 0 ? rest : rest.slice(0, redirect)
  const insertAt = (args.at(-1) ?? head).end
  const name = head.text.slice(head.text.lastIndexOf('/') + 1)
  const verb = args[0]?.text

  if (name === 'xcodebuild') {
    return xcodebuild(args, insertAt)
  }

  if (name === 'swift' && (verb === 'build' || verb === 'test')) {
    return {
      tool: 'swift',
      action: verb,
      hasTests: verb === 'test',
      scheme: null,
      isInfoOnly: args.some(one => one.text === '--help' || one.text === '-h'),
      hasResultBundleFlag: false,
      resultBundlePath: null,
      insertAt,
    }
  }

  return null
}

/**
 * The xcodebuild and `swift build|test` invocations a Bash command runs, in order.
 *
 * Only a command standing at a command position counts: one inside a quoted
 * string, a `$(...)` or a here-document is text, not a build this mod can read.
 */
export const findInvocations = (command: string): Invocation[] =>
  command.includes('<<')
    ? []
    : split(command)
        .map(analyse)
        .filter(one => one !== null)

export const withResultBundle = (command: string, invocation: Invocation, path: string): string => {
  const quoted = `'${path.replaceAll("'", "'\\''")}'`

  return `${command.slice(0, invocation.insertAt)} -resultBundlePath ${quoted}${command.slice(invocation.insertAt)}`
}

/** Commands that print nothing of their own, or only pass on what the build printed. */
const PASSIVE = new Set([
  'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'source', '.', 'true', ':', 'mkdir', 'touch', 'rm', 'sleep', 'wait',
  'tail', 'head', 'grep', 'egrep', 'rg', 'tee', 'sort', 'uniq', 'cut', 'awk', 'wc', 'tr', 'less', 'more', 'column',
  'xcbeautify', 'xcpretty', 'xcsift',
])

/** The name of the command a segment runs, the assignments and wrappers before it passed over. */
const headOf = (words: Word[]): { name: string; args: Word[] } | null => {
  let i = 0

  while (i < words.length) {
    const text = words[i]?.text ?? ''

    if (ASSIGNMENT.test(text)) {
      i += 1
    } else if (WRAPPERS.has(text)) {
      i += 1

      while (words[i]?.text.startsWith('-') === true) {
        i += VALUED_WRAPPER_FLAGS.has(words[i]?.text ?? '') ? 2 : 1
      }
    } else {
      break
    }
  }

  const head = words[i]

  return head === undefined || head.isRedirect ? null : { name: head.text.slice(head.text.lastIndexOf('/') + 1), args: words.slice(i + 1).filter(one => !one.isRedirect) }
}

/**
 * The other commands of a line whose own output Claude may be after:
 * `xcodebuild build && cat config.json` prints a file as well as a build, so
 * that line's output is not replaced by a summary.
 */
export const mixedWith = (command: string): string[] =>
  split(command)
    .filter(words => analyse(words) === null)
    .map(headOf)
    .filter(one => one !== null)
    .filter(one => !PASSIVE.has(one.name) && !((one.name === 'cat' && one.args.every(arg => arg.text.startsWith('-'))) || one.name === 'sed'))
    .map(one => one.name)
