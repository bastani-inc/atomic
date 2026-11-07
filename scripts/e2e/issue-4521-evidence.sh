#!/usr/bin/env bash
#
# Terminal evidence for issue #4521 — one scroll stack and one set of keys for the main chat, an attached
# workflow stage chat and a /tasks subagent transcript.
#
# Usage: bash scripts/e2e/issue-4521-evidence.sh <artifact-dir> [columns] [rows]
#
# Drives the real interactive CLI (the default isolated engine) in a private tmux server, against an offline
# model registered by test/integration/fixtures/issue-4521-transcript-provider.ts, and a one-stage workflow
# (issue-4521-transcript-workflow.ts). Each surface shows a thinking block, a tool call with sixty lines of
# output and a long reply. The settings pin `fullscreenScrollbar: "always"` and `fullscreenWheelScrollLines: 3`
# so the scrollbar and the wheel step are deterministic.
#
# Every check is recorded as PASS or FAIL in <artifact-dir>/checks.txt rather than stopping the run, so the
# same scenario documents a build before and after the change. Each step's screen is kept as NN-step.txt.
# The script exits non-zero when any check failed.

set -uo pipefail

ARTIFACTS="${1:?usage: issue-4521-evidence.sh <artifact-dir> [columns] [rows]}"
COLUMNS_="${2:-80}"
ROWS_="${3:-24}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$REPO_ROOT/test/integration/fixtures"
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
SOCKET="i4521-$$"
TMUX=(tmux -L "$SOCKET")
PING="E2E-PING-4521"

mkdir -p "$ARTIFACTS"
: >"$ARTIFACTS/checks.txt"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/issue-4521-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/workflows" "$AGENT/extensions"
cp "$FIXTURES/issue-4521-transcript-workflow.ts" "$PROJECT/.atomic/workflows/"
cp "$FIXTURES/issue-4521-transcript-provider.ts" "$AGENT/extensions/"
git -C "$PROJECT" init -q
cat >"$AGENT/settings.json" <<'JSON'
{
  "defaultProvider": "e2e4521",
  "defaultModel": "transcript-model",
  "lastChangelogVersion": "0.0.0",
  "firstRunOnboardingStartedVersion": "0.0.0",
  "onboardedVersion": "0.0.0",
  "fullscreenScrollbar": "always",
  "fullscreenWheelScrollLines": 3,
  "hideThinkingBlock": false
}
JSON

cleanup() {
	"${TMUX[@]}" kill-server >/dev/null 2>&1
	rm -rf "$WORKDIR"
}
trap cleanup EXIT

step=0
failures=0
capture() { "${TMUX[@]}" capture-pane -p -t e2e; }
save() {
	step=$((step + 1))
	capture >"$ARTIFACTS/$(printf '%02d' "$step")-$1.txt"
}
record() {
	local verdict="$1" name="$2"
	echo "$verdict $name" >>"$ARTIFACTS/checks.txt"
	[[ "$verdict" == PASS ]] || failures=$((failures + 1))
}
# check <name> <command...>: PASS when the command succeeds against the current screen.
check() {
	local name="$1"
	shift
	if "$@"; then record PASS "$name"; else record FAIL "$name"; fi
}
shows() { capture | grep -qF -- "$1"; }
hides() { ! capture | grep -qF -- "$1"; }
# The rightmost column of every transcript row is a scrollbar glyph.
scrollbar_rows() { capture | grep -cE '[│┃]$'; }
has_scrollbar() { (($(scrollbar_rows) >= 5)); }
# The first transcript-looking line on screen that matches a prefix, e.g. CHILD-LINE-042.
first_line() { capture | grep -oE "$1-[0-9]{3}" | head -1; }
number_of() { sed -E 's/.*-0*([0-9]+)$/\1/' <<<"${1:-x-0}"; }
await() {
	local needle="$1" timeout="${2:-60}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if shows "$needle"; then return 0; fi
		sleep 0.5
	done
	return 1
}
key() {
	"${TMUX[@]}" send-keys -t e2e "$@"
	sleep 0.8
}
raw() {
	"${TMUX[@]}" send-keys -t e2e -l "$1"
	sleep 0.8
}
type_line() {
	"${TMUX[@]}" send-keys -t e2e -l "$1"
	sleep 0.5
	"${TMUX[@]}" send-keys -t e2e Enter
	sleep 0.5
	if shows "❯ $1"; then
		"${TMUX[@]}" send-keys -t e2e Enter
		sleep 0.5
	fi
}
WHEEL_UP=$'\e[<64;10;10M'
WHEEL_DOWN=$'\e[<65;10;10M'
ALT_WHEEL_UP=$'\e[<72;10;10M'

