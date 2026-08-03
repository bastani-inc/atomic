#!/usr/bin/env bash
#
# Terminal evidence for issue #2074 — "typed steering is not consumed at the
# next tool-call slot, and queued-message UI is lost on detaching from a stage".
#
# Usage: bash scripts/e2e/issue-2074-evidence.sh <tmux-session-name> <artifact-dir>
#
# The session already exists and is captured by the caller afterwards, so this
# script never creates, renames, kills, or detaches it. It types into the pane
# and waits for text the CLI renders; it never prints the evidence itself.
#
# Scenario, driven through the real interactive CLI:
#
#   /workflow issue-2074-stage-steering   one stage, whose model endpoint opens
#                                         the turn and never closes it, so the
#                                         stage is streaming throughout
#   F2                                    the workflow graph overlay; the node
#                                         carries its ordinary metadata row
#   ↵                                     attach to the streaming stage
#   "steer-2074-alpha" ↵                  queued as steering
#   "followup-2074-beta" ctrl+f           queued as a follow-up
#   ctrl+x                                detach. Before the fix the node went
#                                         back to showing "root" and the queue
#                                         became invisible; it now badges
#                                         "✉ 2 queued"
#   ↵                                     reattach. Before the fix the chat came
#                                         back with no pending rows at all,
#                                         because the queue's only display lived
#                                         in the pane detaching destroys
#
# The scrollback is dropped immediately before the detach, so every row the
# caller captures was drawn after the user left the node. Both pending rows on
# that final screen are therefore rehydrated from the live session rather than
# left over from the attached view — which is exactly the fix. The intermediate
# screens, the badged node included, are kept under <artifact-dir>.
#
# The scratch project, the CLI, and the stand-in model endpoint all stay alive
# when this returns: the CLI is still running in the pane the caller is about to
# capture, and ending the model turn early would drain the queue and erase the
# evidence. The endpoint stops itself on its own TTL.

set -euo pipefail

SESSION="${1:?usage: issue-2074-evidence.sh <tmux-session-name> <artifact-dir>}"
ARTIFACTS="${2:?usage: issue-2074-evidence.sh <tmux-session-name> <artifact-dir>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$REPO_ROOT/test/integration/fixtures"
WORKFLOW_FIXTURE="issue-2074-stage-steering-workflow.ts"
WORKFLOW_NAME="issue-2074-stage-steering"
STAGE_NAME="steerable"
STAGE_TEXT="issue-2074 stage is mid-turn"
STEER_ROW="Steering: steer-2074-alpha"
FOLLOW_UP_ROW="Follow-up: followup-2074-beta"
QUEUED_BADGE="✉ 2 queued"

# Bun is a declared engine of this repository and runs the CLI from source.
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "issue-2074 evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/issue-2074-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
STATE="$WORKDIR/state"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/workflows" "$STATE" "$AGENT"
cp "$FIXTURES/$WORKFLOW_FIXTURE" "$PROJECT/.atomic/workflows/"

step=0

# Every line `-J` returns is padded to the pane width, so the caller's character
# budget is spent by how much has scrolled rather than by how much was written.
# The value is the caller's, restated here as the ceiling this scenario must
# stay under.
HARNESS_CAPTURE_BUDGET=16000

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
		sleep 1
	done
	echo "issue-2074 evidence: timed out after ${timeout}s waiting for ${label}" >&2
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

# 1. Start the stand-in model endpoint. It opens the stage's turn and holds it,
#    which is what keeps a typed message queued instead of delivered. The port
#    file is its readiness signal, so nothing here guesses or sleeps for it.
"$BUN" "$FIXTURES/issue-2074-model-server.ts" "$STATE" >"$ARTIFACTS/model-server.log" 2>&1 &
MODEL_PORT=""
for _ in $(seq 1 120); do
	if [[ -s "$STATE/model-port" ]]; then
		MODEL_PORT="$(cat "$STATE/model-port")"
		break
	fi
	sleep 0.5
done
if [[ -z "$MODEL_PORT" ]]; then
	echo "issue-2074 evidence: the stand-in model endpoint never published a port" >&2
	exit 1
fi

cat >"$AGENT/models.json" <<JSON
{
  "providers": {
    "issue2074": {
      "baseUrl": "http://127.0.0.1:$MODEL_PORT/v1",
      "apiKey": "issue-2074-test-key",
      "api": "openai-responses",
      "models": [
        {
          "id": "issue-2074-model",
          "name": "issue-2074-model",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 16000,
          "maxTokens": 1024
        }
      ]
    }
  }
}
JSON
cat >"$AGENT/settings.json" <<'JSON'
{
  "defaultProvider": "issue2074",
  "defaultModel": "issue-2074-model",
  "lastChangelogVersion": "0.0.0",
  "firstRunOnboardingStartedVersion": "0.0.0",
  "onboardedVersion": "0.0.0"
}
JSON

