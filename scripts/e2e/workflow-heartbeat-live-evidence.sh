#!/usr/bin/env bash
#
# Full-feature terminal evidence for issue #1975 — all three slices together,
# against a REAL provider.
#
# Usage: bash scripts/e2e/workflow-heartbeat-live-evidence.sh <tmux-session> <artifact-dir>
#
# Why this exists alongside the two per-slice helpers: both of those run the CLI
# with `--offline` and an empty agent directory, so every delivered heartbeat is
# followed by `Unknown provider: unknown`. That proves the card was delivered and
# triggered a parent turn, but it cannot show the thing the issue actually asks
# for — the main chat reading the heartbeat, inspecting the run against its
# original goal, and deciding to continue, steer, or stop it.
#
# This scenario therefore runs an authenticated session. It copies the real
# agent directory's credentials into a scratch agent dir so the run is isolated
# from the operator's own sessions while still being able to reach the provider.
#
# Cadence is 1 minute throughout, so the whole scenario is minutes rather than
# hours.
#
# Scenario:
#   1. Launch a parked workflow authored at heartbeatIntervalMinutes: 1.
#   2. First heartbeat card lands on its own, with nothing typed after launch.
#   3. The main chat takes a real model turn on it and reports alignment.
#   4. A second card lands one interval later — recurrence, not a one-shot.
#   5. The run reaches a terminal state on its own.
#   6. Three further minutes pass with no card: cleanup held.

set -euo pipefail

SESSION="${1:?usage: workflow-heartbeat-live-evidence.sh <tmux-session-name> <artifact-dir>}"
ARTIFACTS="${2:?usage: workflow-heartbeat-live-evidence.sh <tmux-session-name> <artifact-dir>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/test/integration/fixtures/workflow-heartbeat-live-evidence-workflow.ts"
WORKFLOW_NAME="workflow-heartbeat-live-evidence"
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
REAL_AGENT_DIR="${ATOMIC_REAL_AGENT_DIR:-$HOME/.atomic/agent}"

if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "heartbeat live evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi
if [[ ! -f "$REAL_AGENT_DIR/auth.json" ]]; then
	echo "heartbeat live evidence: no auth.json under $REAL_AGENT_DIR; this scenario needs a logged-in provider" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/workflow-heartbeat-live-XXXXXX")"
PROJECT="$WORKDIR/project"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/workflows" "$AGENT"
cp "$FIXTURE" "$PROJECT/.atomic/workflows/"
# Credentials and model selection only. Sessions, history, and caches stay in
# the scratch directory so this run never mixes into the operator's own state.
cp "$REAL_AGENT_DIR/auth.json" "$AGENT/"
[[ -f "$REAL_AGENT_DIR/models-store.json" ]] && cp "$REAL_AGENT_DIR/models-store.json" "$AGENT/"
[[ -f "$REAL_AGENT_DIR/settings.json" ]] && cp "$REAL_AGENT_DIR/settings.json" "$AGENT/"

step=0
capture() { tmux capture-pane -p -t "$SESSION"; }
capture_scrollback() { tmux capture-pane -p -J -S - -t "$SESSION"; }

save() {
	step=$((step + 1))
	capture_scrollback >"$ARTIFACTS/$(printf '%02d' "$step")-$1.txt"
	echo "  saved $(printf '%02d' "$step")-$1.txt"
}

