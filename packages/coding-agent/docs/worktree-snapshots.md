---
title: "Save and restore worktree snapshots"
sidebarTitle: "Worktree snapshots"
description: "How Atomic automatically saves and restores Git checkout state, excludes secrets, handles partial restores, and cleans up old worktrees."
---

Atomic automatically records the state of every Git checkout a session modifies. When you resume on another machine—or after a local checkout is deleted, reset, or moved—Atomic restores the exact repository files without touching your existing checkouts.

<Columns cols={2}>
  <Card title="Resume on any machine" href="/guides/resume-on-any-machine">
    Share a PostgreSQL store across machines and rebuild dependencies with environment blueprints.
  </Card>
  <Card title="Worktree snapshots reference" href="/worktree-snapshots/reference">
    SDK capture and restore APIs, WorkspaceError classes, 25-file environment hash list, leases, and garbage collection.
  </Card>
</Columns>

## What snapshots save and when they run

Snapshots require a Git checkout with at least one commit and a SQL database store (local SQLite by default, or shared PostgreSQL; see [Storage](/storage)). Directories outside Git repositories, JSONL directories, and in-memory sessions do not capture snapshots.

At the end of any turn that runs `bash`, `edit`, `write`, `powershell`, or an extension tool that writes files, Atomic captures the session's working directory and any checkout modified by `edit` or `write`:

- **Working tree and branch state.** Your branch, `HEAD` commit, and full working tree are captured through a private Git index so your own staging area, branch, and files are never altered.
- **Unpushed commits.** Commits reachable from `HEAD` that have not been pushed to any remote travel with the session as a compact Git bundle.
- **Incremental deltas.** Changes are stored as deduplicated binary patches in the session database (split into 1 MiB chunks automatically), restarting from `HEAD` every `snapshots.fullEvery` snapshots.
- **Dependency fingerprint.** A hash of root-level lockfiles and toolchain files lets Atomic match restored worktrees that already have the right dependencies installed. See [Environment fingerprint](/worktree-snapshots/reference#environment-fingerprint).

If `HEAD`, the working tree, and the list of excluded files have not changed since the last turn, Atomic links to the previous snapshot instead of writing a duplicate. Subagents share their parent's store and capture snapshots too. If a path cannot be read (for example due to permissions or a symlink loop), capture skips that checkout with a warning instead of failing your turn.

A restore reproduces exact Git file content rather than host-specific worktree encodings. For example, a Windows checkout using CRLF with `core.autocrlf=true` restores on Linux with identical Git file content and LF endings, accompanied by a filter notice.

## What is left out {#what-is-left-out}

<Warning>
**Built-in secret deny list (cannot be overridden).** Atomic never captures `.env*` (including `.env.example` and `.env.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `credentials`, `credentials.json`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, or private SSH key files (any extensionless `id_*` file, plus `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, `id_mldsa*`, and `id_xmss*` regardless of suffix, excluding `.pub` public keys).

These rules match **case-insensitively at any directory depth** and run before `.atomic/snapshot-ignore` and `git add -f`. You cannot re-include a denied file with `!` negation rules. If an unpushed commit modifies a denied path, the unpushed-commit bundle is omitted too.
</Warning>

Atomic also excludes:

- **Git-ignored files.** Files matched by `.gitignore`, `.git/info/exclude`, or global excludes are omitted unless staged with `git add -f` (staging overrides `.gitignore`, never the secret deny list).
- **Project snapshot excludes.** Add `.atomic/snapshot-ignore` at the repository root using `.gitignore` syntax (respects the repository's `core.ignorecase` setting).
- **Untracked and oversized files.** Untracked files when `snapshots.includeUntracked` is `false`, files larger than `snapshots.maxFileBytes` (default 5 MiB), and files or unpushed bundles exceeding `snapshots.maxSnapshotBytes` (default 50 MiB).
- **Nested repositories and submodules.** Untracked nested Git repositories are omitted. For submodules, snapshots record only the checked-out submodule commit and do not check submodules out on restore; commit and push submodule changes so they travel cleanly.

Tracked files that are ignored or denied keep their `HEAD` content in the snapshot, and any local edits to them are reported as omitted.

## Resuming and automatic restore {#resuming}

When you resume a session, Atomic checks every checkout the session recorded a snapshot for—not only its working directory—and adopts any newer capture made by a finished subagent in the same store:

| Local state on resume | What Atomic does |
| --- | --- |
| Matching local checkout (or same local checkout with your edits) | Resumes in place without touching your files |
| Original checkout is available again and no new work was saved in a restored worktree | Returns to the original checkout |
| Missing checkout, different clone, or drifted secondary checkout | Restores into `~/.atomic/agent/worktree-snapshots/worktrees/` with a one-line notice |

Secondary checkouts restore concurrently (up to 4 at a time) and never block a resume. If a secondary checkout cannot be restored, Atomic skips it with a warning and continues opening the session.

### Recovering from a partial restore {#snapshots-restored-only-partly}

A resume always opens your conversation even when a snapshot cannot be rebuilt identically (for example, because an unpushed commit touched a denied file, a remote is unreachable, or a patch conflicts). Atomic restores the closest reachable state in order:

1. The recorded `HEAD` with every patch that applies cleanly.
2. Otherwise, the closest fetchable commit (the pushed base commit, an earlier snapshot of the checkout, or the branch tip).
3. Otherwise, Atomic continues in the session's recorded directory (or the launch directory) without modifying any files.

Atomic prints a notice explaining what is missing and how to fix it (such as pushing missing commits from the original machine and resuming again). It keeps retrying the original snapshot for up to 30 days, and any edits you make in the partial worktree carry over automatically once a full restore succeeds (or are saved under `refs/atomic/degraded-work/<snapshot>` with a merge command if they conflict). See [Partial restore recovery](/worktree-snapshots/reference#partial-restore-recovery) for SDK controls.

### Restored worktrees {#restored-worktrees}

Restored worktrees live under `~/.atomic/agent/worktree-snapshots/worktrees/<repository>-<n>` and share one Git object store per repository. Checkouts that share the same repository remotes share a pool; repositories with no remotes are never pooled so ignored files cannot cross between unrelated projects.

- **Warm reuse.** When restoring, Atomic reuses a clean idle worktree of the same repository—preferring one with the same dependency fingerprint—so ignored folders like `node_modules`, `target`, or `.venv` stay intact. Excess clean idle worktrees above `snapshots.pool.maxIdlePerRepository` are removed automatically, while any worktree with unrecorded edits or excluded files (such as `.env`) is preserved.
- **Non-interactive fetches and Git LFS.** Restore fetches never hang waiting for terminal input (SSH runs in batch mode with a 15-second connect timeout; run `git ls-remote <remote>` once interactively if a host key or passphrase is needed). Missing Git LFS objects download automatically—up to **2 in parallel per session resume**—leaving unavailable files as pointers with a warning.
- **Cleanup and refs.** Atomic tracks snapshot commits under `refs/atomic/snapshots/` so `git gc` preserves them without affecting `git push`, and cleans up unused snapshot blobs automatically in the background. See [Worktree snapshots reference](/worktree-snapshots/reference) for lease rules, ref cleanup commands, and garbage collection internals.

## Inspecting snapshots {#inspecting-snapshots}

Run `/session snapshot` inside a session to inspect the latest snapshot for each checkout (branch, `HEAD`, omissions, and a `git diff --stat` when available locally), the last capture time, and the **Last resume** timing breakdown:

```text
Last resume

  restored /work/app in 18.5 s (fetch 9.9 full, materialize 1.4, LFS 6.0, verify 0.2)
  blueprint 41.9 s (npm install 8.6, Build 33.3)
  ready after 62.8 s
```

Set `ATOMIC_TIMING=1` to print the same summary to stderr when running `atomic --session <id>`.

To move a session with its snapshots as a single file, run [`/export <file>.jsonl`](/sessions#session-commands) and import it elsewhere with `--import` or `/import`. `/share` omits snapshot blobs from uploaded gists. For multi-session backups, see [Exporting and importing sessions](/storage#exporting-and-importing-sessions).

## Settings

Configure `snapshots.*` in `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `snapshots.enabled` | `true` | Capture worktree snapshots after file-writing turns |
| `snapshots.includeUntracked` | `true` | Include non-ignored untracked files |
| `snapshots.maxFileBytes` | `5242880` (5 MiB) | Largest single file captured (positive integer) |
| `snapshots.maxSnapshotBytes` | `52428800` (50 MiB) | Largest total snapshot or unpushed bundle size (positive integer) |
| `snapshots.fullEvery` | `10` | Restart patch chain from `HEAD` after this many incremental snapshots |
| `snapshots.autoCollect` | `true` | Run background snapshot garbage collection |
| `snapshots.collectIntervalSeconds` | `3600` (1 hour) | Minimum interval between automatic garbage collection runs |
| `snapshots.graceSeconds` | `3600` (1 hour) | Protect newly written blobs for this many seconds (`0` disables grace window) |
| `snapshots.pool.maxIdlePerRepository` | `2` | Maximum clean idle restored worktrees kept per repository (`0` keeps none) |

<Note>
Invalid values for the capture and collection settings (`enabled` through `graceSeconds`) fail immediately before running Git. `snapshots.pool.maxIdlePerRepository` accepts `0` or any positive integer and silently falls back to `2` if invalid.
</Note>

See [Snapshots settings](/settings#snapshots) for schema details, and [Worktree snapshots reference](/worktree-snapshots/reference) for SDK APIs, error classes, and storage internals.
