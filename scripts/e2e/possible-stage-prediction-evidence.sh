#!/usr/bin/env bash
#
# Terminal evidence for #4359: a workflow Intercom send to a path outside the run's known stages queues with a plain
# result by default, `intercom.showUnknownTargetWarnings` brings the old note back, and `intercom list` shows the
# run's future targets, all through the real interactive CLI and a real project workflow.
#
# Usage: bash scripts/e2e/possible-stage-prediction-evidence.sh <tmux-session-name> <artifact-dir> [default|warnings|predicted]
#
# The session already exists and is captured by the caller afterwards, so this script never creates, renames, kills,
# or detaches it. It opens one extra window in it for the stand-in model endpoint, types into the first pane, and
# waits for text the CLI renders.
#
# Scenario:
#
#   /workflow prediction-e2e                        a project workflow whose `plan` stage the stand-in endpoint keeps
#                                                   running, with `review-${round}` rounds after it
#   PREDICTION-E2E SEND workflow:<run>/reveiw-1     the main chat sends to a misspelled future stage
#   PREDICTION-E2E LIST                             the main chat lists live and future targets
#
# `default` expects `Message queued for <target>` with no note; `warnings` sets the setting and expects the old note.
# `predicted` runs a workflow whose stage names come from a helper, with `decisionModel` set to the built-in TypeSafe
# classifier, whose System One client the scenario points at the stand-in endpoint: `intercom list` shows the predicted rows, and a repeated send to a
# misspelled stage gets the `did you mean` line once the classifier has judged it.

set -euo pipefail

SESSION="${1:?usage: possible-stage-prediction-evidence.sh <tmux-session-name> <artifact-dir> [default|warnings|predicted]}"
ARTIFACTS="${2:?usage: possible-stage-prediction-evidence.sh <tmux-session-name> <artifact-dir> [default|warnings|predicted]}"
MODE="${3:-default}"
if [[ "$MODE" != "default" && "$MODE" != "warnings" && "$MODE" != "predicted" ]]; then
	echo "prediction evidence: mode must be default, warnings or predicted" >&2
	exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$REPO_ROOT/test/integration/fixtures"
OLD_NOTE="not in the workflow's known stage set"
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "prediction evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/prediction-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
STATE="$WORKDIR/state"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/workflows" "$STATE" "$AGENT"
WORKFLOW="prediction-e2e"
if [[ "$MODE" == "predicted" ]]; then
	WORKFLOW="prediction-e2e-helper"
	cp "$FIXTURES/possible-stage-prediction-helper-workflow.ts" "$PROJECT/.atomic/workflows/"
else
	cp "$FIXTURES/possible-stage-prediction-workflow.ts" "$PROJECT/.atomic/workflows/"
fi

