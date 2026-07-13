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
export COPILOT_GITHUB_TOKEN="..."  # or ANTHROPIC_API_KEY / OPENAI_API_KEY / ANTHROPIC_OAUTH_TOKEN / OPENROUTER_API_KEY="..."

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model MODEL_NAME \
  --agent-kwarg thinking=THINKING_LEVEL \
  --agent-kwarg version=VERSION \
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

Add `--n-attempts <k>` for pass@k-style repeats. Sizing `--n-concurrent`: each trial's containers are capped at 2 CPUs / 8 GB but typically peak at 2–4 GB, so give the Docker VM at least **4 GB of memory and 2 CPUs per concurrent trial** (e.g. `--n-concurrent 4` wants a ≥ 16 GB / 8-CPU Docker VM); Pier does not schedule against host capacity, and overcommitting memory surfaces as confusing mid-run OOM kills. A single Copilot token also tends to rate-limit beyond ~4–6 concurrent agents. Interrupted jobs resume where they left off: re-run the same command with the same `--job-name` (the config must match), or use `uv run pier job resume -p jobs/atomic-deep-swe`.

## Providers

### Default (Used for official Atomic Deep SWE run)

Note: The OpenRouter provider can first try making requests to the OpenAI and Anthropic APIs directly and otherwise falls back to OpenRouter.

```bash
export OPENROUTER_API_KEY="..."  # fallback for rate limits, relies on OpenAI Codex and Claude Code subscriptions

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model openai-codex/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=0.9.5 \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

### GitHub Copilot

Export a Copilot token and use the `github-copilot/` provider prefix:

```bash
export COPILOT_GITHUB_TOKEN="..."

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model github-copilot/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

The Atomic Pier adapter reads `COPILOT_GITHUB_TOKEN` from the Pier process environment and passes it into the sandbox for Atomic. If your launcher does not inherit shell exports, pass it explicitly with `--agent-env COPILOT_GITHUB_TOKEN=...` instead.

For GitHub Copilot in `allow_internet = false` tasks, the Pier adapter routes API traffic using the first available option:

1. `COPILOT_API_TARGET` if provided (host or URL)
2. `GITHUB_COPILOT_BASE_URL` if provided (host or URL)
3. `GITHUB_SERVER_URL` routing:
    - `https://github.com` → `https://api.githubcopilot.com`
    - `https://<tenant>.ghe.com` → the tenant-specific GHE Copilot routing host
    - other GitHub Enterprise Server domains → `https://api.enterprise.githubcopilot.com`

If you see `421 Misdirected Request`, force the target explicitly:

```bash
export COPILOT_GITHUB_TOKEN="..."

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model github-copilot/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-timeout-multiplier 16 \
  --agent-env COPILOT_API_TARGET=api.githubcopilot.com \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

For GHES use `COPILOT_API_TARGET=api.enterprise.githubcopilot.com`; for GHEC use the tenant-specific GHE Copilot routing host.

### Anthropic subscription with OpenRouter fallback

Export `ANTHROPIC_OAUTH_TOKEN` to run Anthropic models through the subscription OAuth path. Also export `OPENROUTER_API_KEY` if you want the adapters to fall back to the equivalent `openrouter/anthropic/...` model when the subscription token is unavailable:

```bash
export ANTHROPIC_OAUTH_TOKEN="..."
export OPENROUTER_API_KEY="..."  # optional fallback

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model anthropic/claude-fable-5 \
  --agent-kwarg thinking=high \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
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
  --model openai-codex/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
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
  --model openrouter/openai/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

The Atomic Pier adapter reads `OPENROUTER_API_KEY` from the Pier process environment and passes it into the sandbox for Atomic. If your launcher does not inherit shell exports, pass it explicitly with `--agent-env OPENROUTER_API_KEY=...` instead.

The Pier network allowlist automatically includes `openrouter.ai` when the model provider is `openrouter`. To use a custom OpenRouter-compatible endpoint, pass it with `--agent-env OPENROUTER_BASE_URL=...`.

## Pre-provisioned shipped-skill prerequisites

Pier and Harbor install Atomic's default shipped skills with their runtime prerequisites during the sandbox setup phase, while network access is available. `skill_prerequisites.py` is the shared inventory and command source consumed explicitly by both adapters during their install phases, before task runtime and restricted-network execution. Prerequisite installers select their current versions without explicit pins; Atomic itself still follows `--agent-kwarg version` and defaults to `@latest`.

