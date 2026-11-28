---
title: "Worktree snapshots reference"
sidebarTitle: "Worktree snapshots"
description: "Reference for worktree snapshot records, 25-file environment fingerprint, pooling, leases, repository refs, garbage collection, SDK functions, and WorkspaceError classes."
---

This reference covers the internal mechanics, SDK APIs, and typed errors behind [Worktree snapshots](/worktree-snapshots). For cross-machine setup and environment blueprints, see [Resume sessions on any machine](/guides/resume-on-any-machine).

## Snapshot record and storage

Each `worktree_snapshot` session entry (see [WorktreeSnapshotEntry](/session-format#worktreesnapshotentry)) records a JSON `WorktreeSnapshot` object:

- `root`: absolute checkout path on the recording machine (informational).
- `remotes`: configured remote fetch URLs with embedded credentials stripped.
- `branch` and `head`: active branch name (or `null` when detached) and `HEAD` commit SHA.
- `snapshot` and `tree`: local snapshot commit SHA (parented on `head`) and Git tree SHA of the working copy, built through a private Git index under `~/.atomic/agent/worktree-snapshots/capture-index/` (safe to delete; rebuilt automatically on the next capture).
- `delta` and `chain`: binary patch chain starting from a full delta against `head` and continuing with incremental deltas against previous snapshots, restarting from `head` every `snapshots.fullEvery` snapshots (default `10`) or when `HEAD` changes.
- `bundle`: optional Git bundle of commits reachable from `head` and not reachable from any remote-tracking ref.
- `omitted`: structured list of paths or unpushed commits left out of the snapshot.
- `filters`: conversion settings on the recording host (`core.autocrlf`, `core.eol`, and `.gitattributes` filter drivers such as `lfs`).
- `envHash`: SHA-256 fingerprint of root-relative lockfiles and toolchain files.

Patches and bundles are stored once by SHA-256 content hash in the database's `snapshot_blobs` table. Payloads over 1 MiB split into rows of at most 1 MiB so every SQL backend supports files up to `snapshots.maxFileBytes` (default 5 MiB).

- **Unpushed-commit omission caching.** When unpushed commits are omitted because a commit touches a deny-listed secret or the bundle exceeds `snapshots.maxSnapshotBytes` (default 50 MiB), Atomic caches that omission in memory for the running process. It re-checks and re-bundles automatically if the unpushed commit set changes (including after a push or force push), a new Atomic process starts, the repository is repacked (`git gc` or `git repack`), Git packing or attributes settings change, or `snapshots.maxSnapshotBytes` is raised above the bundle size.
- **Blob-less stores and transient failures.** A new session in a store without blob tables (JSONL directory, memory, or custom store without `snapshotBlobs`) reports `blob-store-unsupported` once; a transient database failure reports `blob-store-failed` once without failing the turn.

### Omission reasons

Every entry in `snapshot.omitted` carries a typed `reason`:

| Reason | Extra fields | Meaning |
| --- | --- | --- |
| `denied` | `path` | Matched the built-in secret deny list (cannot be overridden) |
| `snapshot-ignore` | `path` | Matched `.atomic/snapshot-ignore` |
| `untracked-excluded` | `path` | Untracked file skipped because `snapshots.includeUntracked` is `false` |
| `nested-repository` | `path` (trailing `/`) | Untracked Git repository inside the checkout |
| `submodule-changes` | `path` | Submodule with uncommitted local changes |
| `unpushed-submodule-commit` | `path` | Submodule pointing to a commit not reachable from its remotes |
| `submodule-unchecked` | `path` | Submodule inspection failed or timed out after 10 seconds |
| `over-file-cap` | `path`, `bytes` | Single file exceeded `snapshots.maxFileBytes` |
| `over-snapshot-cap` | `path`, `bytes` | Adding the file would push the snapshot past `snapshots.maxSnapshotBytes` |
| `unpushed-history-denied` | `commits`, `paths` | Unpushed commits touched deny-listed paths, so the bundle was omitted |
| `bundle-over-cap` | `commits`, `bytes` | Unpushed-commit bundle exceeded `snapshots.maxSnapshotBytes` |

### Environment fingerprint {#environment-fingerprint}

`envHash` (`computeEnvironmentHash(root)`) computes a SHA-256 digest over `"atomic-env-v1\n"` followed by each present file's path and content hash from these **25** root-relative lockfiles and toolchain files (`ENVIRONMENT_INPUT_FILES`):

`.devcontainer.json`, `.devcontainer/Dockerfile`, `.devcontainer/devcontainer.json`, `.mise.toml`, `.node-version`, `.nvmrc`, `.python-version`, `.tool-versions`, `Cargo.lock`, `Gemfile.lock`, `Pipfile.lock`, `bun.lock`, `bun.lockb`, `composer.lock`, `flake.lock`, `go.sum`, `mise.toml`, `npm-shrinkwrap.json`, `package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, `rust-toolchain`, `rust-toolchain.toml`, `uv.lock`, and `yarn.lock`.

Files outside this list (such as `requirements.txt`, `build.gradle`, and `pom.xml`) are not included in `envHash`.

## Pooling, leases, and restore internals

Restored checkouts live at pooled paths under `~/.atomic/agent/worktree-snapshots/worktrees/<repository>-<n>`, with pool metadata in `~/.atomic/agent/worktree-snapshots/pool/` and shared per-repository Git object stores in `~/.atomic/agent/worktree-snapshots/repositories/`.

Only checkouts sharing the same repository remotes share a pool. Checkouts without remotes are never pooled (so ignored files such as `node_modules` or `.env` cannot cross between unrelated projects); they restore into fresh worktrees each time, and `atomic blueprint prebuild` refuses them.

### Worktree leases

An open session keeps its worktree reserved by refreshing its lease every 10 seconds:

- **Same host.** A worktree held by a live process is never reclaimed. Linux and Windows verify both PID and process start time so reused PIDs after a reboot do not block reuse; macOS falls back to a 24-hour cap without a refresh.
- **Other hosts sharing the pool.** If a process stalls or exits abnormally on another host, the worktree remains reserved for 90 seconds after the last refresh before another host can claim or remove it.
- **Lease verification.** Before saving a snapshot or continuing in a pooled worktree, Atomic verifies the session still holds the lease. If another session claimed it meanwhile, capture skips and warns with `pooled-worktree-lost`; stop editing there and run `/resume` to open a fresh worktree.

A worktree stays associated with the session it was restored for after the session closes so resuming it again continues in the same directory. If another session claims that idle worktree later, the original session gets a fresh worktree on its next resume.

If another Atomic is still updating the pool, resume shows a waiting notice. It can continue right away if Atomic can tell the process holding the pool lock is gone. Locks from an older version or another machine still have to go 30 seconds without a refresh. This wait is separate from worktree leases: Atomic can skip a worktree that is still leased and restore into another one.

### Idle reuse, eviction, and set-aside worktrees

- **Idle reuse.** Restore reuses an idle pooled worktree that still matches its last recorded snapshot with no extra untracked or excluded files, resetting tracked files while preserving ignored directories (`node_modules`, `target`, `.venv`) and preferring worktrees with a matching `envHash`. `/session snapshot` marks reused worktrees `(claimed)`.
- **Eviction.** When clean idle worktrees for a repository exceed `snapshots.pool.maxIdlePerRepository` (default `2`, `0` keeps none; invalid values silently fall back to `2` without throwing `WorkspaceConfigError`), Atomic deletes the oldest clean idle ones. Worktrees with unrecorded edits or excluded files (such as `.env`) are never evicted.
- **Set-aside worktrees.** If Atomic is killed (`SIGKILL`) mid-blueprint build, the next resume marks that worktree set-aside under `~/.atomic/agent/worktree-snapshots/pool/set-aside/` so no session reuses it while build processes might still be running (see [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)). On Linux (`/proc`) and macOS (`lsof`), Atomic deletes set-aside pooled worktrees automatically on a later restore once no process owned by the current user holds open files or a working directory inside them. If another user's or protected process blocks checking, on Windows (where open-file inspection conservatively assumes in-use, though job objects normally terminate child processes on exit), or for non-pooled worktrees, inspect open handles (`lsof +D <path>` on Unix) and remove the directory manually.

### Object stores, SSH, LFS, and interrupted restores

- **Shared object stores.** Missing commits fetch shallowly (`--depth=1`), falling back to a full fetch when needed; run `git fetch --unshallow origin` if you need full local history. Credential-free remotes are added as `origin`, `origin-2`, and so on, and pushed commits receive refs under `refs/remotes/atomic/pushed/` so later snapshots bundle only truly unpushed commits.
- **Non-interactive fetches.** Unless `GIT_SSH_COMMAND`, `GIT_SSH`, or `core.sshCommand` is configured, SSH runs with `BatchMode=yes` and a 15-second connect timeout. Unknown host keys or locked SSH keys fail fast with `commits-unavailable` (`reason: "not-fetched"`); run `git ls-remote <remote>` once interactively and resume again.
- **Git LFS concurrency.** Restores download missing LFS objects across recorded remotes without prompting. During a session resume, at most **2** LFS downloads run in parallel **per session resume** (`LFS_DOWNLOAD_CONCURRENCY = 2`, enforced in memory per resume rather than cross-process per host). A checkout's blueprint and first prompt (or first tool call under [`resume.waitForBlueprint: "tools"`](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)) wait until its download finishes, and a second resume waits up to 10 minutes for an in-flight download. Unavailable LFS objects stay as pointer files with an `lfs-objects-unavailable` warning; push them with `git lfs push --all <remote>` or `git lfs push --object-id <remote> <oid>` and resume again.
- **Interrupted restores.** Restores stage and verify worktrees before publishing them. If a process dies mid-restore, the next restore cleans up staging records under `~/.atomic/agent/worktree-snapshots/restores/` once their lock is 30 seconds stale without deleting files it did not create. Any retained leftover emits `stale-restore-retained` once with `kind` (`"worktree"`, `"record"`, or `"records-directory"`).
- **Security checks.** Before invoking Git, Atomic validates snapshot IDs, hashes, and remotes. Unsafe values (embedded credentials, leading `-`, control characters, or Git remote helpers such as `ext::`) fail with `invalid-snapshot`.

### Partial restore recovery {#partial-restore-recovery}

Only three errors refuse a session resume: an unreadable session, `invalid-snapshot`, or `unsafe-target`. Working directories reached through symlinks compare by their resolved physical path.

When an exact restore fails with a degradable error (`blob-missing`, `blob-corrupt`, `commits-unavailable`, `delta-failed`, or `tree-mismatch`), Atomic records `restore.degraded` (or `unrestored` if no commit is reachable) on the `worktree_snapshot` entry and pins the original snapshot ID in `degradedFrom` on subsequent captures in that worktree for up to 30 days.

On a later resume:

- **Full restore succeeds with local partial-restore edits.** Atomic applies the partial-restore edits on top as a single patch, records `restore.degradedWork` with `outcome: "applied"`, shows an info notice, and captures a fresh snapshot immediately, releasing the old target.
- **Carried-over edits conflict.** Atomic leaves the restored worktree at the original snapshot, saves the conflicting edits under `refs/atomic/degraded-work/<snapshot>`, records `restore.degradedWork` with `outcome: "kept"`, retains those blobs for 30 days (or until discarded), and prints a `git diff ... | git apply --3way` command.
- **Carried-over edits are unavailable.** If edits made in the partial worktree cannot be read on this machine (for example, unpushed commits made there), Atomic records `outcome: "unavailable"`, reports them, leaves them in the partial worktree, and clears the original target.
- **Full restore still fails.** Atomic restores the partial worktree's latest snapshot so new work stays intact, warns that the original is still unreachable, and keeps retrying.

After 30 days—or immediately when you call `discardDegradedRestore()`—the partial worktree's latest snapshot becomes the active restore target and `degradedFrom` clears on the next capture.

## Snapshot refs in your repository

Every snapshot is also written as a Git commit in the checkout's repository and kept reachable at `refs/atomic/snapshots/<session-id>/<checkout>` so `git gc` and `git maintenance` do not prune it, and resume recognizes your local checkout even after further edits.

- Each new snapshot advances the ref so at most one snapshot commit stays alive per session and checkout.
- Moving work to or from a restored worktree deletes the old ref once a snapshot is captured in the new location.
- Deleting a session through `/resume` or `SessionManager.deleteSession()` deletes its local refs along with refs of its non-running subagents.

If you import a copy of a session into another store on the same machine, both copies share the same session ID and ref; deleting one copy removes the local ref for both (no files are lost, though if `git gc` later prunes that commit and the checkout drifted, resume restores into a fresh worktree).

Snapshot refs sit outside `refs/heads` and `refs/tags`, so `git push`, `git push --all`, `git push --tags`, and snapshot bundles ignore them. Avoid `git push --mirror` if you do not want to push snapshot commits.

Exclude snapshot commits from `git log --all`:

```bash
git log --exclude='refs/atomic/*' --all
```

Remove leftover local refs (for example after deleting a session on another machine or via `SessionStore.delete()`):

```bash
git for-each-ref --format='delete %(refname)' refs/atomic/snapshots/ | git update-ref --stdin
```

## Retention and garbage collection

Snapshot blobs live in one shared table per database and are garbage-collected automatically when no retained session references them:

- **Retained snapshots.** For every branch of every session (including internal subagent sessions), Atomic retains the latest snapshot of each checkout on that branch. Deleting a session releases its snapshots. A partly restored snapshot remains retained for up to 30 days. Unfinished workflow runs left from earlier releases retain their snapshots until removed.
- **Background schedule.** When `snapshots.autoCollect` is `true`, Atomic triggers collection in the background 10 seconds after an interactive or RPC session starts and 10 seconds after it closes, at most once per `snapshots.collectIntervalSeconds` per database (measured on the database clock). Collection sweeps in short batches so the UI stays responsive, aborts cleanly when the last store on the database closes, and resumes later if interrupted.
- **Grace window.** Blobs stored or reused within `snapshots.graceSeconds` (default 1 hour) are never deleted, protecting captures in progress. Reusing an earlier patch refreshes its age; if a blob is collected before its snapshot commits, Atomic retries storing it or reports `blobs-collected` without recording a broken snapshot. Raise `snapshots.graceSeconds` if `blobs-collected` repeats.
- **Failures and disk space.** Collection errors never fail an active session; they are recorded in the `snapshot_collection` table (`finished_at`, `deleted`, `error_code`) and retried after the configured interval. SQLite reuses freed pages internally without shrinking the file; run `VACUUM` while no Atomic process uses the database to reclaim disk space.

<Note>
**Older SQLite chunk-table migration (`pendingChunkMove`).** Earlier local SQLite databases stored snapshot chunks in an older table layout. When background collection skips the live table migration (for example because free disk space is low), `collectSnapshotGarbage()` reports `pendingChunkMove` so you can run the offline migration with `atomic storage move-snapshot-chunks`. Because SQLite's `ALTER TABLE RENAME` validates every view and trigger in the database, any broken custom view or trigger referencing renamed or missing tables causes the migration to fail with a hint naming the offending object—drop or fix it, then re-run. See [Moving snapshot data in an old SQLite file](/storage#moving-snapshot-data-in-an-old-sqlite-file).
</Note>

## SDK {#sdk}

Open a `SqliteDatabase` handle with `openNodeSqliteDatabase()` or `openPostgresDatabase()` (see [SDK session storage](/sdk/storage) and [SQLite storage](/storage/sqlite)), then open a `SqlSnapshotBlobStore` on that database:

```typescript
import {
  captureWorktreeSnapshot,
  restoreWorktreeSnapshot,
  verifyWorktree,
  SqlSnapshotBlobStore,
  type WorkspaceBinding,
} from "@bastani/atomic";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";

const database = await openNodeSqliteDatabase("./sessions.sqlite");
try {
  // Pass the same table prefix as your sessions when using a prefix (positional string).
  const blobs = await SqlSnapshotBlobStore.open(database, "project_");
  const capture = await captureWorktreeSnapshot(process.cwd(), { blobs });
  if (capture.status === "captured" || capture.status === "unchanged") {
    const binding: WorkspaceBinding = capture.binding; // { remotes, head, tree, envHash }
    const path = await restoreWorktreeSnapshot(capture.snapshot, { blobs });
    await verifyWorktree(binding, path);
  }
} finally {
  await database.close();
}
```

`SqlSnapshotBlobStore.open(database, prefix?)` takes `prefix` as an optional positional string (unlike `SqlSessionStore.open(database, { prefix })`, which takes an options object). `SqlSnapshotBlobStore` does not own `database` and has no `close()` method; close your caller-owned `database` in a `finally` block after snapshot operations and any running garbage collection finish.

In `createAgentSession({ snapshots })`, pass partial snapshot settings to override `settings.json` for one session.

### Capture, restore, and verification

- `captureWorktreeSnapshot(dir, { settings?, previous?, blobs?, signal? })`: resolves to `captured`, `unchanged`, `disabled`, or `unavailable` with a typed `GitUnavailableError` or `WorkspaceSnapshotError`.
- `restoreWorktreeSnapshot(bindingOrSnapshot, { into?, blobs?, snapshots?, storeDir?, onWarning?, deferLfs?, signal?, git? })`: resolves to the path of a new verified worktree (`into` must be new or empty). Checks the target and blobs before writing, cleans up on failure, emits `omitted-content`, `filters`, `lfs-objects-unavailable`, and `stale-restore-retained` warnings to `onWarning`, and optionally hands off exact-restore Git LFS pulls to `deferLfs(worktree, pull)`.
- `restoreWorktree(bindingOrSnapshot, options?)`: same as `restoreWorktreeSnapshot()`, resolving the full `RestoredWorktree` object (`{ path, snapshot, binding, warnings }`).
- `restoreDegradedWorktree(snapshot, failure, { blobs?, storeDir?, candidates?, onWarning?, signal?, git? })`: restores the closest reachable state after a degradable `WorkspaceRestoreError` accepted by `isDegradableRestoreFailure` (`blob-missing`, `blob-corrupt`, `commits-unavailable`, `delta-failed`, or `tree-mismatch`). Resolves `{ path, degraded, warnings }`.
- `restoreBestWorktree(snapshot, { blobs?, storeDir?, candidates?, signal?, git? })`: runs exact restore followed by degraded restore, resolving `{ status: "restored", path, warnings, degraded? }` or `{ status: "unrestored", reason }`. Rejects only on `invalid-snapshot`, `unsafe-target`, abort, or untyped errors. Pair with `unrestoredRecord(snapshot, reason, continuedIn, place)` to build a `WorktreeUnrestored` entry.
- `verifyWorktree(binding, dir, { settings?, signal? })`: resolves to the checkout's current binding when `HEAD` and tree match, or rejects with `WorkspaceDriftError`.
- `isHeadOnlyAdvance(driftError, signal?)`: resolves `true` when `WorkspaceDriftError` reflects only `HEAD` advancing over the same recorded tree.
- `bindingOf(snapshot)`: extracts `{ remotes, head, tree, envHash }` from a `WorktreeSnapshot`.
- `computeEnvironmentHash(root)` and `ENVIRONMENT_INPUT_FILES`: compute the 25-file `envHash` or inspect the input file list.
- `canonicalizeWorktreePath(path)` and `canonicalizeWorktreePathAsync(path)`: resolve symlinks in the existing portion of a path so paths compare consistently with snapshot roots.
- `defaultWorktreeSnapshotStoreDir(agentDir?)`: return the default host snapshot store directory (`<agentDir>/worktree-snapshots`).
- `removeRestoredWorktree(path, { storeDir?, onWarning?, signal? })`: remove a worktree created by Atomic restore (for rolling back multi-checkout restores); rejects any non-restored path with `unsafe-target`.
- `MemorySnapshotBlobStore`, `snapshotBlob(data)`, and `snapshotBlobHashes(snapshot)`: in-memory blob store (for tests or prebuild), content-hash blob helper, and blob-hash extraction.
- `resolveWorktreeSnapshotSettings(input, source, prefix, base?)`, `DEFAULT_WORKTREE_SNAPSHOT_SETTINGS`, `SNAPSHOT_DENY_PATTERNS`, `SNAPSHOT_KEY_FILE_PATTERNS`, `SNAPSHOT_IGNORE_FILE`, and `setWorktreeSnapshotGit(resolver)`: settings validation, policy constants, and custom Git executable resolution.

### Session resume and partial restores

- `openSessionInWorktree(sessionManager, { settings, storeDir?, signal?, beforeRecord?, pendingMappings?, keepInPlace?, cannotRestore?, fallbackCwd?, skipMissingRecords? })`: checks every recorded checkout and restores drifted or missing ones without running blueprints, resolving `{ sessionManager, notices, unrestored, missingRecords }`. `resumeSessionWorktree` performs the same restore without reopening the session. For standard SDK resume with blueprints, pass `sessionManager` directly to `createAgentSession({ sessionManager })` (see [Worktree snapshots in the SDK](/sdk#worktree-snapshots)).
- `discardDegradedRestore(sessionManager, { settings, root?, signal? })`: records each partly restored worktree (or only `root`) without `degradedFrom` so it becomes the active restore target and releases the original snapshot on the next collection.
- `degradedRestorePin(sessionManager, root)`: returns `{ snapshotId, since, base?, lapsed, work?, kept? }` for a checkout with an active partial-restore target, or `undefined` otherwise.
- `withWorktreeRestoreNotices(notices, work)` and `currentWorktreeRestoreNotices()`: scope `worktree_restore` system prompt notices across sessions opened inside `work`.

### Reading older snapshots on demand

Sessions opened at the default tail window load only the snapshot records needed for resume into memory. Use `sessionManager.readWorktreeSnapshotPages()` and `sessionManager.loadWorktreeSnapshotRecords()` (see [SessionManager API](/session-format#sessionmanager-api)) to inspect older snapshots on demand:

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

- `collectSnapshotGarbage(blobs, { graceSeconds?, signal? })`: deletes eligible unreferenced blobs from a `SqlSnapshotBlobStore` (default `graceSeconds` is `DEFAULT_BLOB_GRACE_SECONDS`, 1 hour) and resolves `{ deleted, pendingChunkMove? }`. Rejects non-SQL stores with `blob-store-unsupported`.
- `scheduleSnapshotCollection(blobs, settings, { onFailure?, delayMs? })`: starts background collection when `settings.autoCollect` is enabled and due (sessions pass `SNAPSHOT_COLLECTION_SESSION_DELAY_MS`, 10 seconds). Never rejects after validating settings; resolves with `collected`, `skipped`, `interrupted`, or `failed`, and does not keep an idle process alive.
- `runningSnapshotCollection(blobs)`: returns a promise settling when the current process's active collection finishes, or `undefined` if none is running.

## Errors {#errors}

Every workspace error except `GitUnavailableError` extends `WorkspaceError`. Each error carries a stable `code`, JSON-safe `fields`, a `hint`, a `summary`, and `retryable`.

- Among snapshot and restore errors below, `WorkspaceCollectionError` sets `retryable: true`; `WorkspaceConfigError`, `WorkspaceGitError`, `WorkspaceSnapshotError`, `WorkspaceRestoreError`, and `WorkspaceDriftError` set `retryable: false`.
- Across the broader `WorkspaceError` hierarchy (also used by workspace binding and pull-request publication), `WorkspaceTimeoutError` always sets `retryable: true`, and `WorkspaceBindingError` (on `writer-conflict`, `addition-in-progress`, clone/fetch/push Git failures, and retryable filesystem errnos) and `WorkspacePublicationError` (on `push-failed` and `gh-failed`) set `retryable: true` conditionally.

Always check `error.retryable` or `isRetryableWorkspaceError(error)` and branch on class or `code`, never on message text. Use `findWorkspaceError(error, guard)` to inspect cause chains up to 8 levels deep, and `serializeWorkspaceError` / `rehydrateWorkspaceError` to preserve typed errors across process boundaries.

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
| `WorkspaceRestoreError` | `path-too-long` | On Windows, a restored worktree path or Git directory exceeds Git for Windows path limits. Nothing is written. | `snapshotId`, `target`, `limit`, `agentDir` | Set `ATOMIC_CODING_AGENT_DIR` to a shorter path ([Long paths on Windows](/guides/resume-on-any-machine#long-paths-on-windows)) |
| `WorkspaceRestoreError` | `invalid-snapshot` | A snapshot record has unsafe remotes or malformed IDs or hashes | `snapshotId`, `field`, `reason` (`unsafe-remote`, `invalid-object-id`, `invalid-snapshot-id`, `invalid-blob-hash`) | Restore only trusted storage records or re-export on the recording machine |
| `WorkspaceDriftError` | `tree-drift` | A checkout drifted from its snapshot and could not be restored | `root`, `expectedHead`, `actualHead`, `expectedTree`, `actualTree`, `snapshotId`, `reason?`, `restoreCode?`, `cause?` | Follow `hint` |
| `WorkspaceCollectionError` | `collection-failed` | Database garbage collection failed (`retryable: true`; retained blobs are untouched) | `table`, `phase` (`claim`, `index`, `sweep`, `record`), `deleted`, `cause` | Check database permissions, disk space, and locks; if the hint names a broken view or trigger blocking an old SQLite chunk-table migration, fix or drop it and see [Moving snapshot data in an old SQLite file](/storage#moving-snapshot-data-in-an-old-sqlite-file) |
