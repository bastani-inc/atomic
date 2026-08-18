#!/usr/bin/env bash
#
# Terminal evidence for the graph-viewer `ask_user_question` overlay bug —
# "atomic-workflows: ctx.ui.custom overlay mode is unavailable in the workflow
# graph viewer", raised whenever a workflow stage asked the user a question.
#
# Usage: bash scripts/e2e/ask-user-question-graph-overlay-evidence.sh \
#          <tmux-session-name> <artifact-dir>
#
# The session already exists and is captured by the caller afterwards, so this
# script never creates, renames, kills, or detaches it. It types into the pane
# and waits for text the CLI renders; it never prints the evidence itself.
#
# Scenario, driven through the real interactive CLI:
#
#   /workflow ask-user-question-graph-overlay   one stage, whose model endpoint
#                                               answers the first turn with a
#                                               real ask_user_question call
#   F2                                          the workflow graph overlay; the
#                                               asking stage is awaiting input
#   ↵                                           attach to the asking stage. The
#                                               questionnaire mounts with
#                                               `overlay: true`, which both
#                                               graph hosts used to reject —
#                                               the question never painted and
#                                               the stage failed
#
# The question is left unanswered: the stage is still blocked on it when this
# returns, which is exactly the state the caller captures. The CLI and the
# stand-in endpoint stay alive for that capture; the endpoint stops itself on
# its own TTL.

set -euo pipefail

SESSION="${1:?usage: ask-user-question-graph-overlay-evidence.sh <tmux-session-name> <artifact-dir>}"
ARTIFACTS="${2:?usage: ask-user-question-graph-overlay-evidence.sh <tmux-session-name> <artifact-dir>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$REPO_ROOT/test/integration/fixtures"
WORKFLOW_FIXTURE="ask-user-question-graph-overlay-workflow.ts"
WORKFLOW_NAME="ask-user-question-graph-overlay"
STAGE_NAME="asking"
QUESTION="GRAPH-OVERLAY-QUESTION"
OPTION_ALPHA="Alpha"
OPTION_BETA="Beta"
REJECTION="overlay mode is unavailable"

# Bun is a declared engine of this repository and runs the CLI from source.
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "graph-overlay evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/graph-overlay-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
STATE="$WORKDIR/state"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/workflows" "$STATE" "$AGENT"
cp "$FIXTURES/$WORKFLOW_FIXTURE" "$PROJECT/.atomic/workflows/"

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
		refuse_rejection "waiting for ${label}"
		sleep 1
	done
	echo "graph-overlay evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

# The bug's own message. It is fatal wherever it appears — visible pane or
# scrollback — because it means the questionnaire was refused rather than shown.
refuse_rejection() {
	local where="$1"
	if capture_as_harness | grep -qF -- "$REJECTION"; then
		echo "graph-overlay evidence: the CLI reported \"${REJECTION}\" while ${where}" >&2
		capture_as_harness >"$ARTIFACTS/failure-overlay-rejected.txt"
		return 1
	fi
	return 0
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

# 1. Start the stand-in model endpoint. Its first turn is a real
#    ask_user_question call, which is what forces the overlay mount. The port
#    file is its readiness signal, so nothing here guesses or sleeps for it.
"$BUN" "$FIXTURES/ask-user-question-graph-overlay-model-server.ts" "$STATE" >"$ARTIFACTS/model-server.log" 2>&1 &
MODEL_PORT=""
for _ in $(seq 1 120); do
	if [[ -s "$STATE/model-port" ]]; then
		MODEL_PORT="$(cat "$STATE/model-port")"
		break
	fi
	sleep 0.5
done
if [[ -z "$MODEL_PORT" ]]; then
	echo "graph-overlay evidence: the stand-in model endpoint never published a port" >&2
	exit 1
fi

cat >"$AGENT/models.json" <<JSON
{
  "providers": {
    "graphoverlay": {
      "baseUrl": "http://127.0.0.1:$MODEL_PORT/v1",
      "apiKey": "graph-overlay-test-key",
      "api": "openai-responses",
      "models": [
        {
          "id": "graph-overlay-model",
          "name": "graph-overlay-model",
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
  "defaultProvider": "graphoverlay",
  "defaultModel": "graph-overlay-model",
  "lastChangelogVersion": "0.0.0",
  "firstRunOnboardingStartedVersion": "0.0.0",
  "onboardedVersion": "0.0.0"
}
JSON

# 2. Start the real CLI in the pane, against a scratch project holding the
#    fixture workflow and an isolated agent directory.
#
#    NODE_ENV is pinned away from "test": the workflows extension gives stages a
#    stub session under a test runner, and a stub never calls a tool, so a
#    leaked NODE_ENV=test would replace the whole thing under test.
tmux send-keys -t "$SESSION" -l \
	"cd '$PROJECT' && NODE_ENV=production ATOMIC_CODING_AGENT_DIR='$AGENT' ATOMIC_SKIP_VERSION_CHECK=1 '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline --no-session"
tmux send-keys -t "$SESSION" Enter
# The model line proves both that the CLI reached its input loop and that the
# stand-in endpoint is the configured default.
await "graph-overlay-model •" "the CLI to finish starting on the stand-in model" 240
save "cli-started"

# 3. Launch the run and wait for its start notice.
type_command "/workflow $WORKFLOW_NAME"
await "\"$WORKFLOW_NAME\" started" "the run to be dispatched" 120
save "run-dispatched"

# 4. Open the graph overlay on the active run.
tmux send-keys -t "$SESSION" F2
await "open stage chat" "the workflow graph overlay" 60
await "$STAGE_NAME" "the asking stage node" 60
save "graph-open"

# 5. Attach to the asking stage. The stage is blocked inside ask_user_question,
#    whose custom UI mounts with `overlay: true`.
tmux send-keys -t "$SESSION" Enter
await "ctrl+x return to graph" "the stage chat footer" 120
save "stage-attached"

# 6. The questionnaire itself: the question text and both options have to be on
#    screen, and the refusal must be nowhere in the pane.
await "$QUESTION" "the questionnaire to paint in the attached stage chat" 120
await "$OPTION_ALPHA" "the first option row" 60
await "$OPTION_BETA" "the second option row" 60
refuse_rejection "reading the mounted questionnaire"
save "question-mounted"

# 7. Guard the handover. The awaits above polled the visible screen; the caller
#    reads scrollback too, so assert the harness-shaped capture here as well.
HARNESS_PANE="$ARTIFACTS/harness-shaped-capture.txt"
capture_as_harness >"$HARNESS_PANE"
if ! grep -qF -- "$QUESTION" "$HARNESS_PANE"; then
	echo "graph-overlay evidence: ${QUESTION} is missing from the pane as the caller captures it" >&2
	exit 1
fi
if grep -qF -- "$REJECTION" "$HARNESS_PANE"; then
	echo "graph-overlay evidence: \"${REJECTION}\" is present in the pane as the caller captures it" >&2
	exit 1
fi

echo "graph-overlay evidence: scenario complete; artifacts in $ARTIFACTS"
