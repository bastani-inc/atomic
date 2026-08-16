#!/usr/bin/env bash
# Record one feature-wall row with VHS driving a real Atomic session.
#
#   scripts/readme-feature-wall/capture.sh 1.1 [1.2 ...]
#   scripts/readme-feature-wall/capture.sh --all
#
# Each row's tape in tapes/<id>.tape holds only the visible beats. This
# script prepends the shared privacy preamble so every clip is recorded the
# same way:
#
#   * a throwaway HOME with only the provider credential, model catalog, and
#     settings - no unrelated sessions, no personal skills or prompts
#   * a bare "$ " prompt, so the shell line carries no user or host name
#   * a clean crash-course clone per row, cloned from the read-only seed
#
# Output is an intermediate 1080p mp4 under $FW_BUILD/raw. render.sh turns it
# into the shipped GIF and poster.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/workspace.sh
. "$HERE/lib/workspace.sh"

mkdir -p "$FW_BUILD/raw" "$FW_BUILD/tapes"

capture_one() {
	local id="$1"
	local body="$HERE/tapes/$id.tape"
	if [ ! -f "$body" ]; then
		echo "no tape for row $id: $body" >&2
		return 1
	fi

	local lesson_home
	lesson_home="$(fw_prepare "$id")"

	# Optional per-row setup that must not appear on screen: copying a shipped
	# example into the workspace, seeding a file the row only uses as a starting
	# point, and so on. It runs before recording, with the workspace as $1 and
	# the capture HOME as $2.
	local prep="$HERE/tapes/$id.prepare.sh"
	if [ -f "$prep" ]; then
		bash "$prep" "$lesson_home/crash-course" "$lesson_home"
	fi

	local full="$FW_BUILD/tapes/$id.full.tape"
	{
		printf 'Source "%s"\n' "$HERE/lib/theme.tape"
		printf 'Output "%s/raw/%s.mp4"\n\n' "$FW_BUILD" "$id"
		# Privacy preamble. Hidden, so none of it appears in the capture.
		printf 'Hide\n'
		printf 'Type "export HOME=%s"\n' "$lesson_home"
		printf 'Enter\n'
		printf 'Type "export PS1=%s PROMPT_COMMAND= HISTFILE=/dev/null"\n' "'$ '"
		printf 'Enter\n'
		printf 'Type "cd $HOME/crash-course && clear"\n'
		printf 'Enter\n'
		printf 'Sleep 2s\n'
		printf 'Show\n\n'
		cat "$body"
	} >"$full"

	echo "==> capturing row $id"
	vhs "$full"
	ls -la "$FW_BUILD/raw/$id.mp4"
}

if [ "${1:-}" = "--all" ]; then
	set -- $(ls "$HERE/tapes" | grep -v '\.prepare\.sh$' | sed 's/\.tape$//' | sort -V)
fi

for id in "$@"; do
	capture_one "$id"
done
