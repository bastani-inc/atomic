#!/usr/bin/env bash
#
# Terminal evidence for workflow stage-output nomination and durable transcripts.
#
# Optional arguments select model ordering, admission timing, and candidate size. Existing two-, three-, and
# four-argument invocations retain their original defaults. The acknowledgement-larger control is marginally larger
# than the deliverable but remains below the 3:2 override threshold. The default nonce has fixed-width timestamp and
# PID fields so acknowledgement size never depends on host PID width.
# Usage: bash scripts/e2e/stage-output-transcript-evidence.sh <tmux-session-name> <artifact-dir>
#   [trailing|mid-prompt|deliverable-after-admission] [streaming|settled] [default|acknowledgement-larger]
# The caller creates a real tmux session; this script drives the REAL interactive
# Atomic CLI in that pane and saves the final pane plus filesystem evidence under
# <artifact-dir>. It never substitutes the workflow executor or the output helper.
#
# Scenario variants:
#
#   trailing (the default):
#     assistant REAL-DELIVERABLE -> admitted custom -> assistant ACK
#   mid-prompt:
#     assistant INTRO -> admitted custom -> assistant ACK + tool call -> assistant REAL-DELIVERABLE
#   deliverable-after-admission:
#     assistant INTRO -> admitted custom -> assistant REAL-DELIVERABLE
#
# All variants dispatch /workflow stage-output-transcript-e2e, whose one stage
# declares output: "stage-output.md" and outputMode: "file-only".
#
# The filesystem assertions are the load-bearing evidence:
#
#   1. stage-output.md contains REAL-DELIVERABLE for every ordering, including reports completed after admission
#   2. stage-output.md never contains ACK or INTRO; marginal size alone does not replace the trailing deliverable
#   3. the rendered transcript exists under the configured durable run root, outside both the repository and $TMPDIR
#   4. the transcript retains admitted and intermediate turns and records runtime admission provenance
#   5. warnings are present whenever non-empty assistant content is passed over and name exactly what was persisted
#      and discarded
# ATOMIC_WORKFLOW_ARTIFACT_DIR is deliberately pointed at a per-run scratch
# directory in the user's home (not the real ~/.atomic and not $TMPDIR). This
# keeps the evidence isolated while exercising the durable-root path semantics.
# The scratch durable root is intentionally left in place for post-run inspection;
# remove it after collecting evidence if desired.

set -euo pipefail

SESSION="${1:?usage: stage-output-transcript-evidence.sh <tmux-session-name> <artifact-dir> [ordering] [streaming|settled]}"
ARTIFACTS="${2:?usage: stage-output-transcript-evidence.sh <tmux-session-name> <artifact-dir> [ordering] [streaming|settled]}"
ORDERING="${3:-${STAGE_OUTPUT_TRANSCRIPT_ORDERING:-trailing}}"
case "$ORDERING" in
	trailing|mid-prompt|deliverable-after-admission) ;;
	*) echo "stage-output-transcript evidence: unsupported ordering: $ORDERING" >&2; exit 1 ;;
esac
ADMISSION="${4:-${STAGE_OUTPUT_TRANSCRIPT_ADMISSION:-}}"
if [[ -z "$ADMISSION" ]]; then
	if [[ "$ORDERING" == "trailing" ]]; then ADMISSION="settled"; else ADMISSION="streaming"; fi
fi
case "$ADMISSION" in
	streaming|settled) ;;
	*) echo "stage-output-transcript evidence: unsupported admission timing: $ADMISSION" >&2; exit 1 ;;
esac
SIZE="${5:-${STAGE_OUTPUT_TRANSCRIPT_SIZE:-default}}"
case "$SIZE" in
	default|acknowledgement-larger) ;;
	*) echo "stage-output-transcript evidence: unsupported size: $SIZE" >&2; exit 1 ;;
esac
if [[ "$SIZE" == "acknowledgement-larger" && ( "$ORDERING" != "trailing" || "$ADMISSION" != "streaming" ) ]]; then
	echo "stage-output-transcript evidence: acknowledgement-larger is supported only with trailing/streaming" >&2
	exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$REPO_ROOT/test/integration/fixtures"
WORKFLOW_FIXTURE="stage-output-transcript-workflow.ts"
MODEL_FIXTURE="stage-output-transcript-model-server.ts"
NOTIFY_FIXTURE="stage-output-transcript-notify-extension.ts"
WORKFLOW_NAME="stage-output-transcript-e2e"
OUTPUT_NAME="stage-output.md"

BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "stage-output-transcript evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/stage-output-transcript-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
STATE="$WORKDIR/state"
AGENT="$WORKDIR/agent"
# Keep this outside both the repository and macOS/Linux's purgeable temp tree.
DURABLE_ROOT="${HOME}/.atomic-stage-output-transcript-e2e-${$}"
FIXED_WIDTH_TIMESTAMP="$(printf '%010d' "$(date +%s)")"
FIXED_WIDTH_PID="$(printf '%07d' "$$")"
NONCE="${STAGE_OUTPUT_TRANSCRIPT_EVIDENCE_NONCE:-tmux-${FIXED_WIDTH_TIMESTAMP}-${FIXED_WIDTH_PID}}"
mkdir -p "$PROJECT/.atomic/workflows" "$STATE" "$AGENT/extensions" "$DURABLE_ROOT"
cp "$FIXTURES/$WORKFLOW_FIXTURE" "$PROJECT/.atomic/workflows/"
cp "$FIXTURES/$NOTIFY_FIXTURE" "$AGENT/extensions/"

step=0
MODEL_PID=""

capture() { tmux capture-pane -p -t "$SESSION"; }
capture_all() { tmux capture-pane -p -S - -t "$SESSION"; }

save() {
	step=$((step + 1))
	capture >"$ARTIFACTS/$(printf '%02d' "$step")-$1.txt"
}

on_exit() {
	local status=$?
	if [[ -n "$MODEL_PID" ]]; then
		kill "$MODEL_PID" 2>/dev/null || true
		wait "$MODEL_PID" 2>/dev/null || true
	fi
	if ((status != 0)); then
		capture_all >"$ARTIFACTS/failure-pane.txt" 2>/dev/null || true
		echo "stage-output-transcript evidence: failed; artifacts in $ARTIFACTS" >&2
	fi
}
trap on_exit EXIT

await_text() {
	local needle="$1" label="$2" timeout="${3:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if grep -qF -- "$needle" <<<"$(capture_all)"; then return 0; fi
		sleep 1
	done
	echo "stage-output-transcript evidence: timed out after ${timeout}s waiting for ${label}" >&2
	return 1
}

await_file() {
	local path="$1" label="$2" timeout="${3:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if [[ -s "$path" ]]; then return 0; fi
		sleep 1
	done
	echo "stage-output-transcript evidence: timed out after ${timeout}s waiting for ${label}: $path" >&2
	return 1
}

# Poll the model-server state file without guessing a request timing.
await_request_count() {
	local expected="$1" timeout="${2:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if [[ -s "$STATE/request-count" ]] && (( $(<"$STATE/request-count") >= expected )); then return 0; fi
		sleep 1
	done
	echo "stage-output-transcript evidence: model server did not receive ${expected} requests" >&2
	return 1
}

await_notify_admitted() {
	local deadline=$((SECONDS + 180))
	while ((SECONDS < deadline)); do
		if [[ -s "$STATE/notify-state" ]]; then
			local state
			state="$(<"$STATE/notify-state")"
			if [[ "$state" == "notify-admitted" ]]; then return 0; fi
			if [[ "$state" == "notify-failed" ]]; then
				echo "stage-output-transcript evidence: notification delivery failed" >&2
				return 1
			fi
		fi
		sleep 1
	done
	echo "stage-output-transcript evidence: timed out waiting for notification admission" >&2
	return 1
}

type_command() {
	tmux send-keys -t "$SESSION" -l "$1"
	sleep 0.5
	tmux send-keys -t "$SESSION" Enter
	sleep 0.5
	if grep -qF -- "❯ $1" <<<"$(capture)"; then
		tmux send-keys -t "$SESSION" Enter
		sleep 0.5
	fi
}

# 1. Start the stand-in model endpoint. Its first response streams the
#    ordering-specific assistant turn and stays open; mid-prompt's next response
#    includes a real tool call so the agent loop produces a third request.
"$BUN" "$FIXTURES/$MODEL_FIXTURE" "$STATE" "$NONCE" "$ORDERING" "$SIZE" >"$ARTIFACTS/model-server.log" 2>&1 &
MODEL_PID=$!
for _ in $(seq 1 120); do
	if [[ -s "$STATE/model-port" ]]; then break; fi
	sleep 0.5
done
if [[ ! -s "$STATE/model-port" ]]; then
	echo "stage-output-transcript evidence: model server never published a port" >&2
	exit 1