step=0
PANE="$SESSION:0"
capture() { tmux capture-pane -p -J -S - -t "$PANE"; }
save() {
	step=$((step + 1))
	capture >"$ARTIFACTS/$(printf '%02d' "$step")-$MODE-$1.txt"
}
await() {
	local needle="$1" label="$2" timeout="${3:-120}" count="${4:-1}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if (($(capture | grep -cF -- "$needle") >= count)); then return 0; fi
		sleep 1
	done
	echo "prediction evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture >"$ARTIFACTS/failure-$MODE-${label// /-}.txt"
	return 1
}
type_line() {
	tmux send-keys -t "$PANE" -l "$1"
	sleep 0.5
	tmux send-keys -t "$PANE" Enter
	sleep 0.5
	if tmux capture-pane -p -t "$PANE" | grep -qF -- "❯ $1"; then
		tmux send-keys -t "$PANE" Enter
		sleep 0.5
	fi
}

# 1. The stand-in model endpoint runs in its own window so it outlives this script's shell.
tmux new-window -d -t "$SESSION" -n "prediction-model" \
	"'$BUN' '$FIXTURES/possible-stage-prediction-model-server.ts' '$STATE' >'$ARTIFACTS/model-server-$MODE.log' 2>&1"
MODEL_PORT=""
for _ in $(seq 1 120); do
	if [[ -s "$STATE/model-port" ]]; then
		MODEL_PORT="$(cat "$STATE/model-port")"
		break
	fi
	sleep 0.5
done
if [[ -z "$MODEL_PORT" ]]; then
	echo "prediction evidence: the stand-in model endpoint never published a port" >&2
	exit 1
fi

cat >"$AGENT/models.json" <<JSON
{
  "providers": {
    "predictione2e": {
      "baseUrl": "http://127.0.0.1:$MODEL_PORT/v1",
      "apiKey": "prediction-e2e-test-key",
      "api": "openai-responses",
      "models": [
        {
          "id": "prediction-e2e-model",
          "name": "prediction-e2e-model",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 400000,
          "maxTokens": 1024
        }
      ]
    },
    "typesafe": {
      "baseUrl": "http://127.0.0.1:$MODEL_PORT/v1"
    }
  }
}
JSON
SETTING=""
if [[ "$MODE" == "warnings" ]]; then SETTING='"intercom": { "showUnknownTargetWarnings": true },'; fi
# The built-in TypeSafe provider's System One client talks to the stand-in endpoint with a scratch key.
CLASSIFIER_ENV=""
if [[ "$MODE" == "predicted" ]]; then
	SETTING='"decisionModel": "typesafe/jev-latest",'
	CLASSIFIER_ENV="TYPESAFE_API_KEY=prediction-e2e-test-key"
fi
cat >"$AGENT/settings.json" <<JSON
{
  $SETTING
  "defaultProvider": "predictione2e",
  "defaultModel": "prediction-e2e-model",
  "lastChangelogVersion": "0.0.0",
  "firstRunOnboardingStartedVersion": "0.0.0",
  "onboardedVersion": "0.0.0"
}
JSON

# 2. The real CLI against the scratch project and an isolated agent directory. NODE_ENV is pinned away from "test",
#    which would give stages stub sessions.
tmux send-keys -t "$PANE" -l \
	"cd '$PROJECT' && NODE_ENV=production $CLASSIFIER_ENV ATOMIC_CODING_AGENT_DIR='$AGENT' ATOMIC_SKIP_VERSION_CHECK=1 '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline --no-session"
tmux send-keys -t "$PANE" Enter
await "prediction-e2e-model •" "the CLI to start on the stand-in model" 240
save "cli-started"

# 3. Launch the project workflow and read its run id from the start notice.
type_line "/workflow $WORKFLOW"
await "\"$WORKFLOW\" started" "the run to be dispatched" 120
RUN_ID="$(capture | grep -oE 'run +[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 | awk '{print $2}')"
if [[ -z "$RUN_ID" ]]; then
	echo "prediction evidence: no run id in the start notice" >&2
	exit 1
fi
await "● running" "the run to be running" 60
save "run-started"

await_classifier() {
	local needle="$1" label="$2" deadline=$((SECONDS + 120))
	while ((SECONDS < deadline)); do
		if grep -lqF -- "$needle" "$STATE"/classifier-*.json 2>/dev/null; then return 0; fi
		sleep 1
	done
	echo "prediction evidence: timed out waiting for ${label}" >&2
	return 1
}

if [[ "$MODE" == "predicted" ]]; then
	# 4p. The launch asked the classifier about the helper-built names; intercom list then shows the predictions.
	await_classifier '"uncertainCallSites"' "the launch-time classifier question"
	type_line "PREDICTION-E2E LIST"
	await "workflow:$RUN_ID/summary-2\` [future, predicted 0.93]" "the predicted summary-2 row" 120
	await "workflow:$RUN_ID/review-1\` [future, confirmed]" "the confirmed review-1 row" 60
	await "intercom call finished" "the turn after the list" 60
	save "intercom-list-predicted"

	# 5p. The first send to a misspelled stage queues plainly and asks the classifier; the repeat gets the line.
	TARGET="workflow:$RUN_ID/reviwe-1"
	type_line "PREDICTION-E2E SEND $TARGET"
	await "Message queued for $TARGET" "the first queued result" 120
	await_classifier '"target":"reviwe-1"' "the classifier's judgment of the misspelled target"
	await "intercom call finished" "the turn after the first send" 60 2
	type_line "PREDICTION-E2E SEND $TARGET"
	await "No stage named reviwe-1 is expected; did you mean review-1?" "the did-you-mean line" 120
	await "intercom call finished" "the turn after the repeated send" 60 3
	save "send-typo-suggestion"
	if capture | grep -qF -- "$OLD_NOTE"; then
		echo "prediction evidence: a predicted-mode send showed \"$OLD_NOTE\"" >&2
		exit 1
	fi

	# 6p. Workflow status names each prediction and whether it came true.
	type_line "/workflow status $RUN_ID"
	await "review-1 confirmed 0.93, summary-2 predicted 0.93" "the status prediction row" 120
	save "workflow-status"
	capture >"$ARTIFACTS/harness-shaped-capture-$MODE.txt"
	echo "prediction evidence: $MODE scenario complete for run $RUN_ID; artifacts in $ARTIFACTS"
	exit 0
fi

# 4. A send to a misspelled future stage: queued either way, with the note only when the setting asks for it.
TARGET="workflow:$RUN_ID/reveiw-1"
type_line "PREDICTION-E2E SEND $TARGET"
await "Message queued for $TARGET" "the queued result" 120
await "intercom call finished" "the turn after the send" 60
save "send-queued"
if [[ "$MODE" == "default" ]] && capture | grep -qF -- "$OLD_NOTE"; then
	echo "prediction evidence: the default send result still shows \"$OLD_NOTE\"" >&2
	exit 1
fi
if [[ "$MODE" == "warnings" ]] && ! capture | grep -qF -- "$OLD_NOTE"; then
	echo "prediction evidence: intercom.showUnknownTargetWarnings did not restore \"$OLD_NOTE\"" >&2
	exit 1
fi

# 5. The run's live and future targets.
type_line "PREDICTION-E2E LIST"
await "workflow:$RUN_ID/review-*\` [future]" "the review-* future row" 120
await "intercom call finished" "the turn after the list" 60 2
save "intercom-list"

capture >"$ARTIFACTS/harness-shaped-capture-$MODE.txt"
echo "prediction evidence: $MODE scenario complete for run $RUN_ID; artifacts in $ARTIFACTS"