# Scroll checks shared by the main chat and the stage chat. <prefix> names the long reply's numbered lines on that
# surface; distances are measured in those lines, from the middle of the reply.
scroll_checks() {
	local surface="$1" prefix="$2" last="$3" first="$4"
	check "$surface: opens following the latest output" shows "$last"
	check "$surface: scrollbar column" has_scrollbar
	key C-Home
	save "$surface-top"
	check "$surface: ctrl+home reaches the first message" shows "$first"
	check "$surface: jump-to-latest shown while scrolled up" shows "Jump to latest"
	for _ in $(seq 1 80); do
		(($(number_of "$(first_line "$prefix")") >= 40)) && break
		key PageDown
	done
	local before after
	before="$(number_of "$(first_line "$prefix")")"
	raw "$WHEEL_UP"
	after="$(number_of "$(first_line "$prefix")")"
	save "$surface-wheel-up"
	check "$surface: wheel scrolls" test "$after" -lt "$before"
	before="$after"
	raw "$ALT_WHEEL_UP"
	after="$(number_of "$(first_line "$prefix")")"
	save "$surface-alt-wheel-up"
	check "$surface: alt+wheel scrolls further than the wheel" test $((before - after)) -ge 4
	before="$after"
	key PageUp
	after="$(number_of "$(first_line "$prefix")")"
	save "$surface-page-up"
	check "$surface: PageUp moves a page" test $((before - after)) -ge 4
	key C-End
	check "$surface: ctrl+end returns to the latest output" shows "$last"
	check "$surface: jump-to-latest gone at the end" hides "Jump to latest"
}

"${TMUX[@]}" new-session -d -s e2e -x "$COLUMNS_" -y "$ROWS_" -c "$PROJECT"
"${TMUX[@]}" send-keys -t e2e -l \
	"cd '$PROJECT' && NODE_ENV=production ATOMIC_CODING_AGENT_DIR='$AGENT' ATOMIC_SKIP_VERSION_CHECK=1 '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline"
"${TMUX[@]}" send-keys -t e2e Enter
if ! await "transcript-model •" 240; then
	save "cli-did-not-start"
	record FAIL "cli started"
	exit 1
fi
save "cli-started"

# 1. Main chat.
type_line "main-long"
await "MAIN-LINE-150" 60
save "main-latest"
scroll_checks main MAIN-LINE "MAIN-LINE-150" "We question,"
key C-Up
key C-Up
save "main-prompt-jump"
check "main: ctrl+up jumps to the previous prompt" shows "main-long"
check "main: thinking shown" shows "MAIN-THINKING"
key C-t
save "main-ctrl-t"
check "main: ctrl+t hides thinking" hides "MAIN-THINKING"
key C-t
key C-o
key C-End
key C-Up
key C-Up
save "main-ctrl-o"
check "main: ctrl+o expands tool output" shows "MAIN-TOOL-001"
key C-o
key C-End

