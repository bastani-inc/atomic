#!/usr/bin/env bash
#
# Terminal evidence for issue #1975 slice 3 — heartbeats stop once a workflow
# reaches a terminal state and stay stopped after a persisted-session restart.
#
# Usage: bash scripts/e2e/workflow-heartbeat-cleanup-evidence.sh <tmux-session-name> <artifact-dir>
#
# The session already exists. This helper owns the complete scenario inside that
# pane: it launches the source CLI, starts the checked-in workflow, waits for a
# heartbeat and terminal state, proves terminal silence, exits the CLI, waits
# for the shell to regain control, starts the same persisted session with
# --continue, and proves another quiet window. It never creates, renames, kills,
# or detaches the caller's tmux session.
#
# The helper writes tmux-01 through tmux-08 captures and a generated README into
# the supplied artifact directory. Every wait and quiet-window assertion fails
# the invocation when its marker or timing proof is missing.
#
# Scenario, driven through the real interactive CLI:
#
#   /workflow workflow-heartbeat-cleanup-evidence   a tool-only run that parks
#                                                   for 200s, authored with
#                                                   heartbeatIntervalMinutes: 1
#   (wait)                                          heartbeat cards land on their
#                                                   own, with nothing typed
#   (wait)                                          the run completes by itself
#   (wait >=3m)                                     no heartbeat after terminal
#   /exit                                            shutdown is observed
#   (restart --continue)                            the same persisted session
#                                                   restores the terminal card
#   (wait >=3m)                                     no stale heartbeat appears
#
# Separate from scripts/e2e/workflow-heartbeat-evidence.sh (slice 2) on purpose:
# that script's evidence stays reproducible unchanged.

set -euo pipefail

SESSION="${1:?usage: workflow-heartbeat-cleanup-evidence.sh <tmux-session-name> <artifact-dir>}"
ARTIFACTS="${2:?usage: workflow-heartbeat-cleanup-evidence.sh <tmux-session-name> <artifact-dir>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/test/integration/fixtures/workflow-heartbeat-cleanup-evidence-workflow.ts"
WORKFLOW_NAME="workflow-heartbeat-cleanup-evidence"
# Three cadence intervals of silence after the run ended and after restart.
QUIET_SECONDS=190
RESTART_QUIET_SECONDS=190
MIN_QUIET_SECONDS=180
# Under one interval: long enough for a card the parent's queue had already
# accepted before the run ended to be read and rendered, short enough that a
# still-running cadence could not have reached its next boundary.
SETTLE_SECONDS=25
# Bun is a declared engine of this repository and runs the CLI from source.
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "heartbeat cleanup evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/workflow-heartbeat-cleanup-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
AGENT="$WORKDIR/agent"
SESSION_DIR="$WORKDIR/sessions"
SHUTDOWN_MARKER="$WORKDIR/first-cli-shutdown"
RESTART_SHUTDOWN_MARKER="$WORKDIR/restarted-cli-shutdown"
mkdir -p "$PROJECT/.atomic/workflows" "$AGENT" "$SESSION_DIR"
cp "$FIXTURE" "$PROJECT/.atomic/workflows/"

step=0
LAST_CAPTURE=""

now_utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# The pane exactly as the caller will read it: the current screen only.
capture() { tmux capture-pane -p -t "$SESSION"; }

# The pane exactly as the caller will read it, with scrollback included, wrapped
# lines joined, and every line padded to the pane width.
capture_as_harness() { tmux capture-pane -p -J -S - -t "$SESSION"; }

save_capture() {
	step=$((step + 1))
	LAST_CAPTURE="$ARTIFACTS/tmux-$(printf '%02d' "$step")-$1.txt"
	capture_as_harness >"$LAST_CAPTURE"
}

