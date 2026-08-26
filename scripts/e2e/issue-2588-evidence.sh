#!/usr/bin/env bash
# Real built-CLI tmux proof for issue #2588.
# Usage: bash scripts/e2e/issue-2588-evidence.sh <tmux-session> <artifact-dir>

set -euo pipefail

SESSION="${1:?usage: issue-2588-evidence.sh <tmux-session> <artifact-dir>}"
ARTIFACTS="${2:?usage: issue-2588-evidence.sh <tmux-session> <artifact-dir>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/test/integration/fixtures/issue-2588-model-server.ts"
CLI="$REPO_ROOT/packages/coding-agent/dist/cli.js"
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
NODE="${ATOMIC_NODE_EXECUTABLE:-node}"
PARENT_MARKER="ISSUE-2588-PARENT-BURST"
PARENT_DONE="ISSUE-2588-PARENT-DONE"
RESULT_A="ISSUE-2588-RESULT-A"
RESULT_B="ISSUE-2588-RESULT-B"
REJECTION="Rejected: a subagent call is already in progress"

if ! command -v tmux >/dev/null 2>&1; then
	echo "issue-2588 evidence: tmux is required" >&2
	exit 1
fi
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "issue-2588 evidence: bun was not found on PATH" >&2
	exit 1
fi
if ! command -v "$NODE" >/dev/null 2>&1; then
	echo "issue-2588 evidence: node was not found on PATH" >&2
	exit 1
fi
if [[ ! -f "$CLI" ]]; then
	echo "issue-2588 evidence: built CLI missing at $CLI; run npm run build --workspace=@bastani/atomic" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/issue-2588-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
STATE="$WORKDIR/state"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/agents" "$STATE" "$AGENT"
printf '%s\n' "$WORKDIR" >"$ARTIFACTS/workdir.txt"

cat >"$PROJECT/.atomic/agents/issue-2588-a.md" <<'MARKDOWN'
---
name: issue-2588-a
description: Deterministic issue 2588 child A
inheritProjectContext: false
inheritSkills: false
tools: read
---
Return ISSUE-2588-RESULT-A.
MARKDOWN
cat >"$PROJECT/.atomic/agents/issue-2588-b.md" <<'MARKDOWN'
---
name: issue-2588-b
description: Deterministic issue 2588 child B
inheritProjectContext: false
inheritSkills: false
tools: read
---
Return ISSUE-2588-RESULT-B.
MARKDOWN

capture() { tmux capture-pane -p -t "$SESSION"; }
capture_all() { tmux capture-pane -p -S - -t "$SESSION"; }

refuse_rejection() {
	local where="$1"
	if capture_all | grep -qF -- "$REJECTION"; then
		echo "issue-2588 evidence: duplicate-in-progress rejection appeared while $where" >&2
		capture_all >"$ARTIFACTS/failure-rejection.txt"
		return 1
	fi
}

await_text() {
	local needle="$1" label="$2" timeout="${3:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if capture_all | grep -qF -- "$needle"; then return 0; fi
		refuse_rejection "waiting for $label"
		sleep 1
	done
	echo "issue-2588 evidence: timed out after ${timeout}s waiting for $label" >&2
	capture_all >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

"$BUN" "$FIXTURE" "$STATE" >"$ARTIFACTS/model-server.log" 2>&1 &
MODEL_PORT=""
for _ in $(seq 1 120); do
	if [[ -s "$STATE/model-port" ]]; then
		MODEL_PORT="$(cat "$STATE/model-port")"
		break
	fi
	sleep 0.5
done
if [[ -z "$MODEL_PORT" ]]; then
	echo "issue-2588 evidence: the model endpoint never published a port" >&2
	exit 1
fi

cat >"$AGENT/models.json" <<JSON
{
  "providers": {
    "issue2588": {
      "baseUrl": "http://127.0.0.1:$MODEL_PORT/v1",
      "apiKey": "issue-2588-test-key",
      "api": "openai-responses",
      "models": [
        {
          "id": "issue-2588-model",
          "name": "issue-2588-model",
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
  "defaultProvider": "issue2588",
  "defaultModel": "issue-2588-model",
  "lastChangelogVersion": "0.0.0",
  "firstRunOnboardingStartedVersion": "0.0.0",
  "onboardedVersion": "0.0.0"
}
JSON

CLI_COMMAND="cd '$PROJECT' && NODE_ENV=production ATOMIC_CODING_AGENT_DIR='$AGENT' ATOMIC_SKIP_VERSION_CHECK=1 '$NODE' '$CLI' --approve --offline --no-session"
printf '%s\n' "$CLI_COMMAND" >"$ARTIFACTS/cli-command.txt"
tmux send-keys -t "$SESSION" -l -- "$CLI_COMMAND"
tmux send-keys -t "$SESSION" Enter
await_text "issue-2588-model •" "the built CLI to start on the stub model" 240

# One user turn. The endpoint responds with two sibling SINGLE subagent calls.
tmux send-keys -t "$SESSION" -l -- "$PARENT_MARKER"
tmux send-keys -t "$SESSION" Enter
await_text "$PARENT_DONE" "the parent to receive both child results" 240
await_text "COALESCED PARALLEL RUN: 2 children" "the two-child proof line" 60
await_text "$RESULT_A" "child A result" 60
await_text "$RESULT_B" "child B result" 60
refuse_rejection "checking the completed run"

RAW_CAPTURE="$ARTIFACTS/coalesced-parallel.txt"
ANSI_CAPTURE="$ARTIFACTS/coalesced-parallel.ansi"
tmux capture-pane -p -t "$SESSION" -S - >"$RAW_CAPTURE"
tmux capture-pane -p -e -t "$SESSION" -S - >"$ANSI_CAPTURE"

for needle in "$PARENT_DONE" "COALESCED PARALLEL RUN: 2 children" "$RESULT_A" "$RESULT_B"; do
	if ! grep -qF -- "$needle" "$RAW_CAPTURE"; then
		echo "issue-2588 evidence: raw capture is missing $needle" >&2
		exit 1
	fi
done
if grep -qF -- "$REJECTION" "$RAW_CAPTURE"; then
	echo "issue-2588 evidence: raw capture contains the duplicate-in-progress rejection" >&2
	exit 1
fi
if ! grep -q '^1:parent-burst$' "$STATE/requests.log"; then
	echo "issue-2588 evidence: first model request was not the parent burst" >&2
	exit 1
fi
for request_class in child-a child-b; do
	if [[ "$(grep -c ":${request_class}$" "$STATE/requests.log")" -ne 1 ]]; then
		echo "issue-2588 evidence: expected one $request_class request" >&2
		cat "$STATE/requests.log" >&2
		exit 1
	fi
done
if [[ "$(grep -c ':parent-final$' "$STATE/requests.log")" -lt 1 ]]; then
	echo "issue-2588 evidence: parent never received both child results" >&2
	cat "$STATE/requests.log" >&2
	exit 1
fi
cp "$STATE/requests.log" "$ARTIFACTS/requests.txt"

echo "issue-2588 evidence: real built CLI scenario passed; artifacts in $ARTIFACTS"
