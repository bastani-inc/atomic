---
title: "Set up teams and CI"
sidebarTitle: "Team and CI setup"
description: "Share Intercom across a team while keeping personal sessions local, and configure CI runners with environment variables."
---

Share one libSQL or Turso database across machines so teammates can message each other over Intercom while keeping their personal sessions local. CI runners can point both sessions and Intercom at the same database using environment variables alone, so teammates can inspect and resume CI runs.

To share both sessions and Intercom across machines, or to use PostgreSQL instead of libSQL, follow the [Storage backends](/storage) guide and use `atomic storage join`.

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

## Join a team

Install the libSQL adapter once per machine, create a database token, and join:

```bash
atomic install npm:@bastani/atomic-storage-libsql
turso db tokens create <db> > ~/team-token
atomic team join libsql://<db>.turso.io --token-file ~/team-token
```

Command syntax:

```bash
atomic team join <url> [--token-file <path>] [--prefix <prefix>]
```

Only `--token-file <path>` is accepted on the command line (there is no `--token` flag) so database tokens do not leak into shell history or process lists.

Before writing anything, Atomic validates the URL, token, prefix, global settings, installed adapter, and a `SELECT 1` health check with a 15-second timeout. If any check fails, Atomic changes nothing. When all checks pass, Atomic performs four steps:

1. Saves the token to a mode-`600` file in your agent directory, reusing that file if you rerun with the same token.
2. Updates `~/.atomic/agent/settings.json` atomically while leaving all other settings untouched: sets `storage` to the team database and pins `sessions.storage` to `{ "path": "workflows/journal.sqlite" }` so personal transcripts stay local (printing a notice if this replaces another store). Atomic also writes a `teamJoin` marker used by `atomic team leave`; leave it unchanged.
3. Restarts the Intercom broker so it routes through the team database.
4. Prints the active profile, the current project's Intercom group, and the `atomic storage status` report.

URL and prefix rules:

