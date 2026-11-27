---
title: "JSONL storage"
sidebarTitle: "JSONL"
description: "Store Atomic sessions as plain JSONL text files in a local directory: selection options, file layout and sidecars, multi-process concurrency, limitations, and migration."
---

A JSONL store saves each session as one plain text file in a directory you choose. Every line is a JSON object: line 1 is the session header, and each subsequent line is one conversation entry. See [Session file format](/session-format) for the complete schema.

<Note>
A JSONL store holds **sessions only**. Intercom continues using its own store (local files by default, or top-level `storage` when configured).
</Note>

## When to choose JSONL

Choose JSONL when you want sessions as ordinary plain-text files on a single machine:

- Inspect, grep, or diff sessions with standard text tools.
- Copy or back up the folder like any regular directory.
- Delete individual sessions by deleting their files.

For most single-machine workflows, keep the default [local SQLite](/storage/sqlite) store (which adds worktree snapshots and zero-copy forks). To share sessions across machines, use [PostgreSQL](/storage/postgres).

## Select a JSONL store

Configure `sessions.storage` in `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json`:

```json
{
  "sessions": {
    "storage": { "dir": "/home/me/atomic-sessions" }
  }
}
```

You can also select a JSONL directory from the environment or CLI:

| Source | Setting / flag | Relative path resolves from |
| --- | --- | --- |
| Settings | `sessions.storage` set to `{ "dir": "<directory>" }` | [Storage home](/storage#storage-home) |
| Environment | `ATOMIC_SESSIONS_STORAGE='{"dir":"<directory>"}'` | [Storage home](/storage#storage-home) |
| Environment | `ATOMIC_CODING_AGENT_SESSION_DIR=<directory>` | Current working directory |
| Command line | `atomic --session-dir <directory>` | Current working directory |

Use an absolute path to avoid path-resolution surprises. Atomic creates the directory automatically if it does not exist. From the SDK, pass `sessionStore: { kind: "jsonl", dir }` (see [SDK session storage](/sdk/storage)).

Validation rules:

- `{ "dir": "..." }` is valid only in `sessions.storage` and `ATOMIC_SESSIONS_STORAGE`. Using it in top-level `storage`, `--storage`, `--storage-file`, or `ATOMIC_STORAGE` fails with `StorageConfigError`.
- `--session-dir` cannot be combined with `--session-store` or `--no-session`.
- A non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` cannot be combined with `ATOMIC_SESSIONS_STORAGE`, `--storage`, or `--storage-file` (`StorageConfigError` with reason `conflicting-overrides`).

When multiple options are set, see [Which selection wins](/storage#which-selection-wins). Run `atomic storage status` in your project directory to inspect the active store.

## Where the files go

Session files sit directly inside the directory you selected:

```text
/home/me/atomic-sessions/
  2026-11-26T09-30-00-000Z_2ace5975…e788d7.jsonl
  2026-11-26T10-02-14-512Z_9f1c03ab…41d0b2.jsonl
```

Filenames combine the creation timestamp (`:` and `.` replaced with `-`), `_`, and the hex SHA-256 hash of the session ID. Sessions from all projects share the same directory; line 1 records `cwd`, which `/resume` uses to filter sessions for the current project.

Alongside `.jsonl` files, Atomic maintains these sidecars and folders:

| Entry | Purpose |
| --- | --- |
| `<session>.jsonl.idx` | Index sidecar that accelerates reopening and history reads (verified against the `.jsonl` file on cold load). Deleting via `/resume` (`Ctrl+D`) removes it automatically; if you delete a `.jsonl` file manually, remove its `.idx` file too (orphaned `.idx` files are otherwise ignored). |
| `.atomic-chat-<sha256>` | Sidecar files storing reader-only chat metadata (such as subagent child records) outside the main conversation file. |
| `.session.lock` and `.session.lock.*` | Lock directory and striped OS advisory lock files coordinating concurrent writers. |
| `<session>.<timestamp>.<label>.bak` | Pre-[compaction](/compaction) backup saved before writing a compaction boundary. Never auto-deleted—prune old backups yourself. |
| `tool-results/` | Overflow files for long tool output. Deleted automatically once the newest file in `tool-results/` is over 30 days old. |

To delete a session, select it in `/resume` and press `Ctrl+D` (moves to trash when a `trash` command is installed), or delete its `.jsonl` and `.jsonl.idx` files directly.

## Several Atomic processes

Multiple Atomic processes on one machine can safely share the same JSONL directory at the same time:

- **Parallel across sessions, serialized per session.** Writers coordinate through operating-system advisory locks striped across 32 lock files (while also maintaining `.session.lock` for compatibility with older Atomic releases). Writes to different session files proceed concurrently, while writes to the same session file wait in order. If a writer process crashes or is killed, the OS releases its lock immediately so the next writer proceeds without waiting out a 10-second stale timeout.
- **Crash-safe grouped saves.** Saves queued behind an active write are batched together under one lock, and every save waits until its bytes are synced to disk before being acknowledged. New, forked, or replaced session files are synced before being renamed into place.
- **File handles during writes.** On Unix/macOS, Atomic keeps an active session file open between rapid saves and closes it once writes pause. On Windows, Atomic closes each file immediately after writing so other operations can delete or replace it.

<Warning>
Keep a JSONL directory on a local disk of a single machine. Do **not** share it across machines over a network drive (NFS/SMB) or cloud-synced folder.
</Warning>

## What JSONL doesn't do

Compared with local SQLite or PostgreSQL, a JSONL directory store:

- **Cannot be shared across machines.** Use [PostgreSQL](/storage/postgres) for multi-machine access.
- **Writes full copies on fork.** Unlike SQLite and PostgreSQL [shared-history forks](/storage#shared-history-forks), JSONL forks duplicate the full parent file on disk.
- **Does not record worktree snapshots.** [Worktree snapshots](/worktree-snapshots) require a SQL database store.
- **Cannot resume subagents on another machine.** Subagents launched from a JSONL store stay tied to the local machine (see [Resume on any machine](/guides/resume-on-any-machine)).

## Move to SQLite or PostgreSQL

<Steps>
  <Step title="Export your JSONL sessions">
    Run `atomic storage export` while the JSONL store is still selected. If you normally select it with `--session-dir`, pass `ATOMIC_SESSIONS_STORAGE` for this command instead (`atomic storage export` does not accept `--session-dir`):

    ```bash
    ATOMIC_SESSIONS_STORAGE='{"dir":"/home/me/atomic-sessions"}' atomic storage export ~/moved
    ```
  </Step>
  <Step title="Stop selecting the JSONL store">
    Remove `sessions.storage` from your settings, and unset `ATOMIC_SESSIONS_STORAGE` and `ATOMIC_CODING_AGENT_SESSION_DIR`.
  </Step>
  <Step title="Import into SQLite or PostgreSQL">
    **Into default local SQLite:**

    ```bash
    atomic storage import ~/moved
    ```

    **Into PostgreSQL** (after completing [Set up the database](/storage/postgres#set-up-the-database)):

    ```bash
    (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
    atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
    rm ~/atomic-db-password  # atomic storage join keeps its own copy
    jq .storage ~/.atomic/agent/settings.json > new-storage.json
    atomic storage import ~/moved --storage-file new-storage.json
    ```
  </Step>
  <Step title="Verify and clean up">
    Confirm your sessions appear in `/resume` and `atomic storage status` shows the new store. Import leaves the original JSONL files untouched—delete the directory once you verify everything migrated. See [Exporting and importing sessions](/storage#exporting-and-importing-sessions) for details.
  </Step>
</Steps>
