# Atomic Evals

Utilities and adapters for running Atomic against evaluation suites such as Deep SWE through Pier.

## Setup from a fresh clone

Every command in this file runs from this `evals/` directory unless it says otherwise. A fresh
clone has both submodules **uninitialized** — `evals/deep-swe/` and `evals/vendor/pier/` are empty
directories — and nothing here works until they are checked out.

```bash
# from the repository root
git submodule sync --recursive        # only needed when a submodule URL changed
git submodule update --init --recursive

cd evals
uv sync
uv run python -c 'import pier, pathlib; print(pathlib.Path(pier.__file__).resolve())'
uv run pier --help
```

The `import pier` line must print `…/evals/vendor/pier/src/pier/__init__.py`. If it prints a path
under `site-packages`, the editable install is stale — see below.

`git submodule sync --recursive` matters after a pull that changes a submodule's URL: an existing
clone keeps the old URL in `.git/config`, and `git submodule update` silently keeps fetching from
it. `evals/vendor/pier` moved to `bastani-inc/pier` (see [Submodules](#submodules)), so run it once.

After any change to a submodule pointer, or any local edit inside `evals/vendor/pier`, refresh the
editable install:

```bash
uv sync --reinstall-package datacurve-pier
```

## Submodules

| Path | Remote | Why |
|---|---|---|
| `evals/deep-swe` | [`datacurve-ai/deep-swe`](https://github.com/datacurve-ai/deep-swe) | The Deep SWE task corpus: 113 tasks, each with a `[[verifier.collect]]` hook that writes `/logs/artifacts/model.patch`. |
| `evals/vendor/pier` | [`bastani-inc/pier`](https://github.com/bastani-inc/pier) | Org-owned fork of [`datacurve-ai/pier`](https://github.com/datacurve-ai/pier). Pinned to upstream `v0.3.1` plus one Atomic commit that sets `extra="forbid"` on the task-config models, so a `task.toml` key pier cannot model raises a `ValidationError` naming it instead of being silently dropped. |

Both are pinned by SHA. Read a pin from the superproject gitlink:

```bash
git -C .. rev-parse HEAD:evals/deep-swe
git -C .. rev-parse HEAD:evals/vendor/pier
```

Do **not** use `git -C evals/deep-swe rev-parse HEAD` to check a pin: in an uninitialized submodule
it prints the *superproject* SHA rather than failing, so it silently reports the wrong corpus.

## Tests

Run the eval bootstrap and adapter regression tests from this directory:

```bash
uv run pytest
```

The shell-level bootstrap tests execute the generated NVM setup command with
isolated fake NVM installations, so they do not modify the host Node setup.

Tests that need the Deep SWE corpus **skip** with an explicit message when `evals/deep-swe` is
uninitialized, so the suite passes in a fresh clone for contributors who never touch evals.

## Preflight

Before a long run, check the corpus, the submodules, Docker, and credentials:

```bash
uv run python -c 'from prerequisites import run_preflight; r = run_preflight(); print(r.describe()); raise SystemExit(0 if r.ok else 1)'
```

It parses every `task.toml` with the standard library's `tomllib` (so it still works when
`vendor/pier` is missing) and asserts 113 tasks, one `[[verifier.collect]]` hook per task, and zero
compose files. A missing corpus is a **skip**; a mis-shaped corpus, an unreachable Docker daemon, or
a total absence of provider credentials is a **failure**.

The same numbers are checkable by hand:

```bash
find deep-swe/tasks -name task.toml | wc -l                  # 113
grep -rl '\[\[verifier.collect\]\]' deep-swe/tasks | wc -l   # 113
grep -rh 'network_mode' deep-swe/tasks --include='*.toml' | sort | uniq -c   # 226 no-network
find deep-swe/tasks -iname 'docker-compose.y*ml' | wc -l     # 0
uv run python -c "from pier.models.task.config import VerifierConfig; print('collect' in VerifierConfig.model_fields)"
```

## Network policy

Every Deep SWE task declares `network_mode = "no-network"` under both `[agent]` and `[verifier]`,
which pier resolves onto `allow_internet=False`. The agent keeps filtered egress through a Squid
overlay built from the adapter's allowlist; the verifier gets none.

That overlay is only applied while the allowlist is **non-empty**. An empty one silently falls back
to the no-network overlay, and the model call then fails as a generic connection error that reads
like a bad credential. The adapter therefore raises `EmptyEgressAllowlistError`
(`evals/network_policy.py`) instead of returning an empty allowlist. If you see it, pass `--model`
as `provider/model`.

## Run status, artifacts, and manifests

Each trial directory carries three things worth reading after a run:

- `agent/atomic-status.json` — the adapter's own verdict. `failed` names a reason such as
  `missing-atomic.txt` or `malformed-session-jsonl` instead of leaving a dead trial looking
  complete.
- `artifacts/model.patch` — written by the task's `[[verifier.collect]]` hook. A missing or empty
  patch is a **failed** trial.
- `agent/atomic-manifest.json` — run ID, seed, model, resolved Atomic version, deep-swe SHA, and
  Pier SHA.

Audit a finished job, and compare two runs:

```bash
uv run python -c 'from trial_audit import audit_job; import pathlib; a = audit_job(pathlib.Path("jobs/atomic-smoke")); print(a.describe()); raise SystemExit(0 if a.ok else 1)'

uv run python -c '
from run_manifest import compare_manifests, read_manifest
import pathlib
compare_manifests(read_manifest(pathlib.Path("jobs/run-a/<trial>/agent")), read_manifest(pathlib.Path("jobs/run-b/<trial>/agent")))
print("comparable")
'
```

`compare_manifests` raises `ManifestMismatchError` naming every field two runs disagree on. Runs
recorded against different corpus SHAs, Pier SHAs, models, seeds, or Atomic versions are not
comparable — including runs from before `network_mode` was honored, which had unrestricted agent
internet access.

## Run Pier with Atomic

Run commands from this `evals/` directory. Choose one provider configuration below, then pass `atomic_pier:Atomic` as the agent import path.

Common options:

- `--agent-kwarg version=next` installs `@bastani/atomic@next` inside the sandbox. Omit it for `@latest`, or pass a concrete npm version/tag without the leading `@` (for example `--agent-kwarg version=0.9.3-alpha.1`).
- `--force-build` rebuilds the task image so the `npm install -g @bastani/atomic@...` layer re-runs. Without it, Docker layer caching reuses a previously installed Atomic even after a new version is published to the tag, so benchmark runs can silently test a stale build. All commands below include it.
- `--agent-kwarg thinking=xhigh` configures Atomic's reasoning level for models that support it.
- `--agent-kwarg disallowed_subscriptions=github-copilot` excludes matching providers from copied local subscription auth. The default is empty: every valid local entry remains eligible unless explicitly denied, with no known-provider allowlist. Pass multiple names as a comma-separated string or JSON list.
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
  --agent-kwarg disallowed_subscriptions=github-copilot \
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

## Run Harbor with Atomic

`atomic_harbor:Atomic` is the Harbor twin of the Pier adapter. Harbor is installed as a transitive
dependency of pier, so no extra setup is needed. Harbor takes the adapter as `-a/--agent`, not
`--agent-import-path`, and it has **no `--sample-seed`** — that flag is Pier's:

```bash
uv run harbor run \
  -p deep-swe/tasks \
  -a atomic_harbor:Atomic \
  -m openai-codex/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg disallowed_subscriptions=github-copilot \
  --agent-timeout-multiplier 16 \
  --job-name atomic-harbor-smoke \
  -l 1 \
  -n 1 \
  --force-build \
  --no-delete \
  --debug
```

`-l/--n-tasks` bounds the task count and `-k/--n-attempts` sets pass@k repeats. The provider
configuration below applies unchanged.

## Providers

### Default (Used for official Atomic Deep SWE run)

Note: the main chat walks a fallback chain. Codex runs go `openai-codex` -> `openai` -> `openrouter`; Anthropic runs go `anthropic` -> `openrouter`. The adapters start the session on the first candidate whose credential is present and write the rest to `settings.fallbackModels` in the sandbox, so the running session advances on rate limits, quota exhaustion, and provider errors.

```bash
export OPENAI_API_KEY="..."      # first fallback for Codex runs
export OPENROUTER_API_KEY="..."  # last fallback, relies on OpenAI Codex and Claude Code subscriptions

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model openai-codex/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=0.9.5 \
  --agent-kwarg disallowed_subscriptions=github-copilot \
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
  --agent-kwarg disallowed_subscriptions=github-copilot \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

The Atomic Pier adapter reads `COPILOT_GITHUB_TOKEN` from the Pier process environment and passes it into the sandbox for Atomic. If your launcher does not inherit shell exports, pass it explicitly with `--agent-env COPILOT_GITHUB_TOKEN=...` instead.

Atomic resolves the Copilot endpoint for `COPILOT_GITHUB_TOKEN` env auth, highest precedence first: `COPILOT_API_TARGET` / `GITHUB_COPILOT_BASE_URL`, then the token's embedded `proxy-ep` segment, then `GITHUB_SERVER_URL` (`<tenant>.ghe.com` → `copilot-api.<tenant>.ghe.com`, other non-`github.com` hosts → `https://api.enterprise.githubcopilot.com`), then the public routing hub `https://api.githubcopilot.com`. Pi's `https://api.individual.githubcopilot.com` default now applies only to OAuth logins, which the sandbox never performs.

Pier forwards only provider credential keys into the container, so the routing variables above are not visible to the agent inside the sandbox. For enterprise or GHE runs the adapter therefore keeps a harness-level pin: when either variable below is set it writes a `providers.github-copilot.baseUrl` override into the container's `models.json`, which outranks the agent's own resolution.

1. `COPILOT_API_TARGET` if provided (host or URL)
2. `GITHUB_COPILOT_BASE_URL` if provided (host or URL)

When neither is set the adapter writes no override, so the container routes the token exactly as a normal Atomic user does — the public hub resolves the plan-specific host server-side. If `GITHUB_SERVER_URL` names a GHE.com tenant, the adapter also adds `copilot-api.<tenant>.ghe.com` to the restricted-egress allowlist so the host Atomic resolves is reachable.

If you see `421 Misdirected Request`, force the target explicitly:

```bash
export COPILOT_GITHUB_TOKEN="..."

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model github-copilot/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg disallowed_subscriptions=github-copilot \
  --agent-timeout-multiplier 16 \
  --agent-env COPILOT_API_TARGET=api.githubcopilot.com \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

For GHES use `COPILOT_API_TARGET=api.enterprise.githubcopilot.com`; for GHEC use the tenant-specific GHE Copilot routing host.

### Anthropic subscription with API-key and OpenRouter fallback

Export `ANTHROPIC_OAUTH_TOKEN` to run Anthropic models through the subscription OAuth path. Atomic cannot tell a subscription apart from an API key — both route through the `anthropic` provider — so `ANTHROPIC_API_KEY` keeps `anthropic` as the primary candidate. Also export `OPENROUTER_API_KEY` if you want a fallback to the equivalent `openrouter/anthropic/...` model when no Anthropic credential is present:

```bash
export ANTHROPIC_OAUTH_TOKEN="..."
export ANTHROPIC_API_KEY="..."   # optional; same `anthropic` provider
export OPENROUTER_API_KEY="..."  # optional fallback

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model anthropic/claude-fable-5 \
  --agent-kwarg thinking=high \
  --agent-kwarg disallowed_subscriptions=github-copilot \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

The native Anthropic provider uses dash-form model ids such as `claude-opus-4-8`; when falling back, the adapters translate version suffixes to OpenRouter's matching dot-form slugs such as `openrouter/anthropic/claude-opus-4.8`.

### OpenAI Codex subscription with OpenAI and OpenRouter fallback

For `openai-codex/...` models, Atomic uses OAuth credentials stored in the agent auth file rather than an environment variable. Log in on the host so `~/.atomic/agent/auth.json` (or legacy `~/.pi/agent/auth.json`) contains an `openai-codex` entry. The Pier and Harbor adapters merge valid local entries with Atomic taking precedence over legacy Pi, remove denied providers and providers shadowed by explicit environment credentials, then write the remainder to the sandbox user's `~/.atomic/agent/auth.json` with `0600` permissions. Export `OPENAI_API_KEY` and `OPENROUTER_API_KEY` for the `openai` and `openrouter` rungs behind the subscription; each is used only when its key is exported, both as the pre-launch selection when the subscription is missing and as a main-chat `fallbackModels` entry when it is not.

```bash
export OPENAI_API_KEY="..."      # optional first fallback
export OPENROUTER_API_KEY="..."  # optional last fallback

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model openai-codex/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg disallowed_subscriptions=github-copilot \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

The adapters do not introduce Codex-specific auth environment variables and do not print copied credential contents.

### OpenRouter

Export an OpenRouter API key and use an OpenRouter model slug after the `openrouter/` provider prefix:

```bash
export OPENROUTER_API_KEY="..."

uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model openrouter/openai/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg disallowed_subscriptions=github-copilot \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

The Atomic Pier adapter reads `OPENROUTER_API_KEY` from the Pier process environment and passes it into the sandbox for Atomic. If your launcher does not inherit shell exports, pass it explicitly with `--agent-env OPENROUTER_API_KEY=...` instead.

The Pier network allowlist automatically includes `openrouter.ai` when the model provider is `openrouter`. To use a custom OpenRouter-compatible endpoint, pass it with `--agent-env OPENROUTER_BASE_URL=...`.

Kimi/Moonshot and ZAI are supported both as top-level `--model` providers and as nested workflow/subagent model assignments: the adapter forwards `KIMI_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, and `ZAI_CODING_CN_API_KEY` from the Pier process environment into the sandbox (alongside every other supported provider credential), and the restricted-egress allowlist includes their pi-ai base-URL domains (`api.kimi.com`, `api.moonshot.ai`, `api.moonshot.cn`, `api.z.ai`, `open.bigmodel.cn`). A stored `kimi-coding` entry in the local Atomic `auth.json` is copied into the sandbox like any other subscription credential.