- Supported URLs are `libsql://`, `https://`, `http://`, `wss://`, `ws://`, or an absolute `file:` URL (which needs no token). Prefer TLS (`libsql://`, `https://`, or `wss://`) for remote hosts; `http://` and `ws://` work for local or private-network `sqld`. Atomic refuses URLs that contain an embedded token. See [Joining a machine to a shared database](/storage#joining-a-machine-to-a-shared-database) for full database setup.
- Pass `--prefix` to isolate multiple teams inside one database. Everyone on a team must use the same URL and prefix.
- Sessions that were already running keep their previous Intercom group until they restart or run `/reload`.

### Check status and leave

```bash
atomic team status          # Profile, project group, and storage report
atomic team status --json   # JSON output
atomic team leave           # Return to the individual layout
```

`atomic team status` exits `1` if the selection is invalid, the adapter fails to load, or the database does not answer.

`atomic team leave` reverses a managed join without overwriting manual changes:

- Removes `storage` and `teamJoin` only when `storage` still matches the `teamJoin` record. Any manual edit leaves `storage` and its token file intact and reports why.
- Keeps a `storage` entry that has no `teamJoin` record. Run `atomic team join` once to record it before leaving.
- Removes `sessions.storage` only while it holds the local pin and no other `storage` selection remains (including a customized `storage`, a trusted project's `storage`, or a legacy `~/.pi/agent/settings.json` `storage` when using the default agent directory).
- Deletes the managed token file only if no remaining setting references it, then restarts the Intercom broker.
- Refuses to modify settings or delete token files if global or project settings cannot be read. Fix the unreadable file first.
- Running `atomic team leave` again makes no changes.

## Project groups

When multi-node Intercom routing is enabled, sessions without an explicit group join `project:<owner>/<repo>`, derived from the repository's `origin` remote. Without an `origin` remote, Atomic uses the repository directory name, or the working directory name outside Git.

Sessions in different repositories on the same database cannot see or message each other unless they join the same group. An explicit group (`ATOMIC_INTERCOM_GROUP`, Intercom's `config.json` `group`, or a subagent's inherited group) always overrides the project group. Joining `default` explicitly while multi-node routing is on prints a warning because every teammate's session on the database can address `default`.

For multi-node broker behavior, Git lookup errors, and routing checks, see [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) and [Project groups](/intercom/operations#project-groups).

## CI and swarms

> Using PostgreSQL in CI? Configure [`ATOMIC_STORAGE`](/storage#selecting-storage-per-process) instead. `ATOMIC_PROFILE=ci` and `teamProfileSelection()` support libSQL and Turso only.

CI runners do not need a `settings.json` file. Configure them with environment variables:

| Variable | Value |
| --- | --- |
| `ATOMIC_PROFILE` | `ci` |
| `ATOMIC_TEAM_URL` | Team libSQL/Turso database URL |
| `ATOMIC_TEAM_TOKEN` or `ATOMIC_TEAM_TOKEN_FILE` | Database token, or an absolute path to a token file (such as under `$RUNNER_TEMP`). Omit only for an absolute `file:` URL. Relative paths are rejected at startup because child processes may run in different working directories. |
| `ATOMIC_TEAM_PREFIX` | Optional prefix matching the team's database prefix |

With `ATOMIC_PROFILE=ci`, both sessions and Intercom use the team database for this process and every child process it spawns. Atomic writes nothing to settings. It reads the token when opening a store and never copies it into settings, logs, or child storage selections.

Validation and precedence:

- Atomic validates these variables at startup before opening a session. Leaving **any** of `ATOMIC_TEAM_URL`, `ATOMIC_TEAM_TOKEN`, `ATOMIC_TEAM_TOKEN_FILE`, or `ATOMIC_TEAM_PREFIX` exported without `ATOMIC_PROFILE=ci` fails startup immediately (`incomplete-profile`), so unset them when not using the CI profile.
- Setting both `ATOMIC_TEAM_TOKEN` and `ATOMIC_TEAM_TOKEN_FILE` fails startup (`conflicting-token`). Empty string values (such as `ATOMIC_TEAM_PREFIX=""`) are treated as unset.
- Unknown profiles, invalid URLs or prefixes, and empty or unreadable token files fail immediately with one error listing everything missing.
- `--storage`, `--storage-file`, and `ATOMIC_STORAGE` override the profile for all stores, including Intercom. Session-specific flags and `ATOMIC_SESSIONS_STORAGE` override only sessions. See [Selecting storage per process](/storage#selecting-storage-per-process) for the full precedence order.
- If the libSQL adapter is not installed, startup fails with the `atomic install` command to run.

### GitHub Actions

```yaml
jobs:
  agent:
    runs-on: ubuntu-latest
    env:
      ATOMIC_PROFILE: ci
      ATOMIC_TEAM_URL: ${{ vars.ATOMIC_TEAM_URL }}
      ATOMIC_TEAM_TOKEN: ${{ secrets.ATOMIC_TEAM_TOKEN }}
    steps:
      - uses: actions/checkout@v5
      - run: npm install -g @bastani/atomic
      - run: atomic install npm:@bastani/atomic-storage-libsql
      - run: atomic -p "Fix the failing test in the checkout"
```

Store the token in an encrypted secret and expose it only to the step that needs it. Every tool the agent runs in that step inherits the step's environment.

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

`@bastani/atomic/storage` exports async helpers `joinTeam()`, `leaveTeam()`, and `getTeamProfile()`, plus `teamProfileSelection()` (libSQL and Turso only).

`teamProfileSelection()` returns an adapter selection for `@bastani/atomic-storage-libsql`. Because adapter selections resolve from user-scope packages, host extension directories, or the agent directory rather than an application's `node_modules`, install the adapter with `atomic install npm:@bastani/atomic-storage-libsql` (without `-l`), or register a local package directory with `DefaultResourceLoader({ additionalExtensionPaths })`.

If you prefer managing `@bastani/atomic-storage-libsql` as an ordinary project dependency with `npm install`, call `openLibsqlDatabase()` directly and pass `sessionStore: { kind: "database", database, prefix? }` to `createAgentSession()`, closing `database` in a `finally` block. See [SDK session storage](/sdk/storage) for complete recipes and ownership rules.

Use `teamProfileSelection({ profile: "ci", url, token })` to pass a storage selection to `createAgentSession({ storage })` without modifying settings:

- `token` stays in memory, serializes as `[redacted]`, and cannot be reopened by child processes.
- `tokenEnv` stores `{ env: "<VAR>" }` so child processes can reopen the store, and checks immediately at call time that the named environment variable is set (throwing `missing-token` if unset).
- `tokenFile` resolves relative paths against `cwd` and reads the file immediately to verify it is non-empty.

Intercom runs one broker per agent directory, so pass the CI environment variables to both the host process and any spawned `atomic` processes:

```typescript
import { spawn } from "node:child_process";
import { createAgentSession } from "@bastani/atomic";
import { teamProfileSelection } from "@bastani/atomic/storage";

const url = process.env.TEAM_DATABASE_URL!;
const token = process.env.TEAM_DATABASE_TOKEN!;

// Embedded SDK agent: sessions use the team database (requires `atomic install npm:@bastani/atomic-storage-libsql`
// or `DefaultResourceLoader({ additionalExtensionPaths })`).
const storage = teamProfileSelection({ profile: "ci", url, token });
const { session } = await createAgentSession({ storage });
try {
  await session.prompt("Summarize the failing tests");
} finally {
  await session.dispose();
}

// Spawned agent process: sessions and Intercom both use the team database.
const child = spawn("atomic", ["-p", "Fix the failing test"], {
  env: { ...process.env, ATOMIC_PROFILE: "ci", ATOMIC_TEAM_URL: url, ATOMIC_TEAM_TOKEN: token },
  stdio: "inherit",
});
```

See [Team setup errors](/storage#team-setup-errors) for the typed errors these functions throw.

## Security

Anyone with read access to the team database can read everything stored in it, including CI sessions and Intercom messages until shortly after delivery.

- Give each team its own database and treat database access as full read access.
- With Turso, issue per-database tokens (`turso db tokens create <db>`), set `--expiration` on CI tokens, and rotate access when someone leaves with `turso db tokens invalidate <db>` (Turso cannot revoke a single token).
- In the team profile, personal sessions stay off the shared database only because `sessions.storage` is pinned locally. Share sessions intentionally with `/share` or `atomic storage export` and `atomic storage import`.

## Related

- [Storage backends](/storage) for storage setup, selections, precedence, and error reference.
- [SDK session storage](/sdk/storage) for Node.js and TypeScript storage recipes, `openLibsqlDatabase()`, and store ownership rules.
- [Resume sessions on any machine](/guides/resume-on-any-machine) for cross-machine worktree snapshots and environment blueprints.
- [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) for multi-node broker details.
- [Intercom groups](/intercom/reference#groups) for how groups isolate sessions.
