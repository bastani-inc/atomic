#!/usr/bin/env bash
#
# Terminal evidence for issue #1975 slice 2 — workflow heartbeat scheduling and
# queued parent delivery.
#
# Usage: bash scripts/e2e/workflow-heartbeat-evidence.sh <tmux-session-name> <artifact-dir>
#
# The session already exists and is captured by the caller afterwards, so this
# script never creates, renames, kills, or detaches it. It types into the pane
# and waits for text the CLI renders; it never prints the evidence itself.
#
# Scenario, driven through the real interactive CLI:
#
#   /workflow workflow-heartbeat-evidence   a tool-only run that parks, with
#                                           heartbeatIntervalMinutes: 1
#   (wait ~60s)                             the first WORKFLOW HEARTBEAT card
#                                           lands in the main chat on its own,
#                                           with nothing typed in between
#   (wait ~60s more)                        the second card lands one interval
#                                           later, proving recurrence rather
#                                           than a one-shot notice
#
# Nothing is typed between the launch and the cards: a heartbeat that only
# appeared after a keystroke would not be the scheduler's doing.

set -euo pipefail

SESSION="${1:?usage: workflow-heartbeat-evidence.sh <tmux-session-name> <artifact-dir>}"
ARTIFACTS="${2:?usage: workflow-heartbeat-evidence.sh <tmux-session-name> <artifact-dir>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/test/integration/fixtures/workflow-heartbeat-evidence-workflow.ts"
WORKFLOW_NAME="workflow-heartbeat-evidence"
# Bun is a declared engine of this repository and runs the CLI from source.
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "heartbeat evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/workflow-heartbeat-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/workflows" "$AGENT"
cp "$FIXTURE" "$PROJECT/.atomic/workflows/"

step=0

capture() { tmux capture-pane -p -t "$SESSION"; }

# The pane exactly as the caller will read it: scrollback included, wrapped
# lines joined, every line padded to the pane width.
capture_as_harness() { tmux capture-pane -p -J -S - -t "$SESSION"; }

save() {
	step=$((step + 1))
	capture >"$ARTIFACTS/$(printf '%02d' "$step")-$1.txt"
}

# Poll the pane for text the CLI rendered. Never a bare sleep: each step waits
# for the state it depends on, and a step that never arrives fails the run.
await() {
	local needle="$1" label="$2" timeout="${3:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if capture | grep -qF -- "$needle"; then return 0; fi
		sleep 2
	done
	echo "heartbeat evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

# Poll for the Nth occurrence of a needle across the whole scrollback.
await_count() {
	local needle="$1" wanted="$2" label="$3" timeout="${4:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if (($(capture_as_harness | grep -cF -- "$needle" || true) >= wanted)); then return 0; fi
		sleep 2
	done
	echo "heartbeat evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture_as_harness >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

# Type one slash command and submit it. The first Enter can be consumed by an
# open completion popup, so submission is confirmed by the editor going quiet.
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
	"cd '$PROJECT' && ATOMIC_CODING_AGENT_DIR='$AGENT' '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline --no-session"
tmux send-keys -t "$SESSION" Enter
await "Type a message or slash command" "the CLI to finish starting" 240
save "cli-started"

# 2. Launch the parked run. This is the last thing typed in this scenario.
type_command "/workflow $WORKFLOW_NAME"
await "started in background" "the run to be dispatched" 120
RUN_ID="$(capture | grep -oE '/workflow connect [0-9a-f]{8}' | tail -1 | awk '{print $3}')"
if [[ -z "$RUN_ID" ]]; then
	echo "heartbeat evidence: the CLI rendered no dispatched run id" >&2
	capture >"$ARTIFACTS/failure-no-run-id.txt"
	exit 1
fi
save "run-dispatched"

# 3. The first cadence boundary is 60s after the persisted start time. Nothing
#    is typed while this waits.
await "WORKFLOW HEARTBEAT" "the first heartbeat card in the main chat" 150
save "first-heartbeat"

# 4. One interval later, a second card. Recurrence, not a one-shot notice.
#
# The first heartbeat holds its slot until its card is consumed into the
# conversation, with no deadline behind it — so this step is the load-bearing
# check that the host's `message_end` consumption signal reaches the extension.
# A failure here means that signal did not arrive; it does not mean a turn
# failed to settle, which is a weaker event this cadence deliberately ignores.
await_count "WORKFLOW HEARTBEAT" 2 "the second heartbeat card one interval later" 200
save "second-heartbeat"

# 5. Guard the handover: assert the markers in the pane shape the caller reads.
HARNESS_PANE="$ARTIFACTS/harness-shaped-capture.txt"
capture_as_harness >"$HARNESS_PANE"
for marker in "WORKFLOW HEARTBEAT" "$WORKFLOW_NAME" "/workflow status $RUN_ID"; do
	if ! grep -qF -- "$marker" "$HARNESS_PANE"; then
		echo "heartbeat evidence: ${marker} is missing from the pane as the caller captures it" >&2
		exit 1
	fi
done

echo "heartbeat evidence: scenario complete; run $RUN_ID; artifacts in $ARTIFACTS"
