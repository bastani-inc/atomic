# Atomic Evals

Utilities and adapters for running Atomic against evaluation suites such as Deep SWE through Pier.

## Run Pier with Atomic

Run commands from this `evals/` directory. Choose one provider configuration below, then pass `atomic_pier:Atomic` as the agent import path.

Common options:

- `--agent-kwarg version=next` installs `@bastani/atomic@next` inside the sandbox. Omit it for `@latest`, or pass a concrete npm version/tag without the leading `@` (for example `--agent-kwarg version=0.9.3-alpha.1`).
- `--agent-kwarg thinking=xhigh` configures Atomic's reasoning level for models that support it.
- `--n-tasks` and `--include-task-name` control which Deep SWE tasks run.

## Providers

### GitHub Copilot

Export a Copilot token and use the `github-copilot/` provider prefix:

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

For GitHub Copilot in `allow_internet = false` tasks, the Pier adapter routes API traffic using the first available option:

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

### OpenRouter

Export an OpenRouter API key and use an OpenRouter model slug after the `openrouter/` provider prefix:

```bash
export OPENROUTER_API_KEY="..."

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model openrouter/anthropic/claude-sonnet-4.5 \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=next \
  --n-tasks 1 \
  --sample-seed 0
```

The Atomic Pier adapter reads `OPENROUTER_API_KEY` from the Pier process environment and passes it into the sandbox for Atomic. If your launcher does not inherit shell exports, pass it explicitly with `--agent-env OPENROUTER_API_KEY=...` instead.

The Pier network allowlist automatically includes `openrouter.ai` when the model provider is `openrouter`. To use a custom OpenRouter-compatible endpoint, pass it with `--agent-env OPENROUTER_BASE_URL=...`.

## Adapter behavior

The adapter is self-contained; it does not require patching Pier. It follows the Harbor/Pier installed-agent pattern:

1. Install Atomic and required local search tools (`rg` and `fd`) during setup.
2. Run the Atomic CLI in JSON mode.
3. Tee Atomic's JSON stream to `/logs/agent/atomic.txt`.
4. Collect usage and trajectory data from the logs.

Like the built-in Pier agents, it does not auto-commit work. Deep SWE tasks rely on the agent following the task instruction to commit.
