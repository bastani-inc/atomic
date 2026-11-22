---
title: Worktree snapshots
description: Capture and restore Git repository state so sessions resume cleanly on any machine.
---

# Worktree snapshots

Atomic records the state of each Git checkout a session modifies. You can resume a session on another machine, or after a local checkout is deleted or reset, with the same repository files.

For cross-machine setup, shared storage, and environment blueprints, see [Resume on any machine](/guides/resume-on-any-machine).

## What a snapshot holds

For each repository root a session changes, a snapshot records:

- `root`: the checkout path on the recording machine (informational).
- `remotes`: configured remote fetch URLs with embedded credentials stripped.
- `branch` and `head`: the active branch name (or `null` when detached) and `HEAD` commit.
- `tree`: the Git tree of the working copy, built through a private index so your own index, branch, and files are untouched.
- A patch chain: a binary delta against `head`, followed by incremental deltas against earlier snapshots, restarting from `head` every `snapshots.fullEvery` snapshots or when `HEAD` changes.
- A bundle of commits reachable from `HEAD` but not from any remote-tracking ref, so unpushed commits travel with the session.
- `omitted`: paths or commits left out of the snapshot and why.
- `filters`: conversion settings on the recording host (`core.autocrlf`, `core.eol`, and `.gitattributes` filter drivers such as Git LFS).
- `envHash`: a SHA-256 hash of root lockfiles and toolchain files (`package-lock.json`, `Cargo.lock`, `.devcontainer/devcontainer.json`, `.nvmrc`, and similar) to detect when dependencies need rebuilding.

Patches and bundles are stored once by content hash in the session's database (`snapshot_blobs` table). Payloads over 1 MiB split into rows of at most 1 MiB, so every backend supports files up to `snapshots.maxFileBytes`. Machines sharing one database read the same blobs automatically.

**What "the same tree" means.** A restore reproduces the repository's Git content so the restored worktree's Git tree ID matches `tree` and every file blob matches. Host-specific worktree encodings are not copied. For example, a source checkout with `core.autocrlf=true` and CRLF files restores with LF files and identical Git content, accompanied by a filter warning.

## When snapshots are taken

Atomic captures snapshots at the end of any turn that ran `bash`, `edit`, `write`, `powershell`, or an extension tool declaring `writesFiles: true`. It captures the session's working directory along with the directories of files targeted by `edit` and `write`.

If `HEAD`, the working tree, and the omitted-file list are all unchanged, Atomic records a reference to the previous snapshot instead of creating a new one. Adding a newly omitted file, such as a new `.env.local`, writes a new snapshot listing it in `omitted` so restores warn about it.

### Unpushed-commit omission caching

When unpushed commits are left out of a snapshot (because a commit modifies a deny-listed path or the bundle exceeds `snapshots.maxSnapshotBytes`), Atomic remembers that omission per checkout for the lifetime of the running process so repeated turns do not re-bundle large unpushed histories.

Atomic re-bundles unpushed commits and re-checks them against the deny list when any of these happen:

- The list of unpushed commits changes, including after pushing commits or when a remote branch moves back (such as a force push) and exposes newly unpushed commits.
- A new Atomic process starts.
- The repository is repacked with `git gc` or `git repack`.
- Git packing settings (`core.compression`, `core.bigFileThreshold`, `pack.*`, `core.attributesFile`, or `attr.tree`) or delta-compression rules (such as `-delta` in `.gitattributes` or Git attributes files) change.
- `snapshots.maxSnapshotBytes` is raised above the bundle size.

### Subagents, storage, and capture edge cases

