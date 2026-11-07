---
title: Resume on any machine
description: "Continue a session or workflow run on another machine that shares your storage: what Atomic restores, when it asks, the setup hook, and what each error means."
---

# Resume on any machine

When several machines share one storage database, a session or workflow run started on one machine can continue on any of them. Atomic finds the session in the shared storage, rebuilds the repository state it was working against, and continues the conversation where it stopped.

## Join each machine

Every machine must use the same shared storage. Install the libSQL adapter and join the database on each one:

```bash
atomic install npm:@bastani/atomic-storage-libsql
atomic team join <url> --token-file <path>
```

`atomic storage join <url> --token-file <path>` selects the same shared storage without the rest of the team setup. See [Sharing storage across hosts](/storage#sharing-storage-across-hosts) for prefixes, tokens and `atomic storage status`.

Keep snapshots on (`snapshots.enabled`, the default). A session records the state of each Git checkout it changes at the end of every turn that ran a file-writing tool, including uncommitted edits, untracked files and commits that were never pushed. That record lives in the shared storage, so a joined machine needs nothing else.

## Resume a session

Resume as usual, with `atomic --session <id>`, `atomic --resume` or `/resume`. When the session's checkout is not on this machine:

- If you start Atomic inside a checkout of the same repository and its files match what the session recorded, the session continues there.
- Otherwise Atomic restores the recorded state into a new worktree under `~/.atomic/agent/worktree-snapshots` and continues there. It never writes into an existing checkout. One line names the new worktree.
- If you start `atomic` inside a checkout of the same repository that differs from the recording and has uncommitted or untracked changes, Atomic asks whether to restore a fresh worktree (the default), continue in your checkout as it is, or cancel. `/resume` and non-interactive modes such as `-p` do not ask; they restore a fresh worktree. A clean checkout that differs, such as a fresh clone at another commit, is left alone without asking, and a fresh worktree is restored. A checkout where the recorded edits were committed counts as matching.
- A session that worked in several repositories gets each of them back: the checkout you started in is used for its repository, and every other recorded checkout that is missing or changed here is restored. If you choose to continue in a checkout that differs, the other checkouts are not restored, and a warning names them.

Absolute paths from the earlier machine keep working: a tool call that names a file under the old checkout opens the same file in the restored worktree. Shell commands are run as written, so a command that names an old absolute path needs the new one.

A `--session` id whose recorded directory does not exist on this machine, or that a restore moved to the current directory, opens directly instead of offering to fork the session into the current directory.

An SDK `createAgentSession({ sessionManager })` call prepares a supplied session the same way before it starts, unless you pass `cwd`. That includes a session whose recorded directory exists on this machine but holds a different tree, for example a runner built from the same image: the session continues in a restored worktree, not in that directory.

## Resume a workflow run

A workflow run restores its own checkouts from the snapshots on its checkpoints when it resumes on another machine; see [Worktree snapshots](/worktree-snapshots). Each restored checkout gets the setup hook below before the run continues, and absolute paths from the earlier machine resolve in the restored worktrees for the run's tools. A missing Git or setup hook is reported before anything is restored, whether the run resumes through `/workflow resume`, the SDK's `resume`, or `run()` with the run's id. If a hook fails, or turns out to be missing only in the restored repository, the run does not continue and the worktrees restored for it are removed, so the next resume starts clean. A run id that this machine cannot find because it uses local storage only fails with `ResumeNotFoundError`, both in `/workflow resume` and as the `cause` of the SDK's `WorkflowRunNotFoundError`.

## Install dependencies with a setup hook

A restored worktree contains the repository's files but not installed dependencies or build output. When the restored files include a dependency lockfile or toolchain file (such as `package-lock.json`, `Cargo.lock` or `.nvmrc`), Atomic runs a setup hook in the worktree before continuing:

1. `.atomic/setup` from the repository, when the project is trusted (`--approve` or `"defaultProjectTrust": "always"`). It runs with bash, the same shell as the bash tool (Git Bash on Windows), so give it a shebang. Or else
2. the command in `resume.setupCommand` in your global settings (`~/.atomic/agent/settings.json`). A project's own settings cannot set it, so a repository never chooses a command for a machine that has not trusted it:

```json
{
  "resume": { "setupCommand": "npm ci" }
}
```

This applies to sessions and to workflow runs. The hook runs once per worktree and lockfile state. It receives `ATOMIC_RESUME_WORKTREE` and `ATOMIC_ENV_HASH` in its environment, may run for up to 15 minutes, and its output goes to a log file under `~/.atomic/agent/worktree-snapshots/setup-logs`. Keep its output in ignored paths such as `node_modules`; files it leaves in the worktree count as changes the next time the session resumes.

## What can stop a resume

Missing setup is checked in one pass before anything is restored: the storage adapter and its token, Git, and a setup hook when the snapshot has dependency inputs and neither `resume.setupCommand` nor a trusted `.atomic/setup` could run. Every missing piece is reported together, with the command that fixes it. When a trusted repository turns out to have no `.atomic/setup`, the worktree restored for it is removed again. A session keeps the record of that restore, so its next resume, on any machine, restores the checkout again instead of continuing in the original one; add `.atomic/setup` or set `resume.setupCommand` before resuming it.

| Error | Code | When it happens | What to do |
|---|---|---|---|
| `ResumeNotFoundError` | `not-found` | The id matches nothing this machine can read. With reason `local-storage-not-joined`, this machine uses local storage only. | Join the machine with `atomic team join <url> --token-file <path>`. With reason `shared-miss`, check the id and that every machine uses the same storage and prefix. |
| `ResumePreconditionError` | `preconditions-unmet` | Setup the resume needs is missing. Every missing piece is listed in `problems`: `adapter-not-installed`, `credential-missing`, `credential-unreadable`, `git-unavailable`, `setup-hook-missing`. | Run each listed fix, for example `atomic install npm:@bastani/atomic-storage-libsql`, write the token file, install Git, or configure a setup hook. |
| `GitUnavailableError` | `not-installed`, `unsupported-platform`, `offline`, `checksum-mismatch` | The session's checkout must be verified or restored and Git cannot be started. | Install Git with the command the error names. |
| `ResumeCatalogUnavailableError` | `catalog-unavailable` | The shared storage could not be reached while looking the session up. Retryable. | Check connectivity with `atomic storage status` and resume again. |
| `ResumeCatalogTimeoutError` | `catalog-timeout` | The shared storage did not answer the first read of the lookup within 15 seconds, for example during a network partition. Retryable. A partition that starts later in the resume is reported when the connection gives up. | Check connectivity with `atomic storage status` and resume again. |
| `ResumeSetupHookError` | `setup-hook-failed`, `setup-hook-timed-out` | The setup hook exited with an error, was stopped, or ran too long. | Read the log named in the error, fix the hook, and resume again; the hook runs again. A session keeps the worktree it restored; a workflow run removes the worktrees its resume restored and restores them again. |
| `WorkspaceDriftError` | `tree-drift` | The recorded state cannot be rebuilt, for example because unpushed commits touch files that are never recorded (`.env`, keys), a snapshot blob is missing, or the disk is full. The message names what the restore could not do (the commits, blob, remote or full volume) and the fix. | Do what the message says; for unpushed commits, push them from the original machine, or continue there. |

Secret values never appear in these messages; they name the environment variable or file instead. The classes, their codes and the `isResume…Error` guards are exported from `@bastani/atomic`.

## Trust

A restored worktree is a new directory, so project trust starts unset there, exactly as for a fresh clone. Until you trust it, project instructions and resources are not loaded and `.atomic/setup` does not run.