# 2. Start the real CLI in the pane, against a scratch project holding the
#    fixture workflow and an isolated agent directory.
#
#    NODE_ENV is pinned away from "test": the workflows extension gives stages a
#    stub session under a test runner, and a stub never streams, so a leaked
#    NODE_ENV=test would replace the whole thing under test.
tmux send-keys -t "$SESSION" -l \
	"cd '$PROJECT' && NODE_ENV=production ATOMIC_CODING_AGENT_DIR='$AGENT' ATOMIC_SKIP_VERSION_CHECK=1 '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline --no-session"
tmux send-keys -t "$SESSION" Enter
# The model line proves both that the CLI reached its input loop and that the
# stand-in endpoint is the configured default.
await "issue-2074-model •" "the CLI to finish starting on the stand-in model" 240
save "cli-started"

# 3. Launch the run. A named workflow launch dispatches to the background.
type_command "/workflow $WORKFLOW_NAME"
await "started in background" "the run to be dispatched" 120
save "run-dispatched"

# 4. Open the graph overlay on the active run and record the node before
#    anything is queued on it — the control for the badge below.
tmux send-keys -t "$SESSION" F2
await "open stage chat" "the workflow graph overlay" 60
await "$STAGE_NAME" "the stage node" 60
save "graph-before-queue"
if capture | grep -qF -- "queued"; then
	echo "issue-2074 evidence: the node claimed queued messages before any were queued" >&2
	exit 1
fi

# 5. Attach, and wait until the stage is really mid-turn. Everything below
#    depends on that: an idle session would deliver these messages instead of
#    queueing them, and there would be no queue to lose.
tmux send-keys -t "$SESSION" Enter
await "$STAGE_TEXT" "the stage chat to open on a streaming turn" 120
await "ctrl+x return to graph" "the stage chat footer" 30
save "stage-attached"

# 6. Queue one message into each queue: Enter steers, ctrl+f follows up.
tmux send-keys -t "$SESSION" -l "steer-2074-alpha"
sleep 0.5
tmux send-keys -t "$SESSION" Enter
await "$STEER_ROW" "the typed message to be queued as steering" 60
tmux send-keys -t "$SESSION" -l "followup-2074-beta"
sleep 0.5
tmux send-keys -t "$SESSION" C-f
await "$FOLLOW_UP_ROW" "the ctrl+f message to be queued as follow-up" 60
save "queued-while-attached"

# 7. Drop the scrollback. From here the pane the caller captures can only hold
#    screens drawn after the user left the node, which is what makes the rows on
#    the final screen evidence of rehydration rather than of what was typed.
tmux clear-history -t "$SESSION"

# 8. Leave the node. The queue is still live on the session, so the node the
#    user is now looking at has to say so. Before the fix this row went back to
#    the stage's dim "root" metadata and the queue became invisible.
tmux send-keys -t "$SESSION" C-x
await "$QUEUED_BADGE" "the detached stage node to badge its queued messages" 60
save "detached-node-badge"

# 9. Reattach. Before the fix the remounted chat had no pending rows: the queue
#    lives on the session, but its display lived in the destroyed pane.
tmux send-keys -t "$SESSION" Enter
await "$STEER_ROW" "the reattached chat to rehydrate the pending steering row" 60
await "$FOLLOW_UP_ROW" "the reattached chat to rehydrate the pending follow-up row" 60
save "reattached-rehydrated"

# 10. Guard the handover. The awaits above polled the visible screen; the caller
#     reads scrollback too and clips what it reads. A screen that rendered
#     correctly can still be truncated out of the evidence, which is a silent
#     failure, so assert the harness-shaped capture here instead.
HARNESS_PANE="$ARTIFACTS/harness-shaped-capture.txt"
capture_as_harness >"$HARNESS_PANE"
for marker in "$STEER_ROW" "$FOLLOW_UP_ROW"; do
	if ! grep -qF -- "$marker" "$HARNESS_PANE"; then
		echo "issue-2074 evidence: ${marker} is missing from the pane as the caller captures it" >&2
		exit 1
	fi
done
PANE_SIZE="$(wc -c <"$HARNESS_PANE" | tr -d '[:space:]')"
if ((PANE_SIZE > HARNESS_CAPTURE_BUDGET)); then
	echo "issue-2074 evidence: the captured pane is ${PANE_SIZE} bytes, over the ${HARNESS_CAPTURE_BUDGET} the caller keeps;" \
		"its tail — the evidence — would be clipped away" >&2
	exit 1
fi

echo "issue-2074 evidence: scenario complete; artifacts in $ARTIFACTS"
