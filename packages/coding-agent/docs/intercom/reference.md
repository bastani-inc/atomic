---
title: Intercom reference
description: The intercom tool contract and every intercom setting.
---

# Intercom reference

## The intercom Tool

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `"list"`, `"groups"`, `"join"`, `"leave"`, `"send"`, `"ask"`, `"reply"`, `"pending"`, `"cancel"`, or `"status"` |
| `to` | string | Exact session name/full session ID, unique 8-hex session UUID prefix, or `workflow:<rootRunId>/<segment>[/<segment>...]`; `*` matches one segment and `**` any depth. Sends support pending/future patterns and broadcast; `ask` requires a live target. |
| `message` | string | Message text (for send/ask/reply) |
| `attachments` | array | Optional `file`, `snippet`, or `context` attachments |
| `wait` | object | For `ask`: how long to wait for the reply before yielding, as in `bash`. Omit it for the automatic yield (default 10 seconds), use `{ kind: "foreground", budgetMs }` to wait up to a budget, or `{ kind: "background" }` to return at delivery. |
| `askId` | string | For `cancel`: the ID, or a unique prefix, of one of your pending asks |
| `replyTo` | string | Exact message ID or unique 8-hex UUID prefix of an unresolved inbound ask; resolved before current-turn and pending-ask fallback |
| `group` | string | Group name for `join` or an optional targeted `leave`; read-only group filter for `list`/`status`. `send`/`ask` remain limited to shared memberships. |

### Actions

