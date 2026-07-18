# LOOP-2 command manifest

All values are placeholders. No secret values, headers, configuration copies, or environment dumps are included.

```sh
git rev-parse HEAD
git status --short
git ls-remote origin refs/heads/main refs/pull/1844/head
git merge-base --is-ancestor <LIVE_MAIN_SHA> HEAD
command -v tmux
tmux -V
bun --version
bun run --cwd packages/coding-agent build
shasum -a 256 packages/coding-agent/dist/cli.js
bun packages/coding-agent/dist/cli.js --list-models gpt-5.6-sol

# Isolated bounded smoke, normal global account state, no inline secret.
(cd <ISOLATED_CWD> && bun <COMPILED_CLI> --model openai-codex/gpt-5.6-sol:off \
  --session-dir <PRIVATE_DIR> --session-id <UUID> --no-tools --no-extensions \
  --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve \
  -p <EXACT_SMALL_PROMPT>)

# Scenario A named tmux process.
tmux new-session -d -s <NAME> -c <PRIVATE_CWD> \
  "env PR1844_LOOP2_EVENT_LOG=<PRIVATE_LOG> PR1844_LOOP2_SIGNAL_PREFIX=<PREFIX> \
  PR1844_LOOP2_LOCAL_WINDOW=<TOKENS> bun <COMPILED_CLI> --model openai-codex/gpt-5.6-sol:off \
  --no-builtin-tools --tools e2e_blob --extension <PUBLIC_EXTENSION> --no-extensions \
  --no-skills --no-prompt-templates --no-themes --no-context-files --approve <SHORT_PROMPT>"
bun <PUBLIC_WAIT_HELPER> <BOUNDED_SECONDS> <TMUX_SIGNAL>
tmux send-keys -t <PANE> -l -- <SHORT_CONTINUATION_PROMPT>
tmux send-keys -t <PANE> Enter
tmux capture-pane -t <PANE> -p -S -<RECENT_LINES>

# Scenario B paired rerun.
sh <PUBLIC_ROOT>/harness/run-cache-pair.sh <1|2|3> <REPO>
bun <PUBLIC_ROOT>/harness/analyze-run.ts <RUN_ROOT>

# Final local-only indexing after private chmod.
bun <PUBLIC_ROOT>/harness/index-raw.ts <RUN_ROOT>

# Fragmented all-public scan (fragments intentionally prevent self-match).
P='author''ization|bear''er|a''pi[ _-]?k''ey|acc''ess|refr''esh|client[ _-]?secr''et|sk''-|session[ _-]?tok''en|cook''ie|private[ _-]?k''eys?|auth[.]j''son|BEGIN [A-Z ]*PRIVATE K''EY'
rg -n -i "$P" <PUBLIC_ROOT>
```

Harness environment names are `PR1844_LOOP2_EVENT_LOG`, `PR1844_LOOP2_SIGNAL_PREFIX`, and `PR1844_LOOP2_LOCAL_WINDOW`. All full event logs, workloads, sessions, diagnostics, and panes remain private under the ignored raw tree.