# Heartbeat cards rendered *after* the run's terminal card are the whole claim.
# Deliberately positional rather than a total count: the CLI draws on the
# alternate screen, so older cards may scroll off and a count can shrink.
heartbeats_after_terminal() {
	local pane="$1" completed_at
	completed_at="$(grep -nF -- "WORKFLOW COMPLETE" "$pane" | tail -1 | cut -d: -f1)"
	if [[ -z "$completed_at" ]]; then
		echo "missing"
		return 0
	fi
	tail -n "+$((completed_at + 1))" "$pane" | grep -cF -- "WORKFLOW HEARTBEAT" || true
}

heartbeat_count() {
	grep -cF -- "WORKFLOW HEARTBEAT" "$1" || true
}

require_marker() {
	local pane="$1" marker="$2" label="$3"
	if ! grep -qF -- "$marker" "$pane"; then
		echo "heartbeat cleanup evidence: ${label} is missing from ${pane}" >&2
		return 1
	fi
}

assert_no_heartbeats_after_terminal() {
	local pane="$1" label="$2" after_terminal
	require_marker "$pane" "WORKFLOW COMPLETE" "$label terminal marker" || return 1
	after_terminal="$(heartbeats_after_terminal "$pane")"
	if [[ "$after_terminal" != "0" ]]; then
		echo "heartbeat cleanup evidence: ${after_terminal} heartbeat card(s) after the terminal card in ${label}" >&2
		cp "$pane" "$ARTIFACTS/failure-heartbeat-after-${label// /-}.txt"
		return 1
	fi
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
	echo "heartbeat cleanup evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture_as_harness >"$ARTIFACTS/failure-${label// /-}.txt"
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
	echo "heartbeat cleanup evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture_as_harness >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

await_file() {
	local path="$1" label="$2" timeout="${3:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if [[ -f "$path" ]]; then return 0; fi
		sleep 1
	done
	echo "heartbeat cleanup evidence: timed out after ${timeout}s waiting for ${label}" >&2
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
#    checked-in fixture and isolated configuration/session directories. The
#    marker is written by the shell only after the CLI process has exited.
tmux send-keys -t "$SESSION" -l \
	"cd '$PROJECT' && ATOMIC_CODING_AGENT_DIR='$AGENT' '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline --session-dir '$SESSION_DIR'; printf '%s\\n' shutdown > '$SHUTDOWN_MARKER'"
tmux send-keys -t "$SESSION" Enter
await "Type a message or slash command" "the CLI to finish starting" 240
CLI_STARTED_AT="$(now_utc)"
CLI_STARTED_TICK=$SECONDS
save_capture "cli-started"
CLI_STARTED_CAPTURE="$LAST_CAPTURE"

# 2. Launch the parked run. This is the last input until terminal shutdown.
type_command "/workflow $WORKFLOW_NAME"
await "started in background" "the run to be dispatched" 120
RUN_ID="$(capture | grep -oE '/workflow connect [0-9a-f]{8}' | tail -1 | awk '{print $3}')"
if [[ -z "$RUN_ID" ]]; then
	echo "heartbeat cleanup evidence: the CLI rendered no dispatched run id" >&2
	capture_as_harness >"$ARTIFACTS/failure-no-run-id.txt"
	exit 1
fi
DISPATCHED_AT="$(now_utc)"
DISPATCHED_TICK=$SECONDS
save_capture "run-dispatched"
DISPATCHED_CAPTURE="$LAST_CAPTURE"

# 3. The cadence is alive: two cards, one interval apart, with nothing typed.
await "WORKFLOW HEARTBEAT" "the first heartbeat card in the main chat" 150
FIRST_HEARTBEAT_AT="$(now_utc)"
FIRST_HEARTBEAT_TICK=$SECONDS
save_capture "first-heartbeat"
FIRST_HEARTBEAT_CAPTURE="$LAST_CAPTURE"
FIRST_HEARTBEAT_COUNT="$(heartbeat_count "$FIRST_HEARTBEAT_CAPTURE")"
if ((FIRST_HEARTBEAT_COUNT < 1)); then
	echo "heartbeat cleanup evidence: first heartbeat capture has no heartbeat card" >&2
	exit 1
fi

await_count "WORKFLOW HEARTBEAT" 2 "the second heartbeat card one interval later" 200
SECOND_HEARTBEAT_AT="$(now_utc)"
SECOND_HEARTBEAT_TICK=$SECONDS
save_capture "second-heartbeat"
SECOND_HEARTBEAT_CAPTURE="$LAST_CAPTURE"

# 4. The run ends on its own. `WORKFLOW COMPLETE` is the terminal lifecycle
#    card's own heading, so this waits for the terminal state rather than for a
#    timeout of its own.
await "WORKFLOW COMPLETE" "the run to reach a terminal state by itself" 240
TERMINAL_AT="$(now_utc)"
TERMINAL_TICK=$SECONDS
save_capture "run-completed"
TERMINAL_CAPTURE="$LAST_CAPTURE"
require_marker "$TERMINAL_CAPTURE" "WORKFLOW COMPLETE" "terminal completion" || exit 1

# A card the parent's queue had already accepted before the run ended is still
# the parent's to read and can be injected just after the completion card. Let
# that settle for less than one interval, so anything appearing later is the
# cadence rather than a card already in flight.
sleep "$SETTLE_SECONDS"

# 5. Three whole intervals of silence, with nothing typed. A cadence that had
#    survived the terminal state would have raised at least three more cards.
sleep "$QUIET_SECONDS"
TERMINAL_QUIET_AT="$(now_utc)"
TERMINAL_QUIET_TICK=$SECONDS
TERMINAL_QUIET_ELAPSED=$((TERMINAL_QUIET_TICK - TERMINAL_TICK))
if ((TERMINAL_QUIET_ELAPSED < MIN_QUIET_SECONDS)); then
	echo "heartbeat cleanup evidence: terminal quiet window was only ${TERMINAL_QUIET_ELAPSED}s" >&2
	exit 1
fi
save_capture "quiet-3min-after-terminal"
TERMINAL_QUIET_CAPTURE="$LAST_CAPTURE"
assert_no_heartbeats_after_terminal "$TERMINAL_QUIET_CAPTURE" "terminal quiet" || exit 1

# 6. Shut down the first CLI and wait for the shell-side marker. Because the
#    marker is written after the CLI command returns, restart cannot race the
#    first process or its session flush. Verify that a durable session exists.
type_command "/exit"
await_file "$SHUTDOWN_MARKER" "the first CLI to shut down before restart" 120
SHUTDOWN_AT="$(now_utc)"
SHUTDOWN_TICK=$SECONDS
SESSION_FILE="$(find "$SESSION_DIR" -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
if [[ -z "$SESSION_FILE" ]]; then
	echo "heartbeat cleanup evidence: shutdown completed without a persisted session file" >&2
	exit 1
fi

# 7. Restart the same persisted session. The second marker is intentionally
#    written only if this restarted CLI later exits; it is not used as startup
#    evidence. A continued session renders its retained transcript directly,
#    so its restored editor prompt is the startup marker rather than the
#    first-run onboarding text.
tmux send-keys -t "$SESSION" -l \
	"cd '$PROJECT' && ATOMIC_CODING_AGENT_DIR='$AGENT' '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline --session-dir '$SESSION_DIR' --continue; printf '%s\\n' shutdown > '$RESTART_SHUTDOWN_MARKER'"
tmux send-keys -t "$SESSION" Enter
await "❯" "the restarted CLI to finish starting" 240
await "WORKFLOW COMPLETE" "the restarted CLI to restore the terminal card" 120
await "$RUN_ID" "the restarted CLI to restore the same run" 120
RESTART_READY_AT="$(now_utc)"
RESTART_READY_TICK=$SECONDS
save_capture "restart-continue"
RESTART_CAPTURE="$LAST_CAPTURE"
require_marker "$RESTART_CAPTURE" "WORKFLOW COMPLETE" "restart terminal completion" || exit 1
require_marker "$RESTART_CAPTURE" "$RUN_ID" "restart run identity" || exit 1
assert_no_heartbeats_after_terminal "$RESTART_CAPTURE" "restart" || exit 1

# 8. Leave the restarted CLI untouched for another complete quiet window.
sleep "$RESTART_QUIET_SECONDS"
RESTART_QUIET_AT="$(now_utc)"
RESTART_QUIET_TICK=$SECONDS
RESTART_QUIET_ELAPSED=$((RESTART_QUIET_TICK - RESTART_READY_TICK))
if ((RESTART_QUIET_ELAPSED < MIN_QUIET_SECONDS)); then
	echo "heartbeat cleanup evidence: restart quiet window was only ${RESTART_QUIET_ELAPSED}s" >&2
	exit 1
fi
save_capture "restart-quiet-3min"
RESTART_QUIET_CAPTURE="$LAST_CAPTURE"
assert_no_heartbeats_after_terminal "$RESTART_QUIET_CAPTURE" "post-restart quiet" || exit 1

# 9. Generate the evidence README from the observed markers and timings. This
#    is deliberately emitted by the helper so the checked-in README describes
#    the exact run that produced the checked-in captures.
GENERATED_AT="$(now_utc)"
TERMINAL_QUIET_AFTER_SECONDS="$TERMINAL_QUIET_ELAPSED"
RESTART_QUIET_AFTER_SECONDS="$RESTART_QUIET_ELAPSED"
TERMINAL_AFTER_HEARTBEATS="$(heartbeats_after_terminal "$TERMINAL_QUIET_CAPTURE")"
RESTART_AFTER_HEARTBEATS="$(heartbeats_after_terminal "$RESTART_CAPTURE")"
FINAL_AFTER_HEARTBEATS="$(heartbeats_after_terminal "$RESTART_QUIET_CAPTURE")"
cat >"$ARTIFACTS/README.md" <<EOF
# Slice 3 terminal cleanup and restart recovery — real CLI evidence

This README and the eight captures were generated by

a single invocation of

the checked-in helper:

\`bash scripts/e2e/workflow-heartbeat-cleanup-evidence.sh '$SESSION' '$ARTIFACTS'\`

The helper drove the source Atomic CLI in tmux, copied the checked-in
\`workflow-heartbeat-cleanup-evidence\` fixture into a scratch project, and
used its \`heartbeatIntervalMinutes: 1\` definition. No workflow input was
sent between launch, heartbeat observations, terminal completion, or either
quiet window.

## Run identity and isolated state

| Field | Value |
| --- | --- |
| Worktree | \`$REPO_ROOT\` |
| Branch | \`$(git -C "$REPO_ROOT" branch --show-current)\` |
| tmux session | \`$SESSION\` |
| CLI under test | \`$BUN packages/coding-agent/src/cli.ts\` |
| Project | \`$PROJECT\` |
| Session directory | \`$SESSION_DIR\` |
| Persisted session file | \`$SESSION_FILE\` |
| Workflow | \`$WORKFLOW_NAME\` |
| Run id (short CLI link) | \`$RUN_ID\` |
| Generated at (UTC) | \`$GENERATED_AT\` |

## Helper-generated timeline

| Event | UTC observed | Elapsed evidence |
| --- | --- | --- |
| CLI ready | $CLI_STARTED_AT | source CLI prompt observed |
| Workflow dispatched | $DISPATCHED_AT | $((DISPATCHED_TICK - CLI_STARTED_TICK))s after CLI ready |
| First heartbeat | $FIRST_HEARTBEAT_AT | $((FIRST_HEARTBEAT_TICK - DISPATCHED_TICK))s after dispatch; $FIRST_HEARTBEAT_COUNT card(s) in capture |
| Second heartbeat | $SECOND_HEARTBEAT_AT | $((SECOND_HEARTBEAT_TICK - FIRST_HEARTBEAT_TICK))s after first heartbeat |
| Terminal completion | $TERMINAL_AT | $((TERMINAL_TICK - DISPATCHED_TICK))s after dispatch |
| Terminal quiet capture | $TERMINAL_QUIET_AT | ${TERMINAL_QUIET_AFTER_SECONDS}s after terminal (required >= ${MIN_QUIET_SECONDS}s) |
| First CLI shutdown observed | $SHUTDOWN_AT | shell marker written after CLI returned |
| Restarted CLI restored same run | $RESTART_READY_AT | $((RESTART_READY_TICK - SHUTDOWN_TICK))s after shutdown |
| Post-restart quiet capture | $RESTART_QUIET_AT | ${RESTART_QUIET_AFTER_SECONDS}s after restart (required >= ${MIN_QUIET_SECONDS}s) |

## Assertions performed by the helper

- \`$FIRST_HEARTBEAT_CAPTURE\` contains at least one \`WORKFLOW HEARTBEAT\` card (count: $FIRST_HEARTBEAT_COUNT).
- \`$TERMINAL_CAPTURE\` contains \`WORKFLOW COMPLETE\`.
- \`$TERMINAL_QUIET_CAPTURE\` contains \`WORKFLOW COMPLETE\` and has $TERMINAL_AFTER_HEARTBEATS heartbeat card(s) below it after ${TERMINAL_QUIET_AFTER_SECONDS}s: expected 0.
- \`$SHUTDOWN_MARKER\` was written by the first CLI's shell command after process exit, and a persisted \`.jsonl\` session file existed before restart.
- \`$RESTART_CAPTURE\` contains \`WORKFLOW COMPLETE\` and the same run id \`$RUN_ID\`; it has $RESTART_AFTER_HEARTBEATS heartbeat card(s) below terminal: expected 0.
- \`$RESTART_QUIET_CAPTURE\` contains \`WORKFLOW COMPLETE\` and has $FINAL_AFTER_HEARTBEATS heartbeat card(s) below terminal after ${RESTART_QUIET_AFTER_SECONDS}s: expected 0.

## Captures

| File | Helper step and proof |
| --- | --- |
| \`tmux-01-cli-started.txt\` | Real source CLI reached its interactive prompt. |
| \`tmux-02-run-dispatched.txt\` | Checked-in workflow dispatched and rendered run identity. |
| \`tmux-03-first-heartbeat.txt\` | First 1-minute heartbeat card observed without input. |
| \`tmux-04-second-heartbeat.txt\` | Recurring heartbeat card observed one cadence later. |
| \`tmux-05-run-completed.txt\` | Workflow rendered terminal completion. |
| \`tmux-06-quiet-3min-after-terminal.txt\` | At least three minutes after terminal, no heartbeat below terminal card. |
| \`tmux-07-restart-continue.txt\` | Shutdown had completed; \`--continue\` restored the same terminal run with no stale heartbeat. |
| \`tmux-08-restart-quiet-3min.txt\` | At least three minutes after restart, no stale heartbeat below terminal card. |
EOF

for marker in "WORKFLOW HEARTBEAT" "$WORKFLOW_NAME" "WORKFLOW COMPLETE" "$RUN_ID"; do
	require_marker "$RESTART_QUIET_CAPTURE" "$marker" "final capture marker" || exit 1
done

echo "heartbeat cleanup evidence: terminal silence ${TERMINAL_QUIET_ELAPSED}s; restart silence ${RESTART_QUIET_ELAPSED}s"
echo "heartbeat cleanup evidence: no heartbeat below terminal in terminal quiet, restart, or post-restart captures"
echo "heartbeat cleanup evidence: scenario complete; run $RUN_ID; artifacts in $ARTIFACTS"
