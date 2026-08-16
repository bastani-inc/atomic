# Atomic Evals — maintainer notes

Everything a consumer needs to run the benchmark is in [README.md](README.md).
This file covers the parts that only matter when changing the harness, pinning
the submodules, or reasoning about whether two results are comparable.

Commands run from `evals/` unless stated otherwise.

## Submodules

| Path | Remote | Why |
|---|---|---|
| `evals/deep-swe` | [`datacurve-ai/deep-swe`](https://github.com/datacurve-ai/deep-swe) | The Deep SWE task corpus: 113 tasks, each with a `[[verifier.collect]]` hook that writes `/logs/artifacts/model.patch`. |
| `evals/vendor/pier` | [`bastani-inc/pier`](https://github.com/bastani-inc/pier), branch `main` | Org-owned fork of [`datacurve-ai/pier`](https://github.com/datacurve-ai/pier). Upstream `v0.3.1` and later, plus Atomic commits that (a) set `extra="forbid"` on the task-config models, so a `task.toml` key pier cannot model raises a `ValidationError` naming it instead of being silently dropped, (b) honor verifier-scoped `network_mode`, and (c) error a trial whose `model.patch` never arrived or arrived empty, instead of recording it as completed. |

Both are pinned by SHA. Read a pin from the superproject gitlink:

```bash
git -C .. rev-parse HEAD:evals/deep-swe
git -C .. rev-parse HEAD:evals/vendor/pier
```

Do **not** use `git -C evals/deep-swe rev-parse HEAD` to check a pin: in an
uninitialized submodule it prints the *superproject* SHA rather than failing, so
it silently reports the wrong corpus.

### Changing the pier fork

The fork's `main` carries the Atomic commits, so changes land there rather than
on a long-lived side branch. Push first, then move the gitlink and refresh the
editable install:

```bash
git -C evals/vendor/pier push origin HEAD:main
git add evals/vendor/pier
uv sync --reinstall-package datacurve-pier
```

To take new upstream work, merge `datacurve-ai/pier` into the fork's `main`,
rerun its suite, and move the gitlink. `git submodule update --remote` will
fetch that `main` because `.gitmodules` names it, but it does **not** update the
pin — it moves the working tree off it, which the preflight then reports as
drift. Commit the new gitlink to make it the pin.

## Preflight

```bash
uv run python -c 'from prerequisites import run_preflight; r = run_preflight(); print(r.describe()); raise SystemExit(0 if r.ok else 1)'
```

It parses every `task.toml` with the standard library's `tomllib` — so it still
works when `vendor/pier` is missing — and asserts 113 tasks, 113
`[[verifier.collect]]` hooks (counted per hook, not per task), and zero compose
files.

**Statuses.** A corpus is a *skip* only while `evals/deep-swe` is
**uninitialized**, decided from the submodule's own state, so a checked-out
corpus with no `tasks/` directory fails rather than skipping. A skip never makes
the report `ok` false. Everything else — an empty or mis-shaped corpus, a
drifted or dirty submodule, an unreachable Docker daemon, no usable credential —
is a failure.

**Submodule state** is checked three ways, because two of them can pass while
the run is still untrustworthy:

1. the gitlink pin exists;
2. the checked-out `HEAD` equals it — otherwise the run benchmarks code the pin
   does not name;
3. the working tree is clean. A tracked edit inside `evals/vendor/pier` leaves
   `HEAD` equal to the pin, so a `HEAD`-only check reported `ok` while the
   manifest recorded the clean pinned SHA. `git status --porcelain` decides
   this, so `.gitignore` still hides build output, and an untracked task file
   dropped into the corpus counts because it changes what runs.

A dirty tree is also recorded: the manifest appends `-dirty` to that submodule's
SHA, so such a run can never compare equal to a clean one.

**Credentials.** A credential means a satisfied provider from the adapter's
provider map, or an `auth.json` holding a valid `api_key`/`oauth` entry — an
empty `{}` file does not count. Most providers are satisfied by any one of their
keys (`anthropic` takes an API key *or* an OAuth token); `amazon-bedrock` needs
**both**, so a lone `AWS_ACCESS_KEY_ID` fails and the message names the missing
companion.

`PROVIDER_AUTH_ENV_KEYS` in `prerequisites.py` is the single source of truth.
Both adapters build their maps from it, so the preflight cannot check a provider
set the adapters do not forward. Harbor adds `huggingface`, which Pier
deliberately omits: Pier would have to allow `huggingface.co` through restricted
egress, and that host also serves git repos and datasets.

The same corpus numbers are checkable by hand:

```bash
find deep-swe/tasks -name task.toml | wc -l                  # 113
grep -rl '\[\[verifier.collect\]\]' deep-swe/tasks | wc -l   # 113
grep -rh 'network_mode' deep-swe/tasks --include='*.toml' | sort | uniq -c   # 226 no-network
find deep-swe/tasks -iname 'docker-compose.y*ml' | wc -l     # 0
uv run python -c "from pier.models.task.config import VerifierConfig; print('collect' in VerifierConfig.model_fields)"
```

## Network policy

Every Deep SWE task declares `network_mode = "no-network"` under both `[agent]`
and `[verifier]`, which pier resolves onto `allow_internet=False`. The agent
keeps filtered egress through a Squid overlay built from the adapter's
allowlist; the verifier gets none.

That overlay applies only while the allowlist is **non-empty**. An empty one
silently falls back to the no-network overlay, and the model call then fails as
a generic connection error that reads like a bad credential. The adapter
therefore raises `EmptyEgressAllowlistError` (`evals/network_policy.py`) instead
of returning an empty allowlist.

## What a trial must produce

- `artifacts/model.patch` — written by the task's `[[verifier.collect]]` hook. A
  missing or empty patch fails the trial **in the run path**: the pinned pier
  records a `MissingArtifactError` in `TrialResult.exception_info`, so
  `result.json` reports `n_errored_trials: 1` and lists the trial under
  `exception_stats`.

  This is scoped to `model.patch` alone. Every other declared artifact stays
  best-effort — a task may legitimately declare a log that a given run leaves
  empty or never writes, and erroring the trial for that would invent a rule no
  task asked for and reject runs on other datasets pier permits. Those outcomes
  are still recorded in the artifacts manifest and the debug log.

- `agent/atomic-status.json` — the adapter's own verdict, written on every path
  including pier's cancel and outer-exception handlers. `failed` names reasons
  such as `missing-atomic.txt`, `empty-atomic.txt`,
  `malformed-session-jsonl`, `manifest-not-written`, or
  `unresolved-atomic-version`.

- `agent/atomic-manifest.json` — see below.

Audit a finished job from the host. `audit_job` discovers a trial by its
`agent/`/`artifacts/` directories **and** by pier's root-level markers
(`trial.log`, or `config.json` plus `result.json`), because a trial that fails
during environment setup has a result and neither directory — and used to be
omitted from the audit entirely, letting a job with one healthy trial and one
dead one report success:

```bash
uv run python -c 'from trial_audit import audit_job; import pathlib; a = audit_job(pathlib.Path("jobs/atomic-smoke")); print(a.describe()); raise SystemExit(0 if a.ok else 1)'
```

### The adapters target the current CLI

Both adapters pass the task as `atomic … -- <instruction>`, using Atomic's
end-of-options terminator. They carry no compatibility path for older builds,
so pin a current version — an Atomic that predates the terminator reads it as a
flag, starts with no task, and prints `Error: Unknown option: --`.

That failure is quiet where it matters, which is worth knowing when reading a
bad run: the trial proceeds, the collect hook writes an empty `model.patch`,
and `atomic-status.json` still reports `ok` — `atomic.txt` is non-empty, so
neither `empty-atomic.txt` nor `malformed-session-jsonl` applies. Only the
host-side audit catches it, through the empty patch. Observed live at
`version=0.9.5`.

## Run manifests

`agent/atomic-manifest.json` records run ID, seed, model, Atomic version,
deep-swe SHA, and pier SHA. Both adapters write it. Every field records what
actually **ran**, not what was asked for:

- the two SHAs are the commits checked out inside each submodule, falling back
  to the gitlink when a submodule is uninitialized, with `-dirty` appended when
  that working tree carried uncommitted changes;
- `model` is the provider/model that answered, read from the agent's own stream,
  falling back to the candidate the session launched on and then to the
  requested `--model`. A fallback run does not record the model it was asked
  for, and neither does a cancelled run whose stream carried no provider
  metadata;
- `atomic_version` is what the container reported after install. A moving
  request such as `version=next` is recorded **only** once resolved; if the
  version probe fails, the manifest records nothing and the status carries
  `unresolved-atomic-version`. Recording `next` would let two different builds
  compare as equal, which is the one thing the manifest exists to prevent.

If the manifest cannot be written, `atomic-status.json` records
`manifest-not-written` and the trial fails: a run that cannot be compared with
another is not a usable result.

Compare two runs:

```bash
uv run python -c '
from run_manifest import compare_manifests, read_manifest
import pathlib
compare_manifests(read_manifest(pathlib.Path("jobs/run-a/<trial>/agent")), read_manifest(pathlib.Path("jobs/run-b/<trial>/agent")))
print("comparable")
'
```

`compare_manifests` raises `ManifestMismatchError` naming every field the two
runs disagree on. It first raises `IncompleteManifestError` when either side is
absent, unreadable, or missing a required field, so two empty manifests can
never compare as equal. Runs recorded against different corpus SHAs, pier SHAs,
models, seeds, or Atomic versions are not comparable — including runs from
before `network_mode` was honored, which had unrestricted agent internet access.

## Harbor

`atomic_harbor:Atomic` is the Harbor twin of the Pier adapter. Harbor arrives as
a transitive dependency of pier, so it needs no extra setup. It takes the
adapter as `-a/--agent`, not `--agent-import-path`, and it has **no
`--sample-seed`** — that flag is Pier's. A Harbor manifest therefore records
`seed: null` and two Harbor runs refuse to compare, naming `seed`; an unrecorded
seed cannot be proven equal. `pier_sha` in a Harbor manifest is the pier
checkout this repository pins, not a claim that Harbor used pier.

Two Harbor facts decide the shape of the command below.

**Harbor has no adapter-side allowlist.** Its `BaseInstalledAgent` exposes no
`network_allowlist` hook, so nothing corresponds to the Squid overlay Pier
builds. Harbor resolves each Deep SWE task to a `public` environment baseline
with a **`no-network` agent-phase override**, applied only around `agent.run()`
— so the Atomic install still has network, but the agent's provider call has
none. The remedy is `--allow-agent-host`, which Harbor merges into the
agent-phase allowlist. **You must pass a host for every provider the run may
reach, including fallbacks.** The adapter forwards the same credentials as the
Pier path, but forwarding a key does not open a route:

| Provider | Hosts to allow |
|---|---|
| `openai`, `openai-codex` | `api.openai.com`, `chatgpt.com`, `auth.openai.com` |
| `anthropic` | `api.anthropic.com`, `console.anthropic.com` |
| `openrouter` | `openrouter.ai` |
| `github-copilot` | `api.githubcopilot.com` |
| `kimi-coding` | `api.kimi.com` |
| `moonshotai` / `moonshotai-cn` | `api.moonshot.ai` / `api.moonshot.cn` |
| `zai` / `zai-coding-cn` | `api.z.ai` / `open.bigmodel.cn` |

**Harbor cannot enforce the `model.patch` contract in its run path.** Harbor is
a PyPI dependency, not a submodule, and offers no post-collect adapter hook, so
its `result.json` reports a trial as completed even when the patch is missing.
Its trial layout is the same `trial_dir/{agent,artifacts}` as Pier's, so run the
host-side audit as part of the command and treat *its* exit code as the verdict.

```bash
uv run harbor run \
  -p deep-swe/tasks \
  -a atomic_harbor:Atomic \
  -m openai-codex/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --agent-timeout-multiplier 16 \
  --job-name atomic-harbor-smoke \
  --allow-agent-host api.openai.com \
  --allow-agent-host chatgpt.com \
  --allow-agent-host auth.openai.com \
  --allow-agent-host api.anthropic.com \
  --allow-agent-host console.anthropic.com \
  --allow-agent-host openrouter.ai \
  -l 1 \
  -n 1 \
  --force-build \
  --no-delete \
  --debug \
&& uv run python -c 'from trial_audit import audit_job; import pathlib; a = audit_job(pathlib.Path("jobs/atomic-harbor-smoke")); print(a.describe()); raise SystemExit(0 if a.ok else 1)'
```

`-l/--n-tasks` bounds the task count and `-k/--n-attempts` sets pass@k repeats.

> **Unexecuted.** This Harbor command has not been run end to end on this host.
> The flags and the policy behavior above were read from Harbor 0.16's sources
> (`trial/trial.py`, `trial/network_policy.py`, `cli/jobs.py`) and from a static
> parse of a corpus task. The Pier commands are the ones with live evidence
> behind them.

## Provider details

### GitHub Copilot

Atomic resolves the Copilot endpoint for `COPILOT_GITHUB_TOKEN` env auth,
highest precedence first: `COPILOT_API_TARGET` / `GITHUB_COPILOT_BASE_URL`, then
the token's embedded `proxy-ep` segment, then `GITHUB_SERVER_URL`
(`<tenant>.ghe.com` → `copilot-api.<tenant>.ghe.com`, other non-`github.com`
hosts → `https://api.enterprise.githubcopilot.com`), then the public routing hub
`https://api.githubcopilot.com`. Pi's `https://api.individual.githubcopilot.com`
default applies only to OAuth logins, which the sandbox never performs.

Pier forwards only provider credential keys into the container, so those routing
variables are not visible to the agent inside the sandbox. For enterprise or GHE
runs the adapter keeps a harness-level pin: when `COPILOT_API_TARGET` or
`GITHUB_COPILOT_BASE_URL` is set it writes a `providers.github-copilot.baseUrl`
override into the container's `models.json`, which outranks the agent's own
resolution. When neither is set it writes no override, so the container routes
the token exactly as a normal Atomic user does. If `GITHUB_SERVER_URL` names a
GHE.com tenant, the adapter also adds `copilot-api.<tenant>.ghe.com` to the
restricted-egress allowlist.

### Anthropic

Atomic cannot tell a subscription apart from an API key — both route through the
`anthropic` provider — so `ANTHROPIC_API_KEY` keeps `anthropic` as the primary
candidate. The native provider uses dash-form model ids such as
`claude-opus-4-8`; when falling back, the adapters translate version suffixes to
OpenRouter's dot-form slugs such as `openrouter/anthropic/claude-opus-4.8`.

### OpenAI Codex

`openai-codex/...` uses OAuth credentials in the agent auth file rather than an
environment variable. The adapters merge valid local entries with Atomic taking
precedence over legacy Pi, remove denied providers and providers shadowed by
explicit environment credentials, then write the remainder to the sandbox user's
`~/.atomic/agent/auth.json` with `0600` permissions. They introduce no
Codex-specific auth environment variables and never print copied credential
contents.

### Kimi, Moonshot, ZAI

Supported both as top-level `--model` providers and as nested workflow/subagent
model assignments. The Pier adapter forwards `KIMI_API_KEY`, `MOONSHOT_API_KEY`,
`ZAI_API_KEY`, and `ZAI_CODING_CN_API_KEY`, and its restricted-egress allowlist
includes their pi-ai base-URL domains (`api.kimi.com`, `api.moonshot.ai`,
`api.moonshot.cn`, `api.z.ai`, `open.bigmodel.cn`). A stored `kimi-coding` entry
in the local Atomic `auth.json` is copied into the sandbox like any other
subscription credential. On the Harbor path the same credentials are forwarded,
but the hosts must be opened explicitly with `--allow-agent-host`.

### OpenRouter

The Pier network allowlist automatically includes `openrouter.ai` when the model
provider is `openrouter`. For a custom OpenRouter-compatible endpoint, pass
`--agent-env OPENROUTER_BASE_URL=...`.

## Tests

There is no test suite in `evals/`. The harness is verified by running it: the
preflight above, then a one-task smoke run whose `audit_job` exit code is the
verdict. `evals/vendor/pier` keeps upstream's suite, which is where changes to
the fork are tested:

```bash
cd vendor/pier && uv run pytest
```
