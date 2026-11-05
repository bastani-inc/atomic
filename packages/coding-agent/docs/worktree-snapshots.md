---
title: Worktree snapshots
description: Resume sessions and workflow runs on another machine with the repository state they were made against.
---

# Worktree snapshots

A session or workflow run records the state of each Git checkout it changes, so it can resume on another machine, or after a worktree was deleted or reset, with the repository content it was working on.

## What a snapshot holds

For each repository root a session or run touches, a snapshot records:

- `root`: the checkout's path on the recording machine (informational);
- `remotes`: fetch URLs of the configured remotes, with any credentials in the URL removed;
- `branch` and `head`: the current branch (or `null` when detached) and the `HEAD` commit;
- `tree`: the Git tree of the whole working copy, built through a private index, so your index, branch and files are never touched;
- a patch chain: a binary delta against `head`, then incremental deltas against earlier snapshots, restarting from `head` every `snapshots.fullEvery` snapshots or when `HEAD` moves;
- a bundle of commits reachable from `HEAD` but from no remote-tracking ref, so unpushed work travels too;
- `omitted`: what was left out and why;
- `filters`: conversion settings on the recording machine (`core.autocrlf`, `core.eol`, filter drivers such as Git LFS that `.gitattributes` names);
- `envHash`: a SHA-256 over the content of lockfiles and toolchain files at the repository root (`package-lock.json`, `Cargo.lock`, `.devcontainer/devcontainer.json`, `.nvmrc`, and similar), so you can tell when dependencies need reinstalling.

Patches and bundles are stored once, by content hash, in the same storage as the session or run (the `snapshot_blobs` table of local SQLite or a database adapter). Machines that share a database see the same blobs and need nothing else.

**What "the same tree" means:** a restore reproduces the repository content as Git stores it: the restored worktree's Git tree id equals the recorded `tree`, and every file's blob matches. It does not reproduce host-specific worktree encodings. A source checkout with `core.autocrlf=true` and CRLF files restores with LF files and the same Git content, and the restore warns about the source's conversion settings.

## When snapshots are taken

- **Sessions:** at the end of each turn that called `bash`, `edit`, `write`, `powershell`, or an extension tool that declares `writesFiles: true`. The session's directory and the directories of the files `edit` and `write` targeted are captured.
- **Workflows:** after each completed stage and each completed `ctx.tool` call, for the stage's working directory and every worktree the run binds. Pooled workers snapshot their own worktree.

A capture that finds `HEAD`, the recomputed tree, and the set of left-out files all unchanged records a reference to the previous snapshot instead of a new one. A newly left-out file, such as a new `.env.local`, records a new snapshot that lists it in `omitted`, so a restore warns about it.

When Git is not installed, or a directory is not inside a Git repository, nothing is recorded for it and behavior is exactly as without snapshots. In-memory sessions record nothing. A persisted store that cannot hold blobs (JSONL session directories, storage adapters without a database) records nothing and reports `blob-store-unsupported` once.

When a file or directory a capture has to read cannot be read, for example because of a permission error or a symbolic link that loops, that checkout's capture records nothing and reports `unreadable-path` naming the path. The turn or stage carries on. Make the path readable, or list it in `.atomic/snapshot-ignore`, to snapshot that checkout again.

## What is left out

