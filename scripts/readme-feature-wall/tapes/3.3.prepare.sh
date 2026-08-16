#!/usr/bin/env bash
# 3.3 needs the shipped question.ts example in the workspace. The lesson copies
# it with a `find` across install roots; doing that on camera would print the
# operator's real install path, so it happens here instead, off screen.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/extensions"
src="$(find "$HOME/.bun" "$HOME/.cache/.bun" "$HOME/.local/share/bun" /usr/local/lib /opt/homebrew/lib \
	-path '*@bastani/atomic/examples/extensions/question.ts' -print -quit 2>/dev/null || true)"
if [ -z "$src" ]; then
	echo "3.3 prepare: could not locate the shipped question.ts example" >&2
	exit 1
fi
cp "$src" "$ws/.atomic/extensions/question.ts"
