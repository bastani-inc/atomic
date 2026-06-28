# Atomic Evals

## Run Pier with Atomic

From this `evals/` directory:

```bash
export COPILOT_GITHUB_TOKEN="..."

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model github-copilot/gpt-5.5 \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=next \
  --n-tasks 1 \
  --sample-seed 0
```

The Atomic Pier adapter reads `COPILOT_GITHUB_TOKEN` from the Pier process environment and passes it into the sandbox for Atomic. If your launcher does not inherit shell exports, pass it explicitly with `--agent-env COPILOT_GITHUB_TOKEN=...` instead.

`version=next` installs `@bastani/atomic@next` inside the sandbox. Omit it for `@latest`, or pass a concrete npm version/tag without the leading `@` (for example `--agent-kwarg version=0.9.3-alpha.1`).

For GitHub Copilot in `allow_internet = false` tasks, the Pier adapter follows:

1. `COPILOT_API_TARGET` if provided (host or URL)
2. `GITHUB_COPILOT_BASE_URL` if provided (host or URL)
3. `GITHUB_SERVER_URL` routing:
    - `https://github.com` → `https://api.githubcopilot.com`
    - `https://<tenant>.ghe.com` → `https://copilot-api.<tenant>.ghe.com`
    - other GitHub Enterprise Server domains → `https://api.enterprise.githubcopilot.com`

If you see `421 Misdirected Request`, force the target explicitly:

```bash
uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model github-copilot/gpt-5.5 \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=next \
  --agent-env COPILOT_API_TARGET=api.githubcopilot.com \
  --n-tasks 1 \
  --sample-seed 0
```

For GHES use `COPILOT_API_TARGET=api.enterprise.githubcopilot.com`; for GHEC use `COPILOT_API_TARGET=copilot-api.<tenant>.ghe.com`.

The adapter is self-contained; it does not require patching Pier. It follows the Harbor/Pier installed-agent pattern: install Atomic plus required local search tools (`rg`/`fd`) during setup, run the CLI, tee its JSON stream to `/logs/agent/atomic.txt`, and collect usage/trajectory data from the logs. Like the built-in Pier agents, it does not auto-commit work; Deep SWE tasks rely on the agent following the instruction to commit.

Use `--n-tasks`/`--include-task-name` to control which Deep SWE tasks run.
