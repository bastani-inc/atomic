---
title: "Team and CI setup"
description: "Share workflow runs and Intercom with your team through one database while sessions stay private, and give CI runners the same database from environment variables alone."
---

# Team and CI setup

A team can share workflow runs and Intercom routing through one libSQL or Turso database. Each person's sessions stay on their own machine, and CI runners can put their sessions in the shared database too, so teammates can inspect and resume them.

| Scope | Sessions | Workflow runs | Intercom |
|---|---|---|---|
| Individual (default) | local | local | local only |
| Team | local (share with `/share` or export/import) | team database | team database, project group |
| CI and swarms | team database | team database | team database, groups per run (workflow groups already are) |

`atomic team status` shows which of these is in effect, or `custom` when your selections match none of them.

## Join a team

Install the adapter once per machine, get a token for the database, and join:

```bash
atomic install npm:@bastani/atomic-storage-libsql
turso db tokens create <db> > ~/team-token
atomic team join libsql://<db>.turso.io --token-file ~/team-token
```

`atomic team join <url> [--token-file <path>] [--prefix <prefix>]` checks everything before it changes anything: the URL, the token, the prefix, your global settings, the installed adapter, and a `SELECT 1` on the database, which must answer within 15 seconds. If any check fails, nothing is written. Then it:

1. stores the token in a private file in the agent directory (mode 600). Running the command again with the same token reuses that file;
2. writes three keys of `~/.atomic/agent/settings.json` in one update: `storage`, set to the team database; `sessions.storage`, set to the local default store (`{ "path": "workflows/journal.sqlite" }`), so your transcripts stay on your machine; and `teamJoin`, a managed record of the `storage` value it wrote, which `atomic team leave` uses to tell your edits from the join's own value. Leave `teamJoin` as it is. If `sessions.storage` held another store, the command says which one it replaced. Every other setting keeps its value;
3. restarts the Intercom broker so it routes through the team database;
4. prints the profile, the Intercom group of the current project, and the same report as `atomic storage status`.

