---
title: "Team and CI setup"
description: "Share Intercom with your team through one database while sessions stay private, and give CI runners the same database from environment variables alone."
---

# Team and CI setup

Share one libSQL or Turso database across machines so teammates can message each other over Intercom while keeping their own sessions local. CI runners can point both sessions and Intercom at the same database using environment variables alone, so teammates can inspect and resume CI runs.

| Scope | Sessions | Intercom |
| --- | --- | --- |
| Individual (default) | Local | Local only |
| Team | Local (share explicitly with `/share` or export/import) | Team database, project group |
| CI and swarms | Team database | Team database, per-run group (`ATOMIC_INTERCOM_GROUP`) |

Run `atomic team status` to see the active profile (`individual`, `team`, `ci`, or `custom` if your settings do not match a preset).

## Join a team

Install the libSQL adapter once per machine, create a database token, and join:

```bash
atomic install npm:@bastani/atomic-storage-libsql
turso db tokens create <db> > ~/team-token
atomic team join libsql://<db>.turso.io --token-file ~/team-token
```

Command syntax: `atomic team join <url> [--token-file <path>] [--prefix <prefix>]`.

Before writing anything, Atomic validates the URL, token, prefix, global settings, installed adapter, and a `SELECT 1` health check (15-second timeout). If any check fails, nothing changes. Otherwise, it:

1. Saves the token to a mode-`600` file in your agent directory (reusing it if you rerun with the same token).
2. Updates three keys in `~/.atomic/agent/settings.json` atomically while leaving all other settings untouched:
   - `storage`: set to the team database.
   - `sessions.storage`: pinned to `{ "path": "workflows/journal.sqlite" }` so local transcripts stay private (prints a notice if it replaces another store).
   - `teamJoin`: records the managed `storage` block so `atomic team leave` can distinguish managed values from your manual edits. Leave `teamJoin` unchanged.
3. Restarts the Intercom broker so it routes through the team database.
4. Prints the active profile, the current project's Intercom group, and the `atomic storage status` report.

