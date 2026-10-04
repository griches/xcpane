# Benchmark: what Claude reads from a failing build

`Tideline` is a Swift package with five source files, three compile errors in two files, four warnings and one failing test. `run.sh` builds it through a headless Claude Code session with no mod loaded and reports what the model was handed.

```sh
Benchmarks/run.sh 5
```

Each run costs a few cents on your Claude account. To compare, load the mod with `--plugin-dir` and run the same build: the result becomes a few hundred characters with every reported error in it.

## Results

Measured on 3 and 4 October 2026 with Claude Code 2.1.288, Xcode 27.1 and xcpane 0.2.0.

| | Without the mod | With the mod |
| --- | --- | --- |
| Raw `xcodebuild` log | 295 lines, 47 KB | the same |
| Characters Claude read | 10,039 or 10,040 in every run | 570 |
| Runs with no error message in what Claude read | 8 of 10 | 0 |

In the other two runs some error text survived. Claude Code keeps the start and the end of a long failing output and cuts the middle; `xcodebuild` compiles files in parallel, so where the errors fall in the log changes from run to run.

## What this does not show

- It is one small project on one machine. A large app has not been measured.
- Claude fixed the project in three builds with and without the mod. Without it, Claude searched the source and re-ran the build through its own filter. The mod removes that detour; it did not reduce the number of builds.
