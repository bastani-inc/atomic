---
title: "Operate Intercom"
sidebarTitle: "Operate Intercom"
description: "Configure Intercom connections, multi-machine routing, broker upgrades, delivery recovery, and troubleshooting."
---

This guide covers how Atomic sessions connect to Intercom, how the background broker handles restarts and upgrades, how to enable cross-machine messaging through shared storage, and how to diagnose delivery issues.

For daily messaging patterns and `contact_supervisor`, see [Coordinate sessions with Intercom](/intercom). For the complete tool schema, `config.json` keys, and exported SDK error classes, see [Intercom reference](/intercom/reference). For CLI subcommands, see [Storage and Intercom CLI commands](/reference/cli#storage-and-intercom-commands).

| What you need | Jump to |
| --- | --- |
| Share Intercom across machines or a team | [Running Intercom across machines](#running-intercom-across-machines) |
| Upgrade Atomic without dropping active sessions | [Upgrading Atomic with sessions running](#upgrading-atomic-with-sessions-running) |
| Inspect logs, local queues, or socket paths | [Local files, logs, and locks](#local-files-logs-and-locks) |
| Diagnose a disconnect, hold, or queued send | [Connection states and recovery](#connection-states-and-recovery) |

## How connection works

Interactive sessions connect to Intercom in the background 3 seconds after startup, including new, resumed, or forked sessions. Neither the initial render nor your first prompt waits for this connection. Once connected, other sessions in the same group can list and message it immediately.

In an untrusted folder, an interactive session waits until you trust the folder or send your first prompt before joining. If the broker cannot be reached at startup, the session retries silently up to 5 times (after 1, 2, 5, 10, and 30 seconds), then waits until your first Intercom use.

Non-interactive and restricted sessions connect on first use when you or the model invoke the `intercom` tool, `/intercom`, or `Alt+M`. This applies to print (`-p`), JSON, RPC, and SDK sessions, interactive sessions whose tool selection excludes `intercom`, and interactive sessions with `joinAtStartup: false` in [Intercom configuration](/intercom/reference#configuration) or `ATOMIC_INTERCOM_JOIN_AT_STARTUP=0` (or `false`; `1` or `true` turns startup join back on; legacy alias `PI_INTERCOM_JOIN_AT_STARTUP`). Any session connects immediately when it launches a subagent with Intercom so it can authorize supervisor contact.

Subagents launched with Intercom connect immediately before their first turn, regardless of `joinAtStartup`, and inherit the launching session's group unless the launch sets `group`. If subagent registration cannot reach the broker, startup waits at `registering on Intercom` and retries after 1, 2, 5, and 10 seconds, then every 30 seconds. A start past `sessionStartTimeoutMs` counts as stalled and retries once before failing ([Background launches and waiting](/subagents#background-launches-and-waiting)); if the broker itself fails to spawn, subagent startup fails immediately.

A session appears in `intercom list` and the `Alt+M` overlay only when it is connected to the broker—not every open Atomic process is listed. Internal control connections never appear as recipients or affect session counts, and connected sessions stay visible and messageable while running tools or waiting for human input.

Use `/name` to assign readable targets such as `planner` and `worker`. Unnamed sessions receive a runtime-only fallback alias (`subagent-chat-<id>`, stripping any leading `session-` prefix from the session ID) so peers can address them without overwriting the `/resume` transcript preview.

### Troubleshooting initialization

If Intercom fails to start its background client or connect to the broker, interactive sessions show a yellow warning in chat while print, JSON, and RPC sessions print a diagnostic to stderr. Atomic leaves the session usable and retries automatically on the next Intercom call.

If startup keeps failing, inspect the error message and `~/.atomic/agent/intercom/broker.log` (or the `intercom/` directory under `ATOMIC_CODING_AGENT_DIR`). Never resend a message whose delivery outcome was reported as unknown before checking with the recipient.

### Upgrading Atomic with sessions running

Sessions on one machine share a single local broker that keeps running after you install a newer Atomic release. Run `atomic intercom status` to inspect the running broker's PID, connected session count, storage match, multi-node state, and protocol version.

- **Automatic handover.** When a session on a newer Atomic version finds an older compatible broker, it asks that broker to shut down, waits up to 1 minute for exit (older Windows brokers can take around 30 seconds with active sessions), and starts the new broker. Existing sessions reconnect automatically, keep their session IDs, and continue exchanging messages.
- **When replacement fails.** If the older broker does not stop, uses a different shared storage selection, or speaks an incompatible protocol, the session leaves it running. Without multi-node storage, the session warns once and runs locally on the existing broker, failing only requests that require newer protocol features (`IntercomBrokerProtocolError`). With multi-node storage configured, the session refuses to register (`IntercomRoutingUnavailableError`) until you run `atomic intercom restart`.
- **Installer and update hook.** Installers and `atomic update` finish by running `atomic intercom upgrade`, which stops an idle older broker immediately and leaves an active one for smooth handover by the next newer session. You can run `atomic intercom upgrade` manually after `npm install -g`.

<Note>
**Upgrading from Atomic 0.10.4 or earlier on Windows.** If `npm install -g @bastani/atomic` fails with `EBUSY` on `dist\builtin\intercom`, an older broker is holding that directory open. Close running Atomic sessions, wait 5 seconds (or run `atomic intercom restart`), and re-run the install. From 0.10.5 onward, the broker runs outside the installation directory and does not block npm updates or uninstalls.
</Note>

For exported SDK broker errors (`IntercomBrokerProtocolError`, `IntercomBrokerUpgradeError`, `IntercomBrokerStopTimeoutError`, and `IntercomBrokerSuccessorTimeoutError`), see [Broker errors](/intercom/reference#broker-errors).

### Mixed versions and workflows

Because the Intercom protocol range stays backward-compatible, sessions running 0.9.x and 0.10.0+ exchange sends, asks, replies, groups, subagent messages, and multi-node traffic through whichever broker is running.

Atomic 0.10.0 removed workflows and `workflow:<rootRunId>/...` stage targets, which now return `Session not found` without queueing. If a 0.9.x workflow run is still active on a 0.10.0+ broker, each started stage registers as an ordinary session in its `workflow:<runId>` group; join that group to reach it by session ID or name.

## Broker lifecycle and crash recovery

### Lifecycle and automatic retries

The local broker starts on demand when the first session connects and exits automatically 5 seconds after its last session disconnects. Clients reconnect with backoff (1, 2, 5, 10, then 30 seconds) while keeping explicit connection errors visible.

A built-in watchdog terminates an unresponsive broker if it stops answering health checks for about a minute, allowing clients to start a replacement. A single slow request does not trigger replacement, and an OS-suspended process cannot run its own watchdog—check which process owns the broker PID before stopping a stuck broker manually.

For `send`, `ask`, and `reply`, the `intercom` tool retries recoverable disconnects internally: one initial attempt plus up to three retries (waiting 1, 2, and 5 seconds) within an 11-minute deadline. Retries reuse the same message ID, arguments, attachments, and reply thread, whereas each new tool call is a fresh operation. If startup fails before delivery begins, the tool returns `outcome: "not_sent"`; cancelling a call stops retries without undoing an already accepted delivery.

### Delivery receipts and crash recovery

`delivered` means the recipient saved the message to its session, not just received it over the socket. If a busy recipient closes or crashes before displaying a saved message, resuming that session replays unread messages once in arrival order when the sender is still connected. Messages from a sender that is gone are recorded once in full without starting a turn; if Intercom is unreachable on reopen or a relaunched subagent has not reconnected yet, recovery defers until the next reopen.

If the recipient does not confirm saving within about 8 seconds, the sender receives an uncertain-outcome failure (`outcome: "unknown"`). **Check with the recipient before sending again**, because a new tool call sends a fresh message while Intercom's own retries deduplicate by message ID. Intercom refuses new deliveries if it cannot safely track duplicates (such as on storage or capacity errors).

### Local files, logs, and locks

Configuration, logs, sockets, and durable local queues live in `~/.atomic/agent/intercom/` (or under `ATOMIC_CODING_AGENT_DIR`, falling back to `PI_CODING_AGENT_DIR`). Edit `config.json` to change [Intercom settings](/intercom/reference#configuration).

- **Logs.** Read `broker.log` when startup fails (ordinary diagnostics cap at 8 KiB per broker). The prior broker's log is saved as `broker.log.previous`, and `broker-watchdog.log` records the latest watchdog termination's time, PID, and reason.
- **Local queues and deduplication.** On first registration, the broker creates owner-only local databases:
  - `delivered-messages.sqlite` and its paired HMAC key `delivered-messages.key` track recently delivered message IDs across restarts so retries never duplicate messages.
  - `away-asks.sqlite` stores open asks waiting on closed sessions and replies held for away askers.
  - `ended-child-queue.sqlite` stores queued messages for finished or paused subagents ([Across restarts](/intercom/reference#across-restarts)).
- **Unix socket path relocation.** On Linux and macOS, if `<agentDir>/intercom/broker.sock` exceeds the OS Unix socket path length limit (107 bytes on Linux, 103 bytes on macOS and BSDs), the broker automatically binds under `$XDG_RUNTIME_DIR/atomic-intercom-<uid>/<digest>.sock` (falling back to `<tmpdir>/atomic-intercom-<uid>/<digest>.sock`) and writes the chosen path to `broker.sock.path`. That directory must be a real directory owned by your user with `0700` permissions; otherwise startup fails with `Intercom refuses the broker socket directory ...`.
- **Session teardown.** Disposing a session cancels any unstarted broker spawn and waits for a broker it already started to finish initializing before resolving. On Windows, a running broker keeps `broker.log` open until its 5-second idle exit finishes.
- **Unchecked startup locks.** If startup encounters a lock held by a process Atomic cannot inspect (for example across containers, on a shared filesystem, or owned by another user), Atomic leaves the lock untouched and logs the lock path and recovery steps after 30 seconds. Confirm no process still needs the files before removing a stale lock.

<Warning>
Never delete `delivered-messages.sqlite`, `delivered-messages.key`, `away-asks.sqlite`, or `ended-child-queue.sqlite` while troubleshooting delivery outcomes. Deleting them removes duplicate-delivery protection and drops queued messages or open asks.
</Warning>

## Subagent notifications

Intercom delivers subagent run results and activity notices from the [subagent runtime](/subagents) back to the launching session.

### Subagent control notices

By default, Atomic monitors running subagents and notifies the parent session (both in chat and over Intercom) when a subagent has no observed activity for 1 minute, fails 3 consecutive mutating tool calls, or runs actively for 4 minutes. Adjust thresholds, events, or delivery channels through `control.*` in `~/.atomic/agent/extensions/subagent/config.json` or per-call `control` options; see [Subagent `config.json` reference](/subagents/reference#subagent-config-json-reference).

Run results report each subagent's Intercom target as `Run intercom target` or `Previous intercom target` (a target may no longer be live once finished). Call `intercom({ action: "status" })` before launching subagents to verify your connection and groups. Fresh subagents launched with Intercom receive it even when an extension allowlist omits it.

### Delivery ordering

In standard interactive and background sessions, single and parallel subagent launches run without cancelling siblings. An `intercom` `ask` returns at delivery and delivers late replies as messages in the same subagent; a `contact_supervisor` decision or interview waits only inside the requesting subagent and resumes that subagent when answered. Sends and progress updates never block.

Queued messages from a subagent arrive before its completion notice. Delivery retries never rerun work or change its outcome, and messages from one sender always arrive in order whether delivered immediately or queued until idle.

## Running Intercom across machines

By default, each machine's broker serves only local sessions. With multi-node routing enabled, brokers on different machines exchange messages through a shared database—sessions still connect only to their local broker, and brokers never open network ports or connect directly to each other.

### Enable multi-node routing

Point every machine at the same [PostgreSQL](/storage/postgres) database using the same `prefix`:

<Steps>
  <Step title="Set up the PostgreSQL database once">
    Follow [Set up the database](/storage/postgres#set-up-the-database). If you use a table prefix (such as `team_`), pass the same `--prefix` to `atomic storage migrate`.
  </Step>
  <Step title="Install the adapter and join on each machine">
    Install the PostgreSQL adapter, save the runtime role's password in a temporary file, join the database, and restart the broker:

    ```bash
    atomic install npm:@bastani/atomic-storage-postgres
    (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
    atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password --prefix team_
    rm ~/atomic-db-password  # atomic storage join keeps its own copy
    atomic intercom restart
    ```
  </Step>
  <Step title="Optional: keep personal sessions local">
    `atomic storage join` sets top-level `storage`, which shares both sessions and Intercom. To share Intercom while keeping personal sessions in local SQLite (see [Set up teams and CI](/guides/team-setup)), add an empty `sessions.storage` object to `~/.atomic/agent/settings.json`:

    ```json
    { "sessions": { "storage": {} } }
    ```
  </Step>
  <Step title="Verify routing">
    Run `atomic intercom status`, `atomic storage status`, or `intercom({ action: "status" })`. Look for the `Multi-node routing:` line showing the adapter, prefix, and live peer broker count.
  </Step>
</Steps>

See [Sharing storage across hosts](/storage#sharing-storage-across-hosts) and [Storage and Intercom CLI commands](/reference/cli#storage-and-intercom-commands) for all options. Any database-backed [custom adapter](/storage/custom-adapters#selecting-an-adapter) also works when every machine uses the same `storage` setting and `prefix`, on both npm installs and standalone binaries.

The broker reads its storage selection from:

1. The launching process's `--storage`, `--storage-file`, or `ATOMIC_STORAGE` ([Selecting storage per process](/storage#selecting-storage-per-process)).
2. Otherwise, the top-level `storage` setting in `~/.atomic/agent/settings.json` (or under `ATOMIC_CODING_AGENT_DIR`).

Example `settings.json` reading the password from an environment variable:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": { "url": "postgresql://atomic_runtime@db.example.com:5432/atomic" },
    "secrets": { "password": { "env": "ATOMIC_DB_PASSWORD" } },
    "prefix": "team_"
  }
}
```

A running broker keeps the storage selection it started with until it exits, so run `atomic intercom restart` after changing `storage`. Each broker logs `Intercom multi-node routing is on (...)` or `Intercom multi-node routing is off: <reason>` to `broker.log`. Multi-node routing stays off when:

- No global or process-level `storage` is configured (project `.atomic/settings.json`, `sessions.storage`, and `ATOMIC_SESSIONS_STORAGE` never enable multi-node routing).
- Storage is in memory (`{ "memory": true }` or `{ "path": ":memory:" }`).
- The storage adapter stores only session files and exposes no shared database tables.
- The selection is invalid (such as a missing `env` secret or unloadable adapter package).

A local `path` selection shares only among brokers on the same machine—never place a local SQLite file on a network filesystem. Different `prefix` values isolate teams or tenants inside one database.

### Project groups

When multi-node routing is on, sessions without an explicit group join `project:<path>` instead of `default` so sessions in different repositories cannot accidentally message each other.

- **Git detection.** Atomic walks parent directories looking for `.git` without spawning `git`. Outside a Git repository, it uses the working directory's base name (`project:<dirname>`), so missing Git never fails outside a repository.
- **Remote URL path and casing.** Inside a Git repository, Atomic reads the `origin` remote URL (falling back to the repository directory name if `origin` is absent) and preserves all path segments (`https://gitlab.com/org/team/repo.git` becomes `project:org/team/repo`). **Casing is preserved verbatim**, so `project:Owner/Repo` and `project:owner/repo` are different groups—ensure teammates use matching remote casing or set `ATOMIC_INTERCOM_GROUP`.
- **Missing or broken Git inside a repo.** If `.git` exists but `git` is missing or fails, Intercom fails startup with `ProjectGroupError` until you install Git, fix the repository, or set `ATOMIC_INTERCOM_GROUP`.

Explicit groups take precedence over the project group: an inherited subagent group, an SDK reach policy, `ATOMIC_INTERCOM_GROUP`, or `group` in `config.json`. Joining `default` explicitly while multi-node routing is on prints a warning because every teammate on the shared database can message `default`. Running sessions keep their current group until restarted or reloaded.

Before registering, each session checks the running broker's routing mode so it never joins `default` on a multi-node broker or runs locally when it requested shared storage. If the running broker's storage differs from the session's, run `atomic intercom restart` and restart the session. For `ProjectGroupError` and `IntercomRouting*Error` classes, see [Routing and project-group errors](/intercom/reference#routing-and-project-group-errors).

### What works across machines

Sessions on remote brokers appear in `intercom list` and behave like local sessions:

- `send`, `ask`, and `reply` keep sender identity, reply threads, and save-confirmed `delivered` receipts.
- Group isolation, [return paths](/intercom/reference#answering-a-sender-outside-your-groups), supervisor routing via `contact_supervisor`, and retry deduplication work identically across machines.
- Routing holds for restoring or released subagents work across machines with the same failure codes ([Connection states and recovery](#connection-states-and-recovery)).

If a local and a remote session share the same name, lookup prefers the local session. Give sessions distinct names or address remote peers by session ID.

### Latency

On PostgreSQL, `LISTEN`/`NOTIFY` wakes the receiving broker immediately, so cross-machine messages and `delivered` receipts usually complete within a few database round trips (with a 5-second safety poll and a 30-second backup check). Behind a transaction pooler without `listenUrl`, or with a custom adapter, brokers poll every 0.5 seconds instead ([Wake-ups](/storage/postgres#wake-ups)).

Senders wait about 8 seconds for a live recipient to confirm saving; an actively saving recipient extends that window up to 2 minutes, and a claimed remote delivery gets one extra 8-second window (about 16 seconds total) before returning an uncertain outcome.

Same-machine traffic does not depend on database availability: local delivery checks shared storage for a prior cross-machine retry for at most 0.3 seconds, initial connection waits at most 5 seconds, and `intercom list` falls back to local sessions alone if remote lookup takes more than 2 seconds.

### Offline sessions

With multi-node routing on, a session that exits or crashes stays known across brokers for about 7 days. It leaves `intercom list`, but peers in its group can still message it by name, Intercom session ID, or Atomic session ID:

- Sends, asks, and replies return immediately as queued (`Message queued for <target>`, `target: "offline session"`); asks do not wait for a reply.
- Queued messages persist in the shared database and deliver in order when the same Atomic session reconnects with the same home group on any machine sharing that storage.
- Messages queued for a [released subagent](/subagents#released-subagents) wake it through its launching session (immediately on reconnect or within about 30 seconds). Paused or quit subagents wait until resumed.
- Each offline session holds up to **1,000 queued messages or 64 MiB**; messages past that limit are refused without dropping earlier ones. Messages expire undelivered after 7 days.

If a machine or broker crashes abruptly, its sessions appear connected for up to 30 seconds. Sends during that window time out with an uncertain outcome after about 8 seconds; after 30 seconds, sends queue normally and unconfirmed messages redeliver once on reconnect.

### Data and security

- **Retention.** Cross-machine messages, attachments, and sender metadata stay in shared storage until delivered, and delivered rows are pruned within about 15 minutes to prevent duplicate retries. Offline messages stay until delivered or expired after 7 days. One broker handles cleanup every 5 minutes, with another taking over within about 15 minutes if it stops.
- **Database access.** Anyone who can read the shared database can read cross-machine Intercom messages. Keep credentials in `secrets` (`{ "env": ... }` or `{ "file": ... }`) rather than plain `options`, and use project groups rather than `default`.
- **No open ports.** Intercom opens no network listeners or broker-to-broker sockets; network security matches your database's authentication and TLS configuration.

### Troubleshooting multi-node

**A remote session does not appear in `intercom list`.**

- Run `atomic storage status` on both machines to verify they share the exact `storage` selection and `prefix` and report `storage: matches the selection above`. Run `atomic intercom restart` if a broker predates a settings change.
- Run `atomic intercom status` or inspect `broker.log` for `Intercom multi-node routing is on`, `off`, or `unavailable`. Remember that a local `path` selection reaches only brokers on the same machine.
- Confirm the remote session has joined Intercom (call `intercom({ action: "status" })` once in first-use sessions) and shares a group with your session (check `origin` URL casing for `project:<path>` groups).
- If the database was briefly slow, `intercom list` falls back to local sessions after 2 seconds; retry shortly.

**A send stays queued.** The recipient is offline and will receive the message when that Atomic session reconnects with the same home group on any host sharing the database and prefix.

**The shared database is unavailable.** Same-machine sessions continue messaging normally. Sends to remote sessions fail with `Session not found on this node, and Intercom could not reach the shared storage database to look for it on other nodes. Try again once the database is available.` On startup failure, the broker logs `Intercom multi-node routing is unavailable: <reason>` and retries with exponential backoff (1s to 30s) without falling back to memory. If sends still fail after recovery, run `atomic intercom restart`.

**A cross-machine ask never gets an answer.** If the remote recipient disconnects before answering, the asker is not notified and the ask stays pending. Cancel it with `intercom({ action: "cancel", askId })` and ask again once the recipient returns.

## Connection states and recovery

Use this table to diagnose chat warnings, `/intercom` behavior, or tool responses. For underlying broker retries and crash recovery, see [Broker lifecycle and crash recovery](#broker-lifecycle-and-crash-recovery).

| State | What you see | What to do |
| --- | --- | --- |
| Not connected yet (connects on first use) | Interactive sessions join 3 seconds after startup unless startup join is off or the folder is untrusted. Print (`-p`), JSON, RPC, SDK sessions, and sessions excluding `intercom` join on first use or when launching a subagent with Intercom. Subagents join on start. | Invoke the `intercom` tool, `/intercom`, or `Alt+M` in that session; the broker starts on demand. See [How connection works](#how-connection-works). |
| Recoverable disconnect | An explicit Intercom call or overlay action fails visibly while background reconnection keeps running. | Wait for reconnect. Check the reported outcome before repeating a send, ask, or reply, and never repeat an unknown outcome automatically. |
| Reconnect backoff | The session stays disconnected between reconnect attempts. | No action needed. Retries wait 1, 2, 5, 10, then 30 seconds until connected or closed. |
| Recipient refused the message | A non-parent asker receives a correlated failed-ask message, or an inline error while waiting, instead of a reply. | Act on the refusal reason, then send again once the recipient can accept messages. |
| Broker restart or concurrent startup | Sessions disappear briefly, or several sessions start Intercom at once. | No action needed. Clients reconnect automatically, and startup locking prevents duplicate brokers. |
| Broker started by an older Atomic | After an upgrade, the first session on the newer version replaces the older broker and sessions reconnect briefly. If replacement fails, the session warns that it uses the older broker locally. | Usually nothing. If the warning appears, run `atomic intercom restart` when a brief reconnect is acceptable. See [Upgrading Atomic with sessions running](#upgrading-atomic-with-sessions-running). |
| Broker accepts connections but stops answering | List or send requests time out. | Allow about a minute for automatic watchdog replacement, then reconnect backoff. Check `broker.log` and `broker-watchdog.log` if it repeats. |
| Broker does not start | The startup or readiness error prints the broker log path and a bounded tail. | Inspect `~/.atomic/agent/intercom/broker.log` (or the Intercom directory under `ATOMIC_CODING_AGENT_DIR`). |
| Peer disconnected unexpectedly | The send returns `Session not found`; its message ID remains retryable. | Refresh the session list and retry after the target reconnects. |
| Subagent that is starting | A send or ask to a starting, resuming, or relaunching background subagent waits for registration (up to `2 × sessionStartTimeoutMs + 2 min`, capped at 1 hour; 20 seconds across nodes). If startup fails, the sender gets the failure reason. | Wait for the send to return, or run `subagent({ action: "status", id })` to inspect progress. |
| Subagent restoring after a restart | A send or ask to a restoring background subagent waits up to 20 seconds by name, Atomic session ID, or pre-restart Intercom ID, returning a retryable error if still restoring or a gone error if it did not survive. | Retry shortly if still restoring, or launch a fresh subagent if it did not survive. |
| Subagent that finished or was paused | A single-target `send` or `ask` to a completed or failed subagent returns immediately as queued and resumes it; one to a paused or quit subagent queues without resuming until continued ([Messages that resume a finished subagent](/intercom/reference#messages-that-resume-a-finished-subagent)). | Wait for the reply or result. If delivery fails later, you get one delivery failure and can resend if needed. |
| Subagent that ended or dropped off | A send or ask to a subagent that just disconnected waits up to 20 seconds for reconnection or an owner report. If not queued for resume, senders in its group get a refusal with `reasonCode` (`recipient_completed`, `recipient_failed`, `recipient_stopped`, `recipient_cancelled`, or retryable `recipient_disconnected`); other groups get `Session not found` ([Subagents with no live session](/intercom/reference#subagents-with-no-live-session)). | Ask the launching session to resume the subagent, or launch a fresh one if it was cancelled. |
| Subagent released while waiting | A send or ask to a [released subagent](/subagents#released-subagents) waits while its launching session wakes it (20 seconds default, up to 120 seconds on confirmed wake; 20 seconds across nodes). Failures report `reasonCode` (`recipient_not_restored`, `recipient_parked`, or retryable `recipient_owner_suspended`). | Retry shortly, or ask the launching session to resume it if paused or quit. See [Released subagents](/intercom/reference#released-subagents). |
| Queued for an offline session | With [multi-node routing](#running-intercom-across-machines) on, a send, ask, or reply to a recently disconnected session returns immediately as queued (`Message queued for <target>`, `target: "offline session"`). | Do not resend as a new message; the broker delivers it when that session reconnects. See [Offline sessions](#offline-sessions). |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Alt+M` | Open session list overlay |
| `↑`/`↓` | Navigate session list |
| `Enter` | Select session or send message |
| `Esc` | Cancel or close overlay |

## Limitations

- **Local broker sockets.** Each session connects to the broker on its own machine over local sockets or Windows named pipes. Cross-machine delivery requires a shared database ([Running Intercom across machines](#running-intercom-across-machines)).
- **No separate Intercom log.** Messages live in each session's history rather than a dedicated inbox file.
- **No attachment picker in the overlay.** `file`, `snippet`, and `context` attachments work through the `intercom` tool, not the `Alt+M` compose overlay.
- **Only connected sessions appear.** `intercom list` and the overlay show sessions connected to the broker, not every open Atomic process.
- **Unsaved sessions.** A session started with `--no-session` keeps received messages only in memory, so unread messages are lost on exit.
- **Subagent queues while the launching session is away.** Routing holds for starting or restoring subagents apply while the launching session is open (ending on disconnect, or after 60 seconds in non-recoverable single-run modes such as `atomic -p`). Messages to reported completed, failed, paused, or quit subagents queue durably in `ended-child-queue.sqlite` or shared storage for up to 7 days while the launching session is away; pattern sends never queue ([Run control](/subagents#run-control)).
- **Released subagent asks on a local broker.** Under multi-node routing, replies from remote machines survive broker restarts. Questions asked of a session on the subagent's own local broker live only in that broker, so a broker restart times out the ask ([Released subagents](/intercom/reference#released-subagents)).
- **Offline session queueing precedence.** Under [multi-node routing](#running-intercom-across-machines), sends to a session that disconnected within about 7 days queue for its return instead of returning `Session not found`, unless an active subagent hold or ended-subagent queue handles them first ([Offline sessions](#offline-sessions)).