- Files ignored by `.gitignore`, `.git/info/exclude`, or your global excludes file. Build outputs and dependencies are rebuilt, never captured.
- Paths matching `.atomic/snapshot-ignore` at the repository root (`.gitignore` syntax).
- Paths on the built-in deny list: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, extensionless `id_*` key files, `credentials`, `credentials.json`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`.
- Untracked files when `snapshots.includeUntracked` is `false`.
- Files over `snapshots.maxFileBytes`, and files beyond `snapshots.maxSnapshotBytes` in total.

Tracked files that are denied or ignored keep their `HEAD` content in the snapshot; changes you made to them are listed in `omitted`.

**Deny-list guarantee:** no deny-listed bytes are captured unless they are already in a commit reachable from a remote-tracking ref. If an unpushed commit adds or modifies a deny-listed path, the bundle of unpushed commits is left out and `omitted` names those commits and paths. Restoring that snapshot then fails until you push them. A bundle larger than `snapshots.maxSnapshotBytes` is left out the same way.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `snapshots.enabled` | boolean | `true` | Record snapshots. Set it in a project's `.atomic/settings.json` to turn them off for one repository |
| `snapshots.includeUntracked` | boolean | `true` | Capture untracked files that no ignore rule or deny pattern excludes |
| `snapshots.maxFileBytes` | number | `5242880` | Largest file captured, in bytes |
| `snapshots.maxSnapshotBytes` | number | `52428800` | Largest total of captured file content, and largest unpushed-commit bundle, in bytes |
| `snapshots.fullEvery` | number | `10` | Restart the patch chain from `HEAD` after this many snapshots |

The SDK takes the same fields as `createAgentSession({ snapshots })` and workflow `RunOpts.snapshots`; they override settings. Invalid values fail with `WorkspaceConfigError` before anything runs.

## Resuming

When a session resumes, Atomic checks every checkout the session recorded a snapshot for, not only the one that contains its working directory:

- If the tree matches and `HEAD` is the recorded commit or a descendant of it, for example after you committed the recorded edits, the session resumes in place.
- If a checkout drifted, does not exist on this machine, or is no longer a repository with commits, Atomic restores its snapshot automatically into a fresh worktree under `~/.atomic/agent/worktree-snapshots/worktrees/`, prints one line per restored checkout, and continues the session there. Your own checkout is never written to. The lines, and any restore warnings, appear at startup and after `/resume` or `/import` in the TUI, and the session records the warnings with each restore.
- If any snapshot cannot be restored (for example, its unpushed commits touched denied paths, a remote is unreachable, or a blob is missing), nothing is restored and the resume fails with `WorkspaceDriftError` (`reason: "restore-failed"`). Its message names what failed (the commits, remote, or blob), its `hint` is the fix, `restoreCode` is the failure's code, and `cause` is the typed failure. A session that refers to a snapshot it holds no record of fails with `snapshot-not-found`. In the TUI, a `/resume` or `/import` that fails this way shows the error and keeps the current session.

A working directory reached through a symbolic link is matched by the directory the link points at, because snapshot roots are Git's physical top-level directories.

Restored worktrees share one object store per repository on each host (`~/.atomic/agent/worktree-snapshots/repositories/`), so many restores of one base cost about one base plus their deltas. The session records the old-to-new root mapping (`SessionManager.getWorktreeRootMappings()`), and later resumes keep using the new root.

A checkout matches its snapshot when every file of the recorded tree has the recorded content and `HEAD` is the recorded commit; `verifyWorktree` checks exactly that, while resume also accepts a `HEAD` that descends from the recorded commit over the same tree. Unchanged recorded files are compared even when this host's excludes or size settings would leave them out; those settings only decide whether a file the snapshot never had counts as a change. A recorded file whose content changed and that is now left out, for example because it grew past `snapshots.maxFileBytes` or is listed in `.atomic/snapshot-ignore`, counts as drift. A checkout whose repository does not hold the recorded tree is treated as drifted and restored.

A restore builds the worktree under a staging directory, verifies it there, and only then moves it to its final path, so a final path never holds an unverified worktree. If the process is killed mid-restore, the staging worktree stays behind with a crash record under `~/.atomic/agent/worktree-snapshots/restores/`. The next restore or `removeRestoredWorktree` on that host removes it once the crash record's lock is stale, 30 seconds after the process stopped. A leftover that cannot be removed is reported once as the `stale-restore-retained` warning naming its path.

Snapshot records come from storage and from imported session files, so restore and verification check each record before running anything. Remotes must be URLs or paths (never a value starting with `-`, never control characters), and commits, trees, blob hashes, and the snapshot id must have the form Atomic writes. A record that does not fails with `invalid-snapshot`, which names the field but not its value. Restore fetches only over `https`, `http`, `ssh`, `git`, and local paths; Git remote helpers such as `ext::` are refused.

Restore fetches never wait for input. On Linux and macOS they run without a terminal, so an unknown host key, a passphrase, or a credential prompt fails at once as `commits-unavailable` (`reason: "not-fetched"`) instead of waiting. Unless you configured your own ssh command (`GIT_SSH_COMMAND`, `GIT_SSH`, or `core.sshCommand`), ssh runs with `BatchMode=yes` and a 15-second connect timeout. To fix such a failure, run `git ls-remote <remote>` once yourself to accept the host key or unlock the key, then resume again.

When the repository uses Git LFS, a restore downloads the LFS objects of the snapshot's files, including files edited or added since the recorded `HEAD`, from the recorded remotes, trying each in order until every LFS file has its content; a remote that is a local path is used as a `file://` URL. The download never waits for input either. A file whose object no recorded remote has stays an LFS pointer, and the `lfs-objects-unavailable` warning lists exactly those files. Push the missing objects from the recording machine (`git lfs push --all <remote>` for committed files, `git lfs push --object-id <remote> <oid>` for an uncommitted edit), then restore again.