Use `--prefix` to keep several teams in one database. Everyone on a team must use the same URL and prefix. `atomic team join` accepts the same URLs as [`atomic storage join`](/storage#joining-a-machine-to-a-shared-database): `libsql://`, `https://`, `wss://`, or an absolute `file:` URL, which needs no token. URLs that contain the token are refused.

Sessions that were already running keep their Intercom group until they restart or run `/reload`.

### Check and leave

```bash
atomic team status          # profile, project group, and the storage report
atomic team status --json   # the same as JSON
atomic team leave           # back to the individual layout
```

`atomic team status` exits 1 when a selection is invalid, the adapter cannot load, or the database does not answer.

`atomic team leave` removes `storage` and `teamJoin` only when `storage` is exactly the value that `team join` wrote (it matches the `teamJoin` record), and `sessions.storage` only while it is still the local pin. Any change you made, even to the URL or the prefix alone, keeps `storage` and its token file untouched, and the command says so. A `storage` written by an earlier build, which has no `teamJoin` record, is kept the same way: run `atomic team join` again once to record it. If another `storage` selection remains, `sessions.storage` stays too, so your sessions do not move to that store. That covers a `storage` you changed, a trusted project's `storage`, and, when you use the default agent directory, a `storage` in the legacy `~/.pi/agent/settings.json` that Atomic also reads. The command deletes the token file unless another setting, including those files, still references it, and restarts the Intercom broker. Running it again changes nothing.

If the global or project settings cannot be read, fix them before leaving. The command keeps settings and token files unchanged rather than deleting a token whose references it cannot check.

## Project groups

While multi-node routing is on, a session that has no explicit group joins a project group instead of `default`:

- `project:<owner>/<repo>`, from the repository's `origin` remote. Clones over SSH and HTTPS of the same repository share one group.
- In a repository without an `origin` remote, the repository's directory name; outside Git, the working directory's name.

Sessions of different repositories on the same database cannot see or message each other unless they share a group. An explicit group still wins: `ATOMIC_INTERCOM_GROUP`, the Intercom `config.json` `group`, a workflow stage's group, or a subagent's inherited group. With one machine and no shared storage, sessions keep using `default`.

Joining `default` explicitly while multi-node routing is on prints a one-line warning, because every teammate's sessions on the database can address that group. A session without a UI, such as `atomic -p` in CI, writes it to stderr once per process.

Inside a Git repository, Atomic runs `git` to read the origin. If Git is not installed or fails there, the session's Intercom start fails with an error that names the install command or the failing `git` command. Setting `ATOMIC_INTERCOM_GROUP` avoids the lookup.

## CI and swarms

A CI runner needs no settings file. Set these variables for the process:

| Variable | Value |
|---|---|
| `ATOMIC_PROFILE` | `ci` |
| `ATOMIC_TEAM_URL` | The team database URL |
| `ATOMIC_TEAM_TOKEN` or `ATOMIC_TEAM_TOKEN_FILE` | The token, or a file holding it. Only an absolute `file:` URL needs neither. Give the file as an absolute path, for example under `$RUNNER_TEMP`: a relative path is refused at startup, because each process Atomic starts would resolve it against its own working directory |
| `ATOMIC_TEAM_PREFIX` | Optional: the prefix the team joined with |

With `ATOMIC_PROFILE=ci`, sessions, workflow runs, and Intercom all use the team database in that process and the processes it starts. Nothing is written to settings. The token is read from the variable or the file when a store opens; it is never copied into settings, logs, or the selection a child process receives.

Atomic checks these variables when it starts, before any session starts. A team variable without `ATOMIC_PROFILE`, or the profile without its URL or token, fails with one error that names every missing variable. An unknown profile, a bad URL, an unreadable or empty token file, and an invalid prefix fail the same way. More specific selections still win: `--storage`, `ATOMIC_STORAGE`, and the domain variables outrank the profile. `--storage` and `ATOMIC_STORAGE` outrank it for every store, Intercom included, while a domain variable outranks it only for its own store. As long as the profile still selects a store, startup fails with the `atomic install` command to run if the adapter cannot be loaded.

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

In a [GitHub Agentic Workflows](https://github.github.com/gh-aw/) (gh-aw) workflow, run Atomic in a custom job from the frontmatter `jobs:`. gh-aw runs those as ordinary GitHub Actions jobs before its own agent, outside its sandbox, so the token can stay in a step's `env:`:

```yaml
---
on: workflow_dispatch
jobs:
  atomic:
    runs-on: ubuntu-latest
    env:
      ATOMIC_PROFILE: ci
      ATOMIC_TEAM_URL: ${{ vars.ATOMIC_TEAM_URL }}
    steps:
      - uses: actions/checkout@v5
      - run: npm install -g @bastani/atomic
      - run: atomic install npm:@bastani/atomic-storage-libsql
      - run: atomic -p "Fix the failing test in the checkout"
        env:
          ATOMIC_TEAM_TOKEN: ${{ secrets.ATOMIC_TEAM_TOKEN }}
---
```

Do not put the token in the frontmatter `env:` or `steps:`: gh-aw makes those visible to its own agent, and `gh aw compile --strict` refuses secrets there.

Keep the token in an encrypted secret, give it only to the step that needs it, and remember that every tool the agent runs in that step inherits it.

### Caching between runs

A hosted runner starts every job with an empty home directory. List the package stores worth keeping in the `cache:` section of `.atomic/blueprint.yaml` (see [Caches for runners](/guides/resume-on-any-machine#caches-for-runners)), and let `atomic blueprint cache-key` name the cache entries. Save them only from a trusted job on the default branch (`push`, `schedule` or `workflow_dispatch`), and restore them in agent jobs with `actions/cache/restore`, which cannot save:

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  warm-cache:
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm install -g @bastani/atomic
      - id: keys
        run: atomic blueprint cache-key --format github-output >> "$GITHUB_OUTPUT"
      - run: npm ci                 # fills the stores the blueprint declares
      - run: atomic --list-models   # transpiles your installed extensions into Atomic's cache
      - uses: actions/cache/save@v4
        with:
          key: ${{ steps.keys.outputs.stores-key }}
          path: ${{ steps.keys.outputs.stores-paths }}
      - uses: actions/cache/save@v4
        with:
          key: ${{ steps.keys.outputs.atomic-key }}
          path: ${{ steps.keys.outputs.atomic-paths }}
```

In the agent job, before Atomic starts:

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
        with:
          key: ${{ steps.keys.outputs.atomic-key }}
          restore-keys: ${{ steps.keys.outputs.atomic-restore-prefix }}
          path: ${{ steps.keys.outputs.atomic-paths }}
      - run: atomic -p "Fix the failing test in the checkout"
```

Restore `git-*` the same way when your jobs resume sessions of the repository: a trusted job that resumed one can save Atomic's Git object store, and later resumes then fetch only new commits. In a gh-aw workflow, put the same steps in the custom job that runs Atomic. Do not use gh-aw's frontmatter `cache:` for these entries: it runs `actions/cache`, which also saves from the agent job.

The key changes when a key file, the declared entries, the OS, the architecture or the Atomic version change, so a restore by exact key never gets stale content; the restore prefix falls back to the newest older entry, which package managers bring up to date. `cache-key` leaves out paths that could hold credentials and prints a warning on stderr, which does not reach `$GITHUB_OUTPUT`. An entry it leaves out has no outputs, and a cache step with an empty `path` fails, so restore only entries your blueprint declares.

### From the SDK

`@bastani/atomic/storage` exposes the same operations as the commands: `joinTeam()`, `leaveTeam()`, and `getTeamProfile()`, which return promises, and `teamProfileSelection()`. `teamProfileSelection({ profile: "ci", url, token })` returns a selection you can pass as `createAgentSession({ storage })` and as `RunOpts.journal`, without touching settings. A literal `token` stays in memory: it serializes as `[redacted]` and is refused anywhere but the SDK. Pass `tokenFile` or `tokenEnv` instead to reference a file or an environment variable.

Intercom has one broker per agent directory, chosen by the process, so give the CI profile variables to the host process (for Intercom in its own sessions) and to the agent processes it starts:

```ts
import { spawn } from "node:child_process";
import { createAgentSession } from "@bastani/atomic";
import { teamProfileSelection } from "@bastani/atomic/storage";

const url = process.env.TEAM_DATABASE_URL!;
const token = process.env.TEAM_DATABASE_TOKEN!;

// An agent in this process: its sessions and workflow runs use the team database.
const storage = teamProfileSelection({ profile: "ci", url, token });
const { session } = await createAgentSession({ storage });
await session.prompt("Summarize the open workflow runs");

// Agent processes on the same database, Intercom included.
const child = spawn("atomic", ["-p", "Fix the failing test"], {
  env: { ...process.env, ATOMIC_PROFILE: "ci", ATOMIC_TEAM_URL: url, ATOMIC_TEAM_TOKEN: token },
  stdio: "inherit",
});
```

A selection with an in-memory token cannot be reopened by [local workflow workers](/workflows/operations#local-workflow-workers), which run in other processes; use `tokenFile` or `tokenEnv` for pooled runs. See [Team setup errors](/storage#team-setup-errors) for the typed errors these functions throw.

## Security

Anyone who can read the database can read everything in it: every session stored there (CI sessions in the CI profile), every workflow run, and Intercom messages until shortly after they are delivered. Treat database access as full read access and give each team its own database. With Turso, create per-database tokens (`turso db tokens create <db>`), give CI tokens an `--expiration`, and when someone leaves, run `turso db tokens invalidate <db>` and hand out new tokens: Turso cannot revoke a single token. The team layout keeps individual sessions out of the database only because `sessions.storage` points at the local store; share a session deliberately with `/share` or export and import.

## Related

- [Storage](/storage) — every storage selection and its precedence.
- [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) — multi-node routing details.
- [Intercom groups](/intercom/reference#groups) — how groups isolate sessions.
