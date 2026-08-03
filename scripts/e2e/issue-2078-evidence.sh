#!/usr/bin/env bash
#
# Terminal evidence for issue #2078 — "in-flight ctx.tool calls cannot be quit,
# and quit records a resumable pause while the callback is still running".
#
# Usage: bash scripts/e2e/issue-2078-evidence.sh <tmux-session-name> <artifact-dir>
#
# The session already exists and is captured by the caller afterwards, so this
# script never creates, renames, kills, or detaches it. It types into the pane
# and waits for text the CLI renders; it never prints the evidence itself.
#
# Scenario, driven through the real interactive CLI:
#
#   /workflow issue-2078-tool-quit   a tool-only run; hang-tool parks on the
#                                    AbortSignal ctx.tool now passes it
#   /workflow status <run>           TOOLS shows hang-tool running
#   /workflow quit <run>             before the fix this answered "No
#                                    controllable stages on run …; the run
#                                    remains active." and the callback kept
#                                    running
#   /workflow status <run>           hang-tool is cancelled, not failed, and
#                                    the run is paused with reason quit
#   /workflow resume <run>           the aborted call runs again at the same
#                                    node while the settled sibling replays
#   /workflow status <run>           the artifact proves both halves
#
# The final screen carries the markers; every intermediate screen is saved
# under <artifact-dir> so the whole scenario stays reviewable. The scratch
# project stays on disk under $TMPDIR because the CLI is still running in the
# pane when the caller captures it.
#
# The caller captures the pane with `capture-pane -p -J -S -`, so it reads the
# whole scrollback and `-J` pads every captured line out to the pane width. That
# text reaches the caller as one command's output and is clipped to a fixed
# budget, tail first — and the tail is the final screen, the one carrying the
# markers. This scenario scrolls well past that budget, so scrollback is dropped
# behind each step (see `save`) and the harness-shaped capture is asserted at the
# end. Nothing reviewable is lost: each screen is kept as its own artifact.

set -euo pipefail

SESSION="${1:?usage: issue-2078-evidence.sh <tmux-session-name> <artifact-dir>}"
ARTIFACTS="${2:?usage: issue-2078-evidence.sh <tmux-session-name> <artifact-dir>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/test/integration/fixtures/issue-2078-tool-quit-workflow.ts"
WORKFLOW_NAME="issue-2078-tool-quit"
# Bun is a declared engine of this repository and runs the CLI from source.
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "issue-2078 evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/issue-2078-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
STATE="$WORKDIR/state"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/workflows" "$STATE" "$AGENT"
cp "$FIXTURE" "$PROJECT/.atomic/workflows/"

step=0

# Every line `-J` returns is padded to the pane width, so the caller's character
# budget is spent by how much has scrolled rather than by how much was written.
# The value is the caller's, restated here as the ceiling this scenario must stay
# under; it is compared against bytes below, which can only over-count characters
# and so can only fail early rather than late.
HARNESS_CAPTURE_BUDGET=16000

capture() { tmux capture-pane -p -t "$SESSION"; }

# The pane exactly as the caller will read it: scrollback included, wrapped lines
# joined, every line padded to the pane width.
capture_as_harness() { tmux capture-pane -p -J -S - -t "$SESSION"; }

# Keep this screen as an artifact, then drop the scrollback behind it, so the
# pane the caller captures is the screen the last step verified rather than the
# clipped head of everything the run ever scrolled.
save() {
	step=$((step + 1))
	capture >"$ARTIFACTS/$(printf '%02d' "$step")-$1.txt"
	tmux clear-history -t "$SESSION"
}

