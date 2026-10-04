#!/bin/sh
# Measures what Claude Code hands the model from a failing xcodebuild, with no
# mod loaded: how many characters, and how many compiler errors survive in them.
#
# usage: Benchmarks/run.sh [runs]     (default 5)
#
# Each run starts a headless Claude Code session on Haiku and costs a few cents.
set -eu

runs="${1:-5}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)/Tideline"
cp -R "$here/Tideline" "$work"
cd "$work"

echo "run  characters  located-errors  cut-from-middle"
i=1
while [ "$i" -le "$runs" ]; do
  claude -p "Run exactly this one Bash command and nothing else: xcodebuild -scheme Tideline -destination 'platform=macOS' build   Then reply with the single word done." \
    --allowedTools "Bash(xcodebuild:*)" --model claude-haiku-4-5-20251001 \
    --output-format stream-json --verbose < /dev/null 2> /dev/null |
    python3 -c '
import json, re, sys
for line in sys.stdin:
    try:
        row = json.loads(line)
    except ValueError:
        continue
    content = row.get("message", {}).get("content")
    for block in content if isinstance(content, list) else []:
        if block.get("type") != "tool_result":
            continue
        text = block.get("content")
        if not isinstance(text, str):
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        located = re.findall(r"^/\S+\.swift:\d+:\d+: error: ", text, re.M)
        cut = re.findall(r"\[(\d+) characters truncated\]", text)
        print("%3s  %10d  %14d  %s" % (sys.argv[1], len(text), len(located), cut[0] if cut else "nothing"))
' "$i"
  i=$((i + 1))
done
