#!/usr/bin/env bash
# Copy Atomic's shipped pirate extension into the clean lesson workspace.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/extensions"
src="$(find "$HOME/.bun" "$HOME/.cache/.bun" "$HOME/.local/share/bun" /usr/local/lib /opt/homebrew/lib \
	-path '*@bastani/atomic/examples/extensions/pirate.ts' -print -quit 2>/dev/null || true)"
if [ -z "$src" ]; then
	echo "A.3 prepare: could not locate the shipped pirate.ts example" >&2
	exit 1
fi
cp "$src" "$ws/.atomic/extensions/pirate.ts"
