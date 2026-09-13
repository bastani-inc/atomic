---
title: Intercom reference
description: The intercom tool contract and every intercom setting.
---

# Intercom reference

## The intercom Tool

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `"list"`, `"groups"`, `"join"`, `"leave"`, `"send"`, `"ask"`, `"reply"`, `"pending"`, or `"status"` |
| `to` | string | Exact session name/full session ID, or `workflow:<rootRunId>/<segment>[/<segment>...]`; `*` matches one segment and `**` any depth. Sends support pending/future patterns and broadcast; `ask` requires a live target. |
| `message` | string | Message text (for send/ask/reply) |
| `attachments` | array | Optional `file`, `snippet`, or `context` attachments |
| `replyTo` | string | Optional message ID for threading or replying to an `ask` |
| `group` | string | Group name for `join` or an optional targeted `leave`; read-only group filter for `list`/`status`. `send`/`ask` remain limited to shared memberships. |

### Actions

| Action | Behavior |
|--------|----------|
| `join` | Adds a trimmed named group membership and creates the group if needed. The action waits for broker acknowledgement and reports the complete resulting membership set. `default` is shared; `true` and `auto` are reserved for subagent auto-groups. |
| `leave` | With `group`, removes only that membership and keeps all others. Without `group`, resets the session to its resolved startup home group. Both forms report the resulting membership set. |
| `groups` | Lists every group represented by a connected session, with its session count and a marker for each group this session belongs to. Use it to discover names rather than guessing. |
| `list` | Returns the current session, active sessions sharing a membership, materialized workflow stages labeled `PENDING` or `RUNNING` with canonical path targets, and possible future literals, globs, and child paths with queued counts. Pass `group` for a read-only view of one group. |
| `send` | Fire-and-forget delivery through ordinary Intercom. A live workflow-stage match receives the message immediately. A pending, future, name, or pattern path is persisted as sticky delivery and returns `queued`; valid paths outside the known set also return `notInKnownSet`. Requires `to` and `message`; cannot message the current session. |
| `ask` | Sends a message and blocks until a live recipient replies (10-minute timeout). An ask to a known workflow stage whose session has not initialized is refused with `pending_stage_ask_unsupported` and recommends ordinary `send`; holding a waiter until a stage eventually starts would be unbounded. A live recipient disconnect fails promptly. Parallel children continue in the same execution after a correlated reply; single-child parent handoffs remain unchanged. |
| `reply` | Replies to the intercom-triggered message of the current turn; otherwise falls back to the single unresolved inbound ask. With multiple pending asks, pass `to` or inspect with `pending` first. |
| `pending` | Lists unresolved inbound asks with sender, message ID, elapsed time, and a short preview. |
| `status` | Shows connection status, session ID, every group this session belongs to, and the count of active sessions visible through those memberships. A `group` filter remains a read-only peek. |

To give two plain chat sessions a private shared membership, have both call:

```typescript
intercom({ action: "join", group: "api-review" })
```

Joining is additive: existing memberships remain active, and the broker updates presence without changing the session ID. Use `intercom({ action: "groups" })` to discover all available names and membership markers. `intercom({ action: "leave", group: "api-review" })` removes only that membership; `intercom({ action: "leave" })` resets to the home group resolved at startup. Rejected or unacknowledged changes leave client and inheritance state unchanged. Ordinary delivery requires a shared membership, while `contact_supervisor` retains its capability-based cross-group path.

An ordinary host session can join several workflow invocation groups and send to
each group's `workflow:<rootRunId>/**` target, including after a broker reconnect.
Reconnection preserves the session's startup identity separately from its joined
memberships; joining a workflow does not turn the host into a workflow worker.
Groups explicitly left stay absent after reconnect; the startup identity is not
automatically added back to the membership list.
Actual workflow workers retain their original invocation boundary across reconnects:
joining another group does not grant that invocation's parent-control authority.

Sent and received messages are recorded in session history as `intercom_sent` / `intercom_received` entries.

### Targeting Sessions and Pending Workflow Stages

