# Atomic Evals

Run Atomic against the Deep SWE benchmark through [Pier](https://github.com/datacurve-ai/pier).

Every command runs from this `evals/` directory unless it says otherwise.
Repo-level setup and maintainer notes are in the root
[DEV_SETUP.md](../DEV_SETUP.md).

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

## 2. Check the pins

The benchmark's guarantees live in the pinned Pier fork, so a checkout that
drifted off its pin does not have them:

```bash
git submodule status        # a leading + means drifted, - means uninitialized
git status --short evals/   # local edits inside a submodule
```

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

Pier itself is the verdict: a trial whose `model.patch` is missing or empty is
recorded as errored, so check `n_errored_trials` in the job result.

```bash
jq '.n_errored_trials, .n_completed_trials' jobs/atomic-smoke/result.json
find jobs/atomic-smoke -name model.patch -size -1c   # any empty patch is a dead trial
```

Each trial directory under `jobs/atomic-smoke/` holds the agent's JSON stream
(`agent/atomic.txt`), session transcripts (`agent/atomic-sessions/`), and the
patch the task collected (`artifacts/model.patch`).

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
| `--agent-kwarg version=0.9.13` | Installs that exact npm version in the sandbox. Prefer a pinned, current version over `next` or `latest`, which cannot be attributed to a build afterwards. |
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

**`Cannot resolve provider domains from model_name=…`** — pass `--model` as
`provider/model`. Without a provider the sandbox gets no egress route, and the
run would otherwise die as a connection error that reads like a bad credential.

**`421 Misdirected Request` on Copilot** — force the endpoint:
`--agent-env COPILOT_API_TARGET=api.githubcopilot.com` (GHES:
`api.enterprise.githubcopilot.com`; GHEC: your tenant's Copilot host).

**A key is exported but the agent cannot authenticate** — your launcher may not
inherit shell exports. Pass it explicitly: `--agent-env OPENROUTER_API_KEY=...`.

**`import pier` resolves to `site-packages`** — the editable install is stale:
`uv sync --reinstall-package datacurve-pier`. Do this after any change to a
submodule pointer or any local edit under `evals/vendor/pier`.

**`git submodule status` shows `+` or `-`** — the checkout drifted off its pin
or was never initialized. `git submodule update --init --recursive --force`
from the repository root returns both to their pins. Results produced by a
drifted or edited checkout cannot be attributed to the pinned SHA.
