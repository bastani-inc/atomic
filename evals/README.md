# Atomic Evals

Run Atomic against the Deep SWE benchmark through [Pier](https://github.com/datacurve-ai/pier).

Every command runs from this `evals/` directory unless it says otherwise.
Maintainer material — submodule pinning, the preflight internals, the network
and artifact contracts, the Harbor path — lives in [DEV_SETUP.md](DEV_SETUP.md).

## 1. Set up

A fresh clone leaves `evals/deep-swe/` and `evals/vendor/pier/` empty. Nothing
here works until they are checked out.

```bash
# from the repository root
git submodule update --init --recursive

cd evals
uv sync
uv run pier --help
```

If you have cloned before, run `git submodule sync --recursive` first: an
existing clone keeps the old URL in `.git/config`, and `evals/vendor/pier` moved
to `bastani-inc/pier`.

## 2. Check your machine

Before a long run, confirm the corpus, submodules, Docker, and credentials:

```bash
uv run python -c 'from prerequisites import run_preflight; r = run_preflight(); print(r.describe()); raise SystemExit(0 if r.ok else 1)'
```

A non-zero exit means the run would not be trustworthy: a mis-shaped corpus, a
submodule that drifted off its pin or has uncommitted edits, an unreachable
Docker daemon, or no usable provider credential. Fix what it names before
running anything below.

## 3. Export a credential

Pick one provider and export its key. The adapter forwards it into the sandbox.

```bash
export OPENAI_API_KEY="..."          # or
export ANTHROPIC_API_KEY="..."       # or ANTHROPIC_OAUTH_TOKEN
export OPENROUTER_API_KEY="..."      # or
export COPILOT_GITHUB_TOKEN="..."
```

`openai-codex/...` models use OAuth instead: log in on the host so
`~/.atomic/agent/auth.json` holds an `openai-codex` entry, and the adapter
copies it into the sandbox.

The main chat walks a fallback chain — Codex runs go `openai-codex` →
`openai` → `openrouter`, Anthropic runs go `anthropic` → `openrouter` — so
exporting the later keys too lets a session survive a rate limit mid-run.

## 4. Smoke check (1 task)

Always do this before a full run. It validates credentials, the sandbox install,
and log capture on a single task:

```bash
uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model openai-codex/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=0.9.13 \
  --agent-timeout-multiplier 16 \
  --job-name atomic-smoke \
  --n-tasks 1 \
  --sample-seed 0 \
  --n-concurrent 1 \
  --force-build \
  --no-delete \
  --debug
```

Then audit it. The audit's exit code is the verdict, not the console output:

```bash
uv run python -c 'from trial_audit import audit_job; import pathlib; a = audit_job(pathlib.Path("jobs/atomic-smoke")); print(a.describe()); raise SystemExit(0 if a.ok else 1)'
```

Each trial directory under `jobs/atomic-smoke/` holds the agent's JSON stream
(`agent/atomic.txt`), session transcripts (`agent/atomic-sessions/`), the patch
the task collected (`artifacts/model.patch`), and two files worth reading when
something looks wrong:

- `agent/atomic-status.json` — the adapter's own verdict. `failed` names a
  reason, such as `missing-atomic.txt`, rather than leaving a dead trial looking
  complete.
- `agent/atomic-manifest.json` — run ID, seed, model, Atomic version, and both
  submodule SHAs. It records what actually ran, so two runs can be compared.

## 5. Full benchmark

Omit `--n-tasks` to run all 113 tasks:

```bash
uv run pier run \
  -p deep-swe/tasks \
  --agent-import-path atomic_pier:Atomic \
  --model openai-codex/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-kwarg version=0.9.13 \
  --agent-timeout-multiplier 16 \
  --job-name atomic-deep-swe \
  --sample-seed 0 \
  --n-concurrent 4 \
  --force-build
```

Give the Docker VM **4 GB of memory and 2 CPUs per concurrent trial** —
`--n-concurrent 4` wants a ≥ 16 GB / 8-CPU VM. Pier does not schedule against
host capacity, so overcommitting surfaces as mid-run OOM kills. A single Copilot
token also rate-limits beyond ~4–6 concurrent agents.

An interrupted job resumes: re-run the same command with the same `--job-name`,
or `uv run pier job resume -p jobs/atomic-deep-swe`.

## Options worth knowing

| Flag | Why |
|---|---|
| `--agent-kwarg version=0.9.13` | Installs that exact npm version in the sandbox. Prefer a pinned, current version over `next` or `latest`: a moving tag cannot be attributed to a build, and the manifest refuses to record one it could not resolve. |
| `--force-build` | Rebuilds the task image so the `npm install -g @bastani/atomic@…` layer re-runs. Without it Docker reuses a cached install and you silently benchmark a stale build. |
| `--agent-timeout-multiplier 16` | Tasks set a 1.5 h agent timeout; ×16 makes it a day. Pier cannot disable the timeout, so a large multiplier is how you run effectively untimed. |
| `--agent-kwarg thinking=xhigh` | Atomic's reasoning level, for models that support it. |
| `--agent-kwarg disallowed_subscriptions=github-copilot` | Excludes providers from the local subscription auth copied into the sandbox. |
| `--n-tasks`, `--include-task-name` | Choose which tasks run. |
| `--n-attempts` | pass@k repeats. |

## Troubleshooting

**`Error: Unknown option: --` in `agent/atomic.txt`** — the sandbox installed an
Atomic older than the CLI the adapter targets, so it read the prompt terminator
as a flag and started with no task. The trial finishes with an empty
`model.patch`. Pin a current version.

**`EmptyEgressAllowlistError`** — pass `--model` as `provider/model`. The agent
runs behind a filtered proxy built from the model's provider; with no provider
the allowlist is empty, and the model call would otherwise fail as a generic
connection error that reads like a bad credential.

**`421 Misdirected Request` on Copilot** — force the endpoint:
`--agent-env COPILOT_API_TARGET=api.githubcopilot.com` (GHES:
`api.enterprise.githubcopilot.com`; GHEC: your tenant's Copilot host).

**A key is exported but the agent cannot authenticate** — your launcher may not
inherit shell exports. Pass it explicitly: `--agent-env OPENROUTER_API_KEY=...`.

**`import pier` resolves to `site-packages`** — the editable install is stale:
`uv sync --reinstall-package datacurve-pier`. Do this after any change to a
submodule pointer or any local edit under `evals/vendor/pier`.

**The preflight fails on a submodule** — `git submodule update --init
--recursive --force` from the repository root returns both to their pins. It
reports uncommitted edits too, because results produced by modified code cannot
be attributed to the pinned SHA.
