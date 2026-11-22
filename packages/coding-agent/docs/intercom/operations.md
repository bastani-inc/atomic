---
title: Intercom operations
description: Connection states, delivery behavior, notifications, shortcuts, and recovery.
---

# Intercom operations

## Connection states and recovery

Start with the state you can observe. The sections below explain each lifecycle and delivery rule in detail.

| State | What you see | What to do |
| --- | --- | --- |
| Not connected or waiting for lazy admission | Interactive sessions join in the background a few seconds after startup, unless startup join is off or the folder is not trusted yet. Print (`-p`), JSON, RPC, SDK sessions, and sessions whose tool selection excludes `intercom` join only on first Intercom use or when launching a subagent with Intercom. Subagents launched with Intercom join as soon as their session starts. | Invoke an Intercom tool, `/intercom`, or ALT+M in that session. The broker starts on demand. See [How Connection Works](#how-connection-works). |
| Recoverable disconnect | An explicit Intercom call or overlay action fails visibly while background recovery keeps running. | Wait for reconnect. Check the reported outcome before repeating a send, ask, or reply, and never automatically repeat an unknown outcome. See [How It Works](#how-it-works). |
| Reconnect backoff | The session stays disconnected between reconnect attempts. | No action is needed to keep recovery moving. Retries wait 1, 2, 5, 10, then 30 seconds until the session connects or closes. See [How It Works](#how-it-works). |
| Destination-side admission failure | A non-parent asker receives a correlated failed-ask message, or an inline error while waiting, instead of a reply. | Act on the destination error, then send again once the recipient can accept messages. See [Subagent Notifications](#subagent-notifications). |
| Broker restart or concurrent startup | Sessions disappear briefly, or several sessions start Intercom at once. | Usually no action is needed. Clients reconnect automatically, and startup locking prevents duplicate brokers. See [How It Works](#how-it-works). |
| Broker started by an older Atomic | After an upgrade, the first session on the newer version replaces the older broker; sessions briefly reconnect. If replacement fails, the session warns that it uses the older broker locally. | Usually nothing. If the warning appears, run `atomic intercom restart` when a brief reconnect is acceptable. See [Upgrading Atomic with sessions running](#upgrading-atomic-with-sessions-running). |
| Broker accepts connections but stops answering | List or send requests time out. | Allow about a minute for automatic broker replacement, then reconnect backoff. A request timeout can add up to five seconds for a health check. Check the logs below if it repeats. See [How It Works](#how-it-works). |
| Broker does not start | The startup or readiness error prints the broker log path and a bounded tail. | Read `~/.atomic/agent/intercom/broker.log`, or the Intercom directory under `ATOMIC_CODING_AGENT_DIR`. See [How It Works](#how-it-works). |
| Half-closed peer or undeliverable send | The send returns `Session not found`; its message ID remains retryable. | Refresh the session list and retry after the target reconnects. See [How It Works](#how-it-works). |
| Subagent that is starting | A send or ask to a starting, resuming, or relaunching background subagent waits for registration instead of returning `Session not found` (up to twice `sessionStartTimeoutMs` plus 2 minutes, capped at 1 hour; 20 seconds across nodes). If startup fails, the sender gets the failure reason. | Wait for the send to return. Run `subagent({ action: "status", id })` to inspect start progress. See [How It Works](#how-it-works). |
| Subagent being restored after a restart | A send or ask to a restoring background subagent waits up to 20 seconds by name, Atomic session ID, or pre-restart Intercom ID. If it is still restoring after 20 seconds, the sender gets a retryable error; if it did not survive the restart, the sender is told it is gone. | Retry shortly if the subagent is still restoring, or launch a fresh subagent if it did not survive. See [How It Works](#how-it-works). |
| Subagent that finished or was paused | A single-target `send` or `ask` from the `intercom` tool to a completed or failed subagent returns at once as queued and resumes the subagent. One to a paused or quit subagent queues without resuming until the launching session continues it ([Messages that resume a finished subagent](/intercom/reference#messages-that-resume-a-finished-subagent)). | Wait for the reply or result. If delivery fails later, you get one delivery failure and can resend if still needed. See [How It Works](#how-it-works). |
| Subagent that ended or dropped off | A send or ask to a subagent that just disconnected waits up to 20 seconds for reconnection or an owner report. If not queued for resume, senders in its group receive a typed error (`recipient_completed`, `recipient_failed`, `recipient_stopped`, `recipient_cancelled`, or retryable `recipient_disconnected`); other groups get `Session not found` ([Subagents with no live session](/intercom/reference#subagents-with-no-live-session)). | Ask the launching session to resume the subagent, or launch a fresh subagent if it was cancelled. See [How It Works](#how-it-works). |
| Subagent released while it waits | A send or ask to a [released subagent](/subagents#released-subagents) waits while its launching session wakes it (20 seconds default, up to 120 seconds on confirmed wake; 20 seconds across nodes). Failures set `reasonCode` (`recipient_not_restored`, `recipient_parked`, or retryable `recipient_owner_suspended`). | Retry shortly, or resume the subagent if it is paused or quit. Only the launching session owns its hold ([Released subagents](/intercom/reference#released-subagents)). See [How It Works](#how-it-works). |
| Queued for an offline session | With [multi-node routing](#running-intercom-across-machines) on, a send, ask, or reply to a recently disconnected session returns at once as queued (`Message queued for <target>`, `target: "offline session"`). An ask returns without waiting. | Do not resend as a new message. The broker delivers it when that session reconnects on any host sharing the database. See [Offline sessions](#offline-sessions). |

## How Connection Works

An interactive session connects to Intercom in the background a few seconds after it starts, including new, resumed, or forked terminal sessions. Neither the initial render nor your first prompt waits for this connection. Once connected, other sessions in its group can list and message it immediately.

In an untrusted folder, an interactive session waits until you trust the folder or send the first prompt before joining. If the broker cannot be reached at startup, the session retries silently after 1, 2, 5, 10, and 30 seconds, then waits until your first Intercom use. It always registers with the same name and group it would use on first use.

Non-interactive and restricted sessions connect lazily when you or the model invoke the `intercom` tool, `/intercom`, or ALT+M. This applies to print (`-p`), JSON, RPC, and SDK sessions, as well as interactive sessions whose tool selection excludes `intercom`. An interactive session also joins lazily when `joinAtStartup` is `false` in [Intercom configuration](/intercom/reference#configuration) or when `ATOMIC_INTERCOM_JOIN_AT_STARTUP=0` is set (`1` turns startup join back on). Any session connects immediately when it launches a subagent with Intercom so it can authorize supervisor contact.

A subagent launched with Intercom connects as soon as its session starts, before its first turn, regardless of `joinAtStartup`. It inherits the launching session's group unless the launch sets `group`.

If registration cannot reach the broker, the start waits at `registering on Intercom` and retries after 1, 2, 5, and 10 seconds, then every 30 seconds. A start past `sessionStartTimeoutMs` counts as stalled and retries once before failing ([Background launches and waiting](/subagents#background-launches-and-waiting)). If the broker fails to spawn, the subagent start fails immediately with the broker's error.

A session is connected to Intercom when all of these hold:

- The bundled Intercom extension is loaded in that session.
- The local broker is running or can be started on demand.
- At least one join trigger applies: an interactive session with `intercom` enabled, startup join on, and a trusted folder or started prompt; a subagent launched with Intercom; an explicit Intercom call or overlay action; or a subagent launch that uses Intercom.

The session list and ALT+M picker display connected agent sessions, not every open Atomic process. Internal control connections never appear as recipients and do not affect session counts. Agent sessions remain visible and messageable while executing tools or waiting for human input.

Use `/name` to give sessions readable targets such as `planner` and `worker`. Unnamed sessions receive a runtime-only fallback alias like `subagent-chat-1a2b3c4d-1111-4222-8333-123456789abc` so peers can address them. That fallback alias is never saved as the session title, so `/resume` still displays the transcript preview.

### Troubleshooting initialization

`Intercom heavy initialization failed; a later call will retry: ...` means initialization failed temporarily and will retry on a later Intercom call. Interactive sessions display this as a yellow warning in chat; print, JSON, and RPC sessions print console diagnostics. Terminal relay and cleanup failures appear as error notifications in interactive sessions.

If initialization keeps failing, inspect the reported error and `~/.atomic/agent/intercom/broker.log` (or the Intercom directory under `ATOMIC_CODING_AGENT_DIR`). Never resend an operation whose delivery outcome was reported as unknown before checking with the recipient.

### Upgrading Atomic with sessions running

Sessions on one machine share one local broker, and that broker keeps running after you install a newer Atomic release. Run `atomic intercom status` to see the running broker's PID, connected session count, storage match, multi-node state, and protocol version.

- **Automatic handover.** When a session on a newer Atomic version finds an older compatible broker, it asks that broker to shut down, waits up to a minute for exit (older Windows brokers can take around 30 seconds with active sessions), and starts the new broker. Existing sessions reconnect automatically, keep their session IDs, and continue exchanging messages across versions.
- **When replacement fails.** If the older broker does not stop, uses a different shared storage selection, or speaks an incompatible protocol, the session leaves it running. Without multi-node storage, the session shows one warning and runs locally on the existing broker; requests that need newer features fail with `IntercomBrokerProtocolError`. With multi-node storage configured, the session refuses to register with `IntercomRoutingUnavailableError` because it cannot verify cross-machine routing. Run `atomic intercom restart` to replace the broker in either case.
- **Installer and update hook.** Installers and `atomic update` finish by running `atomic intercom upgrade`. It stops an older broker immediately when no sessions are connected, and leaves an active broker for the next newer session to hand over safely. You can run `atomic intercom upgrade` manually at any time (for example after `npm install -g`).

For SDK error classes (`IntercomBrokerProtocolError`, `IntercomBrokerUpgradeError`, and `IntercomBrokerStopTimeoutError`) and their type guards, see [Broker errors](/intercom/reference#broker-errors).

### Mixed versions and workflows

Atomic 0.10.0 removed workflows along with `workflow:<rootRunId>/...` stage targets and stage routes. Because the Intercom protocol range remains compatible, sessions running 0.9.x and 0.10.0+ continue exchanging sends, asks, replies, groups, subagent messages, and multi-node traffic through whichever broker is running.

Messages sent to a `workflow:<rootRunId>/...` target are not queued for unstarted stages and return `Session not found`. If a 0.9.x workflow run is still active on a 0.10.0+ broker, each started stage registers as an ordinary session in its `workflow:<runId>` group; join that group to reach the stage by its session ID or name.

## How It Works

### Broker lifecycle and retries

The local broker starts on demand when the first session connects and exits after 5 seconds with no registered sessions. Clients reconnect automatically after 1, 2, 5, 10, and then 30 seconds while keeping explicit connection errors visible.

A built-in watchdog terminates an unresponsive broker if it stops answering health checks for about a minute, allowing clients to spawn a replacement. A single slow request does not trigger replacement, and an OS-suspended process cannot run its own watchdog. If a broker remains stuck, verify which process owns it before stopping it manually.

For `send`, `ask`, and `reply`, the `intercom` tool manages reconnect recovery internally. Each call makes one initial attempt plus up to three retries (waiting 1, 2, and 5 seconds) within an 11-minute operation deadline. Retries preserve the message ID, arguments, attachments, and reply thread. Caller-supplied `retryToken` arguments are rejected without sending; each new tool call is a fresh operation.

If initialization fails before delivery starts, the tool returns `outcome: "not_sent"`. Only recoverable disconnects trigger retries; unrelated errors stop immediately. Cancelling a call stops further retries without undoing an already accepted delivery.

### Delivery receipts and crash recovery

`delivered` means the recipient saved the message to its session, not just received it on the socket. If a busy recipient closes or crashes before showing a saved message, resuming that session displays unread messages once in arrival order when the sender is still connected.

Messages from a sender that is gone are recorded once in full without starting a turn. If Intercom is unreachable on reopen, or the sender is a relaunched subagent that has not reconnected yet, recovery defers the decision until the next reopen.

If the recipient does not confirm the save within about 8 seconds, the sender receives an uncertain-outcome failure (`outcome: "unknown"`). **Check with the recipient before sending again.** A new tool call creates a fresh message, whereas Intercom's own retries reuse the original message ID so a recipient never displays a saved message twice.

Intercom refuses new deliveries when it cannot safely track duplicates (such as storage or capacity failures). Do not delete Intercom database files to force a resend when an outcome is unknown.

Custom SDK hosts can optionally pass `recipientPurpose` (`"agent"` or `"control"`) when registering a session; omitting it defaults to `"agent"`. Invalid values are rejected, and a session's purpose cannot change after registration.

### Local files, logs, and locks

Configuration, logs, and local queues live in `~/.atomic/agent/intercom/` (or under `ATOMIC_CODING_AGENT_DIR`, falling back to `PI_CODING_AGENT_DIR`). Edit `config.json` to change [Intercom settings](/intercom/reference#configuration).

- **Logs.** Read `broker.log` when startup fails; ordinary diagnostics are capped at 8 KiB per broker. The previous broker's log is kept in `broker.log.previous`, and `broker-watchdog.log` records the latest watchdog termination's time, PID, and reason. Keep these files when reporting stalls.
- **Local queues and deduplication.** `delivered-messages.sqlite` tracks recently delivered message IDs across restarts, and `ended-child-queue.sqlite` stores queued messages for finished or paused subagents ([Across restarts](/intercom/reference#across-restarts)). Both are created when the first session registers. Do not delete them while troubleshooting delivery outcomes.
- **Session teardown.** Disposing a session cancels any unstarted broker spawn and waits for a broker it already launched to finish starting. Once `dispose()` resolves, the session makes no further writes to the agent directory. On Windows, a running broker keeps `broker.log` open until it exits about 5 seconds after its last session disconnects.
- **Unchecked startup locks.** If startup encounters a lock held by a process Atomic cannot inspect (for example on a shared filesystem, across containers, or owned by another user), Atomic leaves the lock untouched. After 30 seconds it logs the lock path and recovery steps. Confirm that no process on any host sharing the directory still needs the files before removing them, and never remove the SQLite database files.

## Subagent Notifications

Intercom delivers subagent results and control notices from the [subagent runtime](/subagents) back to the launching session.

### Subagent control notices

The `subagent` tool's `control` options choose which activity notices reach the parent and over which channels:

- **`notifyOn`.** Defaults to `["active_long_running", "needs_attention"]`.
- **`notifyChannels`.** Defaults to `["event", "intercom"]`.

Run results report each subagent's Intercom target as `Run intercom target` or `Previous intercom target`; a target may no longer be live after completion. Call `intercom({ action: "status" })` before launching subagents if you want to verify your connection and group memberships.

Subagents launched with Intercom connect before their first turn and inherit the launching session's group unless the launch sets `group`. Fresh subagents still receive Intercom even when an extension allowlist omits it.

### Delivery ordering

In normal task-host runs, both single-child and parallel launches run in the background without cancelling siblings. An `intercom` `ask` returns at delivery and delivers its reply later as a message in the same child. A `contact_supervisor` decision or interview waits only in the requesting child and continues that same execution when answered. Sends and progress updates are non-blocking.

Only a direct single-child launch in an SDK session without a task host retains the terminal `[TASK_CONTEXT]` fresh-child handoff when a blocking parent request is claimed.

Queued messages from a child arrive before its completion notice. Delivery retries never rerun work or alter its outcome. Messages from one sender arrive in order whether admitted immediately or queued until the recipient is idle.

## Running Intercom across machines

By default, each machine's broker serves only sessions on that machine. With multi-node routing enabled, brokers on different machines read and write a shared storage database to exchange messages. Sessions still connect only to their local broker, and brokers never open network ports or connect directly to each other.

### Turning it on

For a team, run `atomic team join <url> --token-file <path>` to configure the team database for Intercom while keeping session transcripts local and restarting the broker. CI runners use `ATOMIC_PROFILE=ci` instead. See [Team and CI setup](/guides/team-setup).

To configure multi-node routing manually, give every machine the same top-level `storage` selection and `prefix`, using a [storage adapter](/storage#selecting-an-adapter) that implements `openDatabase` and connects to a shared database ([Sharing storage across hosts](/storage#sharing-storage-across-hosts)). Install the adapter on every machine, for example as an [Atomic package](/storage#adapters-from-atomic-packages). Both npm installations and standalone binaries support multi-node routing.

The broker reads its storage selection from:

1. Process overrides on the Atomic process that spawns the broker: `--storage`, `--storage-file`, `ATOMIC_STORAGE`, or `ATOMIC_PROFILE=ci` ([Selecting storage per process](/storage#selecting-storage-per-process)).
2. Otherwise, the top-level `storage` block in `~/.atomic/agent/settings.json` (or under `ATOMIC_CODING_AGENT_DIR`).

```json
{
  "storage": {
    "adapter": "@example/atomic-sqlite",
    "options": { "url": "libsql://team.example" },
    "secrets": { "authToken": { "env": "TEAM_DB_TOKEN" } },
    "prefix": "team_"
  }
}
```

A running broker keeps the storage selection it started with until it exits. After changing `storage`, run `atomic intercom restart` so sessions reconnect and start a broker using the new selection. Check state with `atomic intercom status`, `atomic storage status` ([Checking the selected storage](/storage#checking-the-selected-storage)), or `intercom({ action: "status" })`, which prints a `Multi-node routing:` line showing the adapter, prefix, and live peer broker count.

Each broker logs `Intercom multi-node routing is on (adapter <adapter>, prefix <prefix>)` or `Intercom multi-node routing is off: <reason>` to `broker.log`. Multi-node routing stays off when:

- No global or process-level `storage` is configured (project `.atomic/settings.json`, `sessions.storage`, and `ATOMIC_SESSIONS_STORAGE` do not enable multi-node routing).
- Storage is in memory (`{ "memory": true }` or `{ "path": ":memory:" }`).
- The adapter implements only `openSessionStore` without `openDatabase`.
- The selection is invalid (such as a missing `env` secret or an unloadable adapter package).

A local `path` selection shares only among brokers on the same machine opening the same file. Never place a local SQLite file on a network filesystem. Brokers using different `prefix` values cannot see each other's sessions, allowing one database to isolate separate teams or tenants.

### Project groups

When multi-node routing is on, sessions without an explicit group join `project:<owner>/<repo>` instead of `default`. The name comes from the repository's `origin` remote, falling back to the repository directory name when there is no `origin`, or the working directory name outside Git. This prevents sessions from different repositories on a shared database from accidentally messaging each other.

Explicit groups still take precedence: an inherited subagent group, an SDK host policy, `ATOMIC_INTERCOM_GROUP`, or `group` in `config.json`. Joining `default` explicitly while multi-node routing is on prints a warning (in the UI or once on stderr for non-interactive runs) because every teammate sharing the database can message `default`. Running sessions keep their current group until restarted or reloaded.

Inside a Git repository, Intercom runs `git` to inspect `origin`. If Git is missing or fails, Intercom fails startup with `ProjectGroupError` until you install Git, fix the repository error, or set `ATOMIC_INTERCOM_GROUP` to bypass the lookup.

Before registering, each session verifies the running broker's routing mode so a session never accidentally joins `default` on a multi-node broker or runs locally when shared storage was requested. If the running broker's storage disagrees with the session (for example after switching `storage` or `ATOMIC_PROFILE=ci`), run `atomic intercom restart` and restart the session. For `ProjectGroupError` and the `IntercomRouting*Error` classes (`IntercomRoutingMismatchError`, `IntercomRoutingUnavailableError`, `IntercomRoutingTimeoutError`, `IntercomRoutingChangedError`), see [Routing and project-group errors](/intercom/reference#routing-and-project-group-errors).

### What works across machines

Sessions connected to brokers on other machines appear in `intercom list` and behave like local sessions:

- `send`, `ask`, and `reply` keep sender identity, reply threads, and save-confirmed `delivered` receipts.
- Group isolation and [return paths](/intercom/reference#answering-a-sender-outside-your-groups) enforce the same rules across machines.
- Supervisor traffic from `contact_supervisor` preserves supervisor routing.
- Holds for restoring or released subagents work across machines with the same error codes ([Connection states and recovery](#connection-states-and-recovery)).
- Retry deduplication prevents duplicate delivery across nodes.

If a local session and a remote session share the same name, name lookup prefers the local session. Use distinct session names or address remote peers by session ID.

### Latency

Brokers poll the shared database for wake-ups every 0.5 seconds, so cross-machine messages typically arrive within half a second plus database round trips, with `delivered` confirmation taking a similar round trip. A backup poll every 30 seconds recovers missed wake-ups.

A sender waits about 8 seconds for a live recipient to confirm saving a message. A recipient actively saving reports progress to extend that wait up to 2 minutes, and a claimed remote delivery gets one extra 8-second window (about 16 seconds total) before reporting an uncertain outcome. The message is still delivered once; check with the recipient before resending.

Same-machine traffic does not depend on database availability. Local delivery checks the shared database for a prior cross-machine retry for at most 0.3 seconds. Initial connection waits at most 5 seconds for the database, and `intercom list` waits at most 2 seconds for remote sessions before returning local sessions alone.

### Offline sessions

With multi-node routing on, a session that exits or crashes stays known to all brokers for about 7 days. It leaves `intercom list`, but peers in its group can still message it by name, Intercom session ID, or Atomic session ID:

- Sends, asks, and replies return at once as queued (`Message queued for <target>`, `target: "offline session"`). Asks do not wait for a reply.
- Queued messages remain in the shared database and deliver in order when the same Atomic session reconnects with the same home group on any machine using that storage.
- Messages queued for a [released subagent](/subagents#released-subagents) wake it through its launching session (immediately on reconnect or within about 30 seconds). Paused or quit subagents are not woken automatically; their messages wait until resumed.
- Delivery confirmations for queued messages only go to senders that are still connected; the original tool result remains queued.
- Each offline session accepts at most **1,000 queued messages or 64 MiB**. Messages past that cap are refused without dropping earlier queued messages.
- Messages expire undelivered if the session does not return within 7 days.

When a machine or broker stops abruptly, its sessions still look connected for up to 30 seconds. Sends during that window time out with an uncertain outcome after about 8 seconds; after 30 seconds, sends queue normally, and any unconfirmed messages redeliver once on reconnect.

### Data and security

- **Retention.** Cross-machine message text, attachments, and sender metadata stay in the shared database until delivered, and delivered rows are pruned about 12 minutes later to protect against duplicate retries. Offline messages stay until delivered or expired after 7 days. Session names, IDs, and group memberships are stored for discovery and routing.
- **Database access.** Anyone who can read the shared database can read cross-machine Intercom messages. Keep credentials in `secrets` (`{ "env": ... }` or `{ "file": ... }`) rather than plain `options`, and use project groups rather than `default` so teammates in other repositories cannot inject prompts into your sessions.
- **No open ports.** Intercom opens no network listeners or broker-to-broker sockets. Cross-machine security matches the shared database's authentication and transport security.

### Troubleshooting multi-node

**A remote session does not appear in `intercom list`.**

- Run `atomic storage status` on both machines to verify they use the exact same `storage` selection and `prefix`, and that each broker reports `storage: matches the selection above`. Run `atomic intercom restart` if a broker started before a settings change.
- Run `atomic intercom status` or inspect `broker.log` for `Intercom multi-node routing is on`, `off`, or `unavailable`. Remember that a local `path` selection only reaches brokers on the same machine.
- Confirm the remote session has actually joined Intercom (for non-interactive or lazy sessions, call `intercom({ action: "status" })` once) and shares a group with your session.
- If the database is temporarily slow, `intercom list` falls back to local sessions after 2 seconds; retry shortly.

**A send stays queued.** The recipient is offline. It receives the message when the same Atomic session reconnects with the same home group on a host using the same storage and prefix.

**The shared database is unavailable.** Same-machine sessions keep messaging normally. Sends to remote sessions fail with `Session not found on this node, and Intercom could not reach the shared storage database to look for it on other nodes. Try again once the database is available.`

On startup failure, the broker logs `Intercom multi-node routing is unavailable: <reason>` and retries with exponential backoff from 1 second up to 30 seconds without falling back to memory. If sends still fail after the database recovers, run `atomic intercom restart`.

**A cross-machine ask never gets an answer.** If the remote recipient disconnects before answering, the asker is not notified and the ask stays pending. Cancel it with `intercom({ action: "cancel", askId })` and ask again once the recipient returns.

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| ALT+M | Open session list overlay |
| ↑/↓ | Navigate session list |
| Enter | Select session or send message |
| Escape | Cancel or close overlay |

## Limitations

- **Local broker sockets.** Each session connects to the broker on its own machine over local sockets or pipes. Cross-machine delivery requires a shared storage database ([Running Intercom across machines](#running-intercom-across-machines)).
- **No separate Intercom log.** Messages live in each session's history rather than a dedicated inbox or transcript file.
- **No attachment picker in the overlay.** `file`, `snippet`, and `context` attachments work through the `intercom` tool and protocol, not the ALT+M compose overlay.
- **Only connected sessions appear.** `intercom list` and the overlay show sessions connected to the broker, not every open Atomic process.
- **On-demand broker lifecycle.** The broker starts when the first session connects and exits after 5 seconds idle; sessions reconnect automatically if it restarts.
- **Unsaved sessions.** A session started with `--no-session` keeps received messages only in memory, so unread messages are lost if it exits.
- **Paused or quit subagents.** Single-target messages from `intercom` to a paused or quit subagent queue durably across broker restarts without resuming it, waiting until the launching session continues it. Queued messages fail once if the subagent is cancelled, or if the launching session ends or stays away for 7 days in a row. Pattern sends and older clients do not queue and get `recipient_stopped` or `Session not found` ([Run control](/subagents#run-control)).
- **Subagents whose launching session is not running.** Live and restoring holds apply while the launching session is open or after it reported the subagent. Messages from `intercom` to reported completed, failed, paused, or quit subagents queue durably in `ended-child-queue.sqlite` or shared storage for up to 7 days while that session is away. Unreported or expired subagents return `Session not found` unless multi-node offline queueing applies. Unrestored holds end on disconnect, or after 60 seconds in hosts without recovery such as `atomic -p`.
- **Released subagent asks on the local broker.** With multi-node routing on, replies from another machine survive broker restarts for asks sent to remote peers. Questions asked of a session on the subagent's own local broker are kept only by that broker, so a broker restart delivers a timeout to the subagent ([Released subagents](/intercom/reference#released-subagents)).
- **Offline session queueing scope.** With [multi-node routing](#running-intercom-across-machines) on, sends to a session that disconnected within about 7 days (including a subagent session) queue for its return instead of returning `Session not found`, unless an active subagent hold or ended-subagent queue handles them first ([Offline sessions](#offline-sessions)).