# 2. A workflow stage chat.
type_line "/workflow issue-4521-transcript-stage"
await "started in background" 120
key F2
await "viewer" 60
save "graph"
key Enter
await "STAGE-LINE-150" 90
sleep 4
save "stage-latest"
scroll_checks stage STAGE-LINE '$ true' "STAGE_TASK_4521"
key C-Home
check "stage: thinking shown" shows "STAGE-THINKING"
key C-t
save "stage-ctrl-t"
check "stage: ctrl+t hides thinking" hides "STAGE-THINKING"
key C-t
key C-o
save "stage-ctrl-o"
check "stage: ctrl+o expands tool output" shows "STAGE-TOOL-001"
key C-o
key C-End
key C-Up
save "stage-prompt-jump"
check "stage: ctrl+up jumps to the previous prompt" shows "STAGE_TASK_4521"
key C-End
key C-x
key C-x
await "transcript-model •" 30

# 3. A subagent's /tasks transcript.
type_line "launch-child"
await "MAIN-LAUNCHED" 60
await "CHILD-TOOL-060" 1
sleep 6
# Expand tool output in the chat first: the transcript opens with the chat's Ctrl+O setting.
key C-o
type_line "/tasks"
await "Background tasks" 30
key Enter
await "Inspect transcript" 30
key Enter
await "Transcript ·" 30
sleep 2
save "subtask-opened"
check "subtask: opens at the latest output" shows '$ true'
key C-Home
save "subtask-top"
check "subtask: ctrl+home reaches the task prompt" shows "CHILD_TASK_4521"
check "subtask: jump-to-latest shown while scrolled up" shows "Jump to latest"
check "subtask: thinking shown" shows "CHILD-THINKING"
key C-t
save "subtask-ctrl-t"
check "subtask: ctrl+t hides thinking" hides "CHILD-THINKING"
key C-t
before="$(number_of "$(first_line CHILD-LINE)")"
key PageDown
after="$(number_of "$(first_line CHILD-LINE)")"
save "subtask-page-down"
check "subtask: PageDown moves a page" test $((after - before)) -ge 4
before="$after"
raw "$WHEEL_DOWN"
after="$(number_of "$(first_line CHILD-LINE)")"
check "subtask: wheel scrolls" test "$after" -gt "$before"
before="$after"
raw "$ALT_WHEEL_UP"
after="$(number_of "$(first_line CHILD-LINE)")"
check "subtask: alt+wheel scrolls further than the wheel" test $((before - after)) -ge 4
check "subtask: scrollbar column" has_scrollbar
for _ in $(seq 1 60); do
	shows '$ seq -f "CHILD-TOOL' && break
	key PageDown
done
shows "CHILD-TOOL-001" || key PageDown
save "subtask-inherits-ctrl-o"
check "subtask: tool output follows the chat's ctrl+o" shows "CHILD-TOOL-001"
key C-o
save "subtask-ctrl-o-collapse"
check "subtask: ctrl+o collapses tool output" hides "CHILD-TOOL-001"
key C-o
save "subtask-ctrl-o"
check "subtask: ctrl+o expands tool output" shows "CHILD-TOOL-001"
key C-o
key C-End
save "subtask-latest"
check "subtask: ctrl+end returns to the latest output" hides "Jump to latest"
raw "$PING please acknowledge"
key Enter
if await "CHILD-ACK $PING" 90; then record PASS "subtask: message sent from the transcript is answered"; else record FAIL "subtask: message sent from the transcript is answered"; fi
save "subtask-message"
key Escape
key Escape
key Escape

# 4. Keys pressed on the task pages stay there: the chat behind them keeps its place.
key C-End
type_line "/tasks"
await "Background tasks" 30
key C-Home
key C-Up
key Enter
await "Inspect transcript" 30
key C-Home
key C-Up
key PageUp
key Escape
key Escape
save "main-after-task-pages"
check "main: task pages leave the chat at its latest output" hides "Jump to latest"

{
	echo "size ${COLUMNS_}x${ROWS_}"
	echo "commit $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
	echo "failures $failures"
} >>"$ARTIFACTS/checks.txt"
((failures == 0))
