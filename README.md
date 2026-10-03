# xcode-build

A [Claude Code](https://code.claude.com) mod that turns `xcodebuild` and `swift build` output into a live pane of errors grouped by file, and hands Claude the diagnostics instead of the raw log.

![The xcode-build pane showing a failed build](docs/xcode-build.gif)

## Why

When a Bash command fails with long output, Claude Code gives the model the start and the end and cuts out the middle. A failing `xcodebuild` puts the compiler errors in the middle, between hundreds of lines of `SwiftCompile` and `Copy` steps. Claude learns that the build failed and which files failed, but not why.

Measured on Xcode 27.1 with a five-file Swift package and three compile errors:

| | Without the mod | With the mod |
| --- | --- | --- |
| Raw log | 295 lines, 47 KB | the same |
| What Claude reads | 10,039 characters, none of them an error message | 499 characters, every reported error with its file, line and column |

## What it does

![Claude Code with the pane docked on the right](docs/pane.png)

- **Reads Xcode's result bundle.** Adds `-resultBundlePath` to `xcodebuild` commands that name none, then reads errors, warnings and test failures from the bundle with `xcresulttool`. The bundle goes to the temporary folder and is deleted once read.
- **Condenses what Claude reads.** The tool result becomes the verdict, every error as `file:line:column: error: message`, the failed tests, and a count of warnings per file. The transcript keeps the raw output.
- **Shows a pane.** Errors grouped by file, failed tests, a toggle for warnings, a running timer while a build is in flight, and the last few builds.
- **Sets the status line** on a failure and shows a toast on a success.
- **Draws a compact transcript row.** The verdict and the first three errors, in place of the raw log. This applies to a build drawn as its own row; in the fullscreen layout Claude Code folds shell commands into one line ("Ran 1 shell command"), and the row is not drawn there.

It also reads `swift build` and `swift test` from their log output, and a build piped through `tail`, `xcbeautify` or `xcpretty` is still read from the result bundle.

## Requirements

- macOS with Xcode and its command line tools (`xcodebuild`, `xcrun`).
- Claude Code with mod support. Built and tested on 2.1.288; check yours with `claude --version` and update with `claude update`.
- For the result bundle, an Xcode whose `xcresulttool` has `get build-results` (tested on Xcode 27.1). Without it the mod falls back to reading the log.

## Install

Clone the repository somewhere it can stay:

```sh
git clone https://github.com/griches/claude-xcode-mod.git ~/.claude/mods/claude-xcode-mod
```

### Try it for one session

```sh
cd /path/to/your/xcode/project
claude --plugin-dir ~/.claude/mods/claude-xcode-mod
```

### Load it in every session

Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. The path must be absolute; `~` is allowed.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/claude-xcode-mod"
  }
}
```

If the variable already names other folders, separate them with `:`. Restart Claude Code afterwards. This also covers sessions started from the desktop app.

### Check it loaded

In a session, type `/xcode-build`. The pane opens and says "No builds yet." Then ask Claude to build:

```
Build the MyApp scheme with xcodebuild and fix any errors.
```

## Use

Ask Claude to build or test as you normally would. Nothing else changes.

| What | How |
| --- | --- |
| Open the pane | `/xcode-build` |
| Forget the builds | `/xcode-build clear` |
| Show or hide warnings | Focus the pane (`ctrl+x` then `tab`), press `w` |
| Clear from the pane | Focus the pane, press `c` |
| Close the pane | `ctrl+x` then `x`, or click its `✕` |

The pane opens by itself when a build starts on terminals at least 144 columns wide. On narrower terminals it waits until you type `/xcode-build`, and then shows above the prompt.

## Options

Each option is a row in Claude Code's config menu (`/config`).

| Option | Default | Meaning |
| --- | --- | --- |
| `condense` | `true` | Replace the raw log Claude reads with the parsed diagnostics |
| `warnings` | `count` | `count`: Claude reads how many warnings each file has. `list`: every warning |
| `resultBundle` | `true` | Add `-resultBundlePath` to `xcodebuild` commands that name none |
| `autoOpen` | `always` | Open the pane `always` (when a build starts), on `failure`, or `never` |
| `compactRow` | `true` | Draw the verdict in the transcript instead of the raw log |

## Permissions

The mod changes the command Claude runs by appending one flag: `-resultBundlePath '<temporary folder>/claude-xcode-build/<id>.xcresult'`. An allow rule such as `Bash(xcodebuild:*)` still matches. A rule that names one exact command will no longer match and Claude Code will ask; set `resultBundle` to `false` to leave commands untouched.

## Update and uninstall

```sh
git -C ~/.claude/mods/claude-xcode-mod pull
```

To uninstall, remove the folder from `CLAUDE_CODE_PLUGIN_DIRS` and delete the clone.

## Troubleshooting

- **`/xcode-build` is not a command.** The mod did not load. Run `claude plugin validate ~/.claude/mods/claude-xcode-mod`, check the path in your settings, and check `claude --version`.
- **The pane does not open by itself.** Your terminal is narrower than 144 columns, or `autoOpen` is not `always`. Type `/xcode-build`.
- **A build is not picked up.** See Limits. `claude --debug` logs why a hook was skipped.
- **Claude still reads the raw log.** The mod only condenses when it found errors or failed tests, or the build succeeded. A failure with no diagnostics passes through unchanged.

## Limits

- Only builds Claude runs through the Bash tool are seen. Builds you start in Xcode are not.
- A build inside a script, `make`, `fastlane`, `bash -c` or `$(...)` is not recognised, and neither is one run in the background.
- A command with several `xcodebuild` invocations is read from its log only.
- When a failing build yields no diagnostics, Claude reads the raw log unchanged.
- `swift build` has no result bundle, so a long failing log that Claude Code cuts in the middle can still lose its errors.
- The mod API is early access and may change between Claude Code releases.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

`hooks/register.tsx` holds the hooks; `shell.ts` finds builds in a command, `xcresult.ts` and `log.ts` read results, and `format.ts` words them. The fixtures in `tests/fixtures.ts` are excerpts of real Xcode output.

## License

[MIT](LICENSE)