Live-session lookup accepts only an exact full Intercom session ID or an exact case-insensitive session name. Workflow stages use the canonical `workflow:<rootRunId>/<segment>[/<segment>...]` path printed by `intercom list` and workflow status surfaces; an exact target works while the row is `PENDING` and after it becomes `RUNNING`. Each segment may be a stage name, run id, or glob: `*` matches one segment and may be embedded, while `**` matches any depth. Status surfaces label pending stages whose pre-start delivery capability is unavailable without presenting a usable target and never advertise a retained pending stage after its run terminates. The `sessionId` shown by `workflow status` belongs to the workflow SDK and is **not** an Intercom target.

Agent list rows put the copyable exact ID or canonical workflow path first, followed by status and working directory. Meaningful names remain secondary metadata; redundant generated aliases are hidden only in the list, not removed from lookup. Pending and future workflow rows retain lifecycle and queued counts. Copy the target rather than reconstructing it from a name.

Known non-agent IDs, names, and workflow paths are refused rather than delivered or queued for a future agent. This includes run-level `ctx.ui` prompts, synthetic prompt stages (including retained completed prompts), and `ctx.tool` nodes. Knowing an internal connection's ID does not bypass this broker policy, and supervisor delivery cannot bypass it either. Workflow patterns and `workflow:<rootRunId>/**` still queue for future agent stages, but never deliver to prompt/tool nodes or routing connections.

This refusal also covers nested paths using boundary-stage names or IDs, mixed with materialized run-ID segments. The same spellings still resolve genuine agent stages.

A genuine agent's registered aliases remain valid when its pending-delivery capability is unavailable or its stage completes, even if a non-agent node shares its display name. The host retains that agent identity separately from discovery eligibility so aliases can be restored after an agent or broker reconnect. An agent's human-input wait is not a model-less `ctx.ui` node.

If several live agent stages share a workflow-stage name, `ask` remains ambiguous: use an exact stage-ID path from `intercom list`. Name-based `send` retains sticky delivery to matching agents. A prompt or tool with that same name does not turn genuine-agent matches into non-agent refusals.

Before steering a stage from the main chat, enter the workflow invocation context by joining `workflow:<rootRunId>` with `intercom({ action: "join", group: "workflow:<rootRunId>" })`; workflow-owned invocation sessions already start there. A member of that invocation group can list, `send` to, and live-`ask` exact stages in any invocation-owned subgroup (`workflow:<rootRunId>/<name>`), including intentionally isolated reviewer batches. This control is directional: a session registered as a subgroup stage cannot gain parent control by joining the invocation group, subgroup members cannot discover or reach sibling subgroups, and another workflow invocation remains refused. `PENDING` accepts queued `send` only; `RUNNING` accepts immediate `send` and correlated `ask`/`reply`.

### Deferred delivery to pending stages

Send material updates through Intercom to every affected workflow stage, including stages that have not started. Inside `workflow:<rootRunId>`, `intercom list` shows live sessions, materialized `PENDING`/`RUNNING` stages, and possible future literal, glob, and nested-child targets with queued counts. A deferred send returns `queued`, including its FIFO position, rather than claiming delivery; live matches receive the ordinary inbound message immediately.

Name and pattern paths remain sticky for every future matching stage until the root terminates. When shared scope or acceptance criteria change, broadcast one authoritative update to `workflow:<rootRunId>/**` (or a narrower path pattern) rather than enumerating stages: `**` reaches every live stage now and every future descendant. A syntactically valid path outside the persisted known set still queues and returns `notInKnownSet`; if it never delivers, root-terminal settlement sends the correlated undeliverable notification. A sticky entry delivered at least once is not reported undeliverable.

The workflows extension persists up to **50 queued messages per target** with workflow state. Messages survive resume/replay and broker restart, and logical message IDs prevent redelivery to the same materialized stage across stage-attempt restarts. When a matching stage session initializes, it receives the FIFO entries through the ordinary Intercom inbound path before its first model turn, under the heading **Messages received before you started**, with sender identity and `Sent:` timestamps visible separately from the task prompt.

Only a workflow invocation member with eligible invocation-control authority can queue to its invocation-owned stages; this includes a main-chat session that explicitly joined `workflow:<rootRunId>`. Subgroup peers and another root run remain refused even if they add that membership. An explicit stage `group: "default"` is a shared-group escape, is not workflow-owned, and does not receive pending invocation delivery. An ineligible attempt is refused with `Target workflow run is in a different intercom group`. The 51st queued message is refused with `Pending stage message queue is full (limit 50)` rather than evicting an earlier entry.

