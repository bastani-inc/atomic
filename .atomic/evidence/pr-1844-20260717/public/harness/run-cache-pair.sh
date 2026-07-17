#!/bin/sh
set -eu
umask 077

N="$1"
REPO="$2"
ROOT="$REPO/.atomic/evidence/pr-1844-20260717"
RAW="$ROOT/raw"
EXT="$ROOT/public/harness/e2e-extension.ts"
WAIT="$ROOT/public/harness/wait-for.ts"
CLI="$REPO/packages/coding-agent/dist/cli.js"

case "$N" in
  2r)
    WID='b1844022-0000-4000-8000-000000000022'
    CID='c1844022-0000-4000-8000-000000000022'
    ;;
  5)
    WID='b1844050-0000-4000-8000-000000000050'
    CID='c1844050-0000-4000-8000-000000000050'
    ;;
  6)
    WID='b1844060-0000-4000-8000-000000000060'
    CID='c1844060-0000-4000-8000-000000000060'
    ;;
  *)
    echo 'sample ID must be one of: 2r, 5, 6' >&2
    exit 2
    ;;
esac

WD="$RAW/workload/scenario-b-$N"
WSD="$RAW/sessions/b-warm-$N"
CSD="$RAW/sessions/b-cold-$N"
rm -rf "$WD" "$WSD" "$CSD"
mkdir -m 700 -p "$WD/.atomic" "$WSD" "$CSD"
printf '%s\n' '{"compaction":{"enabled":true,"reserveTokens":16384,"compression_ratio":0.05,"preserve_recent":2}}' > "$WD/.atomic/settings.json"
chmod 600 "$WD/.atomic/settings.json"

WFILE=$(bun "$ROOT/public/harness/seed-history.ts" "$WSD" "$WD" "$WID" 8 40)
WLOG="$RAW/b-warm-$N-events.jsonl"
: > "$WLOG"
chmod 600 "$WLOG"
WS="pr1844-b-warm-$N"
tmux kill-session -t "$WS" 2>/dev/null || true
tmux new-session -d -s "$WS" -c "$WD" "env PR1844_EVENT_LOG='$WLOG' PR1844_SIGNAL_PREFIX='bw$N' bun '$CLI' --model openai-codex/gpt-5.6-sol:off --session-dir '$WSD' --session '$WFILE' --no-tools --extension '$EXT' --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --approve 'Reply exactly PREFIX_READY pr1844-2r.'"
bun "$WAIT" 120 "bw$N-turn-0"
cp "$WFILE" "$RAW/b-pair-$N-precompact.jsonl"
chmod 600 "$RAW/b-pair-$N-precompact.jsonl"
CFILE=$(bun "$ROOT/public/harness/clone-session.ts" "$WFILE" "$CSD" "$CID")
tmux send-keys -t "$WS":0.0 -l -- '/compact'
tmux send-keys -t "$WS":0.0 Enter
bun "$WAIT" 240 "bw$N-compacted"
tmux capture-pane -t "$WS":0.0 -p -S -80 > "$RAW/b-warm-$N-pane.txt"
chmod 600 "$RAW/b-warm-$N-pane.txt"

CLOG="$RAW/b-cold-$N-events.jsonl"
: > "$CLOG"
chmod 600 "$CLOG"
CS="pr1844-b-cold-$N"
tmux kill-session -t "$CS" 2>/dev/null || true
tmux new-session -d -s "$CS" -c "$WD" "env PR1844_EVENT_LOG='$CLOG' PR1844_SIGNAL_PREFIX='bc$N' bun '$CLI' --model openai-codex/gpt-5.6-sol:off --session-dir '$CSD' --session '$CFILE' --no-tools --extension '$EXT' --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --approve"
bun "$WAIT" 60 "bc$N-session-start"
tmux send-keys -t "$CS":0.0 -l -- '/compact'
tmux send-keys -t "$CS":0.0 Enter
bun "$WAIT" 240 "bc$N-compacted"
tmux capture-pane -t "$CS":0.0 -p -S -80 > "$RAW/b-cold-$N-pane.txt"
chmod 600 "$RAW/b-cold-$N-pane.txt"
tail -1 "$WLOG"
tail -1 "$CLOG"