| Action | Behavior |
|--------|----------|
| `join` | Adds a trimmed named group membership and creates the group if needed. The action waits for broker acknowledgement and reports the complete resulting membership set. `default` is shared, and joining it while multi-node routing is on adds a one-line warning; `true` and `auto` are reserved for subagent auto-groups. |
| `leave` | With `group`, removes only that membership and keeps all others. Without `group`, resets the session to its resolved startup home group. Both forms report the resulting membership set. |
| `groups` | Lists every group represented by a connected session, with its session count and a marker for each group this session belongs to. Use it to discover names rather than guessing. |
| `list` | Returns the current session, active sessions sharing a membership, materialized workflow stages labeled `PENDING` or `RUNNING` with canonical path targets, and possible future literals, globs, and child paths with queued counts. Pass `group` for a read-only view of one group. |
| `send` | Fire-and-forget delivery through ordinary Intercom. A live workflow-stage match receives the message immediately. A pending, future, name, or pattern path is persisted as sticky delivery and returns `queued` with `prediction`: `known`, `predicted` or `unknown`. Requires `to` and `message`; cannot message the current session. |
| `ask` | Sends a message to a live recipient and returns once it is delivered, with `askId`, `delivered`, and `recipient` (`name`, `state` `idle` or `busy`, and `currentAction` when known). A reply within the `wait` comes back inline; otherwise the ask stays pending with no expiry and the reply arrives later as a message. See [send vs ask vs reply](#send-vs-ask-vs-reply). An ask to a known workflow stage whose session has not initialized is refused with `pending_stage_ask_unsupported` and recommends ordinary `send`. Single-child parent handoffs remain unchanged. |
| `reply` | Replies to the intercom-triggered message of the current turn; otherwise falls back to the single unresolved inbound ask. With multiple pending asks, pass `to` or inspect with `pending` first. |
| `pending` | Lists unresolved inbound asks with sender, message ID, elapsed time, and a short preview, and your own asks still waiting for a reply with ask ID, target, elapsed time, and the question. |
| `cancel` | Cancels one of your pending asks by `askId`. A reply that still arrives is shown once, marked late. |
| `status` | Shows connection status, session ID, every group this session belongs to, the count of active sessions visible through those memberships, and the broker's multi-node routing state with the number of other brokers live in the shared database. A `group` filter remains a read-only peek. |

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

Live-session lookup accepts:

- An exact full Intercom session ID.
- An exact case-insensitive session name.
- A unique 8-character hexadecimal prefix of a UUID-backed session ID.
- A connected session's Atomic session ID (the ID `atomic --session` resumes), when exactly one session you can see registered it.

Exact names and IDs take precedence, and an Atomic session ID is tried only after the other forms find nothing. Ambiguous prefixes report only authorized candidates and require the full UUID; other truncations are rejected. An isolated child can select its authorized supervisor by a unique UUID prefix without gaining access to unrelated groups.

A reopened session or a restored background subagent registers under the Intercom session ID it had before the restart, so peers can keep using the ID they saw in `intercom list`. The session records that ID in its history as an `intercom_session_identity` entry. The broker never gives an ID to a new registration while a live session holds it; the restarted session then gets a fresh ID. While the broker remembers who last held an ID, only that same Atomic session can take it back.

Workflow stages use the canonical `workflow:<rootRunId>/<segment>[/<segment>...]` path printed by `intercom list` and workflow status surfaces. An exact target works while the row is `PENDING` and after it becomes `RUNNING`. Each segment may be a stage name, run id, or glob: `*` matches one segment and may be embedded, while `**` matches any depth.

Status surfaces label pending stages whose pre-start delivery capability is unavailable without presenting a usable target. They never advertise a retained pending stage after its run terminates. The `sessionId` shown by `workflow status` is the stage's Atomic session ID, not a workflow path: it reaches the stage only while the stage is connected and visible to you, and it never queues for a pending stage.

Agent list rows put the copyable exact ID or canonical workflow path first, followed by status and working directory. Meaningful names remain secondary metadata; redundant generated aliases are hidden only in the list, not removed from lookup. Pending and future workflow rows retain lifecycle and queued counts. Copy the target rather than reconstructing it from a name.

Known non-agent IDs, names, and workflow paths are refused rather than delivered or queued for a future agent. This includes run-level `ctx.ui` prompts, synthetic prompt stages (including retained completed prompts), and `ctx.tool` nodes. Knowing an internal connection's ID does not bypass this broker policy, and supervisor delivery cannot bypass it either. Workflow patterns and `workflow:<rootRunId>/**` still queue for future agent stages, but never deliver to prompt/tool nodes or routing connections.

This refusal also covers nested paths using boundary-stage names or IDs, mixed with materialized run-ID segments. The same spellings still resolve genuine agent stages.

A genuine agent's registered aliases remain valid when its pending-delivery capability is unavailable or its stage completes, even if a non-agent node shares its display name. The host retains that agent identity separately from discovery eligibility so aliases can be restored after an agent or broker reconnect. An agent's human-input wait is not a model-less `ctx.ui` node.

If several live agent stages share a workflow-stage name, `ask` remains ambiguous: use an exact stage-ID path from `intercom list`. Name-based `send` retains sticky delivery to matching agents. A prompt or tool with that same name does not turn genuine-agent matches into non-agent refusals.

The session that launched a run can list and `send` to its stages without joining. Its own group memberships stay unchanged, so the run's stages gain no route back to it. Any other session steering a stage from the main chat first enters the workflow invocation context by joining `workflow:<rootRunId>` with `intercom({ action: "join", group: "workflow:<rootRunId>" })`; workflow-owned invocation sessions already start there. A send from outside both is refused with an error that names the group to join. A member of that invocation group (or the launching session) can list, `send` to, and live-`ask` exact stages in any invocation-owned subgroup (`workflow:<rootRunId>/<name>`), including intentionally isolated reviewer batches. This control is directional: a session registered as a subgroup stage cannot gain parent control by joining the invocation group, subgroup members cannot discover or reach sibling subgroups, and another workflow invocation remains refused. `PENDING` accepts queued `send` only; `RUNNING` accepts immediate `send` and correlated `ask`/`reply`.

### Deferred delivery to pending stages

Send material updates through Intercom to every affected workflow stage, including stages that have not started. Inside `workflow:<rootRunId>`, `intercom list` shows live sessions, materialized `PENDING`/`RUNNING` stages, and possible future literal, glob, and nested-child targets with queued counts. A deferred send returns `queued`, including its FIFO position, rather than claiming delivery; live matches receive the ordinary inbound message immediately.

Name and pattern paths remain sticky for every future matching stage until the root terminates. When shared scope or acceptance criteria change, broadcast one authoritative update to `workflow:<rootRunId>/**` (or a narrower path pattern) rather than enumerating stages: `**` reaches every live stage now and every future descendant. A syntactically valid path outside the persisted known set still queues, with no warning; if it never delivers, root-terminal settlement sends the correlated undeliverable notification. A sticky entry delivered at least once is not reported undeliverable.

Each queued workflow send carries a `prediction` field. `known` means the launch scan or a started stage covers the path. `predicted` means the decision model expects a stage to match it. `unknown` means neither. The first send to a path the decision model has not judged yet is queued plainly while the model is asked in the background. Once it judged the path unlikely, a later send to that path, in this run or a later run of the same workflow, adds one line: `No stage named <x> is expected; did you mean <closest>?`. Set `intercom.showUnknownTargetWarnings` to `true` in `settings.json` to also add a note to every `unknown` send. Delivery is the same either way.

When the launch scan cannot read a stage name, for example a name built by a helper function, a step factory in another module, a loop over a list, or a child workflow chosen at run time, the decision model ranks candidate names taken from the workflow's source. Accepted names appear in `intercom list` as `[future, predicted 0.92]` rows and become `confirmed` once a matching stage starts. An unmatched name stays `predicted` while the root run is live, because a later child call can still start it. After the root ends, workflow status marks unmatched predictions `unused`. Predictions never change delivery.

The `[future]` queued count is the number of retained sticky messages, not the number unread by a particular stage. A message remains queued for later matches after earlier stages receive it. Inspect the per-stage `deliveryStates` in `intercom list` and `workflow({ action: "status", runId: "<rootRunId>" })` to check receipt or why delivery was skipped. `delivered` confirms admission to stage context, not that the model followed the instruction. `receipt-unverified` means only transport delivery or an older receipt is known; inspect the stage transcript before resending.

`[delivery]` rows retain per-stage evidence for sticky targets missing from the future-target list, including exact targets after materialization. They do not indicate that a stage is still in the future or currently live. Use the per-stage state to decide what to do; an ended stage without confirmed context admission shows `stage-terminal`, even when transport delivery was acknowledged.

Each row in `intercom list`, and each run in `workflow` status, lists at most 5 delivery states. When there are more, the states that still need action come first (`queued`, `receipt-unverified`, `session-replaced`, `delivery-unavailable`, `root-unresolved`, `stage-terminal`), followed by the most recent `delivered` ones. A final line reports how many states were omitted and the total in each state. The `deliveryStateCounts` and `omittedDeliveryStates` fields carry the same totals.

| State | What to do |
| --- | --- |
| `queued` | Wait for the matching stage to finish startup. |
| `session-replaced` | Check startup status. The new session must receive retained context before its first turn. |
| `delivery-unavailable` | Enable Intercom for that stage and keep it in the workflow invocation group. |
| `stage-terminal` | Steer a live stage or start separately authorized work; the ended stage cannot consume the update. |
| `root-unresolved` | Check the reported ownership problem before retrying. Preserve the run ID and diagnostic when reporting it. |

The workflows extension persists up to **50 queued messages per target** with workflow state. Messages survive resume/replay and broker restart. Reusing a stage's existing session transcript does not duplicate acknowledged messages; a replacement session with a new transcript receives the retained sticky context again. When a matching stage session initializes, it receives the FIFO entries through the ordinary Intercom inbound path before its first model turn, under the heading **Messages received before you started**, with sender identity and `Sent:` timestamps visible separately from the task prompt.

Only a workflow invocation member with eligible invocation-control authority can queue to its invocation-owned stages; this includes a main-chat session that explicitly joined `workflow:<rootRunId>`. Subgroup peers and another root run remain refused even if they add that membership. An explicit stage `group: "default"` is a shared-group escape, is not workflow-owned, and does not receive pending invocation delivery. An ineligible session is refused with `Target workflow run is in a different intercom group; join workflow:<rootRunId> to send to its stages`. A workflow stage registered outside the invocation (a subgroup peer or another run's stage) is refused with `A workflow stage in <its group> cannot send to stages of workflow:<rootRunId>; joining that group does not grant it control`, because joining never authorizes it. The 51st queued message is refused with `Pending stage message queue is full (limit 50)` rather than evicting an earlier entry.

If the destination stage is skipped, the run terminates, or the stage becomes terminal before its session initializes, Atomic marks the queued message undeliverable and sends the correlated failure notification when acknowledgment was requested. The notification goes back to the session that sent the message, including the launching session and a session that joined `workflow:<rootRunId>` from another group, and to no one else. Use `ask` only on a live, reply-capable exact target. Pending, future, and pattern asks return `pending_stage_ask_unsupported`; use ordinary `send`, because a stage may start much later or never start.

A workflow run that was interrupted and can continue with `/workflow resume` stays addressable after the Atomic session that launched it restarts. Once the crashed session's lease expires (about 120 seconds), its stages show as pending in `intercom list`, and sends to `workflow:<rootRunId>/<stage>` or `workflow:<rootRunId>/**` are queued and delivered once after `/workflow resume`. Asks are refused while the run is dormant, and only the launching session answers for it.

The background subagents that the run's stages launched stay addressable too. While the run waits, the launching session holds sends to them by name, Atomic session ID, or pre-restart Intercom session ID. When the stage runs again and restores them, it takes the hold over, so each held message is delivered once after the subagent reconnects. If another session takes over the run, it also takes over these targets, and senders still waiting for a subagent get an error that names the other session. A stage whose saved session cannot be read has no held subagents; the stage's own route is unaffected. See [Intercom operations](/intercom/operations#connection-states-and-recovery).

### Released subagents

A [released subagent](/subagents#released-subagents) stays addressable through the session that launched it: that session asks the broker to hold sends to the child's name and ids, and the broker tells it to wake the child when one arrives. Only that session owns the child's hold. The owner is the session that reserved the child first, or the one that authorized it as its supervisor when launching it. A session that reconnects with the same Intercom session id stays the owner. If the owner's connection closes while it keeps a released child, as a [suspended](/workflows/operations#suspended-stages) workflow stage's does, the broker keeps the child's hold for the owner's Atomic session: sends wait up to 20 seconds and then get `recipient_owner_suspended` (see [Subagents with no live session](#subagents-with-no-live-session)). When a session of the same Atomic session reconnects and reserves its released children again, it takes the child over and wakes it for the sends waiting then. Such holds end with their workflow run. Another session cannot reserve, drop or acknowledge the child.

A background subagent waiting on an `ask`, or on `contact_supervisor` with `need_decision` or `interview_request`, is released like any other waiting subagent when its broker uses local routing or [multi-node routing](/intercom/operations#running-intercom-across-machines). While multi-node routing is still starting or is unavailable, the subagent stays live and receives the reply as before. Its question stays open while it holds no session.

- **How the reply arrives:** reply as usual, with `reply` or a send with `replyTo`. The reply reaches the session that launched the subagent, and the subagent wakes with it as the result of its `ask` or `contact_supervisor` call.
- **Exactly once:** each question takes one reply, also when it is sent through another node's broker. The first is delivered once and reported `delivered` to you. A later reply to the same question is refused, and no reply is also queued as an ordinary message for the subagent. Sending the same reply again with the same message ID is answered from the first attempt and is not delivered twice.
- **When a reply is refused:** you get a not-delivered result, and nothing reaches the subagent, when any of these is true:
  - the session that launched the subagent has disconnected;
  - that session ended or dropped the subagent's hold;
  - the subagent's call is no longer waiting, for example because it was stopped.
- **Who receives held sends:** only the subagent that its owner relaunched, which registers with the supervisor capability the owner issued for it. A session that merely registers under the same name and group, with no capability or with one another session issued, receives none of the held sends and does not end the owner's hold.
- **Reply confirmation:** the owner confirms a reply once it has saved it. If it has not within about 8 seconds, the replier gets the [uncertain-outcome failure](/intercom/operations#how-it-works) and can reply again; a replier that disconnects while its reply waits can reply again after it reconnects. A message ID already waiting for confirmation of another reply is refused with `message_id_conflict`.
- **How long a question stays open:** as long as the subagent's call waits for it, counted from when the question was asked.
- **Where it works:** without multi-node routing, the replier and the subagent's launching session must be connected to the same broker on the same machine. With multi-node routing on, a question the subagent asked of a session on another node is kept in the shared database, and the replier can reply through any broker that shares it. The reply reaches the launching session's broker, in the order the replier sent its replies.
- **After a restart:** when the launching session reopens, the same question remains open until its original deadline; a reply wakes the child. If the broker itself restarts, a question asked of a session on the same broker loses its route, and the child receives the timeout instead. A question asked of a session on another node survives the restart: once the launching session reconnects, a reply reaches it, and a reply that was handed to it just before the restart is handed to it again and saved once.
- **Capacity:** the broker keeps at most 10,000 released-asker reply routes at once for questions asked on that broker; questions kept in the shared database do not count. If it reaches that limit, additional routes cannot receive replies and their calls time out. `broker_status` reports `droppedReleasedReplyRoutes`, the number refused at capacity since the broker started; the broker also logs the first overflow.

With multi-node routing on, a reply to a question kept in the shared database is refused with a typed error when another reply to the same question holds it. The send result's `reasonCode` names the case, and `error` is an `IntercomReleasedReplyError` with `code`, `messageId`, `questionId`, `childName`, a `hint` and `retryable`. Check `isIntercomReleasedReplyError`, `isReleasedReplyAnsweredError`, `isReleasedReplyInFlightError` or `isRetryableIntercomReleasedReplyError`, never the message. SDK integrations can import these, `IntercomReleasedReplyErrorCode`, and `serializeIntercomReleasedReplyError` / `rehydrateIntercomReleasedReplyError` from `@bastani/intercom`.

| Class | `code` | When | `retryable` | What to do |
| --- | --- | --- | --- | --- |
| `ReleasedReplyAnsweredError` | `released_reply_answered` | The launching session already took another reply to the question, or was handed one again after a lost confirmation and refused it. | `false` | Do not send this reply again. Send a new message if the subagent needs more. |
| `ReleasedReplyInFlightError` | `released_reply_in_flight` | Another reply to the question is still being handed to the launching session. | `true` | Wait, then reply again if the subagent still waits for an answer. If the other reply is accepted, a new reply is refused with `released_reply_answered`; if it cannot be handed over, the question takes a new reply. |

A refused request changes nothing: when one child in a request is refused, no child in it is reserved or dropped. Requests to reserve, drop or acknowledge a released child are refused with these typed errors. Each carries `code`, `childName` when one child caused it, a `hint`, and `retryable: false`. Check `isIntercomReleasedChildError` or the class, never the message.

SDK integrations can import these classes, their guards, `IntercomReleasedChildErrorCode`, and `serializeIntercomReleasedChildError` / `rehydrateIntercomReleasedChildError` from `@bastani/intercom`.

| Class | `code` | When | What to do |
| --- | --- | --- | --- |
| `ReleasedChildReservationError` | `not_owner` | Another session owns the child: it reserved the child first, or authorized it as its supervisor. | Send the request from the owning session, or reconnect as that session. Otherwise launch a new child. |
| `ReleasedChildReservationError` | `group_not_allowed` | The child is reserved in a `workflow:` group that this session is not a member of. Other groups, including subagent auto-groups and task groups, are allowed. | Reserve from a session in that workflow group, or omit `group`. |
| `ReleasedChildReservationError` | `invalid_frame`, `invalid_child_name`, `invalid_alias`, `too_many_aliases`, `invalid_group` | The request is malformed: 1–500 children per frame, a non-empty name other than `*`, at most 4 session-id aliases, and a string group. | Fix the named child and send the request again. |
| `UnknownReleasedChildError` | `unknown_released_child` | A wake acknowledgement names a child that no session has reserved. | Reserve the child first. |

A session can host lightweight sessions on its own broker connection with `IntercomClient.hostSessions`: each is listed and addressed like a connected session, messages for it arrive as `hosted_message` events, and `send(to, { hostedSender })` sends as it. Atomic uses this for released workflow stages. Requests are refused with these typed errors; each carries `code`, `key` or `sessionId` naming the item when one caused it, a `hint`, and `retryable: false`. Check `isIntercomHostedSessionError` or the class, never the message. SDK integrations can import them with `serializeIntercomHostedSessionError` / `rehydrateIntercomHostedSessionError` from `@bastani/intercom`.

| Class | `code` | When | What to do |
| --- | --- | --- | --- |
| `HostedSessionRequestError` | `invalid_hosted_frame` | The request is malformed: 1–500 sessions per frame under distinct non-empty keys, or 1–500 session ids to remove. Nothing in it took effect. | Fix the request and send it again. |
| `HostedSessionRequestError` | `invalid_hosted_session` | A hosted session has no name, is not a valid agent registration, or has a malformed return address or live workflow-stage route. Nothing in its request took effect. | Fix the named item and send the request again. |
| `NotHostedSessionError` | `not_hosted_by_connection` | A send names a `hostedSender`, or a removal names a session, that this connection does not host. A refused send's result has this `reasonCode` and the error in `error`. | Send from, or remove through, the connection that hosts the session; after a reconnect, host it again. |

A hosting request the broker does not answer within 5 seconds fails with `IntercomHostedSessionTimeoutError` (`code` `hosted_session_timeout`, `phase` `"hosted-session-request"`, `requestType`, `sessionCount`, `timeoutMs`, `elapsedMs`, `hint`, `retryable: true`; `cause` is the failed health check when the broker stopped answering altogether). Released stages that need hosting again are hosted on the next connection. A hosting request a broker below protocol 3 refuses fails with `IntercomBrokerProtocolError`, which is not retried: replace the broker with `atomic intercom restart`. Failures of the background reconnect are recorded in the debug log, and it stops after 30 attempts in a row until the next released stage is adopted.

With [multi-node routing](/intercom/operations#running-intercom-across-machines) on, a child reserved through one broker stays with its owner. A reservation that another session makes for it through a different broker is withdrawn as soon as the shared store refuses it.

### Subagents with no live session

When a subagent's session ends or loses its connection and the subagent is not released, the broker holds sends and asks to its name, Atomic session ID and Intercom session ID for up to 20 seconds. A subagent that reconnects under its launching session's authorization receives each held message once, in order. The session that launched the subagent reports how its run ended, and the broker answers held and later senders with a typed error instead of `Session not found`. The launching session makes the report again whenever it reconnects, and it ends when the subagent registers again. If the launching session's connection closes, as a [suspended](/workflows/operations#suspended-stages) workflow stage's does, what it reported stays for its Atomic session, and the session takes it over when it reconnects. A subagent that disconnects after its launching session did waits up to 20 seconds for that report, then the sender gets `recipient_disconnected`. Both end with the workflow run. Only the launching session and senders in the subagent's group are held or told anything.

The send result's `error` is an `IntercomRecipientGoneError` and `reasonCode` is its `code`. It carries `target` (as the send addressed it), `childName`, `childId` when the launching session reported it, a `hint` and `retryable`. Check `isIntercomRecipientGoneError`, `isSubagentRecipientEndedError`, `isSubagentRecipientDisconnectedError`, `isSubagentRecipientOwnerSuspendedError` or `isRetryableIntercomRecipientGoneError`, never the message. SDK integrations can import these, `IntercomRecipientGoneErrorCode`, and `serializeIntercomRecipientGoneError` / `rehydrateIntercomRecipientGoneError` from `@bastani/intercom`. An Intercom client older than this release receives only the error's message as the send's reason.

| Class | `code` | When | `retryable` | What to do |
| --- | --- | --- | --- | --- |
| `SubagentRecipientEndedError` | `recipient_completed` | The subagent's last run completed. | `false` | Its launching session continues it with `subagent({ action: "resume", id: "<childId>", message })`. |
| `SubagentRecipientEndedError` | `recipient_failed` | The subagent's last run failed. | `false` | Same as above. |
| `SubagentRecipientEndedError` | `recipient_stopped` | The subagent was paused, quit or interrupted, or its workflow stage paused. | `false` | Same as above. |
| `SubagentRecipientEndedError` | `recipient_cancelled` | The subagent was cancelled for good, or its workflow stage ended. | `false` | Launch a fresh subagent if its work is still needed. |
| `SubagentRecipientDisconnectedError` | `recipient_disconnected` | The subagent disconnected, did not reconnect within 20 seconds, and its launching session did not say why. | `true` | Check `subagent({ action: "status" })` in its launching session, or try again shortly. |
| `SubagentRecipientOwnerSuspendedError` | `recipient_owner_suspended` | The subagent is released and the session that launched it, which wakes it, is suspended or disconnected; the send waited 20 seconds, or could not wait. | `true` | Try again once that session is back, or send to its workflow stage target (`workflow:<rootRunId>/<stage>`), which queues the message until the stage reopens. |
| `StageRecipientReleasedError` | `recipient_stage_released` | A send or ask names a released workflow stage whose hosted peer is gone: its host connection removed it or closed, and it is not hosted again. The message reads `Workflow stage "<name>" …`. | `false` | Send to its workflow stage target (`workflow:<rootRunId>/<stage>`), which reaches the stage's current session or queues until it reopens, or resume the run. |

A launching session reports at most 500 subagents per request; a malformed report is refused with the `ReleasedChildReservationError` codes above, and a report naming a subagent another session owns with `not_owner`.

### Groups

Every session belongs to a non-empty set of intercom **groups**. Sessions with no group configured retain exactly the legacy behavior: they belong only to the implicit `"default"` group and can see and message each other. A session can ordinarily discover, resolve, and message another session when their membership sets intersect; exact-ID sends with no shared membership are rejected by the broker.

- `list` still lists sessions. Without a filter it returns the union of sessions visible through any of your memberships; with `group`, it gives a read-only view of that one group.
- `groups` lists every currently available group, its connected-session count, and whether this session is a member.
- `join` adds one membership. `leave` removes the named membership, while bare `leave` resets the complete set to the startup home group.
- `status` reports the complete membership set. `session_joined`/`session_left`/`presence_update` events are delivered whenever a membership change affects visibility.

A session's home group is resolved with this precedence: explicit stage/task/subagent group > runtime-owned workflow invocation group or inherited launching-session group > env `ATOMIC_INTERCOM_GROUP` (legacy `PI_INTERCOM_GROUP`) > Intercom `config.json` `"group"` > the [project group](/intercom/operations#project-groups) `project:<owner>/<repo>` while multi-node routing is on > `"default"`. Workflow stage named groups and `group: true` are namespaced under `workflow:<rootRunId>/...`, preventing cross-run collisions while preserving sibling isolation. `group: "default"` remains the explicit non-owned escape. The invocation group has asymmetric exact-target control over its owned subgroups; ownership does not grant reverse or lateral access.

Supervisor coordination is granted by the launching parent and can cross groups only for that authorized relationship. Ordinary sends remain membership-isolated. Reconnects preserve authorized relationships; joining a group does not create one.

### send vs ask vs reply

**`send`** is fire-and-forget — the tool returns immediately after delivery. By default it sends immediately, including in interactive sessions. If you want an approval dialog before non-reply sends, set `confirmSend: true` in config; replies that include `replyTo` still skip confirmation so reply-hint flows continue without an extra approval step.

**`ask`** never takes control away from the asker. It returns once the question is delivered, with an ask ID and whether the recipient is idle or busy (and what it is running, when known). It uses the same wait options as `bash`:

| `wait` | What the call does |
|---|---|
| omitted | Waits up to the automatic yield (default 10 seconds) and returns the reply inline if it comes in time |
| `{ kind: "foreground", budgetMs }` | Waits up to `budgetMs`, then yields |
| `{ kind: "background" }` | Returns right after delivery |

A call that yields, or that you interrupt, leaves the ask pending. An ask has no expiry. Its reply arrives later as an ordinary message on your own thread that starts `Reply to your ask <id> from <name>` and quotes your question. It starts a turn when you are idle; when you are busy, it arrives after the current tool call, like other incoming messages. A refusal, or a recipient session that ends before it replies, arrives the same way as a failed-ask message starting `Your ask <id> to <name> failed`. A session that is saved (not `--no-session`) and closes is treated as away, not ended, so its asks stay pending until it is resumed.

`pending` lists your asks that are still waiting, and `intercom({ action: "cancel", askId })` cancels one. A reply that arrives after you cancelled is still shown once, marked late. Restarting either session keeps the ask: when the asker resumes, the reply is delivered once; when the recipient resumes, it can still `reply`. A reply sent while the asker is closed is not delivered; the recipient can send it again once the asker is back. If the recipient ends while the asker is closed, the asker gets the failed-ask message when it resumes. Only the asked recipient can answer an ask: a message from another session that names the ask arrives as an ordinary message. A forked session does not inherit its parent's asks. Each reply is shown once, however often a session restarts.

Up to `maxPendingAsks` calls (default: 6) may wait for a reply at the same time; further asks are still delivered and their replies arrive as messages. Exact sender/message correlation keeps out-of-order replies and selective disconnects from cross-settling another ask. A single-child launch retains the exception that a claimed parent ask ends that child and returns a dynamic `[TASK_CONTEXT]` handoff.

An `idle` registration does not guarantee reply capability. Completed, failed, interrupted, or cancelled noninteractive subagent children reject new asks immediately with `Target noninteractive child is terminal and cannot reply`; continue a resumable child with `subagent({ action: "resume", id, message })`, or launch a fresh child with explicit context instead. If termination wins after admission but before a reply, the exact pending ask fails explicitly too. Live interactive idle sessions remain askable, and completed workflow stages with a retained reply-capable post-mortem conversation keep their existing reopening behavior. `send` transport behavior is unchanged; a retained registration is not a promise that a terminal child's model will consume a send.

**`contact_supervisor`** keeps a narrower policy: one blocking decision/interview wait per child may coexist with ordinary peer asks, but a second concurrent supervisor wait receives `Already waiting for a supervisor reply`. Claimed foreground handoffs allocate no waiter. Its decision and interview requests still wait for the reply, with a 10-minute timeout.

**`reply`** is receiver-side sugar for replying to an inbound ask. In the turn triggered by an incoming intercom message, `intercom({ action: "reply", message: "..." })` targets that exact sender and message automatically. If you reply later, it falls back to the single unresolved inbound ask; with multiple pending asks, use `pending` and pass `to`, or pass the listed message ID as `replyTo` to disambiguate multiple asks from the same sender. Under the hood this is still a normal `send` with the exact `replyTo` value.

Explicit selectors override the active turn: `to` selects a pending ask from that exact name/full session ID, and `replyTo` selects only that pending ask or the exact active ordinary message. Stale, unknown, or empty thread IDs fail without falling back. If both selectors are supplied, the sender must match the thread. If an ask is still open, inspect `pending` and reply using its exact message ID rather than replying implicitly to an unrelated notification. Multiple asks from the same sender require `replyTo`.

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
| `group` | `"default"`, or the project group while multi-node routing is on | Home intercom group for this session (see [Groups](/intercom/reference#groups)). Overridden by env `ATOMIC_INTERCOM_GROUP` / `PI_INTERCOM_GROUP` and by workflow/orchestrator per-session injection. |

The default `npx --no-install tsx` pair uses Atomic's own runtime and does not require `npx`, `tsx`, or `bun` on `PATH`. Explicit custom commands still work. For example, to use Bun from `PATH`:

```json
{
  "brokerCommand": "bun",
  "brokerArgs": []
}
```

Config validation is strict: every field is checked, and if the file is not valid JSON or any field has an invalid value, the whole config is rejected — an error is logged and all defaults are used.

Intercom publishes live session status automatically: sessions register as `idle`, switch to `thinking` while the agent is running, show `tool:<name>` during tool execution, and return to `idle` on completion. A configured `status` is appended as context instead of replacing the lifecycle status.

Activity is not reply capability. Session rows include `replyCapability: live` or `terminal` when the host supplies it; terminal noninteractive children cannot answer asks even if activity says `idle`. Closed workflow generations show `closed · reply: post-mortem only` when a late-message router is present, or `closed · reply: unavailable` without one. Post-mortem routing still validates the retained conversation and can return a bounded error if it is unavailable; it never resumes workflow execution. Missing capability metadata is not a guarantee that an ask can succeed. A completed workflow stage released from memory keeps a listing with the same status for as long as the session that ran the workflow is open; an ask to it reopens the saved conversation for one turn and returns that turn's final answer, and a plain send reaches the session that ran the workflow. If that session loses its broker connection, these listings return when it reconnects. While it is gone, a send or ask to the stage's name or session ID fails with `StageRecipientReleasedError` (`recipient_stage_released`), which names the stage's `workflow:` target to send to instead; if the broker itself restarted and knows nothing of the stage, it fails as one to an unknown session. A client below broker protocol 3 gets only the plain reason text of that refusal. Invocation/subgroup visibility and stale-ID rejection are unchanged.

For a retained post-mortem conversation, use its exact Intercom session ID or the previously listed canonical stage path, including its final-stage-name variant. Alternate materialized run-ID paths resolve active stages through the workflow owner; they are not retained aliases after the stage completes. A stage marked `reply: unavailable` rejects an ask with guidance to contact a live stage or start new work with explicit context.
