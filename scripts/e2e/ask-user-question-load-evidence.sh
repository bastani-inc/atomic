#!/usr/bin/env bash
#
# Live keystroke-to-paint check for the ask_user_question dialog under real background load (#4333).
#
# Usage: [AQ_LOAD_WORKERS=8] [AQ_LOAD_CHILDREN=24] [AQ_LOAD_SUBAGENTS=4] [AQ_LOAD_STREAM_SECONDS=30] \
#          [AQ_LOAD_SUBAGENT_STREAM_SECONDS=300] [AQ_LOAD_STEADY=1] [AQ_LOAD_CLI_ENTRY=<path to dist/cli.js>] \
#          bash scripts/e2e/ask-user-question-load-evidence.sh <tmux-session-name> <artifact-dir> [keystrokes]
#
# The tmux session already exists (make it large, for example 200x70) and belongs to the caller; this script
# types into its pane and reads it back, and never creates, kills or detaches it.
#
# It drives the BUILT CLI (`packages/coding-agent/dist/cli.js`, from `npm run build` in packages/coding-agent) under
# node. A pooled run needs it: the source worker entry loads its module graph through jiti and takes seconds of CPU
# per worker, which the pool's startup timeout does not allow for with many workers.
#
# Scenario, against a stand-in model endpoint on 127.0.0.1:
#
#   settings: workflows.localWorkers    AQ_LOAD_WORKERS worker processes, with the child workflow as their definition
#   /workflow ask-user-question-load-pool
#                                       a root that starts AQ_LOAD_CHILDREN child workflows on the pool; each child's
#                                       agent stage streams for AQ_LOAD_STREAM_SECONDS, so children keep finishing and
#                                       new ones keep starting
#   AQ-LOAD-MAIN prompt                 the endpoint answers with a background `subagent` call (AQ_LOAD_SUBAGENTS
#                                       streaming subagents), then with `ask_user_question`: four questions, two with
#                                       previews, one multi-select and one plain
#   keys                                arrows, tab switches, a multi-select toggle and a typed custom answer
#
# Before the first key the script proves the pool exists: the CLI's own process tree must hold one pool coordinator
# and at least one worker (`pool.txt`), or it exits non-zero. It reads only that tree, never other processes.
#
# For every key it records the time from `tmux send-keys` to the first pane capture whose dialog region differs
# from the region before the key. The dialog is the bottom overlay starting at its tab bar (" ← "); streamed
# output above it does not count as a paint. Latencies go to <artifact-dir>/latencies-ms.txt and a summary to
# <artifact-dir>/summary.txt. AQ_LOAD_STEADY=1 holds the keys until every pooled stage and subagent is streaming, so
# the startup burst stays out of the measurement.

set -euo pipefail

SESSION="${1:?usage: ask-user-question-load-evidence.sh <tmux-session-name> <artifact-dir> [keystrokes]}"
ARTIFACTS="${2:?usage: ask-user-question-load-evidence.sh <tmux-session-name> <artifact-dir> [keystrokes]}"
KEYSTROKES="${3:-120}"
# Background load: pool workers and the child workflows queued on them, and the subagents the main chat starts.
# The stand-in endpoint reads AQ_LOAD_SUBAGENTS, AQ_LOAD_STREAM_SECONDS and AQ_LOAD_SUBAGENT_STREAM_SECONDS.
WORKERS="${AQ_LOAD_WORKERS:-8}"
CHILDREN="${AQ_LOAD_CHILDREN:-$((WORKERS * 3))}"
export AQ_LOAD_SUBAGENTS="${AQ_LOAD_SUBAGENTS:-4}"
export AQ_LOAD_STREAM_SECONDS="${AQ_LOAD_STREAM_SECONDS:-30}"
export AQ_LOAD_SUBAGENT_STREAM_SECONDS="${AQ_LOAD_SUBAGENT_STREAM_SECONDS:-300}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$REPO_ROOT/test/integration/fixtures"
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
NODE="${ATOMIC_NODE_EXECUTABLE:-node}"
CLI_ENTRY="${AQ_LOAD_CLI_ENTRY:-$REPO_ROOT/packages/coding-agent/dist/cli.js}"
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "aq-load evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi
if ! command -v "$NODE" >/dev/null 2>&1; then
	echo "aq-load evidence: node was not found on PATH; set ATOMIC_NODE_EXECUTABLE" >&2
	exit 1
fi
if [[ ! -f "$CLI_ENTRY" ]]; then
	echo "aq-load evidence: the built CLI is missing at $CLI_ENTRY; run 'npm run build' in packages/coding-agent" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/aq-load-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
STATE="$WORKDIR/state"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/workflows" "$STATE" "$AGENT"
cp "$FIXTURES/ask-user-question-load-workflow.ts" "$PROJECT/.atomic/workflows/"
# Outside .atomic/workflows: the child is a worker definition, not a workflow to list.
CHILD_MODULE="$PROJECT/aq-load-child.ts"
cp "$FIXTURES/ask-user-question-load-child.ts" "$CHILD_MODULE"