If the destination stage is skipped, the run terminates, or the stage becomes terminal before its session initializes, Atomic marks the queued message undeliverable and sends the correlated failure notification when acknowledgment was requested. Use `ask` only on a live, reply-capable exact target. Pending, future, and pattern asks return `pending_stage_ask_unsupported`; use ordinary `send`, because a stage may start much later or never start.

### Groups

Every session belongs to a non-empty set of intercom **groups**. Sessions with no group configured retain exactly the legacy behavior: they belong only to the implicit `"default"` group and can see and message each other. A session can ordinarily discover, resolve, and message another session when their membership sets intersect; exact-ID sends with no shared membership are rejected by the broker.

- `list` still lists sessions. Without a filter it returns the union of sessions visible through any of your memberships; with `group`, it gives a read-only view of that one group.
- `groups` lists every currently available group, its connected-session count, and whether this session is a member.
- `join` adds one membership. `leave` removes the named membership, while bare `leave` resets the complete set to the startup home group.
- `status` reports the complete membership set. `session_joined`/`session_left`/`presence_update` events are delivered whenever a membership change affects visibility.

A session's home group is resolved with this precedence: explicit stage/task/subagent group > runtime-owned workflow invocation group or inherited launching-session group > env `ATOMIC_INTERCOM_GROUP` (legacy `PI_INTERCOM_GROUP`) > Intercom `config.json` `"group"` > `"default"`. Workflow stage named groups and `group: true` are namespaced under `workflow:<rootRunId>/...`, preventing cross-run collisions while preserving sibling isolation. `group: "default"` remains the explicit non-owned escape. The invocation group has asymmetric exact-target control over its owned subgroups; ownership does not grant reverse or lateral access.

The broker, not the client, marks validated supervisor traffic. Ordinary `send` frames remain membership-isolated even if a raw client forges a supervisor marker, and replies cross back only through an exact broker-recorded `replyTo` match. Parent-held authorization state is restored after reconnects. During child admission, the parent wrapper may lazy-load and connect the broker provider to mint that exact child's capability. The child still connects only when it uses an Intercom delivery path. Single-child claimed decisions or interviews terminally hand off before child send or waiter admission; parallel requests use the broker and correlated reply wait. A claimed provider failure aborts launch, while runtimes with no provider omit supervisor metadata and do not expose a broken channel.

### send vs ask vs reply

**`send`** is fire-and-forget — the tool returns immediately after delivery. By default it sends immediately, including in interactive sessions. If you want an approval dialog before non-reply sends, set `confirmSend: true` in config; replies that include `replyTo` still skip confirmation so reply-hint flows continue without an extra approval step.

**`ask`** sends the message and blocks until the recipient responds (10-minute timeout). If the recipient disconnects after delivery, only the exact ask to that peer fails promptly; the timeout remains the backstop for a connected but unresponsive recipient. Up to `maxPendingAsks` waits (default: 6) may run concurrently, including same-target and mixed-target fan-out. Exact sender/message correlation keeps out-of-order replies and selective disconnects from cross-settling another call. Parallel children use this path even when asking their launching parent: only the requester waits, siblings keep executing, and the reply returns from the waiting tool call in the original child execution. A single-child launch retains the exception that a claimed parent ask ends that child and returns a dynamic `[TASK_CONTEXT]` handoff.

An `idle` registration does not guarantee reply capability. Completed, failed, interrupted, or cancelled noninteractive subagent children reject new asks immediately with `Target noninteractive child is terminal and cannot reply`; launch a fresh child with explicit context instead. If termination wins after admission but before a reply, the exact pending ask fails explicitly too. Live interactive idle sessions remain askable, and completed workflow stages with a retained reply-capable post-mortem conversation keep their existing reopening behavior. `send` transport behavior is unchanged; a retained registration is not a promise that a terminal child's model will consume a send.

**`contact_supervisor`** keeps a narrower policy: one blocking decision/interview wait per child may coexist with ordinary peer asks, but a second concurrent supervisor wait receives `Already waiting for a supervisor reply`. Claimed foreground handoffs allocate no waiter. Mutual peer asks are supported, although both sessions must process inbound work to reply; the per-waiter timeout remains the backstop.