fi
MODEL_PORT="$(<"$STATE/model-port")"

cat >"$AGENT/models.json" <<JSON
{
  "providers": {
    "stage-output-transcript": {
      "baseUrl": "http://127.0.0.1:$MODEL_PORT/v1",
      "apiKey": "stage-output-transcript-test-key",
      "api": "openai-responses",
      "models": [
        {
          "id": "stage-output-transcript-model",
          "name": "stage-output-transcript-model",
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
  "defaultProvider": "stage-output-transcript",
  "defaultModel": "stage-output-transcript-model",
  "lastChangelogVersion": "0.0.0",
  "firstRunOnboardingStartedVersion": "0.0.0",
  "onboardedVersion": "0.0.0"
}
JSON

# 2. Start the real source CLI in the real tmux pane. ATOMIC_WORKFLOW_ARTIFACT_DIR
#    is the isolated durable scratch root described in the header, while the
#    project itself remains a disposable $TMPDIR scratch checkout.
tmux send-keys -t "$SESSION" -l \
	"cd '$PROJECT' && NODE_ENV=production ATOMIC_CODING_AGENT_DIR='$AGENT' ATOMIC_WORKFLOW_ARTIFACT_DIR='$DURABLE_ROOT' STAGE_OUTPUT_TRANSCRIPT_ORDERING='$ORDERING' STAGE_OUTPUT_TRANSCRIPT_ADMISSION='$ADMISSION' STAGE_OUTPUT_TRANSCRIPT_SIZE='$SIZE' STAGE_OUTPUT_TRANSCRIPT_NONCE='$NONCE' STAGE_OUTPUT_TRANSCRIPT_STATE='$STATE/notify-state' STAGE_OUTPUT_TRANSCRIPT_RECEIPT_STATE='$STATE/receipt.txt' ATOMIC_SKIP_VERSION_CHECK=1 '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline --no-session"
tmux send-keys -t "$SESSION" Enter
await_text "stage-output-transcript-model •" "the CLI to finish starting" 240
save "cli-started"

# 3. Dispatch the named workflow and recover its full run id from the rendered
#    connect hint, just as the existing terminal evidence scripts do.
type_command "/workflow $WORKFLOW_NAME"
await_text "started in background" "the workflow to be dispatched" 120
RUN_ID="$(capture | grep -oE '/workflow connect [0-9a-f-]+' | tail -1 | awk '{print $3}')"
if [[ -z "$RUN_ID" ]]; then
	echo "stage-output-transcript evidence: the CLI rendered no dispatched run id" >&2
	exit 1
fi
save "run-dispatched"

# 4. Wait for the admitted custom-message delivery and every model request.
#    The output file is only written after the stage closes, so this ordering
#    proves the notification was admitted before finalization. Mid-prompt's
#    third request is produced by the tool call in the real agent loop.
await_notify_admitted
EXPECTED_REQUESTS=2
if [[ "$ORDERING" == "mid-prompt" ]]; then EXPECTED_REQUESTS=3; fi
await_request_count "$EXPECTED_REQUESTS" 180
await_file "$PROJECT/$OUTPUT_NAME" "the stage artifact" 180
await_text "Workflow \"$WORKFLOW_NAME\" completed" "the workflow to complete" 120
save "workflow-completed"

# 5. Clear old screens, ask the real workflow command surface for the run
#    detail, then invoke the evidence-only command registered by the fixture
#    extension. That command renders the exact receipt returned by ctx.prompt;
#    the ordinary run-detail panel intentionally truncates long result values.
await_file "$STATE/receipt.txt" "the workflow's exact file-only receipt" 120
tmux clear-history -t "$SESSION"
type_command "/workflow status $RUN_ID"
await_text "ARTIFACTS" "the workflow run detail" 120
tmux clear-history -t "$SESSION"
PANE="$ARTIFACTS/pane-final.txt"
capture >"$PANE"
cp "$STATE/receipt.txt" "$ARTIFACTS/receipt.txt"
if ! grep -qF -- "Output saved to:" "$ARTIFACTS/receipt.txt" || ! grep -qF -- "Transcript saved to:" "$ARTIFACTS/receipt.txt"; then
	echo "stage-output-transcript evidence: exact receipt omitted one of the two paths" >&2
	exit 1
fi
type_command "/stage-output-receipt"
await_text "Transcript saved to:" "the file-only receipt" 120
save "receipt-screen"

PANE="$ARTIFACTS/pane-final.txt"
capture >"$PANE"
OUTPUT_FILE="$PROJECT/$OUTPUT_NAME"
if [[ ! -f "$OUTPUT_FILE" ]]; then
	echo "stage-output-transcript evidence: output artifact is missing: $OUTPUT_FILE" >&2
	exit 1
fi
cp "$OUTPUT_FILE" "$ARTIFACTS/output-artifact.txt"
DELIVERABLE="REAL-DELIVERABLE-$NONCE"
INTRO="INTRO-$NONCE"
ACK="ACK-$NONCE"
ASYNC_COMPLETION="ASYNC-COMPLETION-$NONCE"
ACK_BYTES="${#ACK}"
if [[ "$SIZE" == "acknowledgement-larger" ]]; then
	ACK_LARGER_UNIT="Larger admission-triggered acknowledgement content. "
	ACK_BYTES=$((ACK_BYTES + 2 + 4 * ${#ACK_LARGER_UNIT}))
fi
EXPECTED_OUTPUT="$DELIVERABLE"
EXPECTED_KIND="deliverable"
if ! grep -qF -- "$EXPECTED_OUTPUT" "$OUTPUT_FILE"; then
	echo "stage-output-transcript evidence: output does not contain stage deliverable $EXPECTED_OUTPUT" >&2
	exit 1
fi
OUTPUT_CONTAINS_DELIVERABLE=true
OUTPUT_CONTAINS_INTRO=false
if grep -qF -- "$INTRO" "$OUTPUT_FILE"; then
	echo "stage-output-transcript evidence: output retained intermediate $INTRO" >&2
	exit 1
fi
if grep -qF -- "$ACK" "$OUTPUT_FILE"; then
	echo "stage-output-transcript evidence: admission-triggered $ACK replaced the stage-own turn" >&2
	exit 1
fi
printf 'ordering=%s\nadmission=%s\nsize=%s\noutput_expected=%s\noutput_contains_stage_own=true\noutput_contains_deliverable=%s\noutput_contains_ack=false\noutput_contains_intro=%s\nack_bytes=%s\noutput_path=%s\n' \
	"$ORDERING" "$ADMISSION" "$SIZE" "$EXPECTED_KIND" "$OUTPUT_CONTAINS_DELIVERABLE" "$OUTPUT_CONTAINS_INTRO" "$ACK_BYTES" "$OUTPUT_FILE" >"$ARTIFACTS/assertion-output.txt"

# Extract the durable transcript path from the verbatim receipt captured by the
# evidence command. The pane capture remains the terminal proof, but its narrow
# renderer may wrap a long absolute path across two display rows.
TRANSCRIPT_PATH="$(grep -oE 'Transcript saved to: [^ ]+' "$ARTIFACTS/receipt.txt" | sed 's/^Transcript saved to: //')"
if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
	echo "stage-output-transcript evidence: receipt did not name an existing transcript" >&2
	exit 1
fi
case "$TRANSCRIPT_PATH" in
	"$DURABLE_ROOT"/*) ;;
	*) echo "stage-output-transcript evidence: transcript escaped durable root: $TRANSCRIPT_PATH" >&2; exit 1 ;;
esac
case "$TRANSCRIPT_PATH" in
	"$REPO_ROOT"/*) echo "stage-output-transcript evidence: transcript is inside repo: $TRANSCRIPT_PATH" >&2; exit 1 ;;
esac
case "$TRANSCRIPT_PATH" in
	"${TMPDIR:-/tmp}"/*) echo "stage-output-transcript evidence: transcript is under TMPDIR: $TRANSCRIPT_PATH" >&2; exit 1 ;;
esac
cp "$TRANSCRIPT_PATH" "$ARTIFACTS/transcript.txt"
DELIVERABLE_MATCH=false
if rg -nF -- "$DELIVERABLE" "$TRANSCRIPT_PATH" >"$ARTIFACTS/transcript-deliverable-hit.txt"; then
	DELIVERABLE_MATCH=true
elif [[ "$ORDERING" != "mid-prompt" || "$ADMISSION" != "settled" ]]; then
	echo "stage-output-transcript evidence: transcript does not contain $DELIVERABLE" >&2
	exit 1
fi
if ! rg -nF -- "$ASYNC_COMPLETION" "$TRANSCRIPT_PATH" >"$ARTIFACTS/transcript-completion-hit.txt"; then
	echo "stage-output-transcript evidence: transcript does not contain $ASYNC_COMPLETION" >&2
	exit 1
fi
ACK_MATCH=false
if [[ "$ORDERING" != "deliverable-after-admission" ]]; then
	if rg -nF -- "$ACK" "$TRANSCRIPT_PATH" >"$ARTIFACTS/transcript-ack-hit.txt"; then
		ACK_MATCH=true
	elif [[ "$ORDERING" != "mid-prompt" || "$ADMISSION" != "settled" ]]; then
		echo "stage-output-transcript evidence: transcript does not contain $ACK" >&2
		exit 1
	fi
fi
INTRO_MATCH=false
if [[ "$ORDERING" != "trailing" ]]; then
	if ! rg -nF -- "$INTRO" "$TRANSCRIPT_PATH" >"$ARTIFACTS/transcript-intro-hit.txt"; then
		echo "stage-output-transcript evidence: transcript does not contain $INTRO" >&2
		exit 1
	fi
	INTRO_MATCH=true
fi
EXPECTED_PROVENANCE="active-stage"
if [[ "$ADMISSION" == "settled" ]]; then EXPECTED_PROVENANCE="assistant-settled"; fi
if ! rg -nF -- "stageAdmissionProvenance: $EXPECTED_PROVENANCE" "$TRANSCRIPT_PATH" >"$ARTIFACTS/transcript-provenance-hit.txt"; then
	echo "stage-output-transcript evidence: transcript omitted provenance $EXPECTED_PROVENANCE" >&2
	exit 1
fi
printf 'ordering=%s\nadmission=%s\nsize=%s\ntranscript_exists=true\ntranscript_path=%s\nunder_durable_root=true\noutside_repo=true\noutside_tmpdir=true\ndeliverable_match=%s\ncompletion_match=true\nack_match=%s\nintro_match=%s\n' \
	"$ORDERING" "$ADMISSION" "$SIZE" "$TRANSCRIPT_PATH" "$DELIVERABLE_MATCH" "$ACK_MATCH" "$INTRO_MATCH" >"$ARTIFACTS/assertion-transcript.txt"

WARNING_BRANCH="post-admission-override"
if [[ "$ORDERING" == "trailing" ]]; then WARNING_BRANCH="pre-admission"; fi
if [[ "$WARNING_BRANCH" == "pre-admission" ]]; then
	if ! rg -nF -- "WARNING: the pre-admission assistant turn was persisted; all non-empty post-admission assistant turns were discarded." "$ARTIFACTS/receipt.txt" >"$ARTIFACTS/receipt-warning-hit.txt"; then
		echo "stage-output-transcript evidence: exact file-only receipt omitted the pre-admission selection warning" >&2
		exit 1
	fi
else
	if ! rg -nF -- "WARNING: the latest plausibly substantive post-admission assistant turn was persisted after meeting the 26-byte and 3:2 override gate; the pre-admission assistant turn and all other post-admission assistant turns were discarded." "$ARTIFACTS/receipt.txt" >"$ARTIFACTS/receipt-warning-hit.txt"; then
		echo "stage-output-transcript evidence: exact file-only receipt omitted the post-admission override warning" >&2
		exit 1
	fi
fi
if ! grep -qF -- "Search the companion transcript at $TRANSCRIPT_PATH." "$ARTIFACTS/receipt.txt"; then
	echo "stage-output-transcript evidence: warning omitted the companion transcript path" >&2
	exit 1
fi
printf 'warning_expected=true\nwarning_branch=%s\nwarning_present=true\nwarning_names_transcript=true\n' \
	"$WARNING_BRANCH" >"$ARTIFACTS/assertion-receipt.txt"

# Preserve the receipt screen verbatim and print the path metadata needed by the
# caller. The screen is the authoritative terminal capture; no receipt is rebuilt.
printf 'ordering=%s\nadmission=%s\nsize=%s\nrun_id=%s\nnonce=%s\nnonce_bytes=%s\nack_bytes=%s\ndurable_root=%s\noutput_path=%s\ntranscript_path=%s\n' \
	"$ORDERING" "$ADMISSION" "$SIZE" "$RUN_ID" "$NONCE" "${#NONCE}" "$ACK_BYTES" "$DURABLE_ROOT" "$OUTPUT_FILE" "$TRANSCRIPT_PATH" >"$ARTIFACTS/metadata.txt"
echo "stage-output-transcript evidence: scenario complete; ordering=$ORDERING; admission=$ADMISSION; size=$SIZE; artifacts in $ARTIFACTS"