# Poll the pane for text the CLI rendered. Never a bare sleep: each step waits
# for the state it depends on, and a step that never arrives fails the run.
await() {
	local needle="$1" label="$2" timeout="${3:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if capture | grep -qF -- "$needle"; then return 0; fi
		sleep 1
	done
	echo "issue-2078 evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

# Wait on the fixture's own record instead of the pane when the fact is about
# the callback rather than about what was drawn.
await_state() {
	local pattern="$1" label="$2" timeout="${3:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if [[ -f "$STATE/issue-2078-state.json" ]] && grep -q "$pattern" "$STATE/issue-2078-state.json"; then return 0; fi
		sleep 1
	done
	echo "issue-2078 evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

# Type one slash command and submit it.
#
# The editor offers argument completions, and the first Enter accepts an open
# completion popup rather than submitting. Submission is therefore confirmed by
# the editor going quiet, with one extra Enter for the popup case; an Enter on
# an already-empty editor submits nothing.
type_command() {
	tmux send-keys -t "$SESSION" -l "$1"
	sleep 0.5
	tmux send-keys -t "$SESSION" Enter
	sleep 0.5
	if capture | grep -qF -- "❯ $1"; then
		tmux send-keys -t "$SESSION" Enter
		sleep 0.5
	fi
}

# 1. Start the real CLI in the pane, against a scratch project holding the
#    fixture workflow and an isolated agent directory.
tmux send-keys -t "$SESSION" -l \
	"cd '$PROJECT' && ISSUE_2078_STATE_DIR='$STATE' ATOMIC_CODING_AGENT_DIR='$AGENT' '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline --no-session"
tmux send-keys -t "$SESSION" Enter
await "Type a message or slash command" "the CLI to finish starting" 240
save "cli-started"

# 2. Launch the tool-only run and wait until its callback is really parked.
type_command "/workflow $WORKFLOW_NAME"
await "started in background" "the run to be dispatched" 120
await_state '"hangRunning":true' "hang-tool's callback to park on its signal" 120
RUN_ID="$(capture | grep -oE '/workflow connect [0-9a-f]{8}' | tail -1 | awk '{print $3}')"
if [[ -z "$RUN_ID" ]]; then
	echo "issue-2078 evidence: the CLI rendered no dispatched run id" >&2
	capture >"$ARTIFACTS/failure-no-run-id.txt"
	exit 1
fi
save "run-dispatched"

# 3. Show the run: tool-only, so no stage could ever have been the quit target.
type_command "/workflow status $RUN_ID"
await "hang-tool" "the running tool node" 60
save "tool-running"

# 4. Quit. Before the fix this reported no controllable stages and left the
#    callback running; the pane text below only appears when it does not.
type_command "/workflow quit $RUN_ID"
await "quit and can be resumed with /workflow resume." "quit to pause the tool-only run" 60
await_state '"hangObservedAbort":true' "the callback to observe its abort signal" 60
save "quit-accepted"

# 5. The cancelled node, rendered distinctly from a failure.
type_command "/workflow status $RUN_ID"
await "atomic-workflows: ctx.tool hang-tool aborted by workflow quit" "the cancelled tool node" 60
save "tool-cancelled"

# 6. Resume: the aborted call runs again at the same node, the settled sibling
#    replays from its checkpoint. Resume opens the graph overlay, so return to
#    the main chat before asking for the run's artifacts.
type_command "/workflow resume $RUN_ID"
await_state '"hangExecutions":2' "the aborted callback to be re-executed" 120
await "ctrl+x return to main chat" "the resumed run's graph overlay" 60
save "resume-graph"
tmux send-keys -t "$SESSION" C-x
await 'Workflow "issue-2078-tool-quit" completed' "the main chat to come back" 60

# 7. The evidence screen. Both halves of the contract are one rendered artifact
#    row: the aborted call observed cancellation and ran again, and the settled
#    sibling executed exactly once across the quit and the resume.
type_command "/workflow status $RUN_ID"
await '"hang":"aborted-then-reran-2"' "the resumed run's artifact" 120
await '"sibling":"sibling-ran-1"' "the replayed sibling's artifact" 30
save "final-evidence"

# 8. Guard the handover. The awaits above polled the visible screen; the caller
#    reads scrollback too and clips what it reads. A screen that rendered
#    correctly can still be truncated out of the evidence, which is a silent
#    failure, so assert the harness-shaped capture here instead.
HARNESS_PANE="$ARTIFACTS/harness-shaped-capture.txt"
capture_as_harness >"$HARNESS_PANE"
for marker in '"hang":"aborted-then-reran-2"' '"sibling":"sibling-ran-1"'; do
	if ! grep -qF -- "$marker" "$HARNESS_PANE"; then
		echo "issue-2078 evidence: ${marker} is missing from the pane as the caller captures it" >&2
		exit 1
	fi
done
PANE_SIZE="$(wc -c <"$HARNESS_PANE" | tr -d '[:space:]')"
if ((PANE_SIZE > HARNESS_CAPTURE_BUDGET)); then
	echo "issue-2078 evidence: the captured pane is ${PANE_SIZE} bytes, over the ${HARNESS_CAPTURE_BUDGET} the caller keeps;" \
		"its tail — the evidence — would be clipped away" >&2
	exit 1
fi

echo "issue-2078 evidence: scenario complete; artifacts in $ARTIFACTS"