**`reply`** is receiver-side sugar for replying to an inbound ask. In the turn triggered by an incoming intercom message, `intercom({ action: "reply", message: "..." })` targets that exact sender and message automatically. If you reply later, it falls back to the single unresolved inbound ask; with multiple pending asks, use `pending` and pass `to`, or pass the listed message ID as `replyTo` to disambiguate multiple asks from the same sender. Under the hood this is still a normal `send` with the exact `replyTo` value.

Explicit selectors override the active turn: `to` selects a pending ask from that exact name/full session ID, and `replyTo` selects only that pending ask or the exact active ordinary message. Stale, unknown, or empty thread IDs fail without falling back. If both selectors are supplied, the sender must match the thread. If an asker is still waiting, inspect `pending` and reply using its exact message ID rather than replying implicitly to an unrelated notification. Multiple asks from the same sender require `replyTo`.

### Attachments

`send`, `ask`, and `reply` accept an `attachments` array of `{ type, name, content, language? }` objects where `type` is `"file"`, `"snippet"`, or `"context"`. Attachment content is included in the recipient's agent-visible message body. When a parent-targeted foreground `ask` is terminally handed off at the source, the same ordered attachment array is retained and rendered with the question for the launching parent; duplicate names and content are not rewritten. Attachments are supported in the protocol but not in the ALT+M compose overlay.

## Configuration

Create `~/.atomic/agent/intercom/config.json`. The legacy `~/.pi/agent/intercom/config.json` fallback is read when the Atomic config is absent:

```json
{
  "brokerCommand": "npx",
  "brokerArgs": ["--no-install", "tsx"],
  "confirmSend": false,
  "replyHint": true,
  "status": "researching",
  "group": "default"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `brokerCommand` | `"npx"` | Command used to start the local broker process; the default sentinel is hardened internally to avoid PATH lookup |
| `brokerArgs` | `["--no-install", "tsx"]` | Arguments passed to `brokerCommand` before the broker script path |
| `confirmSend` | `false` | Show a confirmation dialog before non-reply sends from an interactive session with UI |
| `replyHint` | `true` | Include reply instruction in incoming messages |
| `status` | — | Optional custom status suffix shown after the automatic lifecycle status, for example `thinking · researching` |
| `group` | `"default"` | Home intercom group for this session (see [Groups](/intercom/reference#groups)). Overridden by env `ATOMIC_INTERCOM_GROUP` / `PI_INTERCOM_GROUP` and by workflow/orchestrator per-session injection. |

The default `npx --no-install tsx` pair is a compatibility sentinel: Intercom recognizes it and starts the broker through the current Atomic runtime (`process.execPath`). It never resolves or executes `tsx` — Node-based installs run the broker with Atomic's bundled `jiti` loader, which is dependency-free pure JavaScript; Bun source-checkout runs use the current Bun executable directly; standalone Atomic binaries re-enter the split launcher through a narrow internal broker handoff. Default startup therefore does not rely on `npx`, `tsx`, or `bun` being on `PATH`. Explicit custom broker commands still work — for example, to intentionally use Bun from `PATH`:

```json
{
  "brokerCommand": "bun",
  "brokerArgs": []
}
```

Config validation is strict: every field is checked, and if the file is not valid JSON or any field has an invalid value, the whole config is rejected — an error is logged and all defaults are used.

Intercom publishes live session status automatically: sessions register as `idle`, switch to `thinking` while the agent is running, show `tool:<name>` during tool execution, and return to `idle` on completion. A configured `status` is appended as context instead of replacing the lifecycle status.

Activity is not reply capability. Session rows include `replyCapability: live` or `terminal` when the host supplies it; terminal noninteractive children cannot answer asks even if activity says `idle`. Closed workflow generations show `closed · reply: post-mortem only` when a late-message router is present, or `closed · reply: unavailable` without one. Post-mortem routing still validates the retained conversation and can return a bounded error if it is unavailable; it never resumes workflow execution. Missing capability metadata is not a guarantee that an ask can succeed. Invocation/subgroup visibility and stale-ID rejection are unchanged.

For a retained post-mortem conversation, use its exact Intercom session ID or the previously listed canonical stage path, including its final-stage-name variant. Alternate materialized run-ID paths resolve active stages through the workflow owner; they are not retained aliases after the stage completes. A stage marked `reply: unavailable` rejects an ask with guidance to contact a live stage or start new work with explicit context.