| Shipped skill | Provisioned prerequisite | Install command/source | Early verification |
| --- | --- | --- | --- |
| `liteparse` | Node.js; `lit`; LibreOffice; ImageMagick; `uv`; uv-managed Python with cached `bm25s`/`aiofiles` | Current NVM Node.js or distro Node.js; `npm install -g @llamaindex/liteparse`; distro packages; Astral's current-version installer; `uv python install` and a dependency-prefetch run | `node --version`, `lit --version`, `libreoffice --version`, `magick -version` or `convert -version`, `uv --version`, managed-Python lookup and imports |
| `playwright-cli` | `@playwright/cli`, Playwright-managed Chromium and Chromium headless shell, and Linux runtime libraries | Unpinned `npm install -g @playwright/cli`, followed on Debian/Ubuntu by the supported `playwright-cli install-browser chromium` flow after root setup installs the Linux dependency set. Setup validates those packages and prints the browser plan with `--with-deps --dry-run`, then prints `--list` output after installation. Alpine/musl and yum-family RHEL-compatible images retain distro Chromium because Playwright's managed Linux dependency path is not supported there; their explicit executable, Chromium, headless, and sandbox settings are written idempotently to `~/.atomic-eval-env`, which both adapters source in non-login shells. | CLI version and Playwright-managed installed-browser listing or fallback executable check, followed by an actual headless `about:blank` open, snapshot, and close with browser downloads and npm network access disabled |
| `tmux` | tmux-compatible CLI | Distro `tmux` package (`apk`, `apt-get`, or `yum` in Pier; Debian `apt-get` in Harbor). Alpine also receives edge `libc++`, needed by LiteParse's published musl native module. Yum-family images enable EPEL and CRB/PowerTools before installing Chromium, ImageMagick, ripgrep, and LibreOffice component packages. | `tmux -V` |
| `impeccable` | Node.js for bundled `.mjs` scripts | Node.js as above | `node --version` |
| `skill-creator` | Python 3 and PyYAML for bundled validation/packaging scripts | Distro `python3` and PyYAML package; after installing `uv`, setup first tests whether the active `python3` can import `yaml` and only runs `uv pip install --system pyyaml` when it cannot (covering task images whose `/usr/local` Python precedes the distro interpreter on `PATH` without modifying an already-working externally-managed distro Python) | `python3 -c "import yaml"` |
| `create-spec`, `intercom`, `prompt-engineer`, `research-codebase`, `subagent`, `tdd` | No independently installed external runtime | Harness tools, bundled extensions, or target-project tooling | Not applicable |

The inventory excludes repository-local `.agents` developer helpers such as Crabbox, prek, and GitHub commit/PR skills. Conditional examples are not promoted to universal dependencies: for example, Claude Code is needed only for `skill-creator`'s optional description-optimization path, a browser tool is conditional for Impeccable live mode, and `gh`/`curl` are conditional research paths. Conversely, Office/image support and the `liteparse` ranked-search helper are provisioned because they are declared capabilities of the shipped skill.

The setup commands are noninteractive, repeatable, fail on unsupported package managers or unusable tools, and preload Chromium, Chromium headless shell, Linux browser libraries, and the uv/Python artifacts so skill use does not depend on downloading them after restricted-network task execution begins. The Playwright install uses the public `playwright-cli install-browser` command rather than a package-internal Node entrypoint. This increases eval image size and setup time, especially from LibreOffice and Chromium, in exchange for deterministic availability.

## Adapter behavior

The adapter is self-contained; it does not require patching Pier or Harbor. It follows the installed-agent pattern:

1. Install Atomic and required local search tools (`rg` and `fd`) during setup.
2. Run the Atomic CLI in JSON mode.
3. Keep Atomic's mutable agent state under the sandbox user's `~/.atomic/agent` directory by setting Atomic's existing agent-dir environment override, passing `--session-dir ~/.atomic/agent/atomic-sessions`, and exporting `ATOMIC_TODO_PATH=$HOME/.atomic/agent/todos` inside the sandbox so the default todo tool cannot create `.atomic/todos` in the benchmark repository.
4. Tee Atomic's JSON stream to `/logs/agent/atomic.txt` and continuously mirror session transcripts to `/logs/agent/atomic-sessions/` during the run, with a final exit-trap sync to preserve transcripts on normal exits and SIGTERM-based timeouts. Mirrored transcript permissions are normalized after every copy so job artifacts remain readable and removable by the host user even when the sandbox agent runs as root.
5. Collect usage and trajectory data from the main chat plus workflow-stage and nested child transcripts, de-duplicating copied parent context and reporting the combined agent-step count (`n_agent_steps` in Pier and Harbor context metadata).

Like the built-in Pier agents, it does not auto-commit work. Deep SWE tasks rely on the agent following the task instruction to commit.