Workflow runs follow the same rules at the point where execution resumes: each bound worktree is compared once with the last snapshot recorded for it, continues in place when only `HEAD` moved forward over the same tree, and is restored automatically into a fresh worktree when it drifted. A run, stage, or `gitWorktreeDir` path reached through a symbolic link maps to the restored worktree like the path it points at. See [Workflows operations](/workflows/operations).

## Inspecting snapshots

`/session snapshot` lists the latest snapshot of each checkout in the session (branch, `HEAD`, tree, patch chain, bundled commits, omissions, conversion settings), showing a restored checkout once, under the worktree it was restored into, and compares it with the current checkout the way resume does, so it reports a match when only `HEAD` moved forward over the recorded tree, with a `git diff --stat` when the snapshot's tree is available locally.

## Moving a session as a file

`/export session.jsonl` writes the session with the patch and bundle content of its snapshots inline, each once, and reports how much it includes. `--import session.jsonl` and `/import` check every blob against its hash and store it in the target storage before the session is saved. `/share` leaves snapshot content out of the gist.

## SDK

```typescript
import {
	captureWorktreeSnapshot,
	restoreWorktreeSnapshot,
	verifyWorktree,
	SqlSnapshotBlobStore,
	type WorkspaceBinding,
} from "@bastani/atomic";

const blobs = await SqlSnapshotBlobStore.open(database);
const capture = await captureWorktreeSnapshot(process.cwd(), { blobs });
if (capture.status === "captured" || capture.status === "unchanged") {
	const binding: WorkspaceBinding = capture.binding; // { remotes, head, tree, envHash }
	const path = await restoreWorktreeSnapshot(capture.snapshot, { blobs });
	await verifyWorktree(binding, path);
}
```