step=0
capture() { tmux capture-pane -p -t "$SESSION"; }
save() {
	step=$((step + 1))
	capture >"$ARTIFACTS/$(printf '%02d' "$step")-$1.txt"
}
await() {
	local needle="$1" label="$2" timeout="${3:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if capture | grep -qF -- "$needle"; then return 0; fi
		sleep 0.5
	done
	echo "aq-load evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}
type_line() {
	tmux send-keys -t "$SESSION" -l "$1"
	sleep 0.5
	tmux send-keys -t "$SESSION" Enter
	sleep 0.5
	if capture | grep -qF -- "❯ $1"; then
		tmux send-keys -t "$SESSION" Enter
		sleep 0.5
	fi
}

# 1. The stand-in endpoint. The port file is its readiness signal.
"$BUN" "$FIXTURES/ask-user-question-load-model-server.ts" "$STATE" >"$ARTIFACTS/model-server.log" 2>&1 &
MODEL_SERVER_PID=$!
trap 'kill "$MODEL_SERVER_PID" 2>/dev/null || true' EXIT
MODEL_PORT=""
for _ in $(seq 1 120); do
	if [[ -s "$STATE/model-port" ]]; then
		MODEL_PORT="$(cat "$STATE/model-port")"
		break
	fi
	sleep 0.5
done
[[ -n "$MODEL_PORT" ]] || { echo "aq-load evidence: the stand-in endpoint never published a port" >&2; exit 1; }

cat >"$AGENT/models.json" <<JSON
{
  "providers": {
    "aqload": {
      "baseUrl": "http://127.0.0.1:$MODEL_PORT/v1",
      "apiKey": "aq-load-test-key",
      "api": "openai-responses",
      "models": [
        {
          "id": "aqload-model",
          "name": "aqload-model",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 64000,
          "maxTokens": 4096
        }
      ]
    }
  }
}
JSON
# maxLoadPerCpu 0 keeps the pool from pacing stage starts on a busy machine, which would throttle the load itself.
cat >"$AGENT/settings.json" <<JSON
{
  "defaultProvider": "aqload",
  "defaultModel": "aqload-model",
  "lastChangelogVersion": "0.0.0",
  "firstRunOnboardingStartedVersion": "0.0.0",
  "onboardedVersion": "0.0.0",
  "workflows": {
    "localWorkers": {
      "count": $WORKERS,
      "definitions": [{ "path": "$CHILD_MODULE", "exportName": "child" }],
      "maxLoadPerCpu": 0,
      "startupTimeoutMs": 300000
    }
  }
}
JSON

# 2. The built CLI, in a scratch project with an isolated agent directory and journal. Pool workers inherit this
#    environment, so they reach the same agent directory and stand-in endpoint.
#    NODE_ENV is pinned away from "test", which would give workflow stages a stub session.
tmux send-keys -t "$SESSION" -l \
	"cd '$PROJECT' && NODE_ENV=production AQ_LOAD_CHILDREN='$CHILDREN' AQ_LOAD_CHILD_MODULE='$CHILD_MODULE' ATOMIC_CODING_AGENT_DIR='$AGENT' ATOMIC_SKIP_VERSION_CHECK=1 '$NODE' '$CLI_ENTRY' --approve --offline --no-session"
tmux send-keys -t "$SESSION" Enter
await "aqload-model" "the CLI to start on the stand-in model" 240
save "cli-started"

# 3. Background load: the pooled workflow, then the main prompt that starts the subagents and asks.
type_line "/workflow ask-user-question-load-pool"
await "\"ask-user-question-load-pool\" started" "the pooled workflow to start" 120

# The pool, proved from the CLI's own process tree: one coordinator and the workers, each started with its
# definitions. The workers must also be the ones streaming, which the endpoint's counter shows.
PANE_PID="$(tmux display-message -p -t "$SESSION" '#{pane_pid}')"
tree_args() {
	ps -eo pid=,ppid=,args= | awk -v root="$PANE_PID" '
		{ pid = $1; parent[pid] = $2; $1 = ""; $2 = ""; args[pid] = $0 }
		END {
			for (p in parent) {
				q = p
				while (q != "" && q != 0) {
					if (q == root) { print args[p]; break }
					q = parent[q]
				}
			}
		}'
}
count_matching() { grep -c -- "$1" || true; }
POOL_COORDINATORS=0
POOL_WORKERS=0
for _ in $(seq 1 240); do
	TREE="$(tree_args)"
	POOL_COORDINATORS="$(count_matching '"role":"pool-coordinator"' <<<"$TREE")"
	POOL_WORKERS="$(grep -- '"definitions"' <<<"$TREE" | grep -vc -- '"role":"pool-coordinator"' || true)"
	((POOL_COORDINATORS >= 1 && POOL_WORKERS >= WORKERS)) && break
	sleep 0.5
done
# The journal directory sits beside the agent directory, and holds one stderr log per worker.
WORKER_LOGS="$(find "$WORKDIR" -path '*worker-logs*' -type f 2>/dev/null | wc -l | tr -d ' ')"
{
	echo "pool coordinators in the CLI's process tree: $POOL_COORDINATORS"
	echo "pool workers in the CLI's process tree: $POOL_WORKERS (configured: $WORKERS)"
	echo "worker log files: $WORKER_LOGS"
	echo "child workflows queued: $CHILDREN, each streaming for ${AQ_LOAD_STREAM_SECONDS}s"
	echo "CLI entry: $CLI_ENTRY"
} >"$ARTIFACTS/pool.txt"
if ((POOL_COORDINATORS < 1 || POOL_WORKERS < 1)); then
	echo "aq-load evidence: the workflow did not run on a local worker pool (see $ARTIFACTS/pool.txt)" >&2
	capture >"$ARTIFACTS/failure-no-pool.txt"
	exit 1
fi
streams_started() { cat "$STATE/streams-started" 2>/dev/null || echo 0; }
for _ in $(seq 1 240); do
	(($(streams_started) >= 1)) && break
	sleep 0.5
done
if (($(streams_started) < 1)); then
	echo "aq-load evidence: no pooled stage reached the stand-in endpoint, so the workers are not streaming" >&2
	capture >"$ARTIFACTS/failure-no-streaming.txt"
	exit 1
fi
save "pool-streaming"
type_line "AQ-LOAD-MAIN start the subagents, then ask me the questions"
await "Which architecture should the service use?" "the questionnaire" 180
sleep 3
# With AQ_LOAD_STEADY=1 the keys wait until every pooled stage and subagent is streaming, so startup bursts
# (sessions being created) are kept out of the measurement.
if [[ "${AQ_LOAD_STEADY:-0}" == 1 ]]; then
	for _ in $(seq 1 600); do
		(($(streams_started) >= WORKERS + AQ_LOAD_SUBAGENTS)) && break
		sleep 0.5
	done
fi
save "question-mounted"
STREAMS_AT_START="$(streams_started)"

# 4. Keystroke-to-paint. One loop of the key cycle returns the dialog to its starting state, so it repeats.
KEYS=(Down Down Up Up Tab Down Up Tab Down Space Space Up Tab Down Down Down Down a b c BSpace BSpace BSpace Up Up Up Up BTab BTab BTab)
dialog_region() { capture | sed -n '/^ ← /,$p'; }
now_ns() { date +%s%N; }
: >"$ARTIFACTS/latencies-ms.txt"
missed=0
for ((i = 0; i < KEYSTROKES; i++)); do
	key="${KEYS[$((i % ${#KEYS[@]}))]}"
	before="$(dialog_region)"
	if [[ "$key" =~ ^[a-z]$ ]]; then
		start=$(now_ns)
		tmux send-keys -t "$SESSION" -l "$key"
	else
		start=$(now_ns)
		tmux send-keys -t "$SESSION" "$key"
	fi
	painted=""
	while (($(now_ns) - start < 5000000000)); do
		if [[ "$(dialog_region)" != "$before" ]]; then
			painted=$(now_ns)
			break
		fi
	done
	if [[ -z "$painted" ]]; then
		missed=$((missed + 1))
		capture >"$ARTIFACTS/missed-key-$i.txt"
		continue
	fi
	echo $(((painted - start) / 1000)) | awk '{ printf "%.1f\n", $1 / 1000 }' >>"$ARTIFACTS/latencies-ms.txt"
	sleep 0.03
done
save "after-keys"
STREAMS_AT_END="$(streams_started)"

sort -n "$ARTIFACTS/latencies-ms.txt" | awk -v missed="$missed" -v streams_start="$STREAMS_AT_START" -v streams_end="$STREAMS_AT_END" '
	{ v[NR] = $1 }
	END {
		n = NR
		i50 = int(0.50 * n + 0.999999); if (i50 < 1) i50 = 1
		i95 = int(0.95 * n + 0.999999); if (i95 < 1) i95 = 1
		i99 = int(0.99 * n + 0.999999); if (i99 < 1) i99 = 1
		printf "keystrokes measured: %d, missed (no paint within 5 s): %d\n", n, missed
		printf "p50 %.1f ms, p95 %.1f ms, p99 %.1f ms, max %.1f ms\n", v[i50], v[i95], v[i99], v[n]
		printf "streaming turns started (pooled stages + subagents): %s at the first key, %s at the last\n", streams_start, streams_end
	}' | tee "$ARTIFACTS/summary.txt"
{
	echo "pool: $POOL_COORDINATORS coordinator, $POOL_WORKERS workers (workflows.localWorkers.count $WORKERS), $CHILDREN child workflows queued, $AQ_LOAD_SUBAGENTS background subagents"
} | tee -a "$ARTIFACTS/summary.txt"

# 5. Leave the dialog: Escape cancels the questionnaire.
tmux send-keys -t "$SESSION" Escape
if ((missed > 0)); then
	echo "aq-load evidence: $missed keys produced no paint within 5 s; see $ARTIFACTS/summary.txt and missed-key snapshots" >&2
	exit 1
fi
echo "aq-load evidence: scenario complete; artifacts in $ARTIFACTS"
