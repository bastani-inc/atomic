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
atomic storage join <url> --token-file <path>
```

`atomic storage join` keeps sessions and workflow runs in the shared database, so both resume on any joined machine. `atomic team join` shares workflow runs and Intercom but keeps sessions on each machine, so with it only workflow runs resume elsewhere; to share sessions on a machine joined that way, run `atomic team leave` and then `atomic storage join`. See [Sharing storage across hosts](/storage#sharing-storage-across-hosts) for prefixes, tokens and `atomic storage status`.

Keep snapshots on (`snapshots.enabled`, the default). A session records the state of each Git checkout it changes at the end of every turn that ran a file-writing tool, including uncommitted edits, untracked files and commits that were never pushed. That record lives in the shared storage, so a joined machine needs nothing else.

## Resume a session

Resume as usual, with `atomic --session <id>`, `atomic --resume` or `/resume`. When the session's checkout is missing or changed on this machine:

- If you start Atomic inside a checkout of the same repository and its files match what the session recorded, the session continues there.
- Otherwise Atomic restores the recorded state into a new worktree under `~/.atomic/agent/worktree-snapshots` and continues there. It never writes into an existing checkout. One line names the new worktree.
- If you start `atomic` inside a checkout of the same repository that differs from the recording and has uncommitted or untracked changes, Atomic asks whether to restore a fresh worktree (the default), continue in your checkout as it is, or cancel. `/resume` and non-interactive modes such as `-p` do not ask; they restore a fresh worktree. A clean checkout that differs, such as a fresh clone at another commit, is left alone without asking, and a fresh worktree is restored. A checkout where the recorded edits were committed counts as matching.
- A session that worked in several checkouts gets each of them back where it can, also when it worked from a directory outside all of them: the checkout you started in is used for its repository, and every other recorded checkout that is missing here is restored. Only the checkout the session works in has to be restorable. Any other checkout that is missing or changed never stops the resume: one the session worked in on this machine (a sibling worktree, for example) and that changed since continues as it is, and one that cannot be restored is left out. Each checkout that is left out or kept as it is gets a warning that names its path and why, for example `Continuing without restoring /tmp/probe (snapshot 3f2a9c1d7b04): it does not exist on this node, and the snapshot has dependency inputs (…)`. If you choose to continue in a checkout that differs, the other checkouts are not restored, and a warning names those that are missing here.

Absolute paths from the earlier machine keep working: a tool call that names a file under the old checkout opens the same file in the restored worktree. Shell commands are run as written, so a command that names an old absolute path needs the new one.

A `--session` id whose recorded directory does not exist on this machine, or that a restore moved to the current directory, opens directly instead of offering to fork the session into the current directory.

An SDK `createAgentSession({ sessionManager })` call prepares a supplied session the same way before it starts, unless you pass `cwd` or `workspace`. That includes a session whose recorded directory exists on this machine but holds a different tree, for example a runner built from the same image: the session continues in a restored worktree, not in that directory.

When the shared storage does not answer, `atomic --session`, `--resume`, `--continue` and `/resume` stop after 15 seconds with a retryable `ResumeCatalogTimeoutError` instead of waiting for the network to give up. Nothing was changed; resume again once `atomic storage status` reaches the database.

## Wake a released subagent

A background subagent that was released while it waited keeps its session in the shared storage when it was launched with `context: "fork"`, so it can be woken on another machine. The wake maps its recorded directory through the restores of the session that owns it. The subagent's own session is then prepared as a woken session is: each checkout it worked in on this machine stays as it is, and every other checkout is restored from its snapshots into a worktree on this machine, with the setup hook. Its tools resolve the earlier machine's absolute paths there, and follow the restores of the session or run it was launched in. A subagent started without `context: "fork"` keeps a session file on the machine that launched it, which another machine cannot reopen; it is reported as unrestorable.

## Resume a workflow run

Resume a run with `/workflow resume <run>`, or from the SDK with `run(definition, inputs, { runId })`. A run restores its checkouts from the snapshots on its checkpoints, once, before it continues; see [Worktree snapshots](/worktree-snapshots):

- Each checkout gets its latest recorded state. Completed `ctx.tool` calls are not run again; the step that was interrupted runs again in the restored worktree.
- A child workflow bound to a repository with `workspace({ repo, branch })` continues in its restored worktree, also when its repository or branch exists only on the machine that recorded it.
- A run bound to an input worktree (`worktreeFromInputs`, as `goal` and `ralph` use) continues in the worktree restored for it.
- Children of a pooled run restore their worktree on whichever host claims them, and only hosts that can restore it claim them. A worker host runs the setup hook below, from its own agent directory's settings, in each worktree it restores, before the child starts there; a host given its own `restore` function runs none. See [Workers on other hosts](/workflows/operations#workers-on-other-hosts).
- `forkRun` on another machine materializes the worktrees recorded where the fork starts, not the source run's latest state.

Each checkout the run restores gets the setup hook below before the run continues, and absolute paths from the earlier machine resolve in the restored worktrees for the run's tools. A missing Git or setup hook is reported before anything is restored or claimed; a worker host reports a missing hook once it has claimed the child, before it restores, or after the restore when the work carries no snapshot. If a hook fails, or turns out to be missing only in the restored repository, the run does not continue and the worktrees restored for it are removed, so the next resume starts clean.

`run()` with the id of a run in shared storage stops after 15 seconds with a retryable `ResumeCatalogTimeoutError` when the storage does not answer; once it answers, listing the journal's runs is not bounded, and a retry opens the journal again. `/workflow resume` with a run id this machine cannot find fails with the journal's `run-not-found` error, which tells a machine on local storage only to join the shared storage. `run()` with a run id its journal does not hold starts a new run under that id, so check with `atomic storage status` that the machine uses the shared storage before resuming a run from the SDK. If the machine that ran it stopped without releasing it, another machine can take the run over two minutes after its last heartbeat; until then the resume reports that another execution owns it before it restores or sets up anything, and resuming again later continues it.

## Install dependencies with a setup hook

A restored worktree contains the repository's files but not installed dependencies or build output. When the restored files include a dependency lockfile or toolchain file (such as `package-lock.json`, `Cargo.lock` or `.nvmrc`), Atomic runs a setup hook in the worktree before continuing:

1. `.atomic/setup` from the repository, when the project is trusted (`--approve` or `"defaultProjectTrust": "always"`). It runs with bash (Git Bash on Windows) as `./.atomic/setup`, so make it executable and give it a shebang. Or else
2. the command in `resume.setupCommand` in your global settings (`~/.atomic/agent/settings.json`). A project's own settings cannot set it, so a repository never chooses a command for a machine that has not trusted it:

```json
{
  "resume": { "setupCommand": "npm ci" }
}
```

This applies to sessions and to workflow runs. The hook runs in each worktree a resume restores, once per lockfile state. A session that resumes on the machine it was recorded on, with its checkouts as it left them, restores nothing and runs no hook. For a session, a checkout other than the one it works in that cannot get its hook, because none is configured, or whose hook fails, is left out or kept with a warning instead of stopping the resume; the hook runs again in a worktree where it failed on the next resume. In a worktree an earlier resume of the session restored, it runs again only when its last run there failed or never finished, since later lockfile changes are the session's own work. It receives `ATOMIC_RESUME_WORKTREE` and `ATOMIC_ENV_HASH` in its environment, may run for up to 15 minutes, and its output goes to a log file under `~/.atomic/agent/worktree-snapshots/setup-logs`. Keep its output in ignored paths such as `node_modules`; files it leaves in the worktree count as changes the next time the session resumes.

## What can stop a resume

Missing setup is checked in one pass before anything is restored: the storage adapter and its token (for a session resumed with `atomic`), Git, and a setup hook when the snapshot has dependency inputs and neither `resume.setupCommand` nor a trusted `.atomic/setup` could run. For a session, only the checkout it works in can stop the resume this way: when that checkout must be restored and a piece is missing, the error lists every missing piece of every checkout the resume would restore, each with the path of the checkout it belongs to (`problems[].checkout`), the one the session works in first. For any other checkout, a missing piece is a warning. A machine without Git gets a portable Git automatically, as it does for other Git work; only when that is impossible, for example in offline mode or when the download fails, does `git-unavailable` stop the resume. Every missing piece is reported together, with the command that fixes it. When a trusted repository turns out to have no `.atomic/setup`, the worktree restored for it is removed again and nothing about the attempt is recorded, so the next resume, on any machine, starts as if it had not happened.

| Error | Code | When it happens | What to do |
|---|---|---|---|
| `ResumeNotFoundError` | `not-found` | The session id matches nothing this machine can read. With reason `local-storage-not-joined`, this machine uses local storage only. | Join the machine's sessions with `atomic storage join <url> --token-file <path>`. `atomic team join` keeps sessions on each machine: on a machine joined that way, run `atomic team leave` first. With reason `shared-miss`, check the id and that every machine uses the same storage and prefix. |
| `ResumePreconditionError` | `preconditions-unmet` | Setup the resume needs is missing. Every missing piece is listed in `problems`: `adapter-not-installed`, `credential-missing`, `credential-unreadable`, `git-unavailable`, `setup-hook-missing`; a piece that belongs to one checkout names it in `checkout`. With `git-unavailable`, its `cause` is the `GitUnavailableError` that says why. | Run each listed fix, for example `atomic install npm:@bastani/atomic-storage-libsql`, write the token file, unset offline mode or install Git, or configure a setup hook. |
| `GitUnavailableError` | `not-installed`, `unsupported-platform`, `offline`, `checksum-mismatch`, `download-failed`, `install-failed` | A checkout must be verified or restored and no Git can be started or provisioned. | Do what its hint says, for example unset `ATOMIC_OFFLINE` or install Git with the command it names. |
| `ResumeCatalogUnavailableError` | `catalog-unavailable` | The shared storage could not be reached while looking the session or run up, for example because the connection was refused or broke. Retryable. Any other storage failure, such as a missing token file, is reported as that storage error itself. | Check connectivity with `atomic storage status` and resume again. |
| `ResumeCatalogTimeoutError` | `catalog-timeout` | The shared storage did not answer the lookup within 15 seconds, for example during a network partition. `subject` is `session` or `run`. Retryable. A partition that starts later in the resume is reported when the connection gives up. | Check connectivity with `atomic storage status` and resume again. |
| `ResumeSetupHookError` | `setup-hook-failed`, `setup-hook-timed-out` | The setup hook exited with an error, was stopped, or ran too long. | Read the log named in the error, fix the hook, and resume again; the hook runs again. A session keeps the worktree it restored; a workflow run removes the worktrees its resume restored and restores them again. |
| `WorkspaceDriftError` | `tree-drift` | The recorded state cannot be rebuilt, for example because unpushed commits touch files that are never recorded (`.env`, keys), a snapshot blob is missing, or the disk is full. The message names what the restore could not do (the commits, blob, remote or full volume) and the fix. | Do what the message says; for unpushed commits, push them from the original machine, or continue there. |

Secret values never appear in these messages; they name the environment variable or file instead. The classes, their codes and the `isResume…Error` guards are exported from `@bastani/atomic`.

## Windows

Sessions and workflow runs resume on Windows as they do elsewhere. Local workers are not available on Windows, because Atomic cannot contain their tool processes there: a run with `localWorkers` fails with `SharedPoolSetupError` (code `process-containment-unavailable`) before it starts, so resume pooled runs on Linux or macOS.

## Trust

A restored worktree is a new directory, so project trust starts unset there, exactly as for a fresh clone. Until you trust it, project instructions and resources are not loaded and `.atomic/setup` does not run.
