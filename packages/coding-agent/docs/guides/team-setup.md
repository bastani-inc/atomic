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

`atomic team join <url> [--token-file <path>] [--prefix <prefix>]` checks everything before it changes anything: the URL, the token, the prefix, your global settings, the installed adapter, and a `SELECT 1` on the database. If any check fails, nothing is written. Then it:

1. stores the token in a private file in the agent directory (mode 600). Running the command again with the same token reuses that file;
2. writes two keys of `~/.atomic/agent/settings.json` in one update: `storage`, set to the team database, and `sessions.storage`, set to the local default store (`{ "path": "workflows/journal.sqlite" }`), so your transcripts stay on your machine. Every other setting keeps its value;
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

`atomic team leave` removes `storage` and `sessions.storage` only when they still hold what `team join` wrote. A value you changed yourself stays in place, and the command says so. It deletes the token file unless another setting still references it, and restarts the Intercom broker. Running it again changes nothing.

## Project groups

While multi-node routing is on, a session that has no explicit group joins a project group instead of `default`:

- `project:<owner>/<repo>`, from the repository's `origin` remote. Clones over SSH and HTTPS of the same repository share one group.
- In a repository without an `origin` remote, the repository's directory name; outside Git, the working directory's name.

Sessions of different repositories on the same database cannot see or message each other unless they share a group. An explicit group still wins: `ATOMIC_INTERCOM_GROUP`, the Intercom `config.json` `group`, a workflow stage's group, or a subagent's inherited group. With one machine and no shared storage, sessions keep using `default`.

Joining `default` explicitly while multi-node routing is on prints a one-line warning, because every teammate's sessions on the database can address that group.

Inside a Git repository, Atomic runs `git` to read the origin. If Git is not installed or fails there, the session's Intercom start fails with an error that names the install command or the failing `git` command. Setting `ATOMIC_INTERCOM_GROUP` avoids the lookup.

## CI and swarms

A CI runner needs no settings file. Set these variables for the process:

| Variable | Value |
|---|---|
| `ATOMIC_PROFILE` | `ci` |
| `ATOMIC_TEAM_URL` | The team database URL |
| `ATOMIC_TEAM_TOKEN` or `ATOMIC_TEAM_TOKEN_FILE` | The token, or a file holding it. Only an absolute `file:` URL needs neither |
| `ATOMIC_TEAM_PREFIX` | Optional: the prefix the team joined with |

With `ATOMIC_PROFILE=ci`, sessions, workflow runs, and Intercom all use the team database in that process and the processes it starts. Nothing is written to settings. The token is read from the variable or the file when a store opens; it is never copied into settings, logs, or the selection a child process receives.

Atomic checks these variables when it starts, before any session starts. A team variable without `ATOMIC_PROFILE`, or the profile without its URL or token, fails with one error that names every missing variable. An unknown profile, a bad URL, an unreadable or empty token file, and an invalid prefix fail the same way. If the adapter cannot be loaded, startup fails with the `atomic install` command to run. More specific selections still win: `--storage`, `ATOMIC_STORAGE`, and the domain variables outrank the profile.

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

For a [GitHub Agentic Workflows](https://github.github.com/gh-aw/) (gh-aw) workflow, put the same variables in the frontmatter `env:` and the install commands in `steps:`, which run before the agent:

```yaml
---
on: workflow_dispatch
env:
  ATOMIC_PROFILE: ci
  ATOMIC_TEAM_URL: ${{ vars.ATOMIC_TEAM_URL }}
  ATOMIC_TEAM_TOKEN: ${{ secrets.ATOMIC_TEAM_TOKEN }}
steps:
  - run: npm install -g @bastani/atomic
  - run: atomic install npm:@bastani/atomic-storage-libsql
---
```

Keep the token in an encrypted secret, give it only to the jobs that need it, and remember that every tool the agent runs in the job inherits it.

### From the SDK

`@bastani/atomic/storage` exposes the same operations as the commands: `joinTeam()`, `leaveTeam()`, `getTeamProfile()`, and `teamProfileSelection()`. `teamProfileSelection({ profile: "ci", url, token })` returns a selection you can pass as `createAgentSession({ storage })` and as `RunOpts.journal`, without touching settings. A literal `token` stays in memory: it serializes as `[redacted]` and is refused anywhere but the SDK. Pass `tokenFile` or `tokenEnv` instead to reference a file or an environment variable.

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

Anyone who can read the database can read everything in it: every session stored there (CI sessions in the CI profile), every workflow run, and Intercom messages until shortly after they are delivered. Treat database access as full read access, give each team its own database or token, and rotate the token when someone leaves. The team layout keeps individual sessions out of the database only because `sessions.storage` points at the local store; share a session deliberately with `/share` or export and import.

## Related

- [Storage](/storage) — every storage selection and its precedence.
- [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) — multi-node routing details.
- [Intercom groups](/intercom/reference#groups) — how groups isolate sessions.
