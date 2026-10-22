---
title: Intercom operations
description: Connection states, delivery behavior, notifications, shortcuts, and recovery.
---

# Intercom operations

## Connection states and recovery

Start with the state you can observe. The existing sections below explain the corresponding lifecycle and delivery contracts in detail.

| State | What you see | What to do |
| --- | --- | --- |
| Not connected or waiting for lazy admission | The session does not appear in `intercom list` before it has used an Intercom surface. | Invoke an Intercom tool, `/intercom`, or ALT+M. The broker starts on demand. See [How connection works](#how-connection-works). |
| Recoverable disconnect | An explicit Intercom call or overlay action fails visibly, while background recovery remains active. | Wait for reconnect. Before repeating a send, ask, or reply, check its reported outcome; never automatically repeat an unknown outcome. See [How it works](#how-it-works). |
| Reconnect backoff | The session remains disconnected between attempts. | No extra call is required to keep recovery moving. Retries use 1, 2, 5, 10, then 30 seconds until the session connects or shuts down. See [How it works](#how-it-works). |
| Exhausted workflow-stage warm-up | The stage ends `failed` and names the run, stage id, and stage name. Queued messages remain queued. | Treat the failure as terminal for that stage and restore broker availability before another delivery attempt. See [How it works](#how-it-works). |
| Terminal stage delivery failure | The stage fails without spending a model retry or fallback. | Fix the delivery failure rather than changing models. The typed failure applies to every model candidate. See [How it works](#how-it-works). |
| Destination-side admission failure | A blocking non-parent asker receives a correlated error instead of waiting for the reply timeout. | Act on the returned destination error, then send again when the destination can admit the message. See [Workflow and subagent notifications](#workflow-and-subagent-notifications). |
| Broker restart or concurrent startup | Sessions disappear briefly, or several sessions invoke Intercom at the same time. | Usually no action is needed. Clients reconnect, and the spawn lock prevents duplicate brokers. See [How it works](#how-it-works). |
| Broker accepts connections but stops answering | List, send, or workflow route requests time out. | Allow about a minute for automatic broker replacement, then reconnect backoff. A request timeout can add up to five seconds for a health check. Check the logs below if it repeats. See [How it works](#how-it-works). |
| Broker does not start | The startup or readiness error quotes the broker log path and includes a bounded tail. | Read `~/.atomic/agent/intercom/broker.log`, or the equivalent path below `ATOMIC_CODING_AGENT_DIR`. See [How it works](#how-it-works). |
| Half-closed peer or undeliverable send | The send returns `Session not found`; its message id remains retryable. | Refresh the session list and retry after the target reconnects. See [How it works](#how-it-works). |
| Subagent being restored after a restart | A send or ask to a background subagent that its owner will restore, or is restoring, waits instead of returning `Session not found`. For a plain session's subagent this holds from the moment its reopened session starts. For a subagent of an interrupted workflow stage it holds from the moment the session that launched the run is back and the run is addressable, until the stage, once running again, restores it. It holds for the owner and for any session in the subagent's group, whether the message uses the subagent's name, its Atomic session ID, or the Intercom session ID it had before the restart. The name and Atomic session ID are held from the first moment; the pre-restart ID is held once the owner has read it from the subagent's own session, usually within a fraction of a second. Each waiting message is delivered once, in the order it was sent, when the subagent reconnects. If the subagent has not reconnected within 20 seconds, the sender gets a "still being restored" error. If the subagent did not survive the restart, the sender gets an explicit "did not survive the restart and is gone" error. If another Atomic session takes over the interrupted run, the senders waiting for its subagents get an error saying so. None of these returns `Session not found`. | Retry later if the subagent has not reconnected yet, launch a new subagent if the old one is gone, or send again to the session that took over the run. See [How it works](#how-it-works). |
| Queued for an offline session | With [multi-node routing](#running-intercom-across-machines) on, a send, ask, or reply to a session that has disconnected is reported as queued at once (`Message queued for <target>`, with `target: "offline session"` in the result details). An ask returns without waiting for an answer. | Nothing to retry: the message is delivered when that session connects to Intercom again on any machine that uses the same storage. Do not send it again as a new message. See [Offline sessions](#offline-sessions). |

## How Connection Works

Intercom connects when you use its tool, `/intercom`, or ALT+M. Launching an Intercom-enabled subagent may also connect the parent to authorize supervisor communication. An admitted subagent child connects as soon as its session starts, so it appears in its supervisor's and peers' `intercom list` and can receive `send`/`ask` before it ever uses Intercom itself; if the broker is unavailable at that moment, the child falls back to connecting on its next Intercom use. Connections are cleaned up when the session closes or is replaced.

A session becomes intercom-connected when all of these are true:

- the mandatory bundled Intercom extension is loaded in that Atomic model session
- the model or user has invoked an Intercom surface in that session, **or** the parent runtime is authorizing an Intercom-enabled child supervisor relationship
- the local broker is running or can be auto-started

The session list and ALT+M picker show connected agent sessions, not every open Atomic process. Internal workflow routing/control connections, model-less `ctx.ui` prompts, and `ctx.tool` nodes are not recipients and do not contribute to session counts or presence events. Genuine agents remain visible and messageable while executing tools, including `tool:workflow`, or awaiting human input.

Name sessions with `/name` so they can target each other (for example `/name planner` and `/name worker`). If a session is unnamed, Intercom exposes a runtime-only fallback alias like `subagent-chat-1a2b3c4d-1111-4222-8333-123456789abc` so other sessions can still target it. That alias is not persisted as the session title, so resume pickers keep showing the transcript snippet instead of a generic name.

### Troubleshooting initialization

`Intercom heavy initialization failed; a later call will retry: …` means initialization can be attempted again on a later Intercom call. Interactive sessions show this as a yellow warning in the chat pane, without a console stack trace; non-interactive sessions (print, JSON, and RPC) retain console diagnostics. Terminal relay and cleanup failures appear as error notifications in interactive sessions.

If initialization keeps failing, check the reported cause and `~/.atomic/agent/intercom/broker.log` (or the Intercom directory under `ATOMIC_CODING_AGENT_DIR`). Do not automatically resend an operation reported with an unknown delivery outcome; check with the recipient first.

### Workflow-stage route refusals

When a workflow stage starts, its session registers a live Intercom route with the broker. A refusal names the condition that failed:

| Reason | Meaning | Behavior |
| --- | --- | --- |
| `Live workflow-stage route has no registered workflow owner` | The workflow owner's own broker connection is re-registering (for example after a reconnect). | Transient. The stage's bounded warm-up retry re-registers once the owner is back; the stage fails only if every attempt is refused. |
| `Live workflow-stage route is owned by another active session` | Another connected session already owns this exact stage. | Transient when the previous attempt's session is still being torn down; a genuinely live duplicate owner is refused on every attempt and the stage fails after the bounded retries. |
| `… capability does not match the workflow owner` / `… registrant is outside the workflow invocation group` / `… name a non-agent workflow node` | Authority or configuration mismatch. | Terminal for that stage startup; it repeats identically on retry. |

A stage name reused by a later occurrence in the same run (for example `reviewer-a` in a second review round while the first round's completed session is still connected) is not a duplicate owner. The later stage registers under its stage id, and the reused name is ambiguous: neither occurrence keeps a live name alias, so a send to that name is routed through the workflow owner rather than delivered to whichever occurrence registered first. Address such stages by the id-form target that `intercom list` shows.

## How It Works

The local broker starts on first use and exits after five seconds without registered sessions. Clients reconnect automatically using delays of 1, 2, 5, 10, then 30 seconds. Explicit connection failures remain visible while background recovery continues.

If the broker stops answering health requests for about a minute, it terminates itself so clients can start a replacement. A single slow request does not restart a responsive broker. This protection starts with a newly launched broker; a broker still running from an older Atomic version must restart before it gains it. A process suspended by the operating system cannot run its own recovery. If it remains stuck, verify which process owns the broker before stopping it manually. Do not delete the Intercom database or key files.

If workflow-stage warm-up exhausts its retries, a stage with queued messages fails without consuming them or spending a model retry. Restore broker availability before retrying the work. Protocol, authentication, configuration, and terminal delivery failures require attention rather than a model change.

For `send`, `ask`, and `reply`, the tool owns reconnect recovery. One invocation makes the initial attempt and up to three retries, waiting 1, 2, then 5 seconds between attempts. Retries preserve the original message ID, caller arguments, attachment order and presence, and reply thread. The model neither supplies nor receives a retry token. Every new invocation is a fresh intentional operation, even with identical text. Existing integrations must stop passing `retryToken`; caller-supplied tokens are refused without sending.

Initialization may retry before delivery begins. Exhaustion or cancellation there returns `outcome: "not_sent"`.

Recoverable disconnects trigger retries; unrelated errors stop them. Cancellation stops new attempts but does not undo a successful receipt. Retry and reply waits share the original 11-minute operation deadline.

`delivered` means the recipient saved the message to its session. A message saved by a busy recipient is shown when it goes idle, as before; if the recipient is killed or crashes first, resuming its session shows each saved message once, in arrival order, after the transcript appears. Saved messages go through the same sender check as interrupted deliveries: one from a sender that is still connected is shown and may start a turn, one from a sender that is gone is added once, in full, to the session history without starting a turn, and the recovery notice says the sender is gone. One whose sender cannot be checked is deferred until the session is opened again: Intercom was unreachable, or the sender is a relaunched subagent that has not reconnected yet. If the recipient does not confirm the save within about 8 seconds, the sender gets a failure saying the outcome is uncertain: the recipient may still save and show the message. Check with the recipient before sending it again as a new message. Intercom's own retries reuse the original message ID, and a recipient that already saved a message does not show it twice. A recipient that disconnects before confirming receives the message again when it reconnects. While a broker started by an earlier Atomic version is still running after an upgrade, `delivered` keeps its earlier meaning, that the message reached the recipient, and the recipient still saves it on arrival; the broker exits when idle, and the next one uses the new meaning.

`outcome: "unknown"` means delivery may have occurred, including an accepted ask that ended without a reply. **Check with the recipient before sending again.** A new tool invocation is a new operation, not another retry of the old one.

Intercom refuses new delivery when it cannot safely track duplicates, including capacity or storage failures. Do not delete its runtime files to force a resend when an outcome is unknown. Transport remains local to this machine.

Custom hosts may declare an optional `recipientPurpose` on session registration and workflow-stage roster entries. Only `"agent"` and `"control"` are accepted; omission preserves legacy agent behavior. Invalid strings, `null`, and non-string values are rejected, not silently treated as controls. Session purpose is immutable after registration; presence updates cannot change it. Workflow roster-update completion waits for a broker round trip on the announcing connection so subsequent discovery does not race an unprocessed update.

Configuration and diagnostics live in `~/.atomic/agent/intercom/`, or under `ATOMIC_CODING_AGENT_DIR`. The legacy `PI_CODING_AGENT_DIR` applies when the Atomic variable is unset. Edit `config.json` for [Intercom settings](/intercom/reference#configuration).

When startup fails, read the `broker.log` path printed in the error. Ordinary diagnostics are capped at 8 KiB per broker. The next spawn keeps a bounded copy in `broker.log.previous`; `broker-watchdog.log` separately retains the latest automatic termination's time, PID, and reason. Preserve these files when reporting repeated stalls or restarts. They live under the Intercom directory above.

## Workflow and Subagent Notifications

Intercom is also the delivery channel for workflow run results and subagent control notices from [workflows](/workflows) and [subagents](/subagents).

### Workflow Delivery Modes

Programmatic `workflow()` calls accept an `intercom` option that controls how asynchronous direct-run results and control notices reach a parent session:

```typescript
workflow({
  tasks: [{ agent: "worker", task: "..." }],
  intercom: { delivery: "result" },
})
```

| Option | Values | Meaning |
|--------|--------|---------|
| `enabled` | boolean | `false` forces delivery off; `true` resolves to `control-and-result` |
| `delivery` | `"off"` \| `"notify"` \| `"result"` \| `"control-and-result"` | Explicit delivery mode; wins over `enabled` |
| `parentSession` | string | Target session for delivery; resolved from args or the Intercom port when omitted |
| `notifyOn` | array | Control events to deliver: `"active_long_running"`, `"needs_attention"`, `"completed"`, `"failed"` |

When neither `enabled` nor `delivery` is set, direct `parallel` runs default to `control-and-result` when Intercom is available; otherwise delivery is off. Treat Intercom payloads from direct runs as user-visible workflow output.

Live workflow stages process incoming messages as priority input, cancelling the current model call or cancellable tool first. A child's message releases its parent's foreground wait without cancelling the child. Admission failures return an actionable error to a blocking asker instead of waiting ten minutes. Claimed single-child parent handoffs still end that child.

### Subagent Control Notices

The `subagent` tool's `control` options select which control events notify the parent and over which channels:

- **`notifyOn`** — defaults to `["active_long_running", "needs_attention"]`
- **`notifyChannels`** — defaults to `["event", "intercom"]` (all that are available)

Run results report each child's Intercom target as "Run intercom target" or "Previous intercom target"; a target may be inactive after completion. Use `intercom({ action: "status" })` to inspect connection state and memberships.

For live peer coordination, call `intercom({ action: "status" })` in the parent before launching. Children connect on first use. Fresh children receive Intercom even when an extension allowlist omits it.

### Delivery Ordering

Parallel communication does not cancel the batch. A blocking ask waits only in its requesting child; the correlated reply continues that same execution. Sends and progress updates remain nonblocking. Claimed single-child parent asks retain their terminal fresh-start handoff.

Queued messages from a child arrive before its completion notice. Delivery retries do not rerun work or change its outcome.

## Running Intercom across machines

By default, each machine's broker serves only the sessions on that machine. With multi-node routing, brokers on different machines that use the same shared storage database deliver messages to each other through it. Sessions still connect only to the broker on their own machine, and brokers never connect to each other: they read and write the shared database.

### Turning it on

Give every machine the same shared top-level `storage` selection, including the same `prefix`. To reach other machines, the selection must be an [adapter](/storage#selecting-an-adapter) whose module implements `openDatabase` and connects to a database that every machine can reach, as described in [Sharing storage across hosts](/storage#sharing-storage-across-hosts). Install the adapter on every machine, for example as an [Atomic package](/storage#adapters-from-atomic-packages) so that `atomic install` also brings its driver.

Both the npm installation and the standalone binary run multi-node routing and load storage adapters.

The broker takes its selection from one of two places:

- `--storage`, `--storage-file`, or `ATOMIC_STORAGE` on the Atomic process that starts the broker. See [Selecting storage per process](/storage#selecting-storage-per-process).
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

One broker serves every session in an agent directory and keeps the selection it started with until it exits. After changing the selection, close the Atomic sessions on that machine. The broker exits five seconds after its last session disconnects, and the next session that uses Intercom starts one with the new selection.

Multi-node routing stays off, and Intercom behaves exactly as on a single machine, when the selection is:

- absent, including when only project settings (`.atomic/settings.json`), `sessions.storage`, `workflows.journal`, `ATOMIC_SESSIONS_STORAGE`, or `ATOMIC_WORKFLOWS_JOURNAL` select storage;
- in memory: `{ "memory": true }` or `{ "path": ":memory:" }`;
- an adapter that implements only `openSessionStore` or `openRunJournal` and has no `openDatabase`;
- invalid, for example an `env` secret that is not set in the broker's environment, or an adapter module that cannot be loaded. The broker then writes `Intercom multi-node routing is off: <reason>` to `broker.log`.

A `path` selection, including the default storage file, is a local SQLite file. Only brokers on the same machine that open the same file share it. Do not put it on a network filesystem.

Intercom creates its own tables in the selected database, named with the selection's `prefix` like the session and workflow tables. Brokers that use different prefixes cannot see each other's sessions, so a prefix also separates teams or tenants that share one database.

### What works across machines

A session connected to a broker on another machine appears in `intercom list` and is messaged exactly like a local one:

- `send`, `ask`, and `reply` keep the same sender identity, reply threads, and `delivered` meaning: `delivered` still means the recipient saved the message.
- Group isolation is the same. A session sees and reaches only sessions that share a group with it.
- Supervisor messages from `contact_supervisor` keep their supervisor routing.
- A send to a subagent that its owner is restoring on another machine is held, and reports the same errors, exactly as on one machine. See the [connection states](#connection-states-and-recovery) table.
- Duplicate protection still holds: Intercom's own retries reuse the message ID, and a recipient never shows a message twice.

When a session on this machine and one on another machine have the same name, the name reaches the local one. Give sessions unique names, or address them by session ID.

### Latency

Brokers wake each other through the shared database. Each broker checks it for wake-ups every half second, so a message to a live session on another machine usually arrives within about half a second plus the database round trips, and its `delivered` confirmation takes about as long again. A slow or distant database adds to each step.

If a wake-up is missed, a backup check every 30 seconds finds the message, so delivery can take up to about 30 seconds. A sender waits about 8 seconds for a live recipient to confirm, then gets the uncertain-outcome failure described in [How it works](#how-it-works). The message is still delivered once. Check with the recipient before sending it again as a new message.

Sessions on the same machine do not depend on the shared database. Before delivering locally, the broker checks the database for an earlier cross-machine attempt of the same message, and waits at most 0.3 seconds for it, including while the database is still opening when the broker starts. Connecting to Intercom waits at most 5 seconds for the database, and `intercom list` waits at most 2 seconds for sessions on other machines before it shows the local ones alone.

### Offline sessions

A session that quit cleanly or crashed stays known to every broker for about 7 days after it was last connected. It does not appear in `intercom list`, but you can still message it by name, Intercom session ID, or Atomic session ID, within the same group rules:

- A send, ask, or reply returns at once as queued, `Message queued for <target>`, with `target: "offline session"` in the result details. An ask does not wait for an answer.
- The message stays in the shared database and is delivered, in order, when that same Atomic session connects to Intercom again with the same home group, on any machine that uses the same storage.
- The broker reports the later delivery only to a sender that is still connected. The tool result that already returned stays queued, so check with the recipient if you need confirmation.

A target that no session has used in that time, or never used, still returns `Session not found`.

When a whole machine or its broker stops, its sessions still look connected for up to about 30 seconds. A send to one of them in that window waits about 8 seconds and ends with the uncertain-outcome failure; after it, sends are queued. Any message one of those sessions had not yet confirmed is delivered again when it reconnects, and shown once.

### Data and security

- Message text and attachments are stored in the shared database until they are delivered, together with the sender's identity. Delivered messages are deleted about 12 minutes later, which keeps duplicate protection for retries. Messages for an offline session stay until it reconnects.
- Session names, session IDs, and group memberships are stored there too, so brokers can list and route to sessions on other machines.
- Anyone who can read the database can read Intercom messages that cross machines, just as they can read sessions stored there. Protect it with the database's own credentials and transport security, and pass credentials through `secrets` (`{ "env": ... }` or `{ "file": ... }`) rather than `options`. The broker reads `env` secrets from the environment of the Atomic process that started it.
- Intercom opens no network port and no broker-to-broker connection. Its security across machines is the database's security.

### Troubleshooting multi-node

**A session on another machine does not appear in `intercom list`.**

- Check that both machines use the same storage selection and the same `prefix`, from settings or from the process that started each broker. A broker started before you changed the selection keeps the old one until it exits.
- Check `broker.log` on both machines for `Intercom multi-node routing is off: <reason>` or `Intercom multi-node routing is unavailable: <reason>`. An absent, in-memory, or domain-only selection stays off without a message, and a `path` selection reaches only brokers on the same machine.
- A session appears only after it connects to Intercom, which happens lazily. Ask it to use Intercom once, for example `intercom({ action: "status" })`.
- Both sessions must share a group.
- When the database is slow to answer, `intercom list` shows only local sessions. Try again.

**A send stays queued.** The recipient is offline. It receives the message when the same Atomic session connects to Intercom again with the same home group, on a machine that uses the same storage and prefix. A session reopened on a machine with a different selection never sees it.

**The database is unavailable.** Messages between sessions on the same machine keep working. A send to a session on another machine fails with `Session not found on this node, and Intercom could not reach the shared storage database to look for it on other nodes. Try again once the database is available.` If the database cannot be opened when the broker starts, the broker logs `Intercom multi-node routing is unavailable: <reason>` and retries after 1 second, doubling up to every 30 seconds. Intercom never falls back to in-memory storage. If sends keep failing after the database is back, close the sessions on that machine so that a new broker starts.

**An ask to a session on another machine never gets an answer.** If that session disconnects before it answers, the asker is not told, and waits until the ask times out after 10 minutes.

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
- **Broker lifecycle** — The broker auto-spawns on first use and exits when idle; sessions reconnect automatically if it restarts
- **Unsaved sessions** — A session started with `--no-session` keeps received messages only in memory; if it exits before showing them, they are lost
- **Paused or quit subagent** — A send or ask to a subagent you paused with `subagent({ action: "pause" })` waits until you resume it, but only while the Atomic process that paused it keeps running. After a restart, or for a subagent you quit, sends return `Session not found` until you resume it with `subagent({ action: "resume", id, message? })`. See [Run control](/subagents#run-control)
- **Subagent whose owning process is not running** — Sends to a subagent are held only while an Atomic process that owns it is running: the reopened session for a plain session's subagent, the session that launched the run for a workflow stage's subagent (once the crashed session's lease has expired, about 120 seconds, and the run is addressable). Atomic keeps no durable mailbox for a subagent. While no such process runs, for example before the owning session is reopened, a send to the subagent is not queued and returns `Session not found`, the same as for a top-level session that is not running. The same applies for the few milliseconds after the owning session connects to Intercom and before it has placed its hold. Sends are also not held for a stage's subagent whose stage session cannot be read, or for a subagent that cannot use Intercom. A hold that nothing restores ends on its own: after 60 seconds for a session whose host does not run recovery, such as `atomic -p`, and when its owning session disconnects
- **Offline sessions with multi-node routing** — With [multi-node routing](#running-intercom-across-machines) on, a send to a session that disconnected within about the last 7 days, including a subagent's session, is queued for it instead of returning `Session not found`, unless one of the holds above applies first. See [Offline sessions](#offline-sessions)
