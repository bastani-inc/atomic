# Atomic Evals

Utilities and adapters for running Atomic against evaluation suites such as Deep SWE through Pier.

## Run Pier with Atomic

Run commands from this `evals/` directory. Choose one provider configuration below, then pass `atomic_pier:Atomic` as the agent import path.

Common options:

- `--agent-kwarg version=next` installs `@bastani/atomic@next` inside the sandbox. Omit it for `@latest`, or pass a concrete npm version/tag without the leading `@` (for example `--agent-kwarg version=0.9.3-alpha.1`).
- `--force-build` rebuilds the task image so the `npm install -g @bastani/atomic@...` layer re-runs. Without it, Docker layer caching reuses a previously installed Atomic even after a new version is published to the tag, so benchmark runs can silently test a stale build. All commands below include it.
- `--agent-kwarg thinking=xhigh` configures Atomic's reasoning level for models that support it.
- `--n-tasks` and `--include-task-name` control which Deep SWE tasks run.

## Timeouts

Deep SWE tasks set `[agent] timeout_sec = 5400.0` (1.5 hours) in each `task.toml`. Pass `--agent-timeout-multiplier 16` to raise the agent deadline to 1 day (5400 × 16 = 86,400 s) without modifying the tasks; the commands below include it. The multiplier only scales the agent execution timeout — verifier, agent-setup, and environment-build timeouts are unaffected. Pier has no flag to disable the timeout entirely (a multiplier of `0` times out immediately), so a large multiplier is the supported way to run effectively untimed. The same flag works for Harbor runs with `atomic_harbor:Atomic`.

## Smoke check (1 task, full debug logging)

Use this before a long run to validate provider credentials, the sandbox install, and log capture. It runs a single deterministic task serially with Pier's debug logging enabled (`--debug` is Pier's only log-verbosity flag; `--n-concurrent 1` keeps the console output readable, and `--job-name` pins a predictable output directory). `--no-delete` persists the trial containers after completion so you can inspect the sandbox state post-mortem (remove them manually with `docker rm` when done):

```bash
uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model github-copilot/gpt-5.5 \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=next \
  --agent-timeout-multiplier 16 \
  --job-name atomic-smoke \
  --n-tasks 1 \
  --sample-seed 0 \
  --n-concurrent 1 \
  --force-build \
  --no-delete \
  --debug
```

Inspect the results under `jobs/atomic-smoke/`: each trial directory contains the agent logs (including Atomic's full JSON stream in `agent/atomic.txt` and session transcripts in `agent/atomic-sessions/`), `trajectory.json`, verifier output, and any exception message. Swap the model/provider flags per the Providers section below.

## Full benchmark

Run every Deep SWE task (omit `--n-tasks` to run all tasks in the path):

```bash
uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model github-copilot/gpt-5.5 \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=next \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --n-concurrent 4 \
  --sample-seed 0 \
  --force-build
```

Add `--n-attempts <k>` for pass@k-style repeats. Sizing `--n-concurrent`: each trial's containers are capped at 2 CPUs / 8 GB but typically peak at 2–4 GB, so give the Docker VM at least **4 GB of memory and 2 CPUs per concurrent trial** (e.g. `--n-concurrent 4` wants a ≥ 16 GB / 8-CPU Docker VM); Pier does not schedule against host capacity, and overcommitting memory surfaces as confusing mid-run OOM kills. A single Copilot token also tends to rate-limit beyond ~4–6 concurrent agents. Interrupted jobs resume where they left off: re-run the same command with the same `--job-name` (the config must match), or use `uv run pier job resume -p jobs/atomic-deep-swe`.

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
  --agent-timeout-multiplier 16 \
  --n-tasks 1 \
  --sample-seed 0 \
  --force-build
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
  --agent-timeout-multiplier 16 \
  --n-tasks 1 \
  --sample-seed 0 \
  --force-build
```

For GHES use `COPILOT_API_TARGET=api.enterprise.githubcopilot.com`; for GHEC use `COPILOT_API_TARGET=copilot-api.<tenant>.ghe.com`.

### Anthropic subscription with OpenRouter fallback

Export `ANTHROPIC_OAUTH_TOKEN` to run Anthropic models through the subscription OAuth path. Also export `OPENROUTER_API_KEY` if you want the adapters to fall back to the equivalent `openrouter/anthropic/...` model when the subscription token is unavailable:

```bash
export ANTHROPIC_OAUTH_TOKEN="..."
export OPENROUTER_API_KEY="..."  # optional fallback

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model anthropic/claude-opus-4-8 \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=next \
  --agent-timeout-multiplier 16 \
  --n-tasks 1 \
  --sample-seed 0 \
  --force-build
```

The native Anthropic provider uses dash-form model ids such as `claude-opus-4-8`; when falling back, the adapters translate version suffixes to OpenRouter's matching dot-form slugs such as `openrouter/anthropic/claude-opus-4.8`.

### OpenAI Codex subscription with OpenRouter fallback

For `openai-codex/...` models, Atomic uses OAuth credentials stored in the agent auth file rather than an environment variable. Log in on the host so `~/.atomic/agent/auth.json` (or legacy `~/.pi/agent/auth.json`) contains an `openai-codex` entry. The Pier and Harbor adapters copy only that provider entry into the sandbox user's `~/.atomic/agent/auth.json` with `0600` permissions before launching Atomic. Export `OPENROUTER_API_KEY` if you want missing Codex subscription auth to fall back to the equivalent `openrouter/openai/...` model.

```bash
export OPENROUTER_API_KEY="..."  # optional fallback

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model openai-codex/gpt-5.5 \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=next \
  --agent-timeout-multiplier 16 \
  --n-tasks 1 \
  --sample-seed 0 \
  --force-build
```

The adapters do not introduce Codex-specific auth environment variables and do not print the OAuth credential contents.

### OpenRouter

Export an OpenRouter API key and use an OpenRouter model slug after the `openrouter/` provider prefix:

```bash
export OPENROUTER_API_KEY="..."

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model openrouter/openai/gpt-5.5 \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=next \
  --agent-timeout-multiplier 16 \
  --n-tasks 1 \
  --sample-seed 0 \
  --force-build
```

The Atomic Pier adapter reads `OPENROUTER_API_KEY` from the Pier process environment and passes it into the sandbox for Atomic. If your launcher does not inherit shell exports, pass it explicitly with `--agent-env OPENROUTER_API_KEY=...` instead.

The Pier network allowlist automatically includes `openrouter.ai` when the model provider is `openrouter`. To use a custom OpenRouter-compatible endpoint, pass it with `--agent-env OPENROUTER_BASE_URL=...`.

## Adapter behavior

The adapter is self-contained; it does not require patching Pier or Harbor. It follows the installed-agent pattern:

1. Install Atomic and required local search tools (`rg` and `fd`) during setup.
2. Run the Atomic CLI in JSON mode.
3. Keep Atomic's mutable agent state under the sandbox user's `~/.atomic/agent` directory by setting Atomic's existing agent-dir environment override, passing `--session-dir ~/.atomic/agent/atomic-sessions`, and exporting `ATOMIC_TODO_PATH=$HOME/.atomic/agent/todos` inside the sandbox so the default todo tool cannot create `.atomic/todos` in the benchmark repository.
4. Tee Atomic's JSON stream to `/logs/agent/atomic.txt` and copy session transcripts to `/logs/agent/atomic-sessions/` after the run, with an exit trap to preserve transcripts on SIGTERM-based timeouts.
5. Collect usage and trajectory data from the logs.

Like the built-in Pier agents, it does not auto-commit work. Deep SWE tasks rely on the agent following the task instruction to commit.
