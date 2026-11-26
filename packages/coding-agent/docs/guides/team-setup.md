---
title: "Set up teams and CI"
sidebarTitle: "Team and CI setup"
description: "Share Intercom across a team through PostgreSQL while keeping personal sessions local, and configure CI runners with environment variables."
---

Share one PostgreSQL database across machines so teammates can message each other over Intercom while keeping their personal sessions local. CI runners can point both sessions and Intercom at the same database with one environment variable, so teammates can inspect and resume CI runs.

> Atomic 0.10.11 removed libSQL and Turso support, together with `atomic team join`, `atomic team leave`, and the `ATOMIC_PROFILE=ci` variables. To move sessions off libSQL, see [Moving off libSQL](/storage#moving-off-libsql).

| Scope | Sessions | Intercom |
| --- | --- | --- |
| Individual (default) | Local | Local only |
| Team | Local (share explicitly with `/share` or export and import) | Team database, project group |
| CI and swarms | Team database | Team database, per-run group (`ATOMIC_INTERCOM_GROUP`) |

Run `atomic team status` to see the active profile:

- `individual`: sessions use default local SQLite and Intercom has no shared adapter storage.
- `team`: sessions use default local SQLite while Intercom and shared `storage` use the same shared adapter database.
- `ci`: sessions, Intercom, and shared `storage` all use the same shared adapter database (if you ran `atomic storage join` to share sessions across your own laptops, `atomic team status` also reports `ci`).
- `custom`: any other combination, such as JSONL sessions, a non-default local SQLite file, a project `storage` override, or different adapters or prefixes between sessions and Intercom.

```bash
atomic team status          # Profile, project group, and storage report
atomic team status --json   # JSON output
```

`atomic team status` exits `1` if the selection is invalid, the adapter fails to load, or the database does not answer.

## Join a team

Set up the team's PostgreSQL database as described in [PostgreSQL](/storage/postgres), then on each machine install the adapter and join it:

```bash
atomic install npm:@bastani/atomic-storage-postgres
(umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic?sslmode=verify-full' --password-file ~/atomic-db-password
rm ~/atomic-db-password  # atomic storage join keeps its own copy
```

`atomic storage join` checks the URL, the password, the installed adapter, and a `SELECT 1` within 15 seconds before it writes anything, then sets the global `storage` setting to the team database. See [Joining a machine to a shared database](/storage#joining-a-machine-to-a-shared-database) for every option, including `--token-file`, `--auth azure|aws|gcp`, and `--prefix`.

To keep your personal sessions on this machine while Intercom uses the team database, add an empty `sessions.storage` selection to `~/.atomic/agent/settings.json`. It selects the default local SQLite file even though top-level `storage` is shared. Keep the `storage` value that `atomic storage join` wrote, including the name of its password file:

```json
{
  "storage": { "adapter": "@bastani/atomic-storage-postgres", "options": { "url": "postgresql://atomic_runtime@db.example.com:5432/atomic?sslmode=verify-full" }, "secrets": { "password": { "file": "agent/storage-token.28ab7041-05e2-4ad5-80af-854329035d8c" } } },
  "sessions": { "storage": {} }
}
```

Then restart the Intercom broker so it routes through the team database, and check the layout:

```bash
atomic intercom restart
atomic team status
```

- Pass `--prefix` to isolate multiple teams inside one database. Everyone on a team must use the same URL and prefix.
- Sessions that were already running keep their previous Intercom group until they restart or run `/reload`.
- To leave the team, remove `storage` and `sessions.storage` from `~/.atomic/agent/settings.json` and run `atomic intercom restart`. The password file that `atomic storage join` wrote, `storage-token.<id>` in the agent directory, can then be deleted.

## Project groups

When multi-node Intercom routing is enabled, sessions without an explicit group join `project:<owner>/<repo>`, derived from the repository's `origin` remote. Without an `origin` remote, Atomic uses the repository directory name, or the working directory name outside Git.

Sessions in different repositories on the same database cannot see or message each other unless they join the same group. An explicit group (`ATOMIC_INTERCOM_GROUP`, Intercom's `config.json` `group`, or a subagent's inherited group) always overrides the project group. Joining `default` explicitly while multi-node routing is on prints a warning because every teammate's session on the database can address `default`.

For multi-node broker behavior, Git lookup errors, and routing checks, see [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) and [Project groups](/intercom/operations#project-groups).

## CI and swarms

CI runners do not need a `settings.json` file. Select the team database for the whole process with `ATOMIC_STORAGE`, and keep the password in an environment variable the selection names:

| Variable | Value |
| --- | --- |
| `ATOMIC_STORAGE` | `{"adapter":"@bastani/atomic-storage-postgres","options":{"url":"<team database URL>"},"secrets":{"password":{"env":"ATOMIC_DB_PASSWORD"}}}`, plus `"prefix"` when the team uses one |
| `ATOMIC_DB_PASSWORD` | The database password, read when a store opens |

Both sessions and Intercom use the team database for this process and every child process it spawns. Atomic writes nothing to settings, and it reads the password only when opening a store, never copying it into settings, logs, or child storage selections. Atomic validates `ATOMIC_STORAGE` at startup, before it opens a session. See [Selecting storage per process](/storage#selecting-storage-per-process) for the precedence order.

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

Store the password in an encrypted secret and expose it only to the step that needs it. Every tool the agent runs in that step inherits the step's environment. On Azure, AWS, or Google Cloud, `"options": { "auth": "azure-entra" }` (or `aws-iam`, `gcp-iam`) signs in with the runner's identity instead of a password. See [PostgreSQL](/storage/postgres).

### Caching between runs

Hosted CI runners start with an empty home directory. Use `atomic blueprint cache-key` to compute cache keys and paths for package stores detected from lockfiles and any extra paths in `.atomic/settings.json` under `resume.cache`. See [Caches for runners](/guides/resume-on-any-machine#caches-for-runners).

Save caches only from a trusted job on the default branch (`push`, `schedule`, or `workflow_dispatch`), and restore them read-only in agent jobs with `actions/cache/restore`.

In the trusted job, run [`atomic blueprint prebuild --park --approve`](/guides/resume-on-any-machine#prebuilt-worktrees). It restores the commit into a worktree, runs its blueprints to warm package stores, writes the commit into Atomic's Git object store, and parks `"kind": "build"` paths from `resume.cache`. Prebuild requires a Git remote, `snapshots.enabled: true`, no uncommitted edits to tracked files, and no unpushed commits touching denied secret files. If your project extensions depend on installed Atomic packages, install those packages before running `atomic --list-models` to warm the compiled extension cache:

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
      - run: atomic --list-models   # Compiles installed extensions into Atomic's cache
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

In the agent job, restore those entries before launching Atomic:

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

When the agent job resumes a session, Atomic fetches only the commits missing from the cached Git store and adopts parked build output at the same path used during prebuild. This preserves path-sensitive build artifacts such as Cargo's `target`.

- If `resume.cache` defines no `"kind": "build"` paths, `build-key` is empty and its steps are skipped.
- Omit build paths if untrusted external contributor code builds on the default branch, because every agent job reuses the trusted job's build output.
- Keys include lockfiles, key files, `resume.cache`, the repository blueprint, OS, architecture, and Atomic version, so exact hits never return stale content. `restore-keys` falls back to the newest older cache so package managers can update incrementally.
- `cache-key` omits paths that may hold credentials and warns on stderr while leaving `$GITHUB_OUTPUT` clean. Restore only entries that `cache-key` outputs for your repository, because a cache step with an empty `path` fails.

## From the SDK

`@bastani/atomic/storage` exports `getTeamProfile()`, which reports the layout in effect the way `atomic team status` does. To give an embedded agent the team database, pass a storage selection to `createAgentSession({ storage })` and keep the password in memory with `inMemorySecret()`:

```typescript
import { spawn } from "node:child_process";
import { createAgentSession } from "@bastani/atomic";
import { inMemorySecret } from "@bastani/atomic/storage";

const url = process.env.TEAM_DATABASE_URL!;
const password = process.env.TEAM_DATABASE_PASSWORD!;

// Embedded SDK agent: sessions use the team database (requires `atomic install npm:@bastani/atomic-storage-postgres`
// or `DefaultResourceLoader({ additionalExtensionPaths })`).
const storage = {
  adapter: "@bastani/atomic-storage-postgres",
  options: { url },
  secrets: { password: inMemorySecret(password) },
};
const { session } = await createAgentSession({ storage });
try {
  await session.prompt("Summarize the failing tests");
} finally {
  await session.dispose();
}

// Spawned agent process: sessions and Intercom both use the team database.
const child = spawn("atomic", ["-p", "Fix the failing test"], {
  env: {
    ...process.env,
    ATOMIC_STORAGE: JSON.stringify({ adapter: "@bastani/atomic-storage-postgres", options: { url }, secrets: { password: { env: "ATOMIC_DB_PASSWORD" } } }),
    ATOMIC_DB_PASSWORD: password,
  },
  stdio: "inherit",
});
```

An in-memory password serializes as `[redacted]`, so child processes cannot reopen the store with it: give them an `{ "env": "<VAR>" }` reference instead, as above. See [SDK session storage](/sdk/storage) for complete recipes and ownership rules, and [Team setup errors](/storage#team-setup-errors) for the typed errors.

## Security

Anyone with read access to the team database can read everything stored in it, including CI sessions and Intercom messages until shortly after delivery.

- Give each team its own database, or its own prefix, and treat database access as full read access.
- Give machines and CI runners a runtime role with only the privileges Atomic needs, rotate its password when someone leaves, and prefer platform identities (`--auth`) where your cloud supports them. See [PostgreSQL](/storage/postgres).
- In the team layout, personal sessions stay off the shared database only because `sessions.storage` selects the local store. Share sessions intentionally with `/share` or `atomic storage export` and `atomic storage import`.

## Related

- [Storage](/storage) for storage setup, selections, precedence, and error reference.
- [SDK session storage](/sdk/storage) for Node.js and TypeScript storage recipes and store ownership rules.
- [Resume sessions on any machine](/guides/resume-on-any-machine) for cross-machine worktree snapshots and environment blueprints.
- [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) for multi-node broker details.
- [Intercom groups](/intercom/reference#groups) for how groups isolate sessions.