- `captureWorktreeSnapshot(dir, { settings?, previous?, blobs?, signal? })` resolves `captured`, `unchanged`, `disabled`, or `unavailable` with the typed reason (`GitUnavailableError` or `WorkspaceSnapshotError`).
- `restoreWorktreeSnapshot(bindingOrSnapshot, { into?, blobs?, snapshots?, storeDir?, onWarning?, signal? })` resolves to the path of a new, verified worktree. `into` must be a new or empty directory. A binding is restored from a matching entry of `snapshots`, or from a host whose object store already holds its tree. Restore checks the target and every blob before writing, and removes what it created when it fails. `onWarning` receives `omitted-content`, `filters`, `lfs-objects-unavailable` (LFS files left as pointers), and `stale-restore-retained` (an interrupted earlier restore that could not be cleaned up).
- `verifyWorktree(binding, dir, { settings?, signal? })` resolves to the checkout's current binding when its `HEAD` and tree match, and rejects with `WorkspaceDriftError` otherwise.
- `isHeadOnlyAdvance(driftError, signal?)` resolves `true` when a `WorkspaceDriftError` from `verifyWorktree` only moved `HEAD` forward over the recorded tree, the case resume continues in place.
- `canonicalizeWorktreePath(path)` resolves the symbolic links in the existing part of a path and keeps the rest, the form snapshot roots are compared in.
- `removeRestoredWorktree(path, { storeDir?, onWarning?, signal? })` removes a worktree a restore created, for rolling back a restore of several checkouts. It refuses any other path, including a regular file.
- `collectSnapshotGarbage(blobs, retained, { graceSeconds? })` deletes blobs that none of the retained snapshots needs, and resolves with the hashes it deleted. Retain the latest snapshot of each session (`listRetainedSessionSnapshots(sessionStore)`) and the snapshots resumable workflow runs reference (`listResumableWorkflowSnapshots(journal)` from `@bastani/atomic/workflows`). When sessions and runs share one database they share one blob table, so pass both sets together. A blob stored or stored again within `graceSeconds` (default `DEFAULT_BLOB_GRACE_SECONDS`, one hour, measured on the database's clock) is never deleted, so a collection can run while captures are in flight. Atomic does not run this collection on its own yet ([#4355](https://github.com/bastani-inc/atomic/issues/4355)).

## Errors

Every error except `GitUnavailableError` extends `WorkspaceError`; all of them carry a stable `code`, JSON-safe `fields`, a `hint`, and `retryable: false`, and every `WorkspaceError` has a `summary` (its message without the code and hint). Check the class or code, never the message. `findWorkspaceError(error, guard)` finds one in a cause chain (up to 8 levels), and `serializeWorkspaceError` / `rehydrateWorkspaceError` carry them across process boundaries with their class and fields intact.

| Class | Code | When | Fields | What to do |
|-------|------|------|--------|------------|
| `WorkspaceConfigError` | `invalid-setting` | A snapshot setting or SDK option has the wrong type or range | `source`, `field`, `expected` | Fix the named setting or option |
| `GitUnavailableError` | `not-installed` | Git could not be started | `executable`, `platform` | Install Git with the command in `hint`, or put it on `PATH` |
| `WorkspaceGitError` | `git-failed` | A Git command failed (`detail` holds its first error line, for example `No space left on device`) | `operation`, `cwd`, `exitCode`, `detail` | Check the repository is readable, its disk has free space, and no other Git process holds its lock, then retry |
| `WorkspaceSnapshotError` | `not-a-repository` | The directory is outside any Git work tree | `subject` | Work inside a Git checkout |
| `WorkspaceSnapshotError` | `unborn-head` | The repository has no commits | `subject` | Create a first commit |
| `WorkspaceSnapshotError` | `blob-store-unsupported` | The selected storage cannot hold snapshot blobs | `subject` | Select a SQLite store: `--session-store <path>` or `sessions.storage: { "path": ... }` for sessions, `workflows.journal: { "path": ... }` for workflow runs |
| `WorkspaceSnapshotError` | `unreadable-path` | A file or directory that a capture, restore or verification reads cannot be read (permissions, a looping or dangling symbolic link). A capture reports it as its `unavailable` reason; a restore or verification rejects with it | `subject` (the path); `cause` holds the filesystem error | Make the path readable, fix the link, or list it in `.gitignore` or `.atomic/snapshot-ignore` |
| `WorkspaceRestoreError` | `snapshot-not-found` | A binding has no recorded snapshot and its tree is not on this host | `head`, `tree` | Pass the recorded snapshot, or restore where the tree is warm |
| `WorkspaceRestoreError` | `blob-missing` | A patch or bundle is not in storage | `snapshotId`, `blob`, `role`, `deltaIndex` | Use the storage the snapshot was recorded in, or import an exported session file |
| `WorkspaceRestoreError` | `blob-corrupt` | A stored or imported blob does not match its hash | `snapshotId`, `blob`, `role` | Restore an earlier snapshot or re-export the session |
| `WorkspaceRestoreError` | `commits-unavailable` | `HEAD` cannot be fetched from the remotes and no usable bundle exists | `head`, `commits`, `paths`, `remotes`, `reason` (`denied-history`, `bundle-over-cap`, `not-fetched`) | Push `head` with its history to a recorded remote (with `denied-history` this publishes the denied files the named commits add), raise `snapshots.maxSnapshotBytes` and record again for `bundle-over-cap`, or check access to the named remote |
| `WorkspaceRestoreError` | `delta-failed` | A patch did not produce its recorded tree | `snapshotId`, `deltaIndex`, `blob`, `expectedTree`, `actualTree` | Restore an earlier snapshot |
| `WorkspaceRestoreError` | `tree-mismatch` | The materialized worktree's tree differs from the snapshot | `target`, `expectedTree`, `actualTree` | Check the repository's `.gitattributes` filters on this host, then retry |
| `WorkspaceRestoreError` | `unsafe-target` | `into` exists and is not an empty directory (`reason: "not-empty"`), or `removeRestoredWorktree` was given a path no restore created (`reason: "not-restored"`) | `target`, `reason` | Choose a new or empty directory, or omit `into`; remove only paths a restore returned |
| `WorkspaceRestoreError` | `unwritable-path` | A restore or `removeRestoredWorktree` could not write a directory or file it needs, for example because the disk is full or the directory is read-only | `target`, `snapshotId`; `cause` holds the filesystem error | Free space on that volume, or make the path and its parent writable, then retry |
| `WorkspaceRestoreError` | `invalid-snapshot` | A snapshot or binding record has a value Atomic never writes: a remote starting with `-` or holding control characters, or a malformed commit, tree, blob hash, or id | `snapshotId` (when the id itself is valid), `field`, `reason` (`unsafe-remote`, `invalid-object-id`, `invalid-snapshot-id`, `invalid-blob-hash`) | Restore only sessions and runs from storage you trust, or export the session again on the machine that recorded it |
| `WorkspaceDriftError` | `tree-drift` | A checkout no longer matches the snapshot work would resume from, and it could not be restored | `root`, `expectedHead`, `actualHead`, `expectedTree`, `actualTree`, `snapshotId`; with `reason: "restore-failed"`, `restoreCode` and the failure as `cause` | Follow the hint: after a failed restore it is the failure's own fix |