- **Subagent snapshots.** A subagent's session lives in its parent's store and captures snapshots of its own when backed by a database. When multiple subagents finish file-writing turns in the same checkout while a capture is already running, they share the next snapshot.
- **Private capture index.** Captures share a private Git index per checkout under `~/.atomic/agent/worktree-snapshots/capture-index/` so unchanged files are not re-read on later turns. Deleting that directory is safe; the next capture rebuilds it automatically.
- **Git and storage requirements.** Captures use Atomic's resolved Git binary (including a provisioned portable copy). Directories outside Git repositories, in-memory sessions, and stores without blob tables (such as JSONL directories or database-less adapters) record nothing. A new session in a blob-less store reports `blob-store-unsupported` once; a transient store failure reports `blob-store-failed` once without failing the turn.
- **Unreadable paths.** If a path cannot be read because of permissions or a looping symlink, capture skips that checkout and reports `unreadable-path` without failing the turn. Fix the path or add it to `.atomic/snapshot-ignore` to resume capturing.

## What is left out

Atomic excludes the following from snapshots:

- **Git-ignored files.** Files matched by `.gitignore`, `.git/info/exclude`, or global excludes are skipped unless explicitly staged with `git add -f`.
- **Project snapshot excludes.** Rules in `.atomic/snapshot-ignore` at the repository root match using `.gitignore` syntax and respect the repository's `core.ignorecase` setting.
- **Built-in secret deny list.** `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `credentials`, `credentials.json`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, plus SSH key files: any extensionless `id_*` file and any file starting with `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `id_mldsa`, or `id_xmss` regardless of suffix (such as `id_rsa.bak`), except `.pub` public keys and certificates. Other `id_*` files with extensions, such as `id_utils.ts`, are kept unless they carry a denied extension like `.pem` or `.key`.
- **Untracked and oversized files.** Untracked files when `snapshots.includeUntracked` is `false`, files larger than `snapshots.maxFileBytes`, and files pushing the snapshot past `snapshots.maxSnapshotBytes`.
- **Nested repositories.** Untracked Git repositories inside the checkout appear in `omitted` as `nested-repository`.
- **Submodule contents.** Snapshots record only each submodule's checked-out commit and do not check submodules out on restore. Uncommitted submodule changes appear as `submodule-changes`, unpushed submodule commits as `unpushed-submodule-commit`, and submodules that time out after 10 seconds as `submodule-unchecked`. Commit and push submodule work to preserve it.

Tracked files that are ignored or denied keep their `HEAD` content in the snapshot, and local edits to them are listed in `omitted`.

**Deny-list guarantee.** Deny-listed file bytes are never captured unless already reachable from a remote-tracking ref. If an unpushed commit adds or modifies a deny-listed path, the unpushed-commit bundle is omitted and `omitted` lists the commits and paths. Bundles larger than `snapshots.maxSnapshotBytes` are omitted the same way.

## Settings

