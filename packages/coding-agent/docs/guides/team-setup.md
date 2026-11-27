---
title: "Set up teams and CI"
sidebarTitle: "Set up teams and CI"
description: "Share Intercom across a team through PostgreSQL while keeping personal sessions local, and configure CI runners with environment variables."
---

Share one PostgreSQL database across machines so teammates can coordinate over Intercom while keeping personal sessions local. CI runners can point both sessions and Intercom at that same database with one environment variable so teammates can inspect and resume CI runs.

## Choose a storage layout

| Profile | Sessions | Intercom | Best for |
| --- | --- | --- | --- |
| `individual` (default) | Local SQLite | Local machine only | Solo development on one machine |
| `team` | Local SQLite (share explicitly with `/share` or export/import) | Shared PostgreSQL, per-repository project group | Teammates collaborating over Intercom with private session history |
| `ci` | Shared PostgreSQL | Shared PostgreSQL, per-run group (`ATOMIC_INTERCOM_GROUP`) | CI runners, shared swarms, or syncing your own sessions across laptops |
| `custom` | Any other combination (JSONL, non-default SQLite path, project override, or mismatched prefixes) | Varies | Custom per-project or split-database layouts |

Inspect your active layout at any time with `atomic team status`:

```bash
atomic team status          # Human-readable profile, project group, and storage report
atomic team status --json   # Machine-readable JSON output
```

`atomic team status --json` prints `{ profile, profileError?, projectGroup?, ...storageStatus }`, where `profile` is `{ profile, sessions, intercom }` (or `null` if configuration is invalid) and the remaining fields match `atomic storage status --json`. The command exits `1` if the storage selection is invalid, the adapter fails to load, or the database does not answer.

## Join a team

