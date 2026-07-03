---
name: crabbox
description: "Run remote validation on Linux, macOS, Windows, or WSL2 via the Crabbox wrapper, including delegated Blacksmith Testbox proof. Report the actual provider and lease id."
metadata:
    version: "2026-07-03"
---

# Crabbox

Use the Crabbox wrapper when the task needs remote proof for broad tests,
CI-parity checks, secrets, hosted services, Docker/E2E/package lanes, warmed
reusable boxes, sync timing, logs/results, cache inspection, or lease cleanup.

Crabbox (https://crabbox.sh) is the transport/orchestration surface. The
actual backend can be:

- brokered cloud Crabbox: direct provider (e.g. `provider=azure` or
  `provider=aws`), lease ids like `cbx_...`, `syncDelegated=false`
- Blacksmith Testbox through Crabbox: delegated provider,
  `provider=blacksmith-testbox`, ids like `tbx_...`, `syncDelegated=true`

Do not describe delegated runs as direct-provider runs; report them as
Testbox-through-Crabbox with the `tbx_...` id and the Actions run link.

Use the repo `.crabbox.yaml` direct-provider path when the task specifically
needs direct provider behavior, persistent direct-provider leases,
`--fresh-pr`, `--full-resync`, environment forwarding, capture/download
support, or provider comparison. Use `--provider blacksmith-testbox` when the
task needs a prepared CI environment, broad/heavy test gates, or the user asks
for Testbox/Blacksmith.

## First Checks

- Run from the repo root. Crabbox sync mirrors the current checkout.
- Check the wrapper and providers before remote work:

```sh
command -v crabbox
crabbox --version
crabbox run --help | sed -n '1,120p'
crabbox desktop launch --help
crabbox webvnc --help
```

- If `crabbox` is missing or fails the version/help checks, install it per
  https://crabbox.sh before reporting Crabbox as unavailable. Do not claim
  Crabbox proof from a stale PATH shim.
- Check `.crabbox.yaml` for direct-provider defaults (this repo defaults to
  `provider: azure`, `class: standard`). Omitting `--provider` uses the repo
  default.
- Cold Testbox acquisition and hydration often take tens of seconds. When
  broad remote proof is likely, immediately start
  `crabbox warmup --provider blacksmith-testbox --keep --timing-json` in a
  background command session while inspecting, editing, and running focused
  local tests. Poll later, reuse the returned `tbx_...` with
  `--provider blacksmith-testbox --id <tbx_id>`, and stop it before handoff.
  Do not warm speculatively when remote proof is unlikely.
- Always report the actual provider and id. `cbx_...` means direct-provider
  Crabbox; `tbx_...` means Blacksmith Testbox through Crabbox. If the output
  only says `blacksmith testbox list`, use `blacksmith testbox list --all`
  before concluding no box exists.
- If a warm direct-provider lease smells stale, retry with `--full-resync`
  (alias `--fresh-sync`) before replacing the lease. This resets the remote
  workdir, skips the fingerprint fast path, reseeds Git when possible, and
  uploads the checkout from scratch.
- For live/provider bugs, use the configured secret workflow before
  downgrading to mocks. Copy only the exact needed key into the remote process
  environment for that one command. Do not print it, do not sync it as a repo
  file, and do not leave it in remote shell history or logs. If no secret-safe
  injection path is available, say true live provider auth is blocked instead
  of silently using a fake key.
- Prefer local targeted tests for tight edit loops. Broad gates belong remote.

## macOS And Windows Targets

Use these only when the task needs an existing non-Linux host. Broad Linux
validation uses the repo Crabbox config unless a provider is explicitly
requested.

Crabbox supports static SSH targets:

```sh
crabbox run --provider ssh --target macos --static-host mac-studio.local -- xcodebuild test
crabbox run --provider ssh --target windows --windows-mode normal --static-host win-dev.local -- pwsh -NoProfile -Command "dotnet test"
crabbox run --provider ssh --target windows --windows-mode wsl2 --static-host win-dev.local -- bun run test:unit
```

- `target=macos` and `target=windows --windows-mode wsl2` use the POSIX SSH,
  bash, Git, rsync, and tar contract.
- Native Windows uses OpenSSH, PowerShell, Git, and tar; sync is manifest tar
  archive transfer into `static.workRoot`. Direct native Windows runs support
  `--script*`, `--env-from-profile`, `--preflight`, and PowerShell `--shell`.
- `crabbox actions hydrate/register` are Linux-only today; use plain
  `crabbox run` loops for static macOS and Windows hosts.
- Live proof needs a reachable, operator-managed SSH host. Without one, verify
  with `crabbox run --help`, config/flag tests, and the Crabbox test suite.

## Direct Brokered Backend

Use this when the task needs direct provider semantics rather than the
prepared Blacksmith Testbox CI environment.

Unit gate:

```sh
crabbox run \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "env CI=1 bun install --frozen-lockfile && bun run test:unit"
```

Full gates:

```sh
crabbox run \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "env CI=1 bun install --frozen-lockfile && bun run typecheck && bun run test:all"
```

Focused rerun:

```sh
crabbox run \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "env CI=1 bun test <path-or-filter>"
```

Read the JSON summary. Useful fields:

- `provider`: the direct provider (e.g. `azure`, `aws`)
- `leaseId`: `cbx_...`
- `syncDelegated`: `false`
- `commandPhases`: populated when the command prints `CRABBOX_PHASE:<name>`
- `commandMs` / `totalMs`
- `exitCode`

Crabbox should stop one-shot direct leases automatically after the run. Verify
cleanup when a run fails, is interrupted, or the command output is unclear:

```sh
crabbox list --provider azure
```

## Blacksmith Testbox Through Crabbox

Use this for broad/heavy gates when the prepared CI environment is the right
proof surface:

```sh
crabbox run \
  --provider blacksmith-testbox \
  --blacksmith-org <org> \
  --blacksmith-workflow <hydration-workflow>.yml \
  --blacksmith-job check \
  --blacksmith-ref main \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  -- \
  CI=1 bun run typecheck && bun run test:all
```

Read the JSON summary and the Testbox line. Useful fields:

- `provider`: `blacksmith-testbox`
- `leaseId`: `tbx_...`
- `syncDelegated`: `true`
- `syncPhases`: delegated/skipped because Blacksmith owns checkout/sync
- Actions run URL/id from the Testbox output
- `exitCode`

Use provider-backed cache volumes only for rebuildable caches, not secrets or
checkout state. On Blacksmith, Crabbox forwards them as sticky disks:

```sh
crabbox run \
  --provider blacksmith-testbox \
  --cache-volume bun-cache=<repo>-bun-lock:/tmp/bun-install-cache \
  --timing-json \
  -- \
  CI=1 bun run test:unit
```

The selected provider must advertise cache-volume support. If not, omit
`--cache-volume` and rely on kept-lease caches.

`blacksmith testbox list` may hide hydrating or ready boxes. Use:

```sh
blacksmith testbox list --all
blacksmith testbox status <tbx_id>
```

## Fresh PR Smoke And Local Container Fallback

Use `--fresh-pr <owner/repo#number>` to validate an upstream PR from a clean
remote checkout. Delegated `blacksmith-testbox` owns checkout/sync and does not
support `--fresh-pr`; use a direct provider, or `local-container` when remote
providers are unavailable and a local Docker proof is still useful.

Example local-container fallback:

```sh
crabbox run \
  --provider local-container \
  --local-container-image oven/bun:1 \
  --no-hydrate \
  --fresh-pr <owner/repo>#123 \
  --timing-json \
  --shell -- \
  "set -euo pipefail
   bun install --frozen-lockfile
   git diff --check
   bun test <path-or-filter>"
```

- Report `provider=local-container` and the returned `cbx_...` id exactly.
  This is a Crabbox wrapper proof, but not direct-cloud/Testbox remote proof.
- If brokered runs fall through to cloud credential errors, verify
  `crabbox config show`, `crabbox whoami`, and broker login before asking for
  cloud keys. Prefer broker auth or an existing brokered lease.
- If `blacksmith` is not installed, do not treat that as a direct-provider
  blocker. Use the brokered direct provider or local-container, and label the
  actual provider.

## Observability Flags

Use these on debugging runs before inventing ad hoc logging:

- `--preflight`: prints run context, workspace mode, SSH target, remote
  user/cwd, and target-specific tool probes (`git`, `tar`, `node`, `npm`,
  `corepack`, `pnpm`, `yarn`, `bun`, `docker`, plus POSIX
  `sudo`/`apt`/`bubblewrap` and native Windows
  `powershell`/`execution_policy`/`longpaths`/`temp`/`pwsh`). Add
  `--preflight-tools node,bun,docker`, `CRABBOX_PREFLIGHT_TOOLS`, or repo
  `run.preflightTools` to replace the list. `default` expands built-ins;
  `none` prints only the workspace summary. Preflight is diagnostic only. On
  `blacksmith-testbox`, this prints a delegated-unsupported note because the
  workflow owns setup.
- `CRABBOX_ENV_ALLOW=NAME,...`: forwards only listed local env vars for direct
  providers and prints `set len=N secret=true` style summaries. On
  `blacksmith-testbox`, env forwarding is unsupported; put secrets in the
  Testbox workflow instead.
- `--env-from-profile <file>` plus `--allow-env NAME`: loads simple
  `export NAME=value` / `NAME=value` lines from a local profile without
  executing it, then forwards only allowlisted names. `--allow-env` is
  repeatable and comma-separated. Profile values override ambient allowlisted
  env values for that run. Direct POSIX, WSL2, and native Windows runs are
  supported; delegated providers are not.
- `--env-helper <name>`: with `--env-from-profile` on POSIX SSH targets,
  persists `.crabbox/env/<name>` and `.crabbox/env/<name>.env` so follow-up
  commands on the same lease can run through `./.crabbox/env/<name> <command>`.
  Use only on leases you control; the profile stays until cleanup, lease
  reset, or `--full-resync`.
- `--script <file>` / `--script-stdin`: upload a local script into
  `.crabbox/scripts/` and execute it on the remote box. Shebang scripts
  execute directly on POSIX; scripts without a shebang run through `bash`.
  Native Windows uploads run through Windows PowerShell, and Crabbox appends
  `.ps1` when needed. Arguments after `--` become script args.
- `--fresh-pr owner/repo#123|URL|number`: skip dirty local sync and create a
  fresh remote checkout of the GitHub PR. Bare numbers use the current repo's
  GitHub origin. Add `--apply-local-patch` only when the current local
  `git diff --binary HEAD` should be applied on top of that PR checkout.
- `--full-resync` / `--fresh-sync`: reset a stale direct-provider workdir
  before syncing. Use after sync fingerprints look wrong, SSH times out before
  sync, or rsync watchdog output suggests it. It is redundant with
  `--fresh-pr`, incompatible with `--no-sync`, and unsupported by delegated
  providers.
- `--capture-stdout <path>` / `--capture-stderr <path>`: write remote streams
  to local files and keep binary/noisy output out of retained logs. Parent
  directories must already exist. Direct-provider only.
- `--capture-on-fail`: on non-zero direct-provider exits, downloads
  `.crabbox/captures/*.tar.gz` with `test-results`, `playwright-report`,
  `coverage`, JUnit XML, and nearby logs. Treat as secret-bearing until
  reviewed.
- `--keep-on-failure`: leave a failed one-shot lease alive for live debugging
  until idle/TTL expiry. Useful on direct providers and delegated one-shots.
- `--results-auto`: after test commands, scan common JUnit XML filenames and
  feed them into the failure digest. Use explicit `--junit <path>` for
  nonstandard result paths.
- `--timing-json`: final machine-readable timing. Add
  `echo CRABBOX_PHASE:install`, `CRABBOX_PHASE:test`, etc. in long shell
  commands; both direct providers and Blacksmith Testbox report them as
  `commandPhases`, and failed runs can use them to show the failed phase and
  observed phase order.

Live-provider debug template for direct leases:

```sh
mkdir -p .crabbox/logs
crabbox run \
  --preflight \
  --allow-env OPENAI_API_KEY,OPENAI_BASE_URL \
  --timing-json \
  --capture-stdout .crabbox/logs/live-provider.stdout.log \
  --capture-stderr .crabbox/logs/live-provider.stderr.log \
  --capture-on-fail \
  --shell -- \
  "echo CRABBOX_PHASE:install; bun install --frozen-lockfile; echo CRABBOX_PHASE:test; bun run test:integration"
```

Do not pass `--capture-*`, `--download`, `--checksum`, `--force-sync-large`,
or `--sync-only` to delegated providers. Also do not pass `--script*`,
`--fresh-pr`, `--full-resync`, or `--env-helper` there. Crabbox rejects these
because the provider owns sync or command transport. `--keep-on-failure` is OK
for delegated one-shots when you need to inspect a failed lease.

## Efficient Bug E2E Verification

Use the smallest Crabbox lane that proves the reported user path, not just the
touched code. Aim for one after-fix E2E proof before commenting, closing, or
opening a PR for a user-visible bug.

When the user says "test in Crabbox", do not simply copy tests to the remote
box and run them there. Crabbox is for remote real-scenario proof: install the
package as a user would, run the same setup/update/CLI call that failed, and
capture behavior from that entrypoint. For regressions or bug reports, prove
the broken state first when feasible, then run the same scenario after the
fix.

Pick the lane by symptom:

- Docker/setup/install bug: build a package tarball (`bun pm pack`) and run an
  install-from-tarball proof. This proves npm packaging, install paths,
  runtime deps, config writes, and container behavior.
- Provider/model/auth bug: prefer true live E2E. Use the configured secret
  workflow, then inject the single needed key into Crabbox if needed. Scrub
  unrelated provider env vars in the child command. If only a dummy key is
  used, label the proof narrowly, e.g. "UI/install path only; live provider
  auth not exercised."
- Session/tool bug: prefer an end-to-end CLI command that creates real state
  and inspects the resulting files/output.
- Pure parser/config bug: targeted tests may be enough, but still run a
  Crabbox command when OS, package, Docker, secrets, or service lifecycle
  could change behavior.

Efficient flow:

1. Reproduce or prove the pre-fix symptom from the real user-facing entrypoint
   when feasible. If the issue cannot be reproduced, capture the exact command
   and observed behavior instead.
2. Patch locally and run narrow local tests for edit speed.
3. Run one Crabbox E2E command that starts from the user-facing entrypoint.
4. Record proof as: lease id, command, environment shape, redacted secret
   source, and copied success/failure output.
5. If the issue says "cannot reproduce", ask for the missing config/log fields
   that would distinguish the tested path from the reporter's path.

Keep it efficient:

- Reuse existing E2E scripts and helper assertions before writing ad hoc
  shell.
- Use `--script <file>` or `--script-stdin` for multi-line E2E commands
  instead of quote-heavy `--shell` strings on direct SSH providers.
- Use `--fresh-pr <pr>` when validating an upstream PR in isolation from the
  local dirty tree. Add `--apply-local-patch` only when testing a local fixup
  on top of that PR.
- Use `--full-resync` before replacing a warmed direct-provider lease when the
  remote workdir or sync fingerprint appears stale.
- Use one-shot Crabbox for a single proof; use a reusable Testbox only when
  several commands must share built images, installed packages, or live state.
- Keep secrets redacted. It is fine to report key presence, source, and
  length; never print secret values.
- Include `--timing-json` on broad or flaky runs when command duration or sync
  behavior matters.

Before/after PR proof on delegated Testbox:

- For PRs that should prove "broken before, fixed after", compare base and PR
  on the same Testbox when practical. Fetch both refs, create detached temp
  worktrees under `/tmp`, install in each, then run the same harness twice.
- Do not checkout base/PR refs in the synced repo root. Delegated Testbox sync
  may leave the root dirty with local files; `git checkout` can abort or mix
  proof state.
- For full-screen TUI/CLI bugs, a PTY harness is stronger than helper-only
  assertions. Use a real PTY (or tmux on the box), wait for visible lifecycle
  markers, send input, then send control keys and assert process exit/stuck
  behavior.
- When validating a rebased local branch before push, remember delegated sync
  usually validates synced file content on a detached dirty checkout, not a
  remote commit object. Record the local head SHA, changed files, lease id,
  and final success markers; after pushing, ensure the pushed SHA has the same
  file content.

Interactive CLI/onboarding:

- For full-screen or prompt-heavy CLI flows, run the target command inside
  tmux on the box and drive it with `tmux send-keys`; capture proof with
  `tmux capture-pane`, redacted through `sed`.
- Prefer deterministic arrow navigation over search typing for searchable
  selects. Raw `send-keys -l <text>` may not trigger filtering in a tmux pane;
  inspect option order locally or on-box and send exact Down/Enter sequences.
- Isolate mutable state with a temp config/state dir (`mktemp -d`) so repeated
  onboarding runs start clean and downloads can be verified inside it.

## Reuse And Keepalive

For most Crabbox calls, one-shot is enough. Use reuse only when you need
multiple manual commands on the same hydrated box.

If Crabbox returns a reusable id or you intentionally keep a lease:

```sh
crabbox run --id <cbx_id-or-slug> --no-sync --timing-json --shell -- "bun test <path>"
```

Stop boxes you created before handoff:

```sh
crabbox stop <id-or-slug>
blacksmith testbox stop --id <tbx_id>
```

## Interactive Desktop And WebVNC

Prefer WebVNC for human inspection because the browser portal can preload the
lease VNC password and avoids a native VNC client's copy/paste/password dance.
Use native `crabbox vnc` only when WebVNC is unavailable, the browser portal
is broken, or the user explicitly wants a local VNC client.

Common desktop flow:

```sh
crabbox warmup --provider hetzner --desktop --browser --class standard --idle-timeout 60m --ttl 240m
crabbox desktop launch --provider hetzner --id <cbx_id-or-slug> --browser --url https://example.com --webvnc --open --take-control
```

Useful WebVNC commands:

```sh
crabbox webvnc --provider hetzner --id <cbx_id-or-slug> --open --take-control
crabbox webvnc daemon start --provider hetzner --id <cbx_id-or-slug> --open --take-control
crabbox webvnc daemon status --provider hetzner --id <cbx_id-or-slug>
crabbox webvnc daemon stop --provider hetzner --id <cbx_id-or-slug>
crabbox webvnc status --provider hetzner --id <cbx_id-or-slug>
crabbox webvnc reset --provider hetzner --id <cbx_id-or-slug> --open --take-control
crabbox desktop doctor --provider hetzner --id <cbx_id-or-slug>
crabbox desktop click --provider hetzner --id <cbx_id-or-slug> --x 640 --y 420
crabbox desktop paste --provider hetzner --id <cbx_id-or-slug> --text "user@example.com"
crabbox desktop key --provider hetzner --id <cbx_id-or-slug> ctrl+l
crabbox artifacts collect --id <cbx_id-or-slug> --all --output artifacts/<slug>
crabbox artifacts publish --dir artifacts/<slug> --pr <number>
crabbox artifacts list <artifact-manifest.json-or-url>
crabbox artifacts pull <artifact-manifest.json-or-url> --output /tmp/<slug>-proof
```

`desktop launch --webvnc --open` is usually the nicest one-shot: it starts the
browser/app inside the visible session, bridges the lease into the
authenticated WebVNC portal, and opens the portal. Keep browsers windowed for
human QA; use `--fullscreen` only for capture/video workflows. For human
handoff, include `--take-control` so the opened portal viewer gets
keyboard/mouse control automatically instead of landing as an observer.

Artifact publishing writes and uploads `artifact-manifest.json` by default.
Use that URL for PR-ready proof handoff; `artifacts pull` verifies size and
SHA256. Use `--skip-manifest` only for legacy markdown-only output. Never push
screenshots, videos, or proof assets to the product repo or a temp artifact
branch.

Human handoff preflight:

- Do not assume a visible desktop or launched browser means the repo CLI/app
  is installed, built, or on the interactive terminal's `PATH`.
- Before handing WebVNC to a human tester, prove the expected command from the
  same kept lease and from a neutral directory such as `~`.
- If the handoff needs repo-local code, sync/build/link it explicitly on that
  lease. Source-tree CLIs often need build output before a symlink works.
- Prefer a real `command -v <expected-command> && <expected-command> --version`
  check over a repo-root-only script command.

Generic handoff repair pattern:

```sh
crabbox run --id <cbx_id-or-slug> --full-resync --shell -- \
  "set -euo pipefail
   bun install --frozen-lockfile
   bun run --cwd packages/coding-agent build
   sudo ln -sf \"\$PWD/packages/coding-agent/dist/cli.js\" /usr/local/bin/atomic
   cd ~
   command -v atomic
   atomic --version"
```

## If Crabbox Fails

Keep the fallback narrow. First decide whether the failure is Crabbox itself,
the brokered lease, Blacksmith/Testbox, repo hydration, sync, or the test
command.

Fast checks:

```sh
command -v crabbox
crabbox --version
crabbox run --help | sed -n '1,140p'
crabbox doctor
command -v blacksmith
blacksmith --version
blacksmith testbox list
```

Common Crabbox-only failures:

- Provider missing or old CLI: update/install Crabbox before retrying.
- Bad local config: inspect `.crabbox.yaml`, `crabbox config show`, and
  `crabbox whoami`; normal validation should use the brokered provider without
  asking for cloud keys.
- Slug/claim confusion: use the raw `cbx_...` / `tbx_...` id, or run one-shot
  without `--id`.
- Sync/timing bug: add `--debug --timing-json`; capture the final JSON and the
  printed Actions URL. Large sync warnings include top source directories by
  file count and a hint to update `.crabboxignore` / `sync.exclude`; inspect
  those before reaching for `--force-sync-large`. Quiet rsync watchdogs and
  SSH timeouts print `next_action=` hints; follow them, usually
  `--full-resync` first and a fresh lease second.
- Cleanup uncertainty: run `crabbox list --provider <provider>`; for explicit
  Blacksmith runs, use `blacksmith testbox list` and stop only boxes you
  created.
- Testbox queued/capacity pressure: do not retry Blacksmith repeatedly. Rerun
  once without `--provider` so `.crabbox.yaml` routes to the brokered
  provider, or report the Blacksmith blocker if Testbox itself is the
  requested proof.

Auth fallback, only when `blacksmith` says auth is missing:

```sh
blacksmith auth login --non-interactive --organization <org>
```

Raw Blacksmith footguns:

- Run from repo root. The CLI syncs the current directory.
- Save the returned `tbx_...` id in the session.
- Reuse that id for focused reruns; stop it before handoff.
- Raw commit SHAs are not reliable `warmup --ref` refs; use a branch or tag.
- Treat `blacksmith testbox list` as cleanup diagnostics, not a shared
  reusable queue.

Use Blacksmith only when the task is specifically about Testbox, the brokered
provider is unavailable, or an explicit comparison is needed. If Blacksmith is
down or quota-limited, do not keep probing it; stay on the brokered provider
and note the delegated-provider outage.

## Brokered Provider Auth

The repo `.crabbox.yaml` selects the brokered direct provider, so omit
`--provider` unless testing a different provider deliberately.

New users should self-resolve broker auth before anyone asks for cloud keys:

```sh
crabbox config show
crabbox doctor
crabbox whoami
```

- If broker auth is missing, run
  `crabbox login --url <coordinator-url> --provider <provider>`.
- If the CLI asks for raw cloud credentials during normal validation, assume
  the wrong path was selected. Use brokered `crabbox login` or an existing
  brokered lease before asking the user for cloud credentials.
- Ask for cloud keys only for explicit direct-provider/account
  administration, not for normal brokered proof.
- Trusted automation may use
  `printf '%s' "$CRABBOX_COORDINATOR_TOKEN" | crabbox login --url <coordinator-url> --provider <provider> --token-stdin`.

macOS config lives at:

```text
~/Library/Application Support/crabbox/config.yaml
```

It should include `broker.url`, `broker.token`, and usually the default
`provider`. Let that config drive normal validation.

## Diagnostics

```sh
crabbox status --id <id-or-slug> --wait
crabbox inspect --id <id-or-slug> --json
crabbox sync-plan
crabbox history --limit 20
crabbox history --lease <id-or-slug>
crabbox attach <run_id>
crabbox events <run_id> --json
crabbox logs <run_id>
crabbox results <run_id>
crabbox cache stats --id <id-or-slug>
crabbox cache volumes
crabbox ssh --id <id-or-slug>
blacksmith testbox list
```

Use `--debug` on `run` when measuring sync timing. Use `--timing-json` on
warmup, hydrate, and run when comparing backends. Use `--market spot|on-demand`
only on providers that support market selection for warmup/one-shot runs.

## Failure Triage

- Crabbox cannot find provider: verify `crabbox --help` lists the provider
  selected by `.crabbox.yaml`; update Crabbox before falling back.
- Hydration stuck or failed: open the printed GitHub Actions run URL and
  inspect the hydration step.
- Sync failed: rerun with `--debug`; check changed-file count and whether the
  checkout is dirty.
- Command failed: read the failure digest before rerunning. Use `phase`,
  `area`, `retryable`, `failed_phase`, `observed_phases`, shell-chain skip
  notes, `test_results`, and `failed_test` lines to choose the smallest
  focused rerun. Do not rerun a full suite until the failing shard/file or
  skipped `&&` segment is understood.
- Cleanup uncertain: `crabbox list --provider <provider>`; for explicit
  Blacksmith runs, use `blacksmith testbox list` and stop owned `tbx_...`
  leases you created.
- Crabbox broken but Blacksmith works: use the direct Blacksmith fallback,
  then file/fix the Crabbox issue.

## Boundary

Do not add repo-specific setup to Crabbox itself. Put repo setup in the
hydration workflow and keep Crabbox generic around lease, sync, command
execution, logs/results, timing, and cleanup.
