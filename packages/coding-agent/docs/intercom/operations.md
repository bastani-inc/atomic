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
| Broker does not start | The startup or readiness error quotes the broker log path and includes a bounded tail. | Read `~/.atomic/agent/intercom/broker.log`, or the equivalent path below `ATOMIC_CODING_AGENT_DIR`. See [How it works](#how-it-works). |
| Half-closed peer or undeliverable send | The send returns `Session not found`; its message id remains retryable. | Refresh the session list and retry after the target reconnects. See [How it works](#how-it-works). |
| Subagent being restored after a restart | A send or ask to a background subagent that its owner will restore, or is restoring, waits instead of returning `Session not found`. For a plain session's subagent this holds from the moment its reopened session starts. For a subagent of an interrupted workflow stage it holds from the moment the session that launched the run is back and the run is addressable, until the stage, once running again, restores it. It holds for the owner and for any session in the subagent's group, whether the message uses the subagent's name, its Atomic session ID, or the Intercom session ID it had before the restart. The name and Atomic session ID are held from the first moment; the pre-restart ID is held once the owner has read it from the subagent's own session, usually within a fraction of a second. Each waiting message is delivered once, in the order it was sent, when the subagent reconnects. If the subagent has not reconnected within 20 seconds, the sender gets a "still being restored" error. If the subagent did not survive the restart, the sender gets an explicit "did not survive the restart and is gone" error. If another Atomic session takes over the interrupted run, the senders waiting for its subagents get an error saying so. None of these returns `Session not found`. | Retry later if the subagent has not reconnected yet, launch a new subagent if the old one is gone, or send again to the session that took over the run. See [How it works](#how-it-works). |

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

If workflow-stage warm-up exhausts its retries, a stage with queued messages fails without consuming them or spending a model retry. Restore broker availability before retrying the work. Protocol, authentication, configuration, and terminal delivery failures require attention rather than a model change.

For `send`, `ask`, and `reply`, the tool owns reconnect recovery. One invocation makes the initial attempt and up to three retries, waiting 1, 2, then 5 seconds between attempts. Retries preserve the original message ID, caller arguments, attachment order and presence, and reply thread. The model neither supplies nor receives a retry token. Every new invocation is a fresh intentional operation, even with identical text. Existing integrations must stop passing `retryToken`; caller-supplied tokens are refused without sending.

Initialization may retry before delivery begins. Exhaustion or cancellation there returns `outcome: "not_sent"`.

Recoverable disconnects trigger retries; unrelated errors stop them. Cancellation stops new attempts but does not undo a successful receipt. Retry and reply waits share the original 11-minute operation deadline.

`delivered` means the recipient saved the message to its session. A message saved by a busy recipient is shown when it goes idle, as before; if the recipient is killed or crashes first, resuming its session shows each saved message once, in arrival order, after the transcript appears. If the recipient does not confirm the save within about 8 seconds, the sender gets a failure saying the outcome is uncertain: the recipient may still save and show the message. Check with the recipient before sending it again as a new message. Intercom's own retries reuse the original message ID, and a recipient that already saved a message does not show it twice. A recipient that disconnects before confirming receives the message again when it reconnects.

`outcome: "unknown"` means delivery may have occurred, including an accepted ask that ended without a reply. **Check with the recipient before sending again.** A new tool invocation is a new operation, not another retry of the old one.

Intercom refuses new delivery when it cannot safely track duplicates, including capacity or storage failures. Do not delete its runtime files to force a resend when an outcome is unknown. Transport remains local to this machine.

Custom hosts may declare an optional `recipientPurpose` on session registration and workflow-stage roster entries. Only `"agent"` and `"control"` are accepted; omission preserves legacy agent behavior. Invalid strings, `null`, and non-string values are rejected, not silently treated as controls. Session purpose is immutable after registration; presence updates cannot change it. Workflow roster-update completion waits for a broker round trip on the announcing connection so subsequent discovery does not race an unprocessed update.

Configuration and diagnostics live in `~/.atomic/agent/intercom/`, or under `ATOMIC_CODING_AGENT_DIR`. The legacy `PI_CODING_AGENT_DIR` applies when the Atomic variable is unset. Edit `config.json` for [Intercom settings](/intercom/reference#configuration).

When startup fails, read the `broker.log` path printed in the error. The log is replaced on each broker spawn and ordinary broker diagnostics are capped at 8 KiB, so capture relevant output before retrying.

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

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| ALT+M | Open session list overlay |
| ↑/↓ | Navigate session list |
| Enter | Select session / Send message |
| Escape | Cancel / Close overlay |

## Limitations

- **Same machine only** — Uses local sockets/pipes, no network support
- **No dedicated intercom log** — Messages are kept in session history; there is no separate intercom transcript or inbox
- **No attachments UI** — `file`, `snippet`, and `context` attachments are supported in the protocol, but not in the compose overlay
- **Only connected sessions appear** — The list shows sessions that have connected to the broker, not every open Atomic process
- **Broker lifecycle** — The broker auto-spawns on first use and exits when idle; sessions reconnect automatically if it restarts
- **Unsaved sessions** — A session started with `--no-session` keeps received messages only in memory; if it exits before showing them, they are lost
- **Subagent whose owning process is not running** — Sends to a subagent are held only while an Atomic process that owns it is running: the reopened session for a plain session's subagent, the session that launched the run for a workflow stage's subagent (once the crashed session's lease has expired, about 120 seconds, and the run is addressable). Atomic keeps no durable mailbox for a subagent. While no such process runs, for example before the owning session is reopened, a send to the subagent is not queued and returns `Session not found`, the same as for a top-level session that is not running. The same applies for the few milliseconds after the owning session connects to Intercom and before it has placed its hold. Sends are also not held for a stage's subagent whose stage session cannot be read, or for a subagent that cannot use Intercom. A hold that nothing restores ends on its own: after 60 seconds for a session whose host does not run recovery, such as `atomic -p`, and when its owning session disconnects