<Steps>
  <Step title="Prepare the PostgreSQL database once">
    Create the shared database, roles, and schema following [PostgreSQL](/storage/postgres#set-up-the-database). If multiple teams share one database, pass the same `--prefix` (such as `team_`) to `atomic storage migrate` and to every teammate's `atomic storage join`.
  </Step>
  <Step title="Install the adapter and join on each machine">
    Install the PostgreSQL storage adapter, capture the runtime role's password in a temporary file, and run `atomic storage join`:

    ```bash
    atomic install npm:@bastani/atomic-storage-postgres
    (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
    atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic?sslmode=verify-full' --password-file ~/atomic-db-password
    rm ~/atomic-db-password  # atomic storage join keeps its own private copy
    ```

    `atomic storage join` validates the URL, password, installed adapter, and a `SELECT 1` query within 15 seconds before updating `~/.atomic/agent/settings.json`. See [Joining a machine to a shared database](/storage#joining-a-machine-to-a-shared-database) for `--token-file`, `--auth azure|aws|gcp`, and `--prefix`.
  </Step>
  <Step title="Keep personal sessions local">
    By default, `atomic storage join` sets top-level `storage`, which shares both sessions and Intercom. To keep personal sessions in local SQLite while Intercom uses the team database, add `"sessions": { "storage": {} }` to `~/.atomic/agent/settings.json` while keeping the `storage` block (and the exact `storage-token.<generated-id>` filename) that `atomic storage join` wrote:

    ```json
    {
      "storage": {
        "adapter": "@bastani/atomic-storage-postgres",
        "options": {
          "url": "postgresql://atomic_runtime@db.example.com:5432/atomic?sslmode=verify-full"
        },
        "secrets": {
          "password": { "file": "agent/storage-token.<generated-id>" }
        }
      },
      "sessions": { "storage": {} }
    }
    ```
  </Step>
  <Step title="Restart Intercom and verify">
    Restart the local Intercom broker so it connects to the shared database, then confirm the active profile reads `team`:

    ```bash
    atomic intercom restart
    atomic team status
    ```
  </Step>
</Steps>

- **Running sessions:** Sessions started before joining keep their previous Intercom group until restarted or reloaded with `/reload`.
- **Leaving a team:** Remove `storage` and `sessions.storage` from `~/.atomic/agent/settings.json`, run `atomic intercom restart`, and delete the generated `storage-token.<id>` file in your agent directory.

## Project groups

When multi-node Intercom routing is enabled, sessions without an explicit group automatically join `project:<owner>/<repo>`, derived from the Git repository's `origin` remote (falling back to the repository directory name without `origin`, or the working directory name outside Git).

Sessions in different repositories on the same database cannot see or message each other unless they join the same group. An explicit group (`ATOMIC_INTERCOM_GROUP`, Intercom's `config.json` `group`, or an inherited subagent group) always overrides the project group. Joining `default` explicitly while multi-node routing is on prints a warning because every teammate on the shared database can message `default`.

For remote URL casing rules, Git lookup errors, and multi-node routing checks, see [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) and [Project groups](/intercom/operations#project-groups).

## CI and swarms

CI runners do not need a `settings.json` file. Configure the shared database for the process and all child processes with environment variables:

| Variable | Value |
| --- | --- |
| `ATOMIC_STORAGE` | `{"adapter":"@bastani/atomic-storage-postgres","options":{"url":"<team database URL>"},"secrets":{"password":{"env":"ATOMIC_DB_PASSWORD"}}}` (add `"prefix"` when your team uses one) |
| `ATOMIC_DB_PASSWORD` | Database password, read only when opening a store |
| `ATOMIC_INTERCOM_GROUP` | Optional per-run group isolating one CI job or swarm from others |

Atomic validates `ATOMIC_STORAGE` at startup before opening a session and never copies passwords into settings, logs, or child storage selections. See [Selecting storage per process](/storage#selecting-storage-per-process) for precedence rules.

### GitHub Actions

```yaml
jobs:
  agent:
    runs-on: ubuntu-latest
    env:
      ATOMIC_STORAGE: '{"adapter":"@bastani/atomic-storage-postgres","options":{"url":"${{ vars.ATOMIC_DB_URL }}"},"secrets":{"password":{"env":"ATOMIC_DB_PASSWORD"}}}'
      ATOMIC_DB_PASSWORD: ${{ secrets.ATOMIC_DB_PASSWORD }}
    steps:
      - uses: actions/checkout@v5
      - run: npm install -g @bastani/atomic
      - run: atomic install npm:@bastani/atomic-storage-postgres
      - run: atomic -p "Fix the failing test in the checkout"
```

<Tip>
Store `ATOMIC_DB_PASSWORD` in an encrypted secret and scope it only to the step that runs Atomic, since tools run by the agent inherit that step's environment. On Azure, AWS, or Google Cloud, pass `"options": { "auth": "azure-entra" }` (or `"aws-iam"`, `"gcp-iam"`) to authenticate with the runner's cloud identity instead of a password ([Cloud identities](/storage/postgres#cloud-identities)).
</Tip>

### Caching between runs

Hosted CI runners start with an empty home directory. Use `atomic blueprint cache-key` to emit cache keys and paths for detected package stores and any extra `resume.cache` paths in `.atomic/settings.json` ([Caches for runners](/guides/resume-on-any-machine#caches-for-runners)).

Save caches only from a trusted job on the default branch (`push`, `schedule`, or `workflow_dispatch`), and restore them read-only in agent jobs with `actions/cache/restore`.

In the trusted job, [`atomic blueprint prebuild --park --approve`](/guides/resume-on-any-machine#prebuilt-worktrees) checks out the commit into a worktree, runs repository blueprints to warm package stores, writes the commit into Atomic's Git object store, and parks `"kind": "build"` paths from `resume.cache`. Prebuild requires a Git remote, `snapshots.enabled: true`, no uncommitted edits to tracked files, and no unpushed commits touching denied secret files. Install any required Atomic packages before running `atomic --list-models` to warm the compiled extension cache:

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  prebuild:
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm install -g @bastani/atomic
      - id: keys
        run: atomic blueprint cache-key --format github-output >> "$GITHUB_OUTPUT"
      - run: atomic blueprint prebuild --park --approve   # Runs blueprints to populate stores; trust only the default branch
      - run: atomic --list-models                         # Compiles installed extensions into Atomic's cache
      - uses: actions/cache/save@v4
        with:
          key: ${{ steps.keys.outputs.stores-key }}
          path: ${{ steps.keys.outputs.stores-paths }}
      - uses: actions/cache/save@v4
        if: steps.keys.outputs.build-key != ''
        with:
          key: ${{ steps.keys.outputs.build-key }}
          path: ${{ steps.keys.outputs.build-paths }}
      - uses: actions/cache/save@v4
        with:
          key: ${{ steps.keys.outputs.git-key }}
          path: ${{ steps.keys.outputs.git-paths }}
      - uses: actions/cache/save@v4
        with:
          key: ${{ steps.keys.outputs.atomic-key }}
          path: ${{ steps.keys.outputs.atomic-paths }}
```

In the agent job, restore those cache entries before launching Atomic:

```yaml
      - uses: actions/checkout@v5
      - run: npm install -g @bastani/atomic
      - id: keys
        run: atomic blueprint cache-key --format github-output >> "$GITHUB_OUTPUT"
      - uses: actions/cache/restore@v4
        with:
          key: ${{ steps.keys.outputs.stores-key }}
          restore-keys: ${{ steps.keys.outputs.stores-restore-prefix }}
          path: ${{ steps.keys.outputs.stores-paths }}
      - uses: actions/cache/restore@v4
        if: steps.keys.outputs.build-key != ''
        with:
          key: ${{ steps.keys.outputs.build-key }}
          restore-keys: ${{ steps.keys.outputs.build-restore-prefix }}
          path: ${{ steps.keys.outputs.build-paths }}
      - uses: actions/cache/restore@v4
        with:
          key: ${{ steps.keys.outputs.git-key }}
          restore-keys: ${{ steps.keys.outputs.git-restore-prefix }}
          path: ${{ steps.keys.outputs.git-paths }}
      - uses: actions/cache/restore@v4
        with:
          key: ${{ steps.keys.outputs.atomic-key }}
          restore-keys: ${{ steps.keys.outputs.atomic-restore-prefix }}
          path: ${{ steps.keys.outputs.atomic-paths }}
      - run: atomic --session "$SESSION_ID" -p "Continue"
```

When the agent job resumes a session, Atomic fetches only commits missing from the cached Git store and restores parked build output at the same path used during prebuild (preserving path-sensitive artifacts such as Cargo's `target`).

- Keys hash lockfiles, `keyFiles`, `resume.cache`, the repository blueprint, OS, architecture, and Atomic version; `restore-keys` falls back to the newest older cache for incremental updates.
- `cache-key` omits paths that may hold credentials and warns on stderr while keeping `$GITHUB_OUTPUT` clean. Skip `build` steps when `build-key` is empty so `actions/cache` never receives an empty `path`.

<Warning>
Omit `"kind": "build"` paths from `resume.cache` if untrusted external contributor code builds on the default branch, because agent jobs reuse the trusted job's parked build output.
</Warning>

## From the SDK

`@bastani/atomic/storage` (and `@bastani/atomic`) exports `getTeamProfile(options?)`, which resolves the active layout matching `atomic team status`:

- **Options (`TeamProfileOptions`):** `{ agentDir?, cwd? }` (both optional; default to the resolved agent directory and `process.cwd()`).
- **Return value (`Promise<TeamProfile>`):** `{ profile, sessions, intercom }`, where `profile` is `"individual" | "team" | "ci" | "custom"`, `sessions` describes the active session store, and `intercom` describes the shared Intercom store (or `"off"` when local only).

```typescript
import { getTeamProfile, inMemorySecret } from "@bastani/atomic/storage";

const layout = await getTeamProfile({ cwd: process.cwd() });
// layout: { profile: "team", sessions: "...", intercom: "..." }
```

To pass the team database to an embedded `createAgentSession({ storage })` call, keep the password in memory with `inMemorySecret(password)`. Because in-memory secrets serialize as `[redacted]`, spawned `atomic` subprocesses cannot reopen the store from them—pass an `{ "env": "ATOMIC_DB_PASSWORD" }` reference inside `ATOMIC_STORAGE` instead. See [SDK session storage](/sdk/storage) for complete recipes and store ownership rules, and [Team setup errors](/storage#team-setup-errors) for typed errors.

## Security

<Warning>
Anyone with read access to the shared PostgreSQL database can read everything stored in it, including CI sessions and Intercom messages in transit. Treat database read access as full read access to every session and message under that prefix.
</Warning>

- Give each team its own database or `--prefix` so teams never share tables or Intercom routing.
- Use a dedicated PostgreSQL runtime role with only the privileges Atomic requires, rotate passwords on offboarding, and prefer cloud identities (`--auth`) where supported ([PostgreSQL](/storage/postgres)).
- In the `team` profile, personal sessions stay off the shared database only because `sessions.storage` selects local SQLite. Share individual sessions intentionally with `/share` or `atomic storage export` / `atomic storage import`.

<Note>
**Upgrading from libSQL or Turso?** Atomic removed libSQL support together with `atomic team join`, `atomic team leave`, and `ATOMIC_PROFILE=ci`. Follow [Moving off libSQL](/storage#moving-off-libsql) to export existing sessions and move to PostgreSQL or local SQLite.
</Note>

## Related

<Columns cols={2}>
  <Card title="PostgreSQL setup" href="/storage/postgres">
    Database schema, owner vs. runtime roles, TLS, connection poolers, cloud IAM, and concurrency tuning.
  </Card>
  <Card title="Storage overview" href="/storage">
    All storage backends, selection precedence, session export/import, and storage error reference.
  </Card>
  <Card title="Resume sessions on any machine" href="/guides/resume-on-any-machine">
    Cross-machine worktree snapshots, `.atomic/blueprint.yaml`, and runner cache configuration.
  </Card>
  <Card title="Operate Intercom" href="/intercom/operations#running-intercom-across-machines">
    Multi-node Intercom routing, project groups, offline queueing, and troubleshooting.
  </Card>
</Columns>