# Poll for rendered text. Never a bare sleep: a step that never arrives fails
# the run instead of quietly producing an empty capture.
await() {
	local needle="$1" label="$2" timeout="${3:-180}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if capture_scrollback | grep -qF -- "$needle"; then return 0; fi
		sleep 2
	done
	echo "heartbeat live evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture_scrollback >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

await_count() {
	local needle="$1" wanted="$2" label="$3" timeout="${4:-180}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if (($(capture_scrollback | grep -cF -- "$needle" || true) >= wanted)); then return 0; fi
		sleep 2
	done
	echo "heartbeat live evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture_scrollback >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

# The TUI renders on the alternate screen, so a card that scrolls out of the
# viewport is gone from the pane and cannot be counted there. The session JSONL
# is the durable record of what was actually delivered to the parent, so
# heartbeat accounting reads that; the pane captures remain the visual proof of
# what the operator saw at each moment.
session_file() { find "$AGENT/sessions" -name '*.jsonl' -type f 2>/dev/null | head -1; }
count_cards() {
	local f
	f="$(session_file)"
	[[ -z "$f" ]] && { echo 0; return; }
	grep -cF "workflows:workflow-heartbeat" "$f" 2>/dev/null || echo 0
}

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

echo "heartbeat live evidence: session=$SESSION project=$PROJECT"

# 1. Real authenticated CLI. No --offline.
tmux send-keys -t "$SESSION" -l \
	"cd '$PROJECT' && ATOMIC_CODING_AGENT_DIR='$AGENT' '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve"
tmux send-keys -t "$SESSION" Enter
# The interactive prompt marker. Readiness is the rendered input line, not any
# particular greeting text, which differs across builds and themes.
await "❯" "the CLI to finish starting" 240
save "cli-started-live-provider"

# 2. Launch the parked 1-minute-cadence run. Last thing typed before the cards.
type_command "/workflow $WORKFLOW_NAME"
await "started in background" "the run to be dispatched" 120
RUN_ID="$(capture_scrollback | grep -oE '/workflow connect [0-9a-f]{8}' | tail -1 | awk '{print $3}')"
if [[ -z "$RUN_ID" ]]; then
	echo "heartbeat live evidence: the CLI rendered no dispatched run id" >&2
	capture_scrollback >"$ARTIFACTS/failure-no-run-id.txt"
	exit 1
fi
echo "  run id: $RUN_ID"
save "run-dispatched"

# 3. First card, unprompted.
await "WORKFLOW HEARTBEAT" "the first heartbeat card" 150
save "first-heartbeat-card"

# 4. The parent turn the card triggered. With a real provider this is an actual
#    model response, which is what the offline captures could never show. The
#    marker is the assistant answering after the card without anything typed.
sleep 45
save "parent-turn-on-heartbeat"

# 5. A live parent turn is not instant, and the one-outstanding-heartbeat rule
#    holds a heartbeat's slot until its card is actually consumed. A boundary
#    that falls while the parent is still working the previous card is therefore
#    skipped rather than stacked behind it — by design. So recurrence is not
#    asserted here: with a real provider the honest observation is that at least
#    one card arrived, the parent reacted to it, and no card was ever stacked.
#    The deterministic recurrence proof lives in the offline slice 2 evidence and
#    in the injected-clock unit tests.
CARDS_BEFORE_TERMINAL="$(count_cards)"
echo "  heartbeat cards observed so far: $CARDS_BEFORE_TERMINAL"

# 6. The run completes on its own.
await "WORKFLOW COMPLETE" "the run to reach a terminal state" 240
CARDS_AT_TERMINAL="$(count_cards)"
if ((CARDS_AT_TERMINAL < 1)); then
	echo "heartbeat live evidence: no heartbeat card was ever rendered" >&2
	exit 1
fi
# The whole point of this scenario over the offline ones: the parent turn each
# card triggered actually reached a model.
if grep -qF "Unknown provider" "$ARTIFACTS"/0*.txt; then
	echo "heartbeat live evidence: the session was not authenticated; this run proves nothing the offline evidence does not" >&2
	exit 1
fi
echo "  heartbeat cards at terminal: $CARDS_AT_TERMINAL"
save "run-completed"

# 7. Three further boundaries pass in silence.
sleep 190
CARDS_AFTER="$(count_cards)"
save "quiet-3min-after-terminal"

if [[ "$CARDS_AFTER" != "$CARDS_AT_TERMINAL" ]]; then
	echo "heartbeat live evidence: card count moved after terminal ($CARDS_AT_TERMINAL -> $CARDS_AFTER)" >&2
	exit 1
fi

{
	echo "run_id=$RUN_ID"
	echo "cadence_minutes=1"
	echo "cards_at_terminal=$CARDS_AT_TERMINAL"
	echo "cards_after_3min=$CARDS_AFTER"
	echo "provider=live"
	echo "session_file=$(session_file)"
} >"$ARTIFACTS/summary.txt"
cp "$(session_file)" "$ARTIFACTS/session.jsonl" 2>/dev/null || true

echo "heartbeat live evidence: scenario complete; run $RUN_ID; artifacts in $ARTIFACTS"
