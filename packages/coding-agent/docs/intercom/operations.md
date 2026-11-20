---
title: Intercom operations
description: Connection states, delivery behavior, notifications, shortcuts, and recovery.
---

# Intercom operations

## Connection states and recovery

Start with the state you can observe. The existing sections below explain the corresponding lifecycle and delivery contracts in detail.

| State | What you see | What to do |
| --- | --- | --- |
| Not connected or waiting for lazy admission | An interactive session appears in `intercom list` a moment after it starts. A print (`-p`), JSON, RPC or SDK session, or an interactive session whose tool selection leaves out `intercom`, appears only after it has used an Intercom surface. An interactive session that could not reach the broker when it started tries again for about a minute, then waits for its first use. | Invoke an Intercom tool, `/intercom`, or ALT+M in that session. The broker starts on demand. See [How connection works](#how-connection-works). |
| Recoverable disconnect | An explicit Intercom call or overlay action fails visibly, while background recovery remains active. | Wait for reconnect. Before repeating a send, ask, or reply, check its reported outcome; never automatically repeat an unknown outcome. See [How it works](#how-it-works). |
| Reconnect backoff | The session remains disconnected between attempts. | No extra call is required to keep recovery moving. Retries use 1, 2, 5, 10, then 30 seconds until the session connects or shuts down. See [How it works](#how-it-works). |
| Destination-side admission failure | A non-parent asker receives a correlated failed-ask message (or an error while its call still waits) instead of a reply. | Act on the returned destination error, then send again when the destination can admit the message. See [Subagent notifications](#subagent-notifications). |
| Broker restart or concurrent startup | Sessions disappear briefly, or several sessions invoke Intercom at the same time. | Usually no action is needed. Clients reconnect, and the spawn lock prevents duplicate brokers. See [How it works](#how-it-works). |
| Broker started by an older Atomic | After an update, the first session of the new version replaces the older broker; sessions of both versions disconnect for a moment and reconnect to the new one. If the broker cannot be replaced, the session shows one warning that it uses the broker on this machine only. | Usually nothing. If the warning appears, run `atomic intercom restart` when a brief reconnect is acceptable. See [Upgrading Atomic with sessions running](#upgrading-atomic-with-sessions-running). |
| Broker accepts connections but stops answering | List or send requests time out. | Allow about a minute for automatic broker replacement, then reconnect backoff. A request timeout can add up to five seconds for a health check. Check the logs below if it repeats. See [How it works](#how-it-works). |
| Broker does not start | The startup or readiness error quotes the broker log path and includes a bounded tail. | Read `~/.atomic/agent/intercom/broker.log`, or the equivalent path below `ATOMIC_CODING_AGENT_DIR`. See [How it works](#how-it-works). |
| Half-closed peer or undeliverable send | The send returns `Session not found`; its message id remains retryable. | Refresh the session list and retry after the target reconnects. See [How it works](#how-it-works). |
| Subagent that is starting | A send or ask to a background subagent that is launching, being resumed, or being relaunched after a restart waits for it until it registers, instead of returning `Session not found`. This applies to the session that launched it and to any session in its group, by the subagent's name. The wait lasts through both of its start attempts (twice `sessionStartTimeoutMs` plus two minutes, at most an hour; a sender whose own broker is on another node waits at most 20 seconds). A retried start keeps the messages its stalled first start had received, and waits for new ones too. The subagent registers before its first turn, so each waiting message is delivered once, in order, as context for that turn. If its start fails, the sender is told why, for example `Subagent \`subagent-worker-1a2b3c4d-1\` did not start: …`. | Wait for the send to return. `subagent({ action: "status", id })` shows where the subagent's start is. See [How it works](#how-it-works). |
| Subagent being restored after a restart | A send or ask to a background subagent that its owner will restore, or is restoring, waits instead of returning `Session not found`. It holds from the moment its reopened session starts, for the owner and for any session in the subagent's group, whether the message uses the subagent's name, its Atomic session ID, or the Intercom session ID it had before the restart. The name and Atomic session ID are held from the first moment; the pre-restart ID is held once the owner has read it from the subagent's own session, usually within a fraction of a second. Each waiting message is delivered once, in the order it was sent, when the subagent reconnects. If the subagent has not reconnected within 20 seconds, the sender gets a "still being restored" error. If the subagent did not survive the restart, the sender gets an explicit "did not survive the restart and is gone" error. None of these returns `Session not found`. | Retry later if the subagent has not reconnected yet, or launch a new subagent if the old one is gone. See [How it works](#how-it-works). |
| Subagent that finished or was paused | A send or ask from the `intercom` tool to a subagent that completed or failed returns at once as queued, and the session that launched it resumes it to receive the message; one to a subagent that was paused or quit returns at once as queued and reaches it when that session continues it. A reply arrives later as a message. See [Messages that resume a finished subagent](/intercom/reference#messages-that-resume-a-finished-subagent). | Wait for its reply or result. If the message cannot reach it, you get one delivery failure for it; send it again if it is still needed. See [How it works](#how-it-works). |
| Subagent that ended or dropped off | A send or ask to a subagent whose session just ended or lost its connection waits up to 20 seconds instead of returning `Session not found`. If the subagent reconnects, each waiting message is delivered once, in order. If the session that launched it reports how it ended, a send that asked to resume it is queued as above; otherwise the sender gets a typed error that names why and what to do: `recipient_completed`, `recipient_failed` or `recipient_stopped` with the `subagent({ action: "resume", id, message })` call its launching session can make, or `recipient_cancelled` for a subagent that cannot be resumed. Later sends get the same answer at once, by its name, Atomic session ID or Intercom session ID. If nobody says why within 20 seconds, the sender gets `recipient_disconnected`, which is retryable. What its launching session reported is kept while that session is away, and answers senders until the session is back; a subagent that drops after that session left waits 20 seconds for the report and then gets `recipient_disconnected`. Only senders in the subagent's group, and its launching session, are told anything; others still get `Session not found`. The [error codes](/intercom/reference#subagents-with-no-live-session) are in the reference. | Ask the session that launched the subagent to resume it, or launch a fresh subagent for a cancelled one. See [How it works](#how-it-works). |
| Subagent released while it waits | A send or ask to a [released subagent](/subagents#released-subagents) waits while the session that launched it wakes the subagent from its saved session. Each waiting message is delivered once, in the order it was sent, when the subagent reconnects, usually within a second. If it has not reconnected within 20 seconds, the sender gets the same "still being restored" error as above. If the connection of the session that launched it closes, its sends are still held, but nobody can wake it until that session is back: after 20 seconds the sender gets a retryable `recipient_owner_suspended` error, and the session, once back, wakes the subagent for the sends waiting then. A paused or quit released subagent is not woken, and senders get the "still being restored" error too. When the subagent was woken but a heavy load keeps it from reconnecting, the wait can grow to 120 seconds once the launching session confirms the wake. A sender whose own broker is on another node always waits at most 20 seconds. The delivery failure carries a `reasonCode` so callers need not read the text: `recipient_not_restored` when the wait ended while the subagent was being restored or woken, and `recipient_parked` when it is paused or quit and not woken for a send. Other codes are `session_not_found` and `message_id_conflict`. | Retry later, or `resume` the subagent if it was paused or quit. Only the session that launched it owns its hold ([Released subagents](/intercom/reference#released-subagents)). See [How it works](#how-it-works). |
| Queued for an offline session | With [multi-node routing](#running-intercom-across-machines) on, a send, ask, or reply to a session that has disconnected is reported as queued at once (`Message queued for <target>`, with `target: "offline session"` in the result details). An ask returns without waiting for an answer. | Nothing to retry: the message is delivered when that session connects to Intercom again on any machine that uses the same storage. Do not send it again as a new message. See [Offline sessions](#offline-sessions). |

## How Connection Works

An interactive session connects as soon as it starts, in the background, so any other session in its group can list it and `send` or `ask` it before it uses Intercom itself. This includes a new, resumed or forked session in an open terminal. Neither the first screen nor your first prompt waits for it. If the broker cannot be reached or started, the session says nothing and tries again after 1, 2, 5, 10 and 30 seconds; after that it connects on its next Intercom use. It registers under the same name and group it would get on first use, so nothing changes for the sessions that already reach it.

Other sessions connect when you use Intercom's tool, `/intercom`, or ALT+M: print (`-p`), JSON and RPC sessions, sessions created with the SDK, interactive sessions whose tool selection leaves out `intercom`, and every session when `joinAtStartup` is `false` in [Intercom's configuration](/intercom/reference#configuration) or `ATOMIC_INTERCOM_JOIN_AT_STARTUP=0` is set (`1` turns joining at startup back on whatever the configuration says). Launching an Intercom-enabled subagent may also connect the parent to authorize supervisor communication. An admitted subagent child connects as soon as its session starts, so it appears in its supervisor's and peers' `intercom list` and can receive `send`/`ask` before it ever uses Intercom itself; if the broker is unavailable at that moment, the child falls back to connecting on its next Intercom use. Connections are cleaned up when the session closes or is replaced.

A session becomes intercom-connected when all of these are true:

- the mandatory bundled Intercom extension is loaded in that Atomic model session
- the session is interactive, its tool selection includes `intercom` and joining at startup is on, **or** the model or user has invoked an Intercom surface in that session, **or** the parent runtime is authorizing an Intercom-enabled child supervisor relationship
- the local broker is running or can be auto-started

The session list and ALT+M picker show connected agent sessions, not every open Atomic process. Internal control connections are not recipients and do not contribute to session counts or presence events. Genuine agents remain visible and messageable while executing tools or awaiting human input.

Name sessions with `/name` so they can target each other (for example `/name planner` and `/name worker`). If a session is unnamed, Intercom exposes a runtime-only fallback alias like `subagent-chat-1a2b3c4d-1111-4222-8333-123456789abc` so other sessions can still target it. That alias is not persisted as the session title, so resume pickers keep showing the transcript snippet instead of a generic name.

### Troubleshooting initialization

`Intercom heavy initialization failed; a later call will retry: …` means initialization can be attempted again on a later Intercom call. Interactive sessions show this as a yellow warning in the chat pane, without a console stack trace; non-interactive sessions (print, JSON, and RPC) retain console diagnostics. Terminal relay and cleanup failures appear as error notifications in interactive sessions.

If initialization keeps failing, check the reported cause and `~/.atomic/agent/intercom/broker.log` (or the Intercom directory under `ATOMIC_CODING_AGENT_DIR`). Do not automatically resend an operation reported with an unknown delivery outcome; check with the recipient first.

### Upgrading Atomic with sessions running

Sessions on one machine share one broker, and it keeps running after the Atomic that started it is replaced. Each broker reports the range of Intercom protocol versions it accepts (`atomic intercom status` shows it as `Protocol:`); a broker from Atomic 0.9.71 or earlier reports none and speaks protocol 1. This version speaks protocols 1 to 4.

- **A session of a newer version replaces an older broker.** When a session starts and finds a broker whose range this version covers, it asks that broker to shut down, waits for its process to exit, and starts its own broker in its place. It waits up to a minute: on Windows an older broker can take about 30 seconds to exit while sessions are connected. Until the successor answers, sessions of either version wait for it instead of starting a broker of their own. Sessions of the older version reconnect to it as they do after any broker restart, keep their session IDs, and keep exchanging messages with sessions of the new version. Sessions starting together replace the broker once.
- **A broker that cannot be replaced is used on this machine only.** If the older broker does not stop, reads another shared storage selection than a broker started by this session would, or shares no protocol version with this one, the session leaves it running and registers as an older session would. With no multi-node storage configured, it shows one warning and continues on this machine. With multi-node storage selected, or when the older broker routes across machines, the session is refused with `IntercomRoutingUnavailableError` instead, because it cannot verify how the broker routes. In both cases `atomic intercom restart` replaces the broker.
- **Installers and `atomic update` finish by running `atomic intercom upgrade`** when the version they installed has it. It stops an older broker that has no session connected, so the next session starts the new one, and otherwise leaves the broker to the next session of the new version. It is safe to run at any time.

While a session uses an older broker, requests that need a newer protocol, such as keeping a released subagent addressable, fail before anything is sent:

| Class | `code` | When it happens | Fields | What to do |
| --- | --- | --- | --- | --- |
| `IntercomBrokerProtocolError` | `broker-protocol-unsupported` | The session is connected to an older broker that does not understand the request. | `feature` (the request), `brokerProtocolMin`, `brokerProtocolMax`, `requiredProtocol`, `hint`, `retryable: false` | Run `atomic intercom restart` so a broker of this version replaces it, then retry. |
| `IntercomBrokerUpgradeError` | `broker-upgrade-failed` | Replacing an older broker failed, while stopping it (`phase` `"stop"`) or starting its successor (`phase` `"start"`). The session continues as described above; `atomic intercom upgrade` reports it and exits with status 1. When the older broker shut down but was still running after a minute, the session's connection fails with this error and is retried on the reconnect backoff. The spawn lock then names that process, so no broker starts while it is alive, for up to about another minute. After it exits, or once the lock ages out, the next session to reconnect starts a broker. If an older session reconnects first, that broker is the older version, and the next newer session replaces it again. | `phase`, `previousPid`, `previousProtocolMax`, `hint`, `retryable: true`; `cause` is the failure of that step | For `"stop"`, run `atomic intercom restart`. For `"start"`, sessions start a broker again when they reconnect. |
| `IntercomBrokerStopTimeoutError` | `broker-stop-timeout` | A broker asked to shut down was still running when the stop's bound expired: a minute for an upgrade, 10 seconds for `atomic intercom restart`. | `phase` (`"stop"`), `pid`, `timeoutMs`, `elapsedMs`, `hint`, `retryable: true` | Wait for the broker process to exit, or end it yourself, then retry. |

These belong to the `IntercomBrokerError` family and are exported from `@bastani/atomic` with `isIntercomBrokerProtocolError()`, `isIntercomBrokerUpgradeError()` and `isIntercomBrokerStopTimeoutError()`.

### Mixed versions and workflows

Atomic 0.10.0 removed workflows, and with them Intercom's workflow stage targets, stage routes and workflow invocation groups. The protocol range is unchanged, so a broker of either version keeps serving sessions of the other, and neither replaces the other: whichever broker is running stays. Sends, asks, replies, groups, subagent targets and multi-node routing work across versions as before.

0.9.x workflows keep running while a 0.10.0 broker is running. The broker never closes a connection over a workflow request, so the session keeps messaging. It answers each request with a frame 0.9.x already handles:

| 0.9.x request | 0.10.0 broker's answer |
| --- | --- |
| Registering a run's pending-stage route | Acknowledged without creating a route. A 0.9.x run waits for this answer before it starts each stage, and would fail the stage on a refusal. |
| Registering a running stage's live route | Acknowledged without creating a route. 0.9.x closes its connection and reconnects over every refusal it knows for this request, so a refusal would cost the stage its Intercom connection. |
| Withdrawing a route, or claiming the run it launched | Acknowledged with nothing to withdraw; the claim is answered `claimed: false`. A 0.10.0 broker no longer advertises claims, so 0.9.x does not send one. |
| A run's notice that a message queued for one of its stages will not be delivered | Sent on as an ordinary send from the run's connection to the message's sender, found again after a reconnect as a 0.9.x broker finds it. It is delivered when the sender is in the run's group, and answered as any send otherwise. Only a message that an earlier broker queued has such a notice. |
| A released stage hosted with a live route | The session is hosted; its live route is refused (`owner_missing`). |

A stage that has started registers as an ordinary session in its run's `workflow:<runId>` group. A session in that group, or one that joins it, reaches the stage by its ID or name, and the stage asks and answers its parent like any other session when they share a group. Messages sent to a stage that has not started are not queued for it: a send, ask or reply to a `workflow:<rootRunId>/...` target gets the answer any unknown name gets, `Session not found`. A 0.10.0 broker answers a 0.9.x session that way, and a 0.10.0 session answers its own such send that way without sending it, whatever broker is running.

When a 0.10.0 broker takes over from an earlier one, a message that broker queued for a stage stays with the 0.9.x run. If the stage never starts, the run notifies the message's sender. A sender outside the run's group is not reached, and the 0.9.x run tries again at each later check of its queued messages, until the session ends. A `workflow:<rootRunId>` group is an ordinary group on a 0.10.0 broker: its sessions are listed and reached like any other group's. A 0.10.0 session on a 0.9.x broker never sends a workflow request and ignores the workflow rows that broker lists; it declines a workflow notice that broker hands it.

## How It Works

The local broker starts when the first session connects and exits after five seconds without registered sessions. Clients reconnect automatically using delays of 1, 2, 5, 10, then 30 seconds. Explicit connection failures remain visible while background recovery continues.

If the broker stops answering health requests for about a minute, it terminates itself so clients can start a replacement. A single slow request does not restart a responsive broker. This protection starts with a newly launched broker; a broker still running from an older Atomic version must restart before it gains it. A process suspended by the operating system cannot run its own recovery. If it remains stuck, verify which process owns the broker before stopping it manually. Do not delete the Intercom database or key files.

Protocol, authentication, configuration, and terminal delivery failures require attention rather than a model change.

For `send`, `ask`, and `reply`, the tool owns reconnect recovery. One invocation makes the initial attempt and up to three retries, waiting 1, 2, then 5 seconds between attempts. Retries preserve the original message ID, caller arguments, attachment order and presence, and reply thread. The model neither supplies nor receives a retry token. Every new invocation is a fresh intentional operation, even with identical text. Existing integrations must stop passing `retryToken`; caller-supplied tokens are refused without sending.

Initialization may retry before delivery begins. Exhaustion or cancellation there returns `outcome: "not_sent"`.

Recoverable disconnects trigger retries; unrelated errors stop them. Cancellation stops new attempts but does not undo a successful receipt. Retry and reply waits share the original 11-minute operation deadline.

`delivered` means the recipient saved the message to its session. A message saved by a busy recipient is shown when it goes idle, as before; if the recipient is killed or crashes first, resuming its session shows each saved message once, in arrival order, after the transcript appears. Saved messages go through the same sender check as interrupted deliveries: one from a sender that is still connected is shown and may start a turn, one from a sender that is gone is added once, in full, to the session history without starting a turn, and the recovery notice says the sender is gone. One whose sender cannot be checked is deferred until the session is opened again: Intercom was unreachable, or the sender is a relaunched subagent that has not reconnected yet. If the recipient does not confirm the save within about 8 seconds, the sender gets a failure saying the outcome is uncertain: the recipient may still save and show the message. Check with the recipient before sending it again as a new message. Intercom's own retries reuse the original message ID, and a recipient that already saved a message does not show it twice. A recipient that disconnects before confirming receives the message again when it reconnects. While a broker started by an earlier Atomic version is still running after an upgrade, `delivered` keeps its earlier meaning, that the message reached the recipient, and the recipient still saves it on arrival; the broker exits when idle, and the next one uses the new meaning.

`outcome: "unknown"` means delivery may have occurred, including an accepted ask that ended without a reply. **Check with the recipient before sending again.** A new tool invocation is a new operation, not another retry of the old one.

Intercom refuses new delivery when it cannot safely track duplicates, including capacity or storage failures. Do not delete its runtime files to force a resend when an outcome is unknown. Transport remains local to this machine.

Custom hosts may declare an optional `recipientPurpose` on session registration. Only `"agent"` and `"control"` are accepted; omission preserves legacy agent behavior. Invalid strings, `null`, and non-string values are rejected, not silently treated as controls. Session purpose is immutable after registration; presence updates cannot change it.

Configuration and diagnostics live in `~/.atomic/agent/intercom/`, or under `ATOMIC_CODING_AGENT_DIR`. The legacy `PI_CODING_AGENT_DIR` applies when the Atomic variable is unset. Edit `config.json` for [Intercom settings](/intercom/reference#configuration).

A local broker keeps these files in that directory: `broker.pid` and, outside Windows, `broker.sock` while it runs, which it removes when it exits (when that path would be longer than a Unix socket path may be, 107 bytes on Linux and 103 on macOS, the socket is instead `atomic-intercom-<uid>/<digest>.sock` in an owner-only directory under the starting broker's `$XDG_RUNTIME_DIR` or temp directory, and `broker.sock.path` records where, so every session using the agent directory finds it); `broker.log` from the session that started it; and `delivered-messages.sqlite` with its `delivered-messages.key`, which a broker creates when the first session registers and keeps so that a restarted broker still recognizes messages it already delivered. `ended-child-queue.sqlite` keeps the messages queued for [subagents that finished or were paused](/intercom/reference#across-restarts) across restarts; it too is created when the first session registers. A broker that exits without serving a session leaves no delivered-message files.

Disposing a session cancels a broker start it has not launched yet, and waits for a broker it already launched to finish starting, stopping it if it does not start in time. Once `dispose()` resolves, nothing that session started writes into the agent directory, so a host that uses a temporary `ATOMIC_CODING_AGENT_DIR` can remove it then. On Windows a running broker keeps `broker.log` open, so the directory can be removed only once the broker has exited, about five seconds after its last session.

When startup fails, read the `broker.log` path printed in the error. Ordinary diagnostics are capped at 8 KiB per broker. The next spawn keeps a bounded copy in `broker.log.previous`; `broker-watchdog.log` separately retains the latest automatic termination's time, PID, and reason. Preserve these files when reporting repeated stalls or restarts. They live under the Intercom directory above.

If startup reports a lock held by a process it cannot check, Atomic leaves that lock untouched. This can happen when another host or container shares the agent directory, an earlier version left an incomplete lock or takeover token, a process was killed before recording its holder, or your user cannot read a lock or its owner record. After 30 seconds the warning names the lock, token or generation directory, any writer markers blocking recovery, and recovery steps. If the filesystem also prevents inspecting the lock's file identity, Atomic keeps waiting without recommending removal. Check that the disk or network share is available if startup keeps waiting. Confirm that no process on any host using that directory still needs those files before removing the named files or directory. If another user owns them, ask that user to remove them or restore ownership first. Do not remove the Intercom database or key files.

An idle broker may leave one `broker.sock.replace.lock.gen<N>` directory containing a released marker. This is normal and does not prevent the next broker from starting. Leave it in place.

## Subagent Notifications

Intercom is also the delivery channel for subagent results and control notices from [subagents](/subagents).

### Subagent Control Notices

The `subagent` tool's `control` options select which control events notify the parent and over which channels:

- **`notifyOn`** — defaults to `["active_long_running", "needs_attention"]`
- **`notifyChannels`** — defaults to `["event", "intercom"]` (all that are available)

Run results report each child's Intercom target as "Run intercom target" or "Previous intercom target"; a target may be inactive after completion. Use `intercom({ action: "status" })` to inspect connection state and memberships.

For live peer coordination, call `intercom({ action: "status" })` in the parent before launching. Children connect on first use. Fresh children receive Intercom even when an extension allowlist omits it.

### Delivery Ordering

Parallel communication does not cancel the batch. An `intercom` ask returns at delivery and its reply arrives as a message in the same child; a `contact_supervisor` decision waits only in its requesting child and the correlated reply continues that same execution. Sends and progress updates remain nonblocking. Claimed single-child parent asks retain their terminal fresh-start handoff.

Queued messages from a child arrive before its completion notice. Delivery retries do not rerun work or change its outcome. Messages from one sender reach a session in the order they arrived, whether they are admitted at once or wait until the session is idle.

## Running Intercom across machines

By default, each machine's broker serves only the sessions on that machine. With multi-node routing, brokers on different machines that use the same shared storage database deliver messages to each other through it. Sessions still connect only to the broker on their own machine, and brokers never connect to each other: they read and write the shared database.

### Turning it on

For a team, `atomic team join <url> --token-file <path>` turns it on in one command: it selects the team database for Intercom, keeps sessions on the machine, and restarts the broker. CI runners use `ATOMIC_PROFILE=ci` instead. See [Team and CI setup](/guides/team-setup).

To configure it by hand, give every machine the same shared top-level `storage` selection, including the same `prefix`. To reach other machines, the selection must be an [adapter](/storage#selecting-an-adapter) whose module implements `openDatabase` and connects to a database that every machine can reach, as described in [Sharing storage across hosts](/storage#sharing-storage-across-hosts). Install the adapter on every machine, for example as an [Atomic package](/storage#adapters-from-atomic-packages) so that `atomic install` also brings its driver.

Both the npm installation and the standalone binary run multi-node routing and load storage adapters.

The broker takes its selection from one of two places:

- `--storage`, `--storage-file`, `ATOMIC_STORAGE`, or `ATOMIC_PROFILE=ci` on the Atomic process that starts the broker. See [Selecting storage per process](/storage#selecting-storage-per-process).
- Otherwise, the top-level `storage` in the global settings file, `~/.atomic/agent/settings.json` (or `settings.json` in the agent directory under `ATOMIC_CODING_AGENT_DIR`).

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

One broker serves every session in an agent directory and keeps the selection it started with until it exits. After changing the selection, run `atomic intercom restart`. It asks the broker to shut down; the sessions connected to it reconnect within a few seconds, and the first one starts a broker with the new selection. The command waits for that broker and prints its multi-node routing state. When no session is connected, the next session that uses Intercom starts the new broker. A broker started by an older Atomic version, which does not answer the request, is stopped with SIGTERM.

`atomic intercom status` shows whether the broker is running, how many sessions it serves, whether it uses the current selection, and its multi-node routing state with the number of other brokers live in the shared database. `atomic storage status` shows the same together with the selection for sessions; see [Checking the selected storage](/storage#checking-the-selected-storage). In a session, `intercom({ action: "status" })` adds a `Multi-node routing:` line, for example `Multi-node routing: on (adapter @bastani/atomic-storage-libsql, prefix none), 1 peer broker live (build-host)`.

Each broker writes its multi-node state to `broker.log` when it starts: `Intercom multi-node routing is on (adapter <adapter>, prefix <prefix>)` once it has opened the shared database, or `Intercom multi-node routing is off: <reason>`. `<adapter>` is `sqlite` for a `path` selection.

Multi-node routing stays off, and Intercom behaves exactly as on a single machine, when the selection is:

- absent, including when only project settings (`.atomic/settings.json`), `sessions.storage`, or `ATOMIC_SESSIONS_STORAGE` select storage;
- in memory: `{ "memory": true }` or `{ "path": ":memory:" }`;
- an adapter that implements only `openSessionStore` and has no `openDatabase`;
- invalid, for example an `env` secret that is not set in the broker's environment, or an adapter module that cannot be loaded. Sessions warn at startup when the Atomic they run cannot load the adapter.

In each case the broker writes `Intercom multi-node routing is off: <reason>` to `broker.log`.

A `path` selection, including the default storage file, is a local SQLite file. Only brokers on the same machine that open the same file share it. Do not put it on a network filesystem.

Intercom creates its own tables in the selected database, named with the selection's `prefix` like the session tables. Brokers that use different prefixes cannot see each other's sessions, so a prefix also separates teams or tenants that share one database.

### Project groups

While multi-node routing is on, a session with no explicit group joins `project:<owner>/<repo>`, named from its repository's `origin` remote (the repository's directory name without an `origin`, the working directory's name outside Git), instead of `default`. Sessions of different repositories on one database therefore cannot list or message each other, while sessions of one repository on any machine can. One broker serves every project of a machine, so groups, not prefixes, separate projects. An explicit `ATOMIC_INTERCOM_GROUP`, Intercom `config.json` `group`, or inherited subagent group still wins. Joining `default` explicitly, with the `join` action or through those settings, prints a one-line warning while the broker routes across machines, because every teammate's sessions can address it. The interactive TUI and RPC clients show it as a notice when the session registers with the broker. Print and JSON runs and subagents have no UI, so they write the line to stderr, at most once per process, and leave stdout alone. A running session keeps the group it started with; it moves to its project group after it restarts or reloads.

Inside a Git repository, the session runs `git` to read the origin. When Git is not installed or fails there, the session's Intercom start fails with `ProjectGroupError` (`code` `"git-unavailable"` or `"git-failed"`, with `cwd`, `detail`, and a `hint` naming the install command or the failing `git` command; exported from `@bastani/atomic` with the guard `isProjectGroupError()`); set `ATOMIC_INTERCOM_GROUP` to skip the lookup. The error is not retried in the background: the session keeps reporting it until it restarts.

One broker serves every session of an agent directory and keeps the storage it started with, so a session decides its group from what that broker reports before it registers, not from its own environment. A session that reuses a broker started with `ATOMIC_PROFILE=ci`, `ATOMIC_STORAGE` or `--storage` joins its project group even though its own environment selects no storage. A session never registers when it cannot tell what the broker does, or when the broker's routing contradicts its group. It registers with the routing it verified, and the broker refuses the registration if its routing differs, so a broker that is replaced after the check cannot admit a `default` member. A broker that predates this registration is replaced by the session's own broker; one that cannot be replaced is used on this machine only, unless multi-node routing is selected or reported, which fails the session with `IntercomRoutingUnavailableError` (`reason` `"unsupported"`, `phase` `"register"`). See [Upgrading Atomic with sessions running](#upgrading-atomic-with-sessions-running). These failures are `IntercomRoutingError`s, exported from `@bastani/atomic` with their guards, and each carries a `hint`:

| Class | `code` | When it happens | Fields | What to do |
| --- | --- | --- | --- | --- |
| `IntercomRoutingMismatchError` | `broker-routing-mismatch` | The broker now routes across machines but this session joined it as an implicit `default` member (`reason` `"implicit-default-on-remote-broker"`), or this session selects shared storage but the running broker started without it, or, under `ATOMIC_PROFILE=ci`, does not route across machines for any reason (`reason` `"shared-storage-not-on-broker"`). Terminal: it is not retried in the background and is reported until the session restarts. | `reason`, `group`, `hint`, `retryable: false` | Restart the session so it joins its project group, or set `ATOMIC_INTERCOM_GROUP`. For `"shared-storage-not-on-broker"`, run `atomic intercom restart` first. |
| `IntercomRoutingUnavailableError` | `broker-routing-unavailable` | The broker cannot report or verify its routing: it closed the status request without answering (`phase` `"broker_status"`, `reason` `"unsupported"`), answered with an unreadable report (`"malformed"`), or is an older broker without verified registration that could not be replaced (`phase` `"register"`). Only refused while multi-node storage is selected or the broker reports multi-node routing; otherwise the session uses the broker on this machine only, with one warning. | `reason` (`"unsupported"` or `"malformed"`), `phase`, `hint`, `retryable: true`; `cause` is the `IntercomBrokerUpgradeError` when replacing the broker failed | Run `atomic intercom restart` to replace the broker. The session retries on the normal reconnect backoff and never registers meanwhile. |
| `IntercomRoutingTimeoutError` | `broker-routing-timeout` | The broker accepted the status request but did not answer in time. | `timeoutMs`, `elapsedMs`, `phase`, `hint`, `retryable: true` | Run `atomic intercom restart` if it persists. The session retries on the normal reconnect backoff and never registers meanwhile. |
| `IntercomRoutingChangedError` | `broker-routing-changed` | The broker changed how it routes between the session's check and its registration. The broker refuses the registration before it takes effect, because the session sends the routing it verified with the registration itself. | `expectedAcrossMachines`, `hint`, `retryable: true` | Nothing: the session checks the broker again and retries. Run `atomic intercom restart` if it keeps failing. |

The guards are `isIntercomRoutingError()`, `isIntercomRoutingMismatchError()`, `isIntercomRoutingUnavailableError()`, `isIntercomRoutingTimeoutError()`, `isIntercomRoutingChangedError()` and `isRetryableIntercomRoutingError()`. The `intercom` tool reports the message and `hint` once, with the `code` in the result details, and no stack trace.

### What works across machines

A session connected to a broker on another machine appears in `intercom list` and is messaged exactly like a local one:

- `send`, `ask`, and `reply` keep the same sender identity, reply threads, and `delivered` meaning: `delivered` still means the recipient saved the message.
- Group isolation is the same. A session sees and reaches only sessions that share a group with it, and by default that is its [project group](#project-groups). A session can still answer a sender outside its groups whose message reached it, within the same [return path](/intercom/reference#answering-a-sender-outside-your-groups) limits, whichever machine either is on.
- Supervisor messages from `contact_supervisor` keep their supervisor routing.
- A send to a subagent that its owner is restoring on another machine is held, and reports the same errors, exactly as on one machine. See the [connection states](#connection-states-and-recovery) table.
- Duplicate protection still holds: Intercom's own retries reuse the message ID, and a recipient never shows a message twice.

When a session on this machine and one on another machine have the same name, the name reaches the local one. Give sessions unique names, or address them by session ID.

### Latency

Brokers wake each other through the shared database. Each broker checks it for wake-ups every half second, so a message to a live session on another machine usually arrives within about half a second plus the database round trips, and its `delivered` confirmation takes about as long again. A slow or distant database adds to each step.

If a wake-up is missed, a backup check every 30 seconds finds the message, so delivery can take up to about 30 seconds. A sender waits about 8 seconds for a live recipient to confirm. A recipient that is still saving the message reports its progress, and each report keeps the sender waiting, for up to 2 minutes; once the recipient's broker on another machine holds the message, a recipient that is too busy to report in time gets one more 8-second wait. A send that is never claimed (for example when a wake-up is missed or the destination broker is stopped), or a same-machine recipient that neither confirms nor reports, ends with the uncertain-outcome failure described in [How it works](#how-it-works) after about 8 seconds; a claimed recipient on another machine that neither confirms nor reports ends uncertain after about 16 seconds. The message is still delivered once. Check with the recipient before sending it again as a new message.

Sessions on the same machine do not depend on the shared database. Before delivering locally, the broker checks the database for an earlier cross-machine attempt of the same message, and waits at most 0.3 seconds for it, including while the database is still opening when the broker starts. Connecting to Intercom waits at most 5 seconds for the database, and `intercom list` waits at most 2 seconds for sessions on other machines before it shows the local ones alone.

### Offline sessions

A session that quit cleanly or crashed stays known to every broker for about 7 days after it was last connected. It does not appear in `intercom list`, but you can still message it by name, Intercom session ID, or Atomic session ID, within the same group rules:

- A send, ask, or reply returns at once as queued, `Message queued for <target>`, with `target: "offline session"` in the result details. An ask does not wait for an answer.
- The message stays in the shared database and is delivered, in order, when that same Atomic session connects to Intercom again with the same home group, on any machine that uses the same storage.
- A message queued for a [released subagent](/subagents#released-subagents) wakes it. The session that launched the subagent wakes it when it next holds sends for it, for example after that session or its broker restarts, and otherwise within about 30 seconds. The subagent then receives each queued message once, in order, even when its session returns more than seven days after the subagent last connected. A paused or quit subagent is not woken; its messages wait until it is resumed.
- The broker reports the later delivery only to a sender that is still connected. The tool result that already returned stays queued, so check with the recipient if you need confirmation.
- One session can have at most **1,000 queued messages, or 64 MiB of queued messages**, waiting for it. A send past that limit is refused with `The recipient already has the most queued Intercom messages it accepts (1000 messages or 64 MiB); this message was not queued`. The messages already queued are kept and delivered when it returns.
- A message queued for a session that does not return within the 7 days expires undelivered. A retry of that message is refused with `The recipient did not return within the known-session retention of 7 days; the queued message expired undelivered`.

A target that no session has used in that time, or never used, still returns `Session not found`.

When a whole machine or its broker stops, its sessions still look connected for up to about 30 seconds. A send to one of them in that window waits about 8 seconds and ends with the uncertain-outcome failure; after it, sends are queued. Any message one of those sessions had not yet confirmed is delivered again when it reconnects, and shown once.

### Data and security

- Message text and attachments are stored in the shared database until they are delivered, together with the sender's identity. Delivered messages are deleted about 12 minutes later, which keeps duplicate protection for retries. Messages for an offline session stay until it reconnects, or until they expire after about 7 days.
- Session names, session IDs, and group memberships are stored there too, so brokers can list and route to sessions on other machines.
- Anyone who can read the database can read Intercom messages that cross machines, just as they can read sessions stored there: database access means full read access. A session in `default` can be messaged by every teammate's sessions, which is a prompt-injection path between people; project groups keep that from happening by accident. Protect it with the database's own credentials and transport security, and pass credentials through `secrets` (`{ "env": ... }` or `{ "file": ... }`) rather than `options`. The broker reads `env` secrets, including `ATOMIC_TEAM_TOKEN` under `ATOMIC_PROFILE=ci`, from the environment of the Atomic process that started it.
- Intercom opens no network port and no broker-to-broker connection. Its security across machines is the database's security.

### Troubleshooting multi-node

**A session on another machine does not appear in `intercom list`.**

- Run `atomic storage status` on both machines. Both must use the same storage selection and the same `prefix`, from settings or from the process that started each broker, and the broker must report `storage: matches the selection above`. A broker started before you changed the selection keeps the old one until `atomic intercom restart` replaces it.
- Check that each broker reports multi-node routing `on` with the other broker live, in `atomic intercom status` or in `broker.log`. `Intercom multi-node routing is off: <reason>` or `Intercom multi-node routing is unavailable: <reason>` there gives the cause. A `path` selection reaches only brokers on the same machine, and a machine whose broker is not running is not live.
- A session appears only after it connects to Intercom. An interactive session connects when it starts; any other session connects on its first Intercom use. Ask it to use Intercom once, for example `intercom({ action: "status" })`.
- Both sessions must share a group.
- When the database is slow to answer, `intercom list` shows only local sessions. Try again.

**A send stays queued.** The recipient is offline. It receives the message when the same Atomic session connects to Intercom again with the same home group, on a machine that uses the same storage and prefix. A session reopened on a machine with a different selection never sees it.

**The database is unavailable.** Messages between sessions on the same machine keep working. A send to a session on another machine fails with `Session not found on this node, and Intercom could not reach the shared storage database to look for it on other nodes. Try again once the database is available.` If the database cannot be opened when the broker starts, the broker logs `Intercom multi-node routing is unavailable: <reason>` and retries after 1 second, doubling up to every 30 seconds. Intercom never falls back to in-memory storage. If sends keep failing after the database is back, run `atomic intercom restart` so that a new broker starts.

**An ask to a session on another machine never gets an answer.** If that session disconnects before it answers, the asker is not told, and the ask stays pending. Cancel it with `intercom({ action: "cancel", askId })` and ask again once the session is back.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| ALT+M | Open session list overlay |
| ↑/↓ | Navigate session list |
| Enter | Select session / Send message |
| Escape | Cancel / Close overlay |

## Limitations

- **Local connections only** — Each session connects to the broker on its own machine over local sockets/pipes. Sessions on other machines are reachable only through a shared storage database; see [Running Intercom across machines](#running-intercom-across-machines)
- **No dedicated intercom log** — Messages are kept in session history; there is no separate intercom transcript or inbox
- **No attachments UI** — `file`, `snippet`, and `context` attachments are supported in the protocol, but not in the compose overlay
- **Only connected sessions appear** — The list shows sessions that have connected to the broker, not every open Atomic process
- **Broker lifecycle** — The broker auto-spawns when the first session connects and exits when idle; sessions reconnect automatically if it restarts
- **Unsaved sessions** — A session started with `--no-session` keeps received messages only in memory; if it exits before showing them, they are lost
- **Paused or quit subagent** — A message from the `intercom` tool to a subagent you paused or quit does not resume it: it is queued, with no time limit, and reaches the subagent after what you resume it with. It survives a broker restart. It fails once, with a delivery failure to its sender, if your session ends, or stays away for 7 days in a row, or if the subagent is cancelled. A pattern send, or a send from an older Intercom client, is not queued: it waits up to 20 seconds for the subagent and is then refused, or is refused at once with `recipient_stopped`, which names the `subagent({ action: "resume", id, message? })` call, while the session that launched it has reported the subagent, and returns `Session not found` otherwise. See [Run control](/subagents#run-control)
- **Subagent whose owning process is not running** — Sends to a subagent are held only while the Atomic process that owns it, its reopened session, is running. Atomic keeps no durable mailbox for a subagent. While no such process runs, for example before the owning session is reopened, a send to the subagent is not queued and returns `Session not found`, the same as for a top-level session that is not running. The same applies for the few milliseconds after the owning session connects to Intercom and before it has placed its hold. Sends are also not held for a subagent that cannot use Intercom. A hold that nothing restores ends on its own: after 60 seconds for a session whose host does not run recovery, such as `atomic -p`, and when its owning session disconnects
- **A released subagent's question to a session on its own broker** — With multi-node routing on, a reply from another machine reaches a released subagent whose `ask` or `contact_supervisor` question went to a session on another node. A question to a session on the subagent's own broker is kept only by that broker: if the broker restarts, the subagent receives its reply timeout instead. See [Released subagents](/intercom/reference#released-subagents)
- **Offline sessions with multi-node routing** — With [multi-node routing](#running-intercom-across-machines) on, a send to a session that disconnected within about the last 7 days, including a subagent's session, is queued for it instead of returning `Session not found`, unless one of the holds above applies first. See [Offline sessions](#offline-sessions)
