---
title: "Resume sessions on any machine"
sidebarTitle: "Resume anywhere"
description: "Continue sessions on another machine using shared PostgreSQL storage, worktree snapshots, environment blueprints, and CI runner caches."
---

When several machines share one PostgreSQL storage database, you can start a session on one machine and continue it on any other. Atomic reads the session from shared storage, rebuilds the repository files it was working against, runs optional environment blueprints, and continues the conversation where it left off.

## Join each machine

Every machine must use the same shared [PostgreSQL](/storage/postgres) database (PostgreSQL 16 or newer).

<Steps>
  <Step title="Set up the database once">
    Create the owner and runtime roles, then run `atomic storage migrate` as the owner role (and re-run it after each Atomic upgrade). See [Set up the database](/storage/postgres#set-up-the-database).
  </Step>
  <Step title="Join every machine as the runtime role">
    Install the PostgreSQL adapter, save the runtime role's password in a private file, join the database, and restart Intercom:

    ```bash
    atomic install npm:@bastani/atomic-storage-postgres
    (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
    atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
    rm ~/atomic-db-password  # atomic storage join keeps its own copy
    atomic intercom restart
    atomic storage status
    ```
  </Step>
</Steps>

<Warning>
Never put a password in the database URL. Always pass credentials with `--password-file`, `--token-file`, or `--auth` (see [Join a machine](/storage/postgres#join-a-machine)). A URL containing a password is rejected immediately.
</Warning>

`atomic storage join` stores sessions in the shared database so any joined machine can resume them. If a machine sets `sessions.storage` to `{}` (keeping sessions local while sharing only Intercom), remove that setting so its sessions go to the shared database too. See [Sharing storage across hosts](/storage#sharing-storage-across-hosts).

Keep worktree snapshots enabled (`snapshots.enabled`, on by default). At the end of each turn that modifies files, Atomic saves uncommitted edits, untracked files, and unpushed commits in the shared database. If `snapshots.enabled` is `false`, session turns do not capture snapshots and cross-machine resume cannot restore repository files (`atomic blueprint prebuild` still runs because it snapshots the committed `HEAD` independently of `snapshots.enabled`).

Work inside submodules and untracked nested repositories is not recorded, and resume warns so you can commit and push those changes first. See [What is left out](/worktree-snapshots#what-is-left-out).

## Resume a session

Resume as usual with `atomic --session <id>`, `atomic --resume`, or `/resume` (see [Resuming and deleting sessions](/sessions#resuming-and-deleting-sessions)).

- **Matching local checkout.** If you start Atomic inside a checkout of the same repository whose files match the snapshot (or where the recorded edits were committed), the session continues there directly.
- **Restored worktree.** Otherwise, Atomic restores the recorded state into a worktree under `~/.atomic/agent/worktree-snapshots` without modifying your local checkouts, and prints the restored path. Atomic reuses a clean idle worktree of the same repository when available so existing dependencies and build output stay intact ([Restored worktrees](/worktree-snapshots#restored-worktrees)).
- **Changed local checkout.** If you start `atomic` interactively in a checkout of the same repository that differs and has uncommitted or untracked changes, Atomic asks whether to restore a fresh worktree (the default), continue in your checkout as-is, or cancel. `/resume`, non-interactive modes such as `-p`, and clean differing checkouts restore a fresh worktree automatically.
- **Partial (degraded) restore.** If the exact tree cannot be rebuilt (for example, an unreachable remote, a missing blob, or unpushed commits touching denied secret files), the session still opens with its full conversation. Atomic restores the closest reachable state and prints a notice naming what is missing and how to recover ([Resuming](/worktree-snapshots#resuming)).
- **Multiple checkouts.** A session that modified several checkouts restores each one that is missing on this machine. Only the checkout the session works in must be restorable; any other checkout that cannot be restored produces a warning without blocking the resume.
- **Timing diagnostics.** Run `/session snapshot` to inspect the **Last resume** timing breakdown, or run `ATOMIC_TIMING=1 atomic --session <id>` to print timings to stderr ([Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)).

Absolute paths from the earlier machine keep working in built-in file tools because Atomic maps paths under the old checkout to the restored worktree. Shell commands run as written, so commands containing old absolute paths need the new worktree path.

Passing `--session <id>` for a session whose recorded directory does not exist on this machine opens directly instead of offering to fork. If shared storage does not respond within 15 seconds, `atomic --session`, `--resume`, `--continue`, and `/resume` stop without modifying anything; verify connectivity with `atomic storage status` and try again.

For SDK resume behavior with `createAgentSession({ sessionManager })`, see [Worktree snapshots in the SDK](/sdk#worktree-snapshots) and [SDK session storage](/sdk/storage).

### When the session is already open {#when-the-session-is-already-open}

A session runs in one process at a time. `atomic --session`, `--resume`, and `--continue` claim the session before writing to it or restoring checkouts. If another live process on the same agent directory already holds the session, resume makes no changes and exits with code `75`:

```text
Error: Session <id> is already open in process <pid> on <host>. Nothing was changed. Close it there or wait for that process to exit, then resume again.
```

Interactive mode prints the same message before starting. If several resumes start simultaneously, one succeeds and the others exit with code `75`.

Atomic uses two separate coordination records:

- **Session claims (`~/.atomic/agent/session-claims/<id>.json`).** Prevent concurrent resumes across processes sharing an agent directory. Claims left by dead processes (such as after `SIGKILL`) are taken over automatically—matching holders by PID and, on Linux and Windows, by process start time so reused PIDs never block resume. Claims refresh every 15 seconds and expire after 60 seconds without a refresh on another host sharing the directory.
- **Open-session markers (SQL `session_open_markers` or `<agentDir>/open-sessions/<id>/<token>.json`).** Track active sessions across every host sharing a database so another host cannot delete an open session and one-way shared-history schema upgrades wait until older releases close. Markers refresh every 15 seconds, expire after 60 seconds from another host, and expire after 24 hours without a refresh on same-host markers that lack a process start timestamp (such as on macOS).

If a process using a different agent directory writes to the same session in shared storage at the same time, the conflicting write stops with `Another process wrote to session <id> ...` and exit code `1`. Resume again to continue from saved state.

## Resuming subagents on another machine

Both fresh and forked (`context: "fork"`) subagents store their sessions in the launching parent's shared database and can resume and export on another machine.

When a background subagent resumes on another machine, Atomic maps its recorded directory through the parent session's restored checkouts, then prepares the subagent's own checkouts from its snapshots and builds their blueprints. Its file tools resolve old absolute paths into the restored worktrees.

Only subagents whose parent uses JSONL session files, and file-backed subagents from earlier releases, stay tied to the machine that launched them and report as unrestorable elsewhere.

## Set the environment up with a blueprint {#set-the-environment-up-with-a-blueprint}

A restored worktree contains repository files, not installed dependencies, runtimes, or build output. A *blueprint* defines how Atomic rebuilds the environment. Atomic uses the [blueprint](https://docs.devin.ai/onboard-devin/environment/blueprints) YAML format, reading `.atomic/blueprint.yaml` instead of `.devin/blueprint.yaml` (Atomic never reads `.devin/` paths).

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

<Warning>
**Always set `runs-on` for macOS or Windows.** If a blueprint omits `runs-on`, Atomic defaults to `["linux"]` only, which silently skips the blueprint on macOS and Windows. Set `runs-on: [macos]`, `runs-on: [windows]`, or `runs-on: [linux, macos, windows]`, or define separate `---`-separated YAML documents per operating system.
</Warning>

| Section | Purpose | When it runs |
| --- | --- | --- |
| `initialize` | Install tools, runtimes, and system packages | During a build |
| `maintenance` | Install or update project dependencies. Keep it fast and incremental (for example `npm install` rather than `npm ci`) | During a build. Shown to the agent at session start, never run automatically at prompt time |
| `knowledge` | List of `{ name, contents }` items (by convention `lint`, `test`, and `build`) | Never executed. Provided to the agent as context |
| `post-build` | Verify the assembled environment (global blueprint only) | During a build, after all repositories |

Each section accepts a single string (one `run` step) or a list of steps. A step is a bare string, `{ name?, run, env? }`, or `{ name?, uses, with?, env? }`, never both `run` and `uses`. `with` applies only to `uses`: YAML scalars convert to strings, `null` becomes `""`, and YAML arrays or objects serialize as JSON strings.

`uses` accepts `github.com/<owner>/<repo>[/<subpath>]@<ref>` in `initialize` and `post-build` (never in `maintenance`, where Atomic rejects it). Owner must start with an alphanumeric character and use `[A-Za-z0-9-]`, repo uses `[A-Za-z0-9._-]`, and `ref` cannot start with `-` or contain whitespace, control characters, or `~^:?*[\`. Anything an action writes to `GITHUB_ENV` or `GITHUB_PATH` is appended to `$ENVRC` automatically for later steps and the session. Actions cache under `~/.atomic/agent/blueprint-actions`; set `ATOMIC_BLUEPRINT_GITHUB_BASE_URL` to fetch actions from a host other than `https://github.com`.

<Accordion title="GitHub Actions compatibility details">
- **Supported action types:** Node.js actions targeting `node12`, `node16`, `node20`, or `node24`, and composite actions. Docker actions and unknown `runs.using` types fail the step.
- **Lifecycle hooks:** Node.js actions run `runs.pre` (respecting `runs.pre-if`) and `runs.main`. `runs.post` and `runs.post-if` are ignored.
- **Nesting limit:** Composite actions can nest nested `uses` steps up to **10** levels deep.
- **Expressions:** Composite actions support `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `always`, `success`, `failure`, and `cancelled`, along with standard comparison and boolean operators. `hashFiles`, `secrets`, and `matrix` expressions fail the step.
- **Stubbed `github.*` context:** `github.workspace`, `github.action_path`, `github.action_repository`, and `github.action_ref` reflect the actual build directory and action. Other `github.*` fields use fixed stubs (such as `github.repository: "atomic/blueprint"`, `github.sha: "0000000000000000000000000000000000000000"`, `github.token: ""`, `github.event: {}`).
</Accordion>

Key blueprint rules:

- **Platforms and validation.** `runs-on` accepts a string or list matched case-insensitively (`default` and `linux` are aliases; `macos` and `windows` are explicit). A file can hold multiple `---`-separated YAML documents as long as no two documents target the same platform. A machine runs only its matching document, but Atomic validates **every** document in the file.
- **Shell.** `shell` accepts `"default"`, `"bash"`, or `"powershell"` (case-insensitive). `run` steps execute in bash (Git Bash on Windows) with `set -e`. Setting `shell: powershell` runs PowerShell on Windows with `$ErrorActionPreference = 'Stop'` (on Linux and macOS, `run` steps always execute in bash). Commands must be non-interactive.
- **Environment.** Step `env:` applies to that step only and overrides `$ENVRC`. In bash, Atomic sources `$ENVRC` with `set -a`, so plain `KEY=VALUE` lines appended to `$ENVRC` (for example `echo "API_URL=http://localhost:3000" >> "$ENVRC"`) are exported to later steps and the resumed session's bash tool without needing `export`. On Windows, `$ENVRC` is evaluated by Git Bash with `PATH` converted back automatically; from PowerShell steps, write UTF-8 bash assignments with LF line endings and no BOM to `$env:ENVRC`. `$ENVRC` starts empty on every build, so `maintenance` should not depend on values `initialize` wrote during an earlier build.
- **Timeout.** Any step running longer than 3 hours is stopped and marked failed.
- **Includes.** The repository blueprint can list workspace directories (or `<dir>/.atomic/blueprint.yaml` paths) in `includes`, without `..` or duplicates. Workspace blueprints cannot declare `includes`, global blueprints ignore `includes`, and only global blueprints allow `post-build`.
- **Ignored keys.** `clone` is ignored with a warning because resume restores the recorded tree. `cache` triggers a warning pointing to `resume.cache`. Other unknown keys are ignored silently.

<Note>
Legacy `.atomic/setup` is no longer read. `resume.setupCommand` is deprecated and **global-only** (project `.atomic/settings.json` values are silently ignored); it runs temporarily as a single global maintenance step with a deprecation warning. Move its command into `.atomic/blueprint.yaml` under `maintenance`.
</Note>

### How blueprint builds run

When resume restores a worktree, Atomic builds in order: global `initialize` and `maintenance`, then each repository's `initialize` and `maintenance` (followed by its included workspaces), then global `post-build`. Existing local checkouts that resume directly are never built.

<Note>
**Project trust required.** A restored worktree is a new directory, so project trust starts unset just like a fresh clone. Repository blueprints run only for trusted projects (saved trust, `--approve`, or `"defaultProjectTrust": "always"`). Untrusted worktrees skip project instructions, resources, and blueprint builds (the agent still receives `maintenance` and `knowledge` marked as not yet run), and the global blueprint runs only when at least one restored worktree is trusted.
</Note>

Builds are differential. Atomic compares each workspace blueprint against the last successful build on this machine:

- Unchanged workspaces skip `initialize` and run only `maintenance`.
- New, edited, or previously failed workspaces run both `initialize` and `maintenance`.
- A full rebuild runs across all workspaces (including global `initialize`) whenever the global blueprint changes or the last full build is older than 7 days.

A step fails if its command exits non-zero, raises a PowerShell error, times out after 3 hours, or cannot start (Atomic retries temporarily busy executables for up to 2 seconds before failing). When a step fails, the remaining steps of that blueprint are skipped while other repositories and workspaces continue building. A blueprint failure never blocks resuming the session:

| Outcome | Result | What you see |
| --- | --- | --- |
| Repository or workspace blueprint failed | Partial. Worktree files are intact and usable. | Warning naming the blueprint, failing step, and log path |
| Global blueprint or `post-build` failed | Failed. Repository blueprints do not run. | Prominent warning; the session still resumes |
| No blueprint, untrusted worktree, or no matching platform | Nothing ran | Nothing |

On Windows, if a stopped step could not be tracked as a process group after its root command exited, Atomic warns that child processes may still be running; check for leftover processes before retrying.

Blueprint build state lives under `~/.atomic/agent/worktree-snapshots/`:

- `blueprint-logs/`: per-step logs with command, timestamps, duration, exit status, and output.
- `blueprint-builds/ledger.json`: differential build ledger on this machine.
- `blueprint-builds/locks/<rootKey>.json`: active build lock per restored worktree.
- `blueprint-env/<hash>.envrc`: exported session environment written to `$ENVRC`.

To recover from a failed build, read the step log, fix the environment or blueprint, and resume again.

### Start the first turn while the build runs {#start-the-first-turn-while-the-build-runs}

`resume.waitForBlueprint` controls whether Atomic waits for blueprint builds before opening the session:

- `"prompt"` (default in interactive mode) opens the session after the build finishes.
- `"tools"` (default in `-p`, `--mode json`, `--mode rpc`, and SDK sessions) opens the session immediately after restoring files so the first model request starts while the build runs in the background.

In `"tools"` mode, Atomic tells the agent that the environment is still building and holds every tool call and shell command in the restored worktree (including forks or switches into that worktree) until the build settles. The first waiting tool call receives the build result ahead of its own output. Warnings are delivered once via stderr (`-p`) or a `blueprint_build_finished` event (`--mode json` and `--mode rpc`).

Interrupting a turn cancels the tool wait without stopping the build. `atomic -p` and `--mode json` print their answer and exit once the build finishes.

Stopping and concurrent builds:

- **Graceful stop (Ctrl-C, signals, or RPC stdin closing).** Atomic stops running build processes and rebuilds the worktree on the next resume.
- **Abrupt kill (`SIGKILL`).** On Unix, the next resume cancels the interrupted build, terminates confirmed recorded build processes, sets that worktree aside so no session reuses it, and restores and builds a fresh worktree with a warning naming the set-aside path and logs. Atomic cleans up set-aside worktrees once no process uses them ([Pooling and set-aside worktrees](/worktree-snapshots/reference#idle-reuse-eviction-and-set-aside-worktrees)). On Windows, step processes exit with Atomic, so the next resume rebuilds the same worktree.
- **Concurrent resumes on one worktree.** Only one build runs per worktree. Switching back to a session whose build is still running joins it. Another Atomic process waits up to 5 minutes (printing a stderr line or emitting `blueprint_build_waiting`) before rebuilding with a warning.
- **Concurrent blueprint ledger updates.** Builds on the same machine take turns saving their results. Atomic tells you when it is waiting for another writer. If it can tell that writer has stopped, it continues without waiting for the lock to expire. Locks from older versions that do not identify a writer still expire after 15 seconds without a refresh.

To override the mode default, set `resume.waitForBlueprint` in settings:

```json
{ "resume": { "waitForBlueprint": "prompt" } }
```

When an installed extension can decline saved project trust ([Project trust](/security#project-trust)), resume always defers the blueprint build like `"tools"` until trust is decided, and untrusted worktrees stay unbuilt.

<Accordion title="SDK and JSON/RPC events for background blueprint builds">
- **`blueprint_build_finished`** (SDK hook: `onBlueprintBuildFinished(listener)`): emitted once when a background build settles, with `{ type: "blueprint_build_finished", sessionId, roots, notices }` where each notice is `{ type: "info" | "warning", message }`.
- **`blueprint_build_waiting`** (SDK hook: `onBlueprintBuildWaiting(listener)`): emitted when a resume waits for another process's build on the same worktree, with `{ type: "blueprint_build_waiting", root, message }`.
- Both hooks replay any unannounced events from the current process when first subscribed and return an unsubscribe function. Use `blueprintBuildSettled(sessionId)` in the SDK to await build completion explicitly.
</Accordion>

### What the agent sees

The first turn of a resumed session includes each applicable blueprint's `maintenance` steps and `knowledge` items, tagged with their build status (ran in this build, not yet run, or partial with the failing step and log path). The agent reruns `maintenance` itself if dependencies change. Atomic's default system prompt also guides the agent to maintain `.atomic/blueprint.yaml` as project setup evolves, leaving `~/.atomic/agent/blueprint.yaml` alone unless asked.

### Caches for runners {#caches-for-runners}

Ephemeral runners start with an empty home directory on every job. Run `atomic blueprint cache-key` to compute cache keys, restore prefixes, and paths for CI cache actions such as `actions/cache` (Atomic never uploads or downloads caches itself):

```bash
atomic blueprint cache-key [dir] [--format text|json|github-output]
```

Atomic detects package stores automatically from lockfiles at the repository root (subdirectory lockfiles in monorepos are not auto-detected). It reads project `resume.cache` from `.atomic/settings.json` without requiring project trust (validating paths and refusing credential locations without executing any project code) and hashes the root `.atomic/blueprint.yaml`.

<Accordion title="Auto-detected package stores (11 ecosystems)">
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

Environment variables in parentheses override each store path, and `XDG_CACHE_HOME` moves Linux `~/.cache` paths. On macOS, Yarn v1 uses `~/Library/Caches/Yarn`, pip uses `~/Library/Caches/pip`, Poetry uses `~/Library/Caches/pypoetry`, Go build cache uses `~/Library/Caches/go-build`, and pnpm uses `~/Library/pnpm/store` (npm, uv, Bun, Cargo, Go modules, Gradle, and Maven match Linux). On Windows, paths use `%LOCALAPPDATA%` (`npm-cache`, `pnpm\store`, `Yarn\Cache`, `uv\cache`, `pip\Cache`, `pypoetry\Cache`, and `go-build` for `GOCACHE`).
</Accordion>

Declare additional stores or build outputs under `resume.cache` in `.atomic/settings.json` (a project list replaces the global list; blueprints themselves do not declare caches):

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
| `stores` | Detected package stores plus `"store"` paths in `resume.cache` | Lockfiles, `keyFiles`, `resume.cache`, root repository blueprint, OS, or architecture change |
| `build` | Parked `"build"` paths and seed manifest | Same inputs as `stores` |
| `git` | Atomic's Git object store for the repository | Checkout `HEAD` changes (omits CPU architecture; uses `"unborn"` when `HEAD` has no commits yet; restore newest via restore prefix) |
| `atomic` | Atomic's compiled extension cache | Atomic version, OS, or architecture change |

Entries with no paths are omitted. The `git` and `build` entries require a Git remote. Atomic normalizes HTTPS remotes and `git@` SSH remotes by host and repository path so HTTPS runner checkouts reuse caches built from SSH checkouts (other SSH usernames stay distinct).

<Accordion title="Excluded credential paths">
To protect secrets, `cache-key` omits store paths inside the worktree, snapshot-denied paths ([What is left out](/worktree-snapshots#what-is-left-out)), `<agentDir>/auth.json`, and these home credential paths (along with any parent directory containing one, so `~/.cargo` is omitted because it holds `~/.cargo/credentials`, while `~/.cargo/registry` is allowed):

`.aws`, `.azure`, `.cargo/credentials`, `.cargo/credentials.toml`, `.config/gcloud`, `.config/gh`, `.docker/config.json`, `.gem/credentials`, `.git-credentials`, `.gnupg`, `.gradle/gradle.properties`, `.kube`, `.m2/settings.xml`, `.netrc`, `.npmrc`, `.pypirc`, `.ssh`, `.terraform.d/credentials.tfrc.json`, and `.yarnrc.yml`.

Checks run case-insensitively and across symlinks, printing a warning on stderr for every omitted path.
</Accordion>

Use `--format github-output` to emit `<name>-key`, `<name>-restore-prefix`, and `<name>-paths` lines for `$GITHUB_OUTPUT`. See [Caching between runs](/guides/team-setup#caching-between-runs) for a full GitHub Actions workflow.

### Prebuilt worktrees {#prebuilt-worktrees}

`atomic blueprint prebuild` prepares a repository ahead of time so a later resume starts with dependencies and build artifacts already built:

```bash
atomic blueprint prebuild [dir] [--park] [--approve|-a]
```

Prebuild restores the committed `HEAD` at `dir` (defaulting to the current directory) into a new worktree, runs `initialize` and `maintenance`, and leaves the worktree idle for the next resume to claim. Only committed files are restored, so untracked or ignored files such as `.env` never enter the worktree.

Prebuild requires:

- A Git remote on the checkout.
- No uncommitted edits to tracked files, and no unpushed commits touching denied secret files.
- A trusted project (saved trust, `"defaultProjectTrust": "always"`, or `--approve` / `-a`), because prebuild runs project code.

<Note>
`atomic blueprint prebuild` snapshots the committed `HEAD` directly (without untracked files) even if `snapshots.enabled` is set to `false` in `settings.json`.
</Note>

Exit codes: `0` when an idle worktree is ready, `1` when the project is untrusted, a precondition is not met, or a blueprint step fails (removing the new worktree while keeping earlier worktrees and seeds), and `2` on invalid CLI arguments. Timings print to stderr.

With `--park`, Atomic moves untracked build output declared with `"kind": "build"` in [`resume.cache`](#caches-for-runners) into `~/.atomic/agent/worktree-snapshots/seeds/` along with a manifest naming the built commit. When another machine restores that cache and has no idle worktree, resume creates a worktree at the same path used during prebuild, moves the parked output into place (without overwriting tracked or existing files), and checks out the session snapshot. `/session snapshot` labels such restores `(seeded)` with a `seed` timing line.

If parking cannot acquire the seed lock, prebuild reports the error, leaves existing seeds intact, and keeps the completed build in its idle worktree for local reuse.

## What can stop a resume

Atomic checks required setup in one pass before restoring anything: the storage adapter, its credentials, and Git. When Git is absent, Atomic downloads a verified portable Git automatically unless offline or download fails.

For session resumes, missing Git never blocks opening the session—it opens in its recorded or launch directory with a notice for each unrestored checkout. A session resume fails only when the session cannot be read, a snapshot fails security checks, or a target directory contains unexpected files. Blueprint failures never stop a resume.

| Symptom | What to do |
| --- | --- |
| Session ID not found on this machine | If this machine keeps sessions locally, join the shared database with `atomic storage join` and remove any `sessions.storage` override. If already joined, check the session ID, database URL, and table prefix. |
| Missing storage adapter, missing or unreadable credentials, or offline mode | Follow each fix listed in the error—run `atomic install`, create the password or token file, or unset offline mode. |
| Git cannot be started or downloaded | Install Git on `PATH` or unset `ATOMIC_OFFLINE`. Session resumes still open without restoring checkouts. |
| Shared database unreachable or timed out after 15 seconds | Check connectivity with `atomic storage status` and resume again. |
| Checkout cannot be rebuilt identically (denied unpushed commits, missing blob, or full disk) | Follow the printed notice (for unpushed commits, push from the original machine and resume again). The session still opens with the closest state. |
| Windows worktree path exceeds Git for Windows limits | Set `ATOMIC_CODING_AGENT_DIR` to a shorter path ([Long paths on Windows](#long-paths-on-windows)). Nothing is written. |
| Snapshot fails security validation (credentials in remote URL, `ext::` helper, or malformed hashes) | Resume only sessions from trusted storage, or re-export from the source machine. Nothing is fetched or run. |

Secret values never appear in error messages; errors name only the file or environment variable.

<Accordion title="SDK resume and blueprint error classes">
All resume and blueprint errors carry stable `code`, `hint`, `retryable`, and JSON-safe `fields` and are exported from `@bastani/atomic`:

- **Resume errors:** `ResumeNotFoundError` (`not-found`, reasons `local-storage-not-joined` / `shared-miss`), `ResumePreconditionError` (`preconditions-unmet`), `ResumeCatalogUnavailableError` (`catalog-unavailable`), `ResumeCatalogTimeoutError` (`catalog-timeout`), `GitUnavailableError`, `WorkspaceDriftError`, and `WorkspaceRestoreError` (`path-too-long`, `invalid-snapshot`), with `isResume*Error` guards. See [Resuming on another machine](/sdk/reference#resuming-on-another-machine) and [Worktree snapshot errors](/worktree-snapshots/reference#errors).
- **Blueprint errors (`BlueprintError`):** Resuming never throws a `BlueprintError`—instead, builds record failures in `BlueprintBuildOutcome.failures` so the session still resumes with warnings:
  - `BlueprintInvalidError` (`code: "blueprint-invalid"`): invalid YAML or rule violation (`reason`: `yaml-syntax`, `not-a-mapping`, `invalid-shell`, `invalid-field`, `uses-in-maintenance`, `run-and-uses`, `missing-run-or-uses`, `with-without-uses`, `invalid-uses-reference`, `duplicate-platform`, `nested-includes`, `include-parent-path`, `duplicate-include`, or `post-build-not-global`).
  - `BlueprintStepFailedError` (`code: "blueprint-step-failed"`): step exited non-zero, stopped by a signal, or could not start (`exitStatus`, `signal`, `logPath`).
  - `BlueprintStepTimedOutError` (`code: "blueprint-step-timed-out"`): step exceeded its 3-hour timeout (`timeoutMs`, `elapsedMs`, `phase`, `logPath`).
  - `BlueprintUsesUnsupportedError` (`code: "blueprint-uses-unsupported"`): `uses` action could not run (`reason`: `docker-action`, `unknown-action-type`, `action-not-found`, `action-fetch-failed`, `action-metadata-invalid`, `node-unavailable`, `required-input-missing`, or `unsupported-expression`).
  - `BlueprintBuildFailedError` (`code: "blueprint-build-failed"`): build infrastructure failure (`phase`: `read-blueprint`, `ledger`, `environment`, or `unknown`).
  - Match and pass across boundaries with `isBlueprintError`, `isBlueprintInvalidError`, `isBlueprintStepFailedError`, `isBlueprintStepTimedOutError`, `isBlueprintUsesUnsupportedError`, `isBlueprintBuildFailedError`, `findBlueprintError`, `serializeBlueprintError`, and `rehydrateBlueprintError`.
</Accordion>

## Long paths on Windows {#long-paths-on-windows}

Sessions resume on Windows the same way as on Linux and macOS (see [Windows setup](/windows)).

Atomic restores worktrees under `%USERPROFILE%\.atomic\agent` unless `ATOMIC_CODING_AGENT_DIR` overrides it. Even with `core.longpaths`, Git for Windows enforces path limits on administrative paths (220 characters for the object store, 212 for the worktree root, and 247 for the worktree Git directory). Atomic keeps internal names short and enables `core.longpaths`, so an agent directory path up to about 155 characters works.

If a longer agent directory would exceed those limits, restore stops before writing anything. Point `ATOMIC_CODING_AGENT_DIR` at a shorter path:

```powershell
$env:ATOMIC_CODING_AGENT_DIR = "C:\atomic\agent"
```
