---
title: "JSONL setup"
sidebarTitle: "Setup"
description: "Keep sessions as plain JSONL files in a directory on one machine: when to choose it, how to select it, where the files go, how several Atomic processes share it, what it doesn't do, and how to move to SQLite or PostgreSQL."
---

A JSONL store keeps each session as a plain text file in a directory you choose. Each line of the file is one JSON object. The first line describes the session, and each later line is one entry of the conversation. [Session file format](/session-format) describes every field.

## When to choose JSONL

Choose JSONL when you want your sessions as ordinary files on one machine:

- You can read, search, or compare a session with any text tool.
- You can back up or copy the directory like any other folder.
- You can delete a session by deleting its file.

Otherwise, keep the default [local SQLite](/storage/sqlite) store. To share sessions between machines, use [PostgreSQL](/storage/postgres).

A JSONL store holds sessions only. Intercom keeps using the store it would use without it.

## Select a JSONL store

Add `sessions.storage` to `~/.atomic/agent/settings.json`, or to a trusted project's `.atomic/settings.json`:

```json
{
  "sessions": {
    "storage": { "dir": "/home/me/atomic-sessions" }
  }
}
```

You can select the same store in other ways:

| Where | What to set | A relative path starts from |
| --- | --- | --- |
| Settings | `sessions.storage` set to `{ "dir": "<directory>" }` | The [storage home](/storage#storage-home) |
| Environment | `ATOMIC_SESSIONS_STORAGE='{"dir":"<directory>"}'` | The storage home |
| Environment | `ATOMIC_CODING_AGENT_SESSION_DIR=<directory>` | The current directory |
| Command line | `atomic --session-dir <directory>` | The current directory |

Use an absolute path to avoid surprises. Atomic creates the directory if it is missing. From the SDK, pass `sessionStore: { kind: "jsonl", dir }`, as [SDK session storage](/sdk/storage) shows.

Rules for these settings:

- `"dir"` works only in `sessions.storage` and `ATOMIC_SESSIONS_STORAGE`. In top-level `storage`, `--storage`, `--storage-file`, or `ATOMIC_STORAGE`, it fails with `StorageConfigError`.
- `--session-dir` can't be combined with `--session-store` or `--no-session`.
- A non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` can't be combined with `ATOMIC_SESSIONS_STORAGE`, `--storage`, or `--storage-file`. Atomic stops at startup with `StorageConfigError` (`conflicting-overrides`).

When several of these are set, the one higher in [the precedence list](/storage#selecting-storage-per-process) wins. Run `atomic storage status` in your project to see which store Atomic uses and where the choice came from.

## Where the files go

Every session file sits directly in the directory you chose:

```text
/home/me/atomic-sessions/
  2026-11-26T09-30-00-000Z_2ace5975…e788d7.jsonl
  2026-11-26T10-02-14-512Z_9f1c03ab…41d0b2.jsonl
```

A file's name is the time the session was created, with `:` and `.` replaced by `-`, then `_`, then the SHA-256 hash of the session ID in hex. Sessions from every project share the directory. The first line of each file records the project's working directory (`cwd`), which is how `/resume` finds the sessions of the current project.

Atomic can also put these next to the session files:

- **`.session.lock`.** A folder that exists only while a process writes. See [Several Atomic processes](#several-atomic-processes).
- **Backups before compaction.** Before Atomic [compacts](/compaction) a session, it saves a copy beside the file, named `<session file>.<timestamp>.<label>.bak`. Atomic never deletes these, so remove old ones yourself.
- **`tool-results/`.** Long tool output saved in files. Atomic deletes a `tool-results/` folder once its newest file is more than 30 days old.

To delete a session, delete its `.jsonl` file, or select it in `/resume`, press `Ctrl+D`, and confirm. Atomic moves the file to the trash when the `trash` command is installed.

## Several Atomic processes

Several Atomic processes on one machine can use the same directory at once:

- **One writer at a time.** Before it writes, a process takes the `.session.lock` folder in the directory, and other processes wait for it. If a process exits while it holds the lock, another process takes the lock over after about 10 seconds.
- **Grouped writes.** Saves that queue up while another save holds the lock are written together under one lock.
- **Files kept open while writing.** While a session is being written, Atomic keeps its file open between saves, and closes it 30 seconds after the last one. A process keeps at most 16 files open this way. On Windows, Atomic closes each file after it writes, because Windows won't delete or replace an open file.

Keep the directory on a local disk of one machine. Don't share it between machines through a network drive or a cloud-synced folder.

## What JSONL doesn't do

Compared with local SQLite, a JSONL store:

- **Can't be shared between machines.** Use [PostgreSQL](/storage/postgres) for that.
- **Copies forks.** In SQLite and PostgreSQL, a fork [shares its parent's history](/storage#shared-history-forks). In JSONL, a fork writes a new file with a full copy of that history, so forking a long session takes longer and uses more disk.
- **Records no worktree snapshots.** [Worktree snapshots](/worktree-snapshots) need a SQL database store.
- **Keeps subagents on this machine.** Subagents launched from a session in a JSONL store can't be [resumed on another machine](/guides/resume-on-any-machine).

## Move to SQLite or PostgreSQL

Export the sessions while the JSONL store is still selected. If you select it with `--session-dir`, set `ATOMIC_SESSIONS_STORAGE` for this one command instead, because `atomic storage export` doesn't take `--session-dir`:

```bash
ATOMIC_SESSIONS_STORAGE='{"dir":"/home/me/atomic-sessions"}' atomic storage export ~/moved
```

Then stop selecting the JSONL store. Remove `sessions.storage` from your settings, and unset `ATOMIC_SESSIONS_STORAGE` and `ATOMIC_CODING_AGENT_SESSION_DIR`.

To move the sessions into the default local SQLite store, import them:

```bash
atomic storage import ~/moved
```

To move them into PostgreSQL, [set up the database](/storage/postgres#set-up-the-database), join it, and import into it by name:

```bash
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
jq .storage ~/.atomic/agent/settings.json > new-storage.json
atomic storage import ~/moved --storage-file new-storage.json
```

Import leaves the JSONL files in place. Delete the directory once you have checked the sessions in their new store. See [Exporting and importing sessions](/storage#exporting-and-importing-sessions) for what an export holds.
