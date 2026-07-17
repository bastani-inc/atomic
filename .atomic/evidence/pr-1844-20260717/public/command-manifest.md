# Command manifest

Values below are placeholders; no credentials, environment values, headers, or auth files are included.

```sh
command -v tmux
tmux -V
git rev-parse HEAD
git status --short
git diff --binary | shasum -a 256
bun --version

# Historical invalid-order attempt (failed; not validation)
bun --cwd packages/coding-agent run build
# Canonical builds
bun run --cwd packages/coding-agent build

bun packages/coding-agent/dist/cli.js --list-models gpt-5.6-sol
bun packages/coding-agent/dist/cli.js --model openai-codex/gpt-5.6-sol:off --session-dir <DIR> --session-id <UUID> --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve -p <SMALL_PROMPT>

# Scenario processes (all use the compiled CLI)
tmux new-session -d -s <NAME> -c <ISOLATED_CWD> "env PR1844_EVENT_LOG=<RAW_PATH> PR1844_SIGNAL_PREFIX=<NAME> PR1844_LOCAL_WINDOW=<TOKENS> bun <COMPILED_CLI> ..."
bun public/harness/wait-for.ts <TIMEOUT_SECONDS> <SIGNAL>
tmux send-keys -t <PANE> -l -- <SMALL_PROMPT_OR_COMMAND>
tmux send-keys -t <PANE> Enter
tmux capture-pane -t <PANE> -p -S -<RECENT_LINES>

bun public/harness/seed-history.ts <RAW_SESSION_DIR> <RAW_WORKLOAD_DIR> <UUID> <PAIRS> <LINES>
bun public/harness/clone-session.ts <SOURCE> <RAW_DEST_DIR> <KEY_ISOLATED_UUID>
sh public/harness/run-cache-pair.sh <2r|5|6> <REPO>
bun public/harness/analyze-run.ts <RUN_ROOT>

# Run only after final private writes, scan, and chmod.
bun public/harness/index-raw.ts <RUN_ROOT>
# Sanitization and inspection
P='<fragmented secret pattern>'
rg -n -i "$P" public
find public -type f -maxdepth <N> -print
bun <run-specific scalar validation script>
```

Environment variable names used by the run-specific harness: `PR1844_EVENT_LOG`, `PR1844_SIGNAL_PREFIX`, and `PR1844_LOCAL_WINDOW`. Global coding-agent home was never overridden, so stored credentials remained in their normal location. No inline credential flag was used.