**URLs and prefixes:**
- Supported URLs match [`atomic storage join`](/storage#joining-a-machine-to-a-shared-database): `libsql://`, `https://`, `wss://`, or an absolute `file:` URL (which needs no token). URLs containing an embedded token are refused.
- Use `--prefix` to isolate multiple teams inside one database. Everyone on a team must pass the same URL and prefix.
- Sessions that were already running keep their previous Intercom group until they restart or run `/reload`.

### Check and leave

```bash
atomic team status          # Profile, project group, and storage report
atomic team status --json   # JSON output
atomic team leave           # Return to the individual layout
```

`atomic team status` exits `1` if the selection is invalid, the adapter fails to load, or the database does not answer.

`atomic team leave` reverses a managed join safely:

- Removes `storage` and `teamJoin` only when `storage` still exactly matches the `teamJoin` record. Any manual edit (even changing only the URL or prefix) leaves `storage` and its token file intact and reports why.
- Keeps a `storage` entry written without a `teamJoin` record (for example from an earlier build). Run `atomic team join` once to record it before leaving.
- Removes `sessions.storage` only while it is still the local pin and no other `storage` selection remains (including a customized `storage`, a trusted project's `storage`, or a legacy `~/.pi/agent/settings.json` `storage` when using the default agent directory).
- Deletes the managed token file only if no remaining setting references it, then restarts the Intercom broker.
- Refuses to modify settings or delete token files if global or project settings cannot be read; fix the unreadable file first.
- Safe to run repeatedly; subsequent runs make no changes.

## Project groups

When multi-node routing is enabled, sessions without an explicit group automatically join a project group instead of `default`:

- `project:<owner>/<repo>` derived from the repository's `origin` remote (SSH and HTTPS clones map to the same group).
- The repository directory name when there is no `origin` remote, or the working directory name outside Git.

Sessions in different repositories on the same database cannot see or message each other unless they join the same group. An explicit group always wins: `ATOMIC_INTERCOM_GROUP`, the Intercom `config.json` `group`, or a subagent's inherited group. Without shared storage, single-machine sessions keep using `default`.

Joining `default` explicitly while multi-node routing is enabled prints a warning (once per process to stderr in non-UI modes like `atomic -p`), because every teammate's session on the database can address `default`.

Inside a Git repository, Atomic invokes `git` to read `origin`. If `git` is missing or fails, Intercom startup fails with the install command or failing `git` command. Set `ATOMIC_INTERCOM_GROUP` to bypass the lookup.

## CI and swarms

CI runners do not need a `settings.json` file. Configure them with environment variables:

| Variable | Value |
| --- | --- |
| `ATOMIC_PROFILE` | `ci` |
| `ATOMIC_TEAM_URL` | Team database URL |
| `ATOMIC_TEAM_TOKEN` or `ATOMIC_TEAM_TOKEN_FILE` | Database token or absolute path to a token file (for example under `$RUNNER_TEMP`). Omit only for an absolute `file:` URL. Relative paths are rejected at startup because child processes may run in different working directories. |
| `ATOMIC_TEAM_PREFIX` | Optional prefix matching the team's database prefix |

With `ATOMIC_PROFILE=ci`, both sessions and Intercom use the team database for this process and every child process it spawns. Nothing is written to settings, and the token is read when opening a store—never copied into settings, logs, or child storage selections.

**Validation and precedence:**
- Atomic validates these variables at startup before opening a session. Missing paired variables (a team variable without `ATOMIC_PROFILE`, or `ATOMIC_PROFILE=ci` without a URL or token), unknown profiles, invalid URLs or prefixes, and empty or unreadable token files fail immediately with a single error listing everything missing.
- More specific overrides win: `--storage` and `ATOMIC_STORAGE` override the profile for all stores (including Intercom), while domain-specific variables override only their own store.
- If the profile still selects the adapter and it is not installed, startup fails with the `atomic install` command to run.

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

Store the token in an encrypted secret, expose it only to the step that needs it, and remember that every tool the agent runs in that step inherits it.

### Caching between runs

Hosted CI runners start with an empty home directory. Use `atomic blueprint cache-key` to compute cache keys and paths for package stores detected from lockfiles plus any extra paths in `.atomic/settings.json` under `resume.cache` (see [Caches for runners](/guides/resume-on-any-machine#caches-for-runners)).

Save caches only from a trusted job on the default branch (`push`, `schedule`, or `workflow_dispatch`), and restore them read-only in agent jobs with `actions/cache/restore`.

In the trusted job, run [`atomic blueprint prebuild --park`](/guides/resume-on-any-machine#prebuilt-worktrees) to restore the commit into a worktree, run its blueprints to warm package stores, write the commit into Atomic's Git object store, and park `"kind": "build"` paths from `resume.cache`:

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
      - run: atomic --list-models   # Transpiles installed extensions into Atomic's cache
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

When the agent job resumes a session, it fetches only the commits missing from the cached Git store and adopts parked build output into a worktree at the same path used during prebuild (preserving path-sensitive artifacts such as Cargo's `target`).

- If `resume.cache` defines no `"kind": "build"` paths, `build-key` is empty and its steps are skipped.
- Omit build paths if untrusted external contributor code builds on the default branch, because every agent job reuses the trusted job's build output.
- Keys include lockfiles, key files, `resume.cache`, the repository blueprint, OS, architecture, and Atomic version, so exact hits never return stale content. `restore-keys` falls back to the newest older cache for package managers to update incrementally.
- `cache-key` omits paths that may hold credentials and warns on stderr (leaving `$GITHUB_OUTPUT` clean). Restore only entries that `cache-key` outputs for your repository, because a cache step with an empty `path` fails.

### From the SDK

`@bastani/atomic/storage` exports async helpers `joinTeam()`, `leaveTeam()`, and `getTeamProfile()`, plus `teamProfileSelection()`.

Use `teamProfileSelection({ profile: "ci", url, token })` to pass a storage selection to `createAgentSession({ storage })` without modifying settings. An in-memory `token` stays in memory, serializes as `[redacted]`, and cannot be reopened by other processes; pass `tokenFile` or `tokenEnv` instead when child processes need it.

Intercom runs one broker per agent directory, so pass the CI environment variables to both the host process and any spawned `atomic` processes:

```ts
import { spawn } from "node:child_process";
import { createAgentSession } from "@bastani/atomic";
import { teamProfileSelection } from "@bastani/atomic/storage";

const url = process.env.TEAM_DATABASE_URL!;
const token = process.env.TEAM_DATABASE_TOKEN!;

// In-process agent: sessions use the team database.
const storage = teamProfileSelection({ profile: "ci", url, token });
const { session } = await createAgentSession({ storage });
await session.prompt("Summarize the failing tests");

// Spawned agent process: sessions and Intercom both use the team database.
const child = spawn("atomic", ["-p", "Fix the failing test"], {
  env: { ...process.env, ATOMIC_PROFILE: "ci", ATOMIC_TEAM_URL: url, ATOMIC_TEAM_TOKEN: token },
  stdio: "inherit",
});
```

See [Team setup errors](/storage#team-setup-errors) for the typed errors these functions throw.

## Security

Anyone with read access to the team database can read everything in it: all stored sessions (including CI sessions), any workflow runs written by earlier releases, and Intercom messages until shortly after delivery.

- Give each team its own database and treat database access as full read access.
- With Turso, issue per-database tokens (`turso db tokens create <db>`), set `--expiration` on CI tokens, and rotate access when someone leaves with `turso db tokens invalidate <db>` (Turso cannot revoke a single token).
- In the team profile, individual sessions stay off the shared database only because `sessions.storage` is pinned locally. Share sessions intentionally with `/share` or export/import.

## Related

- [Storage](/storage) — storage selections and precedence.
- [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) — multi-node routing details.
- [Intercom groups](/intercom/reference#groups) — how groups isolate sessions.