Configure `snapshots.*` options in `~/.atomic/agent/settings.json` or `.atomic/settings.json`. See [Snapshots settings](/settings#snapshots) for the full table of keys and defaults (`snapshots.enabled`, `includeUntracked`, `maxFileBytes`, `maxSnapshotBytes`, `fullEvery`, `autoCollect`, `collectIntervalSeconds`, `graceSeconds`, and `pool.maxIdlePerRepository`).

In the SDK, pass `createAgentSession({ snapshots })` to override settings for one session. Invalid values fail fast with `WorkspaceConfigError` before running Git commands.

## Resuming

When you resume a session, Atomic checks every checkout the session recorded a snapshot for, not only its working directory.

If a finished subagent stored in the same session store captured a checkout later than the parent session did, Atomic adopts that newer subagent capture as the checkout's latest snapshot. Captures compare by recording timestamp, with the parent session winning ties. Partly restored checkouts keep their pinned snapshot, and named subagent worktrees stay separate.

For each checkout, Atomic applies these rules in order:

- **In-place resume.** If the tree matches and `HEAD` is the recorded commit or a descendant of it, the session resumes in place. If the active checkout changed locally since its snapshot but is still the same checkout on this machine (holding the snapshot commit, the session's [snapshot ref](#snapshot-refs-in-your-repository), or a local Atomic restore), the session continues there without overwriting your files.
- **Return to original checkout.** If an earlier resume moved the session into a restored worktree and no new work was saved there, Atomic returns to the original checkout once it is available again on this machine.
- **Automatic restore.** If another checkout drifted, or the active checkout is missing, belongs to a different clone, or has no commits, Atomic restores the snapshot into a fresh worktree under `~/.atomic/agent/worktree-snapshots/worktrees/` and prints a one-line notice. Your existing checkouts are never modified.
- **Non-blocking secondary checkouts.** A checkout outside the session's working directory never stops a resume. If it cannot be checked or restored, Atomic skips it with a warning and builds [blueprints](/guides/resume-on-any-machine) for every restored worktree.

### Degraded restores

A resume always opens the session with its full conversation. When a snapshot cannot be restored exactly (for example because unpushed commits touched denied files, a remote is unreachable, a blob is missing, or a patch fails to apply), Atomic restores the closest reachable state in order:

1. The recorded `HEAD` with every change set that applies cleanly, stopping before the first conflicting patch. If host checkout filters alter written files, Atomic keeps the worktree and lists the differing files.
2. Otherwise, the closest commit fetchable from recorded remotes: the pushed base of the unpushed bundle, then earlier snapshots of the same checkout (nearest first), then the tip of the recorded branch (or default branch when detached).
3. Otherwise, Atomic skips the restore and continues in the session's recorded directory without writing to it, or in the directory where the resume started if the recorded directory is absent. Missing Git or a missing snapshot record also ends here.

Each degraded or unrestored checkout emits one notice listing what was restored, what is missing, and how to fix it (such as pushing missing commits and resuming again). The outcome is stored on the session entry (`restore.degraded` or `unrestored`) and displayed by `/session snapshot`.

Only three errors refuse a resume: an unreadable session, a snapshot failing security validation (`invalid-snapshot`), or a non-empty restore target (`unsafe-target`). Working directories reached through symlinks are matched by their resolved physical path.

### Snapshots restored only partly

A partly restored snapshot remains the checkout's restore target for 30 days, and garbage collection keeps its blobs and patch chain until one of three events occurs: a later resume restores it completely, you release it with `discardDegradedRestore` (see [SDK](#sdk)), or 30 days pass since the partial restore.

Each turn captured in a partly restored worktree records its actual tree and links back to the original snapshot via `degradedFrom`, so partial restores never overwrite the original target.

On a later resume, Atomic tries to restore the original snapshot again:

- **Full restore succeeds.** If you edited files in the partly restored worktree, Atomic applies those edits on top as a single patch, shows an info notice, and records a new snapshot immediately. Once that new snapshot saves, the pin ends.
- **Carried-over edits conflict.** Atomic leaves the restored worktree at the original snapshot, saves your conflicting edits under `refs/atomic/degraded-work/<snapshot>`, keeps them in snapshot storage until discarded or 30 days pass, and prints a `git diff ... | git apply --3way` command so you can merge them manually.
- **Carried-over edits are unavailable.** If the partial-restore edits cannot be read on this machine (for example, unpushed commits made there), Atomic reports them, leaves them in the partial worktree, and clears the original pin.
- **Full restore still fails.** Atomic restores the partly restored worktree's latest snapshot so your new work is preserved, warns that the original is still unreachable, and keeps the pin active.

After 30 days, the next resume warns that the original snapshot is no longer retained, promotes the partial worktree's latest snapshot to the restore target, and drops `degradedFrom` on the next capture.

### Restored worktrees

Restored checkouts live at stable pooled paths under `~/.atomic/agent/worktree-snapshots/worktrees/<repository>-<n>`, with pool metadata in `~/.atomic/agent/worktree-snapshots/pool/`.

Only checkouts sharing the same repository remotes share a pool. Checkouts without remotes are never pooled so ignored files such as `node_modules` or `.env` cannot cross between unrelated projects. They restore into fresh worktrees each time, and `atomic blueprint prebuild` refuses them. Add a remote to enable pooling.

A worktree stays associated with the session it was restored for after that session closes so resuming it again continues in the same directory. If another session later takes over that worktree, the original session gets a fresh worktree on its next resume.

#### Leases and pool locks

An open session refreshes its worktree lease every 10 seconds. If a process stops refreshing (for example after sleeping or stalling), it keeps the worktree for 90 seconds after its last refresh (30 seconds until stale, plus a 60-second grace window) before another machine sharing the pool can claim or remove it.

On shared filesystems where host clocks may disagree, Atomic measures lease and lock ages against the filesystem's own clock using a short-lived probe file. On all platforms, Atomic advances the sampled filesystem time with monotonic elapsed time through probe cleanup and ignores wall-clock jumps.

On the same host, a worktree held by a still-running session process is never reclaimed. Both Linux and Windows record the holder's process start time on leases (Linux through `/proc`, Windows through the native module with a PowerShell fallback), so a reused PID after a reboot or container restart never keeps a stale worktree on either OS. Only macOS and other platforms without a process start-time reader fall back to a 24-hour cap without a refresh.

Before recording a snapshot or continuing in a pooled worktree, a session verifies it still holds the lease. If another session claimed the worktree meanwhile, Atomic skips the snapshot and warns with `pooled-worktree-lost` so you know to resume into a fresh worktree.

On Windows, pool and seed lock acquisition retries temporary `EPERM` errors for up to 10 seconds before failing. Contended pool locks wait up to 60 seconds (120 seconds when parking a seed) and respond to cancellation.

#### Idle reuse, eviction, and set-aside worktrees

When restoring a repository, Atomic reuses an idle pooled worktree if one matches its last recorded snapshot with no extra untracked or excluded files. It resets tracked files to the target snapshot while keeping ignored files such as `node_modules`, `target`, or `.venv`, prioritizing worktrees with the same `envHash`. `/session snapshot` labels a reused worktree as `(claimed)`.

When idle worktrees for one repository exceed `snapshots.pool.maxIdlePerRepository`, Atomic removes the oldest clean idle ones. Any worktree with unrecorded edits or excluded files (such as `.env`) is preserved.

If Atomic is killed mid-blueprint build, that worktree is marked set-aside under `~/.atomic/agent/worktree-snapshots/pool/set-aside/` so no session reuses it while build processes might still run (see [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)). Atomic deletes set-aside pooled worktrees on a later restore once no user process has an open file or working directory inside them (checked via `/proc` on Linux and `lsof` on macOS). When a non-dumpable process prevents verification, or for non-pooled worktrees, check with `lsof +D <path>` and delete the directory manually.

#### Shared object stores, SSH, LFS, and interrupted restores

- **Shared object stores.** Restored worktrees share one object store per repository under `~/.atomic/agent/worktree-snapshots/repositories/`. Missing commits fetch shallowly (`--depth=1`), falling back to a full fetch when needed; run `git fetch --unshallow origin` if you need full history locally. Safe credential-free remotes are added as `origin`, `origin-2`, and so on, and pushed commits get refs under `refs/remotes/atomic/pushed/` so later snapshots bundle only truly unpushed work.
- **Non-interactive fetches.** Restore fetches never wait for terminal input. Unless you set `GIT_SSH_COMMAND`, `GIT_SSH`, or `core.sshCommand`, SSH runs with `BatchMode=yes` and a 15-second connect timeout. Unknown host keys or locked SSH keys fail immediately with `commits-unavailable` (`reason: "not-fetched"`); run `git ls-remote <remote>` once interactively, then resume again.
- **Git LFS.** Restores download missing LFS objects across recorded remotes without prompting. Unavailable files stay as pointers with an `lfs-objects-unavailable` warning; push missing objects from the source machine (`git lfs push --all <remote>` or `git lfs push --object-id <remote> <oid>`), then restore again.
- **LFS download concurrency.** During session resume, at most two LFS downloads run in parallel per host. A checkout's blueprint and first prompt (or first tool call under [`resume.waitForBlueprint: "tools"`](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)) wait until its download finishes, and a second resume waits up to 10 minutes for an in-flight download.
- **Interrupted restores.** Restores stage and verify worktrees before moving them into place. If a process dies mid-restore, the next restore cleans up the staging record under `~/.atomic/agent/worktree-snapshots/restores/` once its lock is 30 seconds stale without deleting files it did not create. Any retained leftover reports `stale-restore-retained` once with `kind` (`worktree`, `record`, or `records-directory`) so you can inspect and delete it safely.
- **Snapshot security checks.** Before running Git, Atomic validates snapshot IDs, hashes, and remotes. Unsafe values (credentials, leading `-`, control characters, or Git remote helpers such as `ext::`) fail with `invalid-snapshot`.

## Inspecting snapshots

Run `/session snapshot` to see the latest snapshot of each checkout (branch, `HEAD`, tree, patch chain, bundled commits, omissions, and filter settings), along with a `git diff --stat` when the recorded tree is available locally.

It also prints how long the last turn capture took (`last capture took 0.4 s`) and a **Last resume** timing breakdown after any restore or blueprint run:

```text
Last resume

  restored /work/app in 18.5 s (fetch 9.9 full, materialize 1.4, LFS 6.0, verify 0.2)
  blueprint 41.9 s (npm install 8.6, Build 33.3)
  ready after 62.8 s
```

Each checkout line breaks down restore phases in seconds (`fetch`, `reconstruct`, `materialize`, `LFS`, `verify`, `publish`) and appends `(degraded)` for partial restores. Blueprint steps note `failed` or `timed-out` when applicable. Under [`resume.waitForBlueprint: "tools"`](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs), `ready after` measures up to worktree restore completion and the blueprint line appears once the build finishes.

Set `ATOMIC_TIMING=1` to print the same summary to stderr during `atomic --session`. Atomic also stores these numbers in a `resume_timings` entry for exports and SDK inspection.

### Moving a session as a file

`/export session.jsonl` embeds each snapshot patch and bundle inline once and reports the included size. `--import session.jsonl` and `/import` verify every blob hash and store the blobs in the target database before saving the session. `/share` omits snapshot blobs from the gist.

## Snapshot refs in your repository

Every snapshot is also a Git commit in the checkout's repository. Atomic keeps the latest snapshot commit per session and checkout reachable at `refs/atomic/snapshots/<session-id>/<checkout>` so `git gc` and `git maintenance` do not prune it, and resume can recognize your local checkout even after further edits.

- Each new snapshot advances the ref so at most one snapshot commit stays alive per session and checkout.
- Moving work to or from a restored worktree deletes the old ref once a snapshot is captured in the new location.
- Deleting a session through `/resume`, the picker, or `SessionManager.deleteSession()` deletes its local refs along with refs of its non-running subagents.

If you import a copy of a session into another store on the same machine, both copies share the same session ID and ref; deleting one copy can remove the ref used by the other. No files are lost, though if `git gc` later prunes that commit and the checkout drifted, resume restores into a fresh worktree.

Snapshot refs sit outside `refs/heads` and `refs/tags`, so `git push`, `git push --all`, `git push --tags`, and snapshot bundles ignore them. Avoid `git push --mirror` if you do not want to push snapshot commits (which contain uncommitted tracked and untracked work excluding [What is left out](#what-is-left-out)).

Snapshot commits appear in `git for-each-ref` and `git log --all` titled `Atomic worktree snapshot`. Exclude them from `git log --all` with:

```sh
git log --exclude='refs/atomic/*' --all
```

Sessions deleted on another machine or via `SessionStore.delete()` can leave local refs behind. Remove all Atomic snapshot refs in a repository with:

```sh
git for-each-ref --format='delete %(refname)' refs/atomic/snapshots/ | git update-ref --stdin
```

## Retention and collection

Snapshot blobs live in one shared table per database and are garbage-collected automatically when no retained session needs them:

- **Retained snapshots.** For every branch of every session (including internal sessions), Atomic keeps the latest snapshot of each checkout on that branch. Deleting a session releases its snapshots. A partly restored snapshot remains retained for up to 30 days (see [Snapshots restored only partly](#snapshots-restored-only-partly)). Unfinished workflow runs kept in the database from earlier releases retain their snapshots until removed.
- **Background schedule.** When `snapshots.autoCollect` is `true`, Atomic runs collection in the background 10 seconds after an interactive or RPC session starts and 10 seconds after it closes, at most once per `snapshots.collectIntervalSeconds` per database (measured on the database clock). Collection runs in short batches so the UI stays responsive, aborts cleanly when the last store on the database closes, and resumes later if interrupted.
- **Grace window.** Blobs stored or reused within `snapshots.graceSeconds` (default one hour) are never deleted, protecting captures in progress. Reusing an earlier patch resets its age; if a blob is collected before its snapshot commits, Atomic retries storing it or reports `blobs-collected` without recording a broken snapshot. Raise `snapshots.graceSeconds` if `blobs-collected` repeats.
- **Failures and disk space.** Collection errors never fail an active session; they are recorded in the `snapshot_collection` table (`finished_at`, `deleted`, `error_code`) and retried after the configured interval. SQLite reuses freed space internally without shrinking the file; run `VACUUM` while no Atomic process uses the database to reclaim disk space.

To trigger collection immediately from code, call `collectSnapshotGarbage`. If a large legacy chunk-table migration was deferred for free-space checks, the result includes `pendingChunkMove`; see [Size limits](/storage#size-limits) for the offline migration command.

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

### Capture, restore, and verification

- `captureWorktreeSnapshot(dir, { settings?, previous?, blobs?, signal? })`: resolves to `captured`, `unchanged`, `disabled`, or `unavailable` with a typed `GitUnavailableError` or `WorkspaceSnapshotError`.
- `restoreWorktreeSnapshot(bindingOrSnapshot, { into?, blobs?, snapshots?, storeDir?, onWarning?, signal?, git? })`: resolves to the path of a new verified worktree (`into` must be new or empty). Checks the target and blobs before writing, cleans up on failure, and emits `omitted-content`, `filters`, `lfs-objects-unavailable`, and `stale-restore-retained` warnings to `onWarning`.
- `restoreDegradedWorktree(snapshot, failure, { blobs?, storeDir?, candidates?, onWarning?, signal?, git? })`: restores the closest reachable state after a degradable `WorkspaceRestoreError` accepted by `isDegradableRestoreFailure` (`blob-missing`, `blob-corrupt`, `commits-unavailable`, `delta-failed`, or `tree-mismatch`). Resolves `{ path, degraded, warnings }`.
- `restoreBestWorktree(snapshot, { blobs?, storeDir?, candidates?, signal?, git? })`: runs exact restore followed by degraded restore, resolving `{ status: "restored", path, warnings, degraded? }` or `{ status: "unrestored", reason }`. Rejects only on `invalid-snapshot`, `unsafe-target`, abort, or untyped errors. Pair with `unrestoredRecord(snapshot, reason, continuedIn, place)` to build a `WorktreeUnrestored` entry.
- `verifyWorktree(binding, dir, { settings?, signal? })`: resolves to the checkout's current binding when `HEAD` and tree match, or rejects with `WorkspaceDriftError`.
- `isHeadOnlyAdvance(driftError, signal?)`: resolves `true` when `WorkspaceDriftError` reflects only `HEAD` advancing over the same recorded tree.
- `canonicalizeWorktreePath(path)`: resolves symlinks in the existing portion of a path so paths compare consistently with snapshot roots.
- `removeRestoredWorktree(path, { storeDir?, onWarning?, signal? })`: removes a worktree created by Atomic restore (for rolling back multi-checkout restores) and rejects any non-restored path with `unsafe-target`.

### Session resume and partial restores

- `openSessionInWorktree(sessionManager, { settings, storeDir?, signal?, beforeRecord?, pendingMappings?, keepInPlace?, cannotRestore?, fallbackCwd?, skipMissingRecords? })`: checks every recorded checkout and restores drifted or missing ones without running blueprints, resolving `{ sessionManager, notices, unrestored, missingRecords }`. `resumeSessionWorktree` performs the same restore without reopening the session. For standard SDK resume with blueprints, pass `sessionManager` directly to `createAgentSession({ sessionManager })`.
- `discardDegradedRestore(sessionManager, { settings, root?, signal? })`: records each partly restored worktree (or only `root`) without `degradedFrom` so it becomes the active restore target and releases the pinned snapshot on the next collection.
- `degradedRestorePin(sessionManager, root)`: returns `{ snapshotId, since, base?, lapsed, work?, kept? }` for a pinned checkout, or `undefined` when unpinned.
- `withWorktreeRestoreNotices(notices, work)` and `currentWorktreeRestoreNotices()`: scope `worktree_restore` system prompt notices across sessions opened inside `work`.

### Reading snapshots from windowed sessions

Sessions opened at the default tail window hold only the snapshot records needed for resume. Use `sessionManager.readWorktreeSnapshotPages()` and `sessionManager.loadWorktreeSnapshotRecords()` to inspect older snapshots on demand:

```typescript
const session = await SessionManager.open(store, sessionId);
const held = session.getWorktreeSnapshotRecords();
const ids: string[] = [];
for await (const page of session.readWorktreeSnapshotPages({ branch: true })) {
  for (const { entry } of page) ids.push(entry.snapshotId);
}
const records = await session.loadWorktreeSnapshotRecords(ids);
```

### Garbage collection

- `collectSnapshotGarbage(blobs, { graceSeconds?, signal? })`: deletes eligible unreferenced blobs from a `SqlSnapshotBlobStore` (default `graceSeconds` is `DEFAULT_BLOB_GRACE_SECONDS`, one hour) and resolves `{ deleted, pendingChunkMove? }`. Rejects non-SQL stores with `blob-store-unsupported`.
- `scheduleSnapshotCollection(blobs, settings, { onFailure?, delayMs? })`: starts background collection when `settings.autoCollect` is enabled and due (sessions pass `SNAPSHOT_COLLECTION_SESSION_DELAY_MS`). Never rejects after validating settings; resolves with `collected`, `skipped`, `interrupted`, or `failed`, and does not keep an idle process alive.
- `runningSnapshotCollection(blobs)`: returns a promise settling when the current process's active collection finishes, or `undefined` if none is running.

## Errors

Every workspace error except `GitUnavailableError` extends `WorkspaceError`. Each error carries a stable `code`, JSON-safe `fields`, a `hint`, a `summary`, and `retryable` (`true` only on `WorkspaceCollectionError`).

Match errors by class or `code`, never by message text. Use `isRetryableWorkspaceError(error)` and `findWorkspaceError(error, guard)` to inspect cause chains up to 8 levels deep, and `serializeWorkspaceError` / `rehydrateWorkspaceError` to pass errors across process boundaries.

| Class | Code | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `WorkspaceConfigError` | `invalid-setting` | A snapshot setting or SDK option has an invalid type or range | `source`, `field`, `expected` | Fix the named setting or option |
| `GitUnavailableError` | `not-installed`, `unsupported-platform`, `offline`, `checksum-mismatch`, `download-failed`, `install-failed` | Git could not be started or provisioned | `platform`, `arch`, `installDir`, `installCommand?`, `systemGit?` | Follow `hint` (install Git or put it on `PATH`) |
| `WorkspaceGitError` | `git-failed` | A Git command failed (`detail` holds its first error line) | `operation`, `cwd`, `exitCode`, `detail` | Check repository permissions, free disk space, and Git locks, then retry |
| `WorkspaceSnapshotError` | `not-a-repository` | The directory is outside any Git work tree | `subject` | Work inside a Git checkout |
| `WorkspaceSnapshotError` | `unborn-head` | The repository has no commits yet | `subject` | Create an initial commit |
| `WorkspaceSnapshotError` | `blob-store-unsupported` | The selected storage cannot hold snapshot blobs | `subject` | Use a SQLite or SQL database store (`--session-store` or `sessions.storage`) |
| `WorkspaceSnapshotError` | `blob-store-failed` | The session's storage was unreachable or rejected the snapshot payload | `subject`, `cause` | Restore storage access (`atomic storage status`); the next file-writing turn captures again |
| `WorkspaceSnapshotError` | `blobs-collected` | Collection deleted a capture's blobs before the snapshot recorded, and retrying failed | `subject` | Raise `snapshots.graceSeconds` |
| `WorkspaceSnapshotError` | `pooled-worktree-lost` | Another session took over the pooled worktree while this session was running | `subject` | Stop editing files there and run `/resume` to restore into a fresh worktree |
| `WorkspaceSnapshotError` | `unreadable-path` | A path needed by capture, restore, or verification cannot be read | `subject`, `cause` | Fix permissions or symlinks, or add the path to `.gitignore` or `.atomic/snapshot-ignore` |
| `WorkspaceRestoreError` | `snapshot-not-found` | A binding has no recorded snapshot and its tree is not on this host | `head`, `tree` | Pass the recorded snapshot or restore where the tree exists |
| `WorkspaceRestoreError` | `blob-missing` | A patch or bundle is missing from storage | `snapshotId`, `blob`, `role`, `deltaIndex` | Use the storage where the snapshot was recorded, or import a `.jsonl` export |
| `WorkspaceRestoreError` | `blob-corrupt` | A stored or imported blob fails its hash check | `snapshotId`, `blob`, `role` | Restore an earlier snapshot or re-export the session |
| `WorkspaceRestoreError` | `commits-unavailable` | `HEAD` cannot be fetched and no usable bundle exists | `head`, `commits`, `paths`, `remotes`, `reason` (`denied-history`, `bundle-over-cap`, `not-fetched`) | Push `head` to a recorded remote, raise `snapshots.maxSnapshotBytes` for `bundle-over-cap`, or verify remote access |
| `WorkspaceRestoreError` | `delta-failed` | A patch failed to produce its recorded tree | `snapshotId`, `deltaIndex`, `blob`, `expectedTree`, `actualTree` | Restore an earlier snapshot |
| `WorkspaceRestoreError` | `tree-mismatch` | The materialized worktree tree differs from the snapshot | `target`, `expectedTree`, `actualTree` | Check `.gitattributes` filters on this host, then retry |
| `WorkspaceRestoreError` | `unsafe-target` | `into` is non-empty (`not-empty`), or `removeRestoredWorktree` received a non-restored path (`not-restored`) | `target`, `reason` | Pass a new or empty directory, or omit `into` |
| `WorkspaceRestoreError` | `unwritable-path` | A restore or removal could not write a directory or file | `target`, `snapshotId`, `cause` | Free disk space or fix directory permissions, then retry |
| `WorkspaceRestoreError` | `invalid-snapshot` | A snapshot record has unsafe remotes or malformed IDs or hashes | `snapshotId`, `field`, `reason` (`unsafe-remote`, `invalid-object-id`, `invalid-snapshot-id`, `invalid-blob-hash`) | Restore only trusted storage records or re-export on the recording machine |
| `WorkspaceDriftError` | `tree-drift` | A checkout drifted from its snapshot and could not be restored | `root`, `expectedHead`, `actualHead`, `expectedTree`, `actualTree`, `snapshotId`, `reason?`, `restoreCode?`, `cause?` | Follow `hint` |
| `WorkspaceCollectionError` | `collection-failed` | Database garbage collection failed (`retryable: true`; retained blobs are untouched) | `table`, `phase` (`claim`, `index`, `sweep`, `record`), `deleted`, `cause` | Check database permissions, disk space, and locks; drop broken triggers or views if hinted ([Size limits](/storage#size-limits)) |
