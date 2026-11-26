---
title: "Resume sessions on any machine"
sidebarTitle: "Resume anywhere"
description: "Continue sessions on another machine using shared storage, worktree snapshots, and environment blueprints."
---

When several machines share one storage database, you can start a session on one machine and continue it on any other. Atomic reads the session from shared storage, rebuilds the repository files it was working against, runs optional environment blueprints, and continues the conversation where it stopped.

## Join each machine

Every machine must use the same shared database, either PostgreSQL or Turso / libSQL. Do not embed passwords or auth tokens in the database URL; pass credentials through `--password-file`, `--token-file`, or `--auth` (`credential-in-url`).

**PostgreSQL (PostgreSQL 16 or newer for sessions):**

In two-role deployments, run `atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password` once as the owner role (and after Atomic upgrades), then grant the runtime role its privileges before joining machines as `atomic_runtime`. See [Set up the database](/storage#set-up-the-database).

```bash
atomic install npm:@bastani/atomic-storage-postgres
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
atomic intercom restart
atomic storage status
```

See [PostgreSQL](/storage#postgresql) for database roles, TLS, and cloud identities.

**libSQL / Turso:**

```bash
atomic install npm:@bastani/atomic-storage-libsql
atomic storage join libsql://<db>.turso.io --token-file ~/turso-token
atomic intercom restart
atomic storage status
```

`atomic storage join` stores sessions in the shared database so they resume on any joined machine. By contrast, `atomic team join` ([Set up teams and CI](/guides/team-setup)) shares Intercom while keeping personal sessions local. To share sessions on a machine joined with `atomic team join`, run `atomic team leave` and then `atomic storage join`. See [Sharing storage across hosts](/storage#sharing-storage-across-hosts) for prefixes, tokens, and `atomic storage status`.

Keep worktree snapshots enabled (`snapshots.enabled`, on by default). At the end of each turn that modifies files, Atomic saves uncommitted edits, untracked files, and unpushed commits in the shared database. If `snapshots.enabled` is set to `false`, no snapshots are captured, cross-machine resume cannot restore repository files, and `atomic blueprint prebuild` fails with `snapshots are disabled`.

Work inside submodules and untracked nested repositories is not recorded, and resume warns with `nested-repository`, `submodule-changes`, or `unpushed-submodule-commit` so you can commit and push those changes first. See [What is left out](/worktree-snapshots#what-is-left-out).

## Resume a session

Resume as usual with `atomic --session <id>`, `atomic --resume`, or `/resume` (see [Resuming and deleting sessions](/sessions#resuming-and-deleting-sessions)).

- **Matching local checkout.** If you start Atomic inside a checkout of the same repository whose files match the snapshot (or where the recorded edits were committed), the session continues there directly.
- **Restored worktree.** Otherwise, Atomic restores the recorded state into a worktree under `~/.atomic/agent/worktree-snapshots` without modifying your local checkouts, and prints the restored path. Atomic reuses a clean idle worktree of the same repository when available so existing dependencies and build output stay intact. See [Restored worktrees](/worktree-snapshots#restored-worktrees).
- **Changed local checkout.** If you start `atomic` interactively in a checkout of the same repository that differs and has uncommitted or untracked changes, Atomic asks whether to restore a fresh worktree (the default), continue in your checkout as-is, or cancel. `/resume`, non-interactive modes such as `-p`, and clean differing checkouts restore a fresh worktree automatically.
- **Partial (degraded) restore.** If the exact tree cannot be rebuilt (for example, an unreachable remote, a missing blob, or unpushed commits touching denied secret files), the session still opens with its full conversation. Atomic restores the closest reachable state and prints a notice naming what is missing and how to recover. See [Resuming](/worktree-snapshots#resuming).
- **Multiple checkouts.** A session that modified several checkouts restores each one that is missing on this machine. Only the checkout the session works in must be restorable; any other checkout that cannot be restored or changed locally produces a warning without blocking the resume.
- **Timing diagnostics.** Run `/session snapshot` to inspect the **Last resume** timing breakdown (fetch, materialize, LFS, verify, and each blueprint step), or run `ATOMIC_TIMING=1 atomic --session <id>` to print timings to stderr. See [Inspecting snapshots](/worktree-snapshots#inspecting-snapshots).

Absolute paths from the earlier machine keep working in built-in file tools because Atomic maps paths under the old checkout to the restored worktree. Shell commands run as written, so commands containing old absolute paths need the new worktree path.

Passing `--session <id>` for a session whose recorded directory does not exist on this machine opens directly instead of offering to fork the session. SDK callers using `createAgentSession({ sessionManager })` get the same restore behavior unless they pass `cwd` or `workspace`, even when the recorded path exists on this machine with different files (such as runners built from the same container image). See [Worktree snapshots in the SDK](/sdk#worktree-snapshots) and [SDK session storage](/sdk/storage).

If shared storage does not answer, `atomic --session`, `--resume`, `--continue`, and `/resume` stop after 15 seconds with a retryable `ResumeCatalogTimeoutError`. Nothing is modified; resume again once `atomic storage status` connects.

### When the session is already open

A session runs in one process at a time. `atomic --session`, `--resume`, and `--continue` claim the session before writing to it or restoring checkouts. If another live process on this machine already holds the session, resume makes no changes and exits with code `75`:

```text
Error: Session <id> is already open in process <pid> on <host>. Nothing was changed. Close it there or wait for that process to exit, then resume again.
```

Interactive mode prints the same message before starting. If several resumes start simultaneously, one succeeds and the others exit with code `75`.

Claims live under `~/.atomic/agent/session-claims` and apply to processes sharing that agent directory. A claim left by a dead process (such as after `SIGKILL`) is taken over automatically. Atomic matches holders by PID and, on Linux and Windows, by process start time so a later process reusing the same PID does not block resume. A claim from another host refreshes every 15 seconds and expires after 60 seconds without a refresh.

If a process using a different agent directory writes to the same session in shared storage at the same time, the conflicting write stops with `Another process wrote to session <id> ...` and exit code `1`. Resume the session again to continue from saved state.

## Resuming subagents on another machine

Both fresh and forked (`context: "fork"`) subagents store their sessions in the launching parent's shared database and can resume and export on another machine.

When a background subagent resumes on another machine, Atomic maps its recorded directory through the parent session's restored checkouts, then prepares the subagent's own checkouts from its snapshots and builds their blueprints. Its file tools resolve old absolute paths into the restored worktrees.

Only subagents whose parent uses JSONL session files, and file-backed subagents from earlier releases, stay tied to the machine that launched them and report as unrestorable elsewhere.

## Set the environment up with a blueprint

A restored worktree contains repository files, not installed dependencies, runtimes, or build output. A *blueprint* defines how Atomic sets up the environment again. Atomic uses the [blueprint](https://docs.devin.ai/onboard-devin/environment/blueprints) YAML format, except repository blueprints live at `.atomic/blueprint.yaml` instead of `.devin/blueprint.yaml`. Atomic never reads `.devin/` paths.

| Blueprint | File | Working directory |
| --- | --- | --- |
| Global | `~/.atomic/agent/blueprint.yaml` | Your home directory |
| Repository | `.atomic/blueprint.yaml` at repository root | Repository root |
| Workspace | `<dir>/.atomic/blueprint.yaml`, listed in `includes` of the repository blueprint | Workspace directory |

```yaml
runs-on: [linux, macos, windows]
includes:
  - services/api
initialize:
  - name: Install Node.js
    uses: github.com/actions/setup-node@v4
    with:
      node-version: "24"
  - name: Install pnpm
    run: npm install -g pnpm
maintenance:
  - name: Install dependencies
    run: pnpm install
knowledge:
  - name: test
    contents: |
      Run the tests with `pnpm test`.
```

**Always set `runs-on` for macOS or Windows.** If a blueprint omits `runs-on`, Atomic defaults to `["linux"]` only, which silently does nothing on macOS and Windows. Add `runs-on: [macos]`, `runs-on: [windows]`, or `runs-on: [linux, macos, windows]`, or define separate `---`-separated YAML documents per operating system.

| Section | Purpose | When it runs |
| --- | --- | --- |
| `initialize` | Install tools, runtimes, and system packages | During a build |
| `maintenance` | Install or update project dependencies. Keep it fast and incremental (for example `npm install` rather than `npm ci`) | During a build. Shown to the agent at session start, never run automatically at prompt time |
| `knowledge` | List of `{ name, contents }` items (by convention `lint`, `test`, and `build`) | Never executed. Provided to the agent as context |
| `post-build` | Verify the assembled environment (global blueprint only) | During a build, after all repositories |

Each section accepts a single string (one `run` step) or a list of steps. A step is a bare string, `{ name?, run, env? }`, or `{ name?, uses, with?, env? }`, never both `run` and `uses`. `with` applies only to `uses`; YAML scalar values (including numbers and booleans) are converted to strings, and `null` becomes `""`.

`uses` accepts `github.com/<owner>/<repo>[/<subpath>]@<ref>` in `initialize` and `post-build` (never in `maintenance`, where Atomic rejects it with `'uses' steps are not supported in maintenance sections`). Owner must start with an alphanumeric character and use `[A-Za-z0-9-]`, repo uses `[A-Za-z0-9._-]`, and ref cannot contain whitespace, control characters, or `~^:?*[\`. Node.js and composite GitHub Actions are supported; Docker actions and composite actions using `hashFiles`, `secrets`, or `matrix` expressions fail the step. Anything an action writes to `GITHUB_ENV` or `GITHUB_PATH` is automatically appended to `$ENVRC` for later steps and the session. Actions cache under `~/.atomic/agent/blueprint-actions`. Set `ATOMIC_BLUEPRINT_GITHUB_BASE_URL` to fetch actions from a host other than `https://github.com`.

Key blueprint rules:

- **Platforms and validation.** `runs-on` accepts a string or list matched case-insensitively (`default` and `linux` are aliases; `macos` and `windows` are explicit; omitting `runs-on` defaults to `["linux"]` only). A file can contain multiple `---`-separated YAML documents as long as no two documents target the same platform. A machine runs only the document matching its OS, but Atomic validates **every** document in the file, so a syntax or schema error in a `windows` document fails the blueprint on Linux too.
- **Shell.** `shell` accepts `"default"`, `"bash"`, or `"powershell"` (case-insensitive). `run` steps execute in bash (Git Bash on Windows) with `set -e` so they stop at the first failing command. Setting `shell: powershell` runs PowerShell on Windows with `$ErrorActionPreference = 'Stop'` (on Linux and macOS, `run` steps always execute in bash). Commands must be non-interactive.
- **Environment.** Step `env:` applies to that step only and overrides `$ENVRC`. In bash, Atomic sources `$ENVRC` with `set -a`, so plain `KEY=VALUE` lines appended to `$ENVRC` (for example `echo "API_URL=http://localhost:3000" >> "$ENVRC"`) are exported automatically to later steps and the resumed session's bash tool without needing `export`. On Windows, `$ENVRC` is evaluated by Git Bash with `PATH` converted back automatically; from PowerShell steps, write UTF-8 bash assignments with LF line endings and no BOM to `$env:ENVRC`. `$ENVRC` starts empty on every build, so `maintenance` should not depend on values `initialize` wrote during an earlier build.
- **Timeout.** Any step running longer than 3 hours is stopped and marked failed.
- **Includes.** The repository blueprint can list workspace directories (or `<dir>/.atomic/blueprint.yaml` paths) in `includes`, without `..` or duplicates. Workspace blueprints cannot declare `includes`, global blueprints ignore `includes`, and only global blueprints allow `post-build`.
- **Ignored keys.** `clone` is ignored with a warning because resume restores the recorded tree. `cache` triggers a warning pointing to `resume.cache`. Other unknown keys are ignored silently.

Note: Legacy `.atomic/setup` is no longer read. `resume.setupCommand` is deprecated, acts temporarily as a single global maintenance step with a deprecation warning, and should be moved into the `maintenance` section of `.atomic/blueprint.yaml`.

### How blueprint builds run

When resume restores a worktree, Atomic builds in order: global `initialize` and `maintenance`, then each repository's `initialize` and `maintenance` (followed by its included workspaces), then global `post-build`. Existing local checkouts that resume directly are never built.

**Project trust required.** A restored worktree is a new directory, so project trust starts unset just like a fresh clone. Because builds run project code, repository blueprints execute only for trusted projects (saved trust, `--approve`, or `"defaultProjectTrust": "always"`). Untrusted worktrees skip project instructions, resources, and blueprint builds silently (though the agent still receives `maintenance` and `knowledge` marked as not yet run), and the global blueprint runs only when at least one restored worktree is trusted.

Builds are differential. Atomic compares each workspace blueprint against the last successful build on this machine:

- Unchanged workspaces skip `initialize` and run only `maintenance`.
- New, edited, or previously failed workspaces run both `initialize` and `maintenance`.
- A full rebuild runs across all workspaces (including global `initialize`) whenever the global blueprint changes or the last full build is older than 7 days.

A step fails if its command exits non-zero, raises a PowerShell error, times out after 3 hours, or cannot start (Atomic briefly retries temporarily busy executables for up to 2 seconds before failing). When a step fails, the remaining steps of that blueprint are skipped while other repositories and workspaces continue building. A blueprint failure never blocks resuming the session:

| Outcome | Result | What you see |
| --- | --- | --- |
| Repository or workspace blueprint failed | Partial. Worktree files are intact and usable. | Warning naming the blueprint, failing step, and log path |
| Global blueprint or `post-build` failed | Failed. Repository blueprints do not run. | Prominent warning. The session still resumes |
| No blueprint, untrusted worktree, or no matching platform | Nothing ran | Nothing |

On Windows, if a stopped step could not be tracked as a process group after its root command exited, Atomic warns that child processes may still be running. Check for leftover processes before retrying.

Every step writes a log under `~/.atomic/agent/worktree-snapshots/blueprint-logs` containing command, timestamps, duration, exit status, and output. To recover from a failed build, read the log, fix the environment or blueprint, and resume again.

### Start the first turn while the build runs

`resume.waitForBlueprint` controls whether Atomic waits for blueprint builds before opening the session:

- `"prompt"` (default in the interactive TUI) opens the session after the build finishes.
- `"tools"` (default in `-p`, `--mode json`, `--mode rpc`, and SDK sessions) opens the session immediately after restoring files so the first model request starts while the build runs in the background.

In `"tools"` mode, Atomic tells the agent that the environment is still building and holds every tool call and shell command in the restored worktree (including forks or switches into that worktree) until the build settles. The first waiting tool call receives the build result ahead of its own output. Warnings are reported once via stderr (`-p`) or a `blueprint_build_finished` event (`--mode json` and `--mode rpc`).

Interrupting a turn cancels the tool wait without stopping the build. `atomic -p` and `--mode json` print their answer and exit once the build finishes.

Stopping and concurrent builds:

- **Graceful stop (Ctrl-C, signals, or RPC stdin closing).** Atomic stops running build processes and rebuilds the worktree on the next resume.
- **Abrupt kill (`SIGKILL`).** On Unix, the next resume cancels the interrupted build, terminates confirmed recorded build processes, sets that worktree aside so no session reuses it, and restores and builds a fresh worktree with a warning naming the set-aside path and logs. Atomic cleans up set-aside worktrees once no process uses them ([Restored worktrees](/worktree-snapshots#restored-worktrees)). On Windows, step processes exit with Atomic, so the next resume rebuilds the same worktree.
- **Concurrent resumes on one worktree.** Only one build runs per worktree. Switching back to a session whose build is still running joins it. Another Atomic process waits up to 5 minutes (printing a stderr line or emitting `blueprint_build_waiting`) before rebuilding with a warning.

To override the mode default, set `resume.waitForBlueprint` in settings:

```json
{ "resume": { "waitForBlueprint": "prompt" } }
```

When an installed extension can decline saved project trust ([Project trust](/security#project-trust)), resume always defers the blueprint build like `"tools"` until trust is decided, and untrusted worktrees stay unbuilt.

### What the agent sees

The first turn of a resumed session includes each applicable blueprint's `maintenance` steps and `knowledge` items, tagged with their build status (ran in this build, not yet run, or partial with the failing step and log path). The agent reruns `maintenance` itself if dependencies change. Atomic's default system prompt also guides the agent to maintain `.atomic/blueprint.yaml` as project setup evolves, leaving `~/.atomic/agent/blueprint.yaml` alone unless asked.

### Caches for runners

Ephemeral runners start with an empty home directory on every job. Run `atomic blueprint cache-key` to generate cache keys, restore prefixes, and paths for CI cache actions such as `actions/cache`. Atomic does not upload or download caches itself.

```bash
atomic blueprint cache-key [dir] [--format text|json|github-output]
```

Atomic detects package stores automatically from lockfiles at the repository root:

| Root files | Detected stores (Linux default) |
| --- | --- |
| `package-lock.json`, `npm-shrinkwrap.json` | `~/.npm` (`npm_config_cache`) |
| `pnpm-lock.yaml` | `~/.local/share/pnpm/store` (`npm_config_store_dir`, `PNPM_HOME`, `XDG_DATA_HOME`) |
| `yarn.lock` | `~/.cache/yarn` (`YARN_CACHE_FOLDER`); with `.yarnrc.yml`, `~/.yarn/berry/cache` (`YARN_GLOBAL_FOLDER`) |
| `bun.lock`, `bun.lockb` | `~/.bun/install/cache` (`BUN_INSTALL_CACHE_DIR`, `BUN_INSTALL`) |
| `Cargo.lock` | `~/.cargo/registry`, `~/.cargo/git` (`CARGO_HOME`) |
| `uv.lock` | `~/.cache/uv` (`UV_CACHE_DIR`) |
| `requirements.txt`, `Pipfile.lock` | `~/.cache/pip` (`PIP_CACHE_DIR`) |
| `poetry.lock` | `~/.cache/pypoetry` (`POETRY_CACHE_DIR`) |
| `go.sum` | `~/go/pkg/mod`, `~/.cache/go-build` (`GOMODCACHE`, `GOPATH`, `GOCACHE`) |
| `build.gradle(.kts)`, `settings.gradle(.kts)`, `gradle.lockfile`, Gradle wrapper | `~/.gradle/caches`, `~/.gradle/wrapper` (`GRADLE_USER_HOME`) |
| `pom.xml` | `~/.m2/repository` |

Environment variables in parentheses move each store, and `XDG_CACHE_HOME` moves Linux `~/.cache` paths. On macOS, Yarn v1 uses `~/Library/Caches/Yarn`, pip uses `~/Library/Caches/pip`, Poetry uses `~/Library/Caches/pypoetry`, Go build cache uses `~/Library/Caches/go-build`, and pnpm uses `~/Library/pnpm/store` (npm, uv, Bun, Cargo, Go modules, Gradle, and Maven match Linux). Windows uses `%LOCALAPPDATA%` (such as `npm-cache`, `pnpm\store`, `Yarn\Cache`, `uv\cache`, `pip\Cache`, and `pypoetry\Cache`). Subdirectory lockfiles in monorepos are not auto-detected.

Declare additional stores or build outputs under `resume.cache` in `.atomic/settings.json` (a project list replaces the global list). Blueprints themselves do not declare caches:

```json
{
  "resume": {
    "cache": [
      { "paths": ["/opt/tool-cache"] },
      { "paths": ["target"], "kind": "build", "keyFiles": ["Cargo.lock", "rust-toolchain.toml"] }
    ]
  }
}
```

Each entry takes `paths`, an optional `kind`, and optional `keyFiles`:

- `"kind": "store"` (default) paths must be absolute or start with `~/` outside the worktree and join the `stores` entry.
- `"kind": "build"` paths must be repository-relative and name build outputs parked by `atomic blueprint prebuild --park` under `~/.atomic/agent/worktree-snapshots/seeds/`. Build paths cannot name `.npmrc`, `.pypirc`, `.yarnrc.yml`, or snapshot-denied paths. If a `"build"` path contains Git-tracked files, `cache-key` warns and `prebuild --park` parks only untracked and ignored files under it while leaving tracked files untouched.
- `keyFiles` lists root-relative files hashed into the key (defaulting to detected lockfiles and toolchain files). `keyFiles` cannot be empty (`[]` causes the entry to be ignored with a warning) and cannot contain `..` or absolute/drive paths.
- Paths must be literal paths without glob characters (`*`, `?`, `[`, `]`, `{`, `}`) or a leading `!`. Invalid entries are skipped with a warning.

| Entry | Paths | Key changes when |
| --- | --- | --- |
| `stores` | Detected package stores plus `"store"` paths in `resume.cache` | Lockfiles, `keyFiles`, `resume.cache`, repository blueprint, OS, or architecture change |
| `build` | Parked `"build"` paths and seed manifest | Same inputs as `stores` |
| `git` | Atomic's Git object store for the repository | Checkout `HEAD` changes (restore newest via restore prefix) |
| `atomic` | Atomic's compiled extension cache | Atomic version, OS, or architecture change |

Entries with no paths are omitted. The `git` and `build` entries require a Git remote. Atomic normalizes HTTPS remotes and `git@` SSH remotes by host and repository path so HTTPS runner checkouts reuse caches built from SSH checkouts (other SSH usernames stay distinct).

To protect secrets, `cache-key` omits store paths inside the worktree, snapshot-denied paths ([What is left out](/worktree-snapshots#what-is-left-out)), and these home credential paths (along with any parent directory containing one, so `~/.cargo` is omitted because it holds `~/.cargo/credentials`, while `~/.cargo/registry` is allowed): `.aws`, `.azure`, `.cargo/credentials`, `.cargo/credentials.toml`, `.config/gcloud`, `.config/gh`, `.docker/config.json`, `.gem/credentials`, `.git-credentials`, `.gnupg`, `.gradle/gradle.properties`, `.kube`, `.m2/settings.xml`, `.netrc`, `.npmrc`, `.pypirc`, `.ssh`, `.terraform.d/credentials.tfrc.json`, and `.yarnrc.yml`. Checks run case-insensitively and across symlinks, with a warning on stderr.

Use `--format github-output` to emit `<name>-key`, `<name>-restore-prefix`, and `<name>-paths` lines for `$GITHUB_OUTPUT`. See [Caching between runs](/guides/team-setup#caching-between-runs) for a full GitHub Actions workflow.

### Prebuilt worktrees

`atomic blueprint prebuild` prepares a repository ahead of time so a later resume starts with dependencies and build artifacts already built:

```bash
atomic blueprint prebuild [dir] [--park] [--approve]
```

Prebuild restores the committed `HEAD` at `dir` (defaulting to the current directory) into a new worktree, runs `initialize` and `maintenance`, and leaves the worktree idle for the next resume to claim. Only committed files are restored, so untracked or ignored files such as `.env` never enter the worktree.

Prebuild requires:

- `snapshots.enabled` set to `true` (otherwise it exits with `snapshots are disabled`).
- A Git remote on the checkout.
- No uncommitted edits to tracked files, and no unpushed commits touching denied secret files (`unpushed-history-denied`).
- A trusted project (saved trust, `"defaultProjectTrust": "always"`, or `--approve`), because prebuild runs project code.

If a blueprint step fails, prebuild exits `1`, deletes the new worktree, and preserves earlier worktrees and seeds. Timings print to stderr.

With `--park`, Atomic moves untracked build output declared with `"kind": "build"` in [`resume.cache`](#caches-for-runners) into `~/.atomic/agent/worktree-snapshots/seeds/` along with a manifest naming the built commit. When another machine restores that cache and has no idle worktree, resume creates a worktree at the same path used during prebuild, moves the parked output into place (without overwriting tracked or existing files), and checks out the session snapshot. `/session snapshot` labels such restores `(seeded)` with a `seed` timing line.

If parking cannot acquire the seed lock, prebuild reports the error, leaves existing seeds intact, and keeps the completed build in its idle worktree for local reuse.

## What can stop a resume

Atomic checks required setup in one pass before restoring anything: the storage adapter, its credentials, and Git. When Git is absent, Atomic provisions a portable Git automatically unless offline or download fails.

For session resumes, missing Git never blocks opening the session. Instead, the session opens in its recorded or current directory with a notice for each unrestored checkout. A session resume fails only when the session cannot be read, a snapshot fails security checks (`invalid-snapshot`), or a target directory contains unexpected files (`unsafe-target`). Blueprint failures never stop a resume.

| Symptom | Fix | SDK error and code |
| --- | --- | --- |
| Session ID not found on this machine | If this machine uses local storage only (`local-storage-not-joined`), join shared storage with `atomic storage join` (run `atomic team leave` first if joined with `atomic team join`). If already joined (`shared-miss`), check the session ID, database URL, and prefix. | `ResumeNotFoundError` (`not-found`) |
| Missing storage adapter, missing or unreadable credentials, or unavailable Git | Follow each fix listed in the error, such as running `atomic install`, creating the token or password file, or unsetting offline mode. | `ResumePreconditionError` (`preconditions-unmet`) |
| Git cannot be started or downloaded | Follow the hint (install Git on `PATH` or unset `ATOMIC_OFFLINE`). Session resumes still open without restoring checkouts. | `GitUnavailableError` (`not-installed`, `unsupported-platform`, `offline`, `checksum-mismatch`, `download-failed`, `install-failed`) |
| Shared database unreachable during lookup | Check connectivity with `atomic storage status` and resume again. | `ResumeCatalogUnavailableError` (`catalog-unavailable`) |
| Shared database lookup timed out after 15 seconds | Check connectivity with `atomic storage status` and resume again. | `ResumeCatalogTimeoutError` (`catalog-timeout`) |
| Checkout cannot be rebuilt exactly (denied unpushed commits, missing blob, or full disk) | Follow the notice (for unpushed commits, push from the original machine and resume again). Session resumes still open with the closest state. | `WorkspaceDriftError` (`tree-drift`) |
| Windows worktree path exceeds Git for Windows limits | Set `ATOMIC_CODING_AGENT_DIR` to a shorter path ([Long paths on Windows](#long-paths-on-windows)). Nothing is written. | `WorkspaceRestoreError` (`path-too-long`) |
| Snapshot fails security validation (credentials in remote URL, `ext::` remote helper, or malformed hashes) | Resume only sessions from trusted storage, or re-export from the source machine. Nothing is fetched or run. | `WorkspaceRestoreError` (`invalid-snapshot`) |

Secret values never appear in error messages; errors name only the file or environment variable. SDK error classes, codes, and `isResume*Error` guards are exported from `@bastani/atomic`; see [Resuming on another machine](/sdk/reference#resuming-on-another-machine).

## Windows

Sessions resume on Windows as they do on Linux and macOS.

### Long paths on Windows

Atomic restores worktrees under `%USERPROFILE%\.atomic\agent` unless `ATOMIC_CODING_AGENT_DIR` overrides it. Even with `core.longpaths`, Git for Windows enforces path limits on administrative paths:

- Object store (`worktree-snapshots\repositories\<id>.git`): 220 characters
- Worktree root: 212 characters
- Worktree Git directory under `<store>\worktrees`: 247 characters

Atomic keeps internal directory names short, opens local SQLite files with the `\\?\` long-path prefix, and enables `core.longpaths` inside restored object stores. With these defaults, an agent directory path up to about 155 characters works.

If a longer agent directory would exceed those limits, restore fails before writing anything with `WorkspaceRestoreError` (`code: "path-too-long"`). Move the agent directory to a shorter path:

```powershell
$env:ATOMIC_CODING_AGENT_DIR = "C:\atomic\agent"
```
