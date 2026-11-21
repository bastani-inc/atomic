---
title: Intercom reference
description: The intercom tool contract and every intercom setting.
---

# Intercom reference

## The intercom Tool

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `"list"`, `"groups"`, `"join"`, `"leave"`, `"send"`, `"ask"`, `"reply"`, `"pending"`, `"cancel"`, or `"status"` |
| `to` | string | Exact session name/full session ID or unique 8-hex session UUID prefix. `send` also takes a session-name glob or `subagents:` target ([Sending to several sessions at once](#sending-to-several-sessions-at-once)); `ask` needs one exact target. |
| `message` | string | Message text (for send/ask/reply) |
| `attachments` | array | Optional `file`, `snippet`, or `context` attachments |
| `wait` | object | For `ask`: how long to wait for the reply before yielding, as in `bash`. Omit it for the automatic yield (default 10 seconds), use `{ kind: "foreground", budgetMs }` to wait up to a budget, or `{ kind: "background" }` to return at delivery. |
| `askId` | string | For `cancel`: the ID, or a unique prefix, of one of your pending asks |
| `replyTo` | string | Exact message ID or unique 8-hex UUID prefix of an unresolved inbound ask; resolved before current-turn and pending-ask fallback. With `cancel`, the inbound ask to close |
| `group` | string | Group name for `join` or an optional targeted `leave`; read-only group filter for `list`/`status`. `send`/`ask` remain limited to shared memberships. |

### Actions

| Action | Behavior |
|--------|----------|
| `join` | Adds a trimmed named group membership and creates the group if needed. The action waits for broker acknowledgement and reports the complete resulting membership set. `default` is shared, and joining it while multi-node routing is on adds a one-line warning; `true` and `auto` are reserved for subagent auto-groups. |
| `leave` | With `group`, removes only that membership and keeps all others. Without `group`, resets the session to its resolved startup home group. Both forms report the resulting membership set. |
| `groups` | Lists every group represented by a connected session, with its session count and a marker for each group this session belongs to. Use it to discover names rather than guessing. |
| `list` | Returns the current session and the active sessions sharing a membership. Pass `group` for a read-only view of one group. |
| `send` | Fire-and-forget delivery through ordinary Intercom. Requires `to` and `message`; cannot message the current session. |
| `ask` | Sends a message to a live recipient and returns once it is delivered, with `askId`, `delivered`, and `recipient` (`name`, `state` `idle` or `busy`, and `currentAction` when known). A reply within the `wait` comes back inline; otherwise the ask stays pending with no expiry and the reply arrives later as a message. See [send vs ask vs reply](#send-vs-ask-vs-reply). Single-child parent handoffs remain unchanged. |
| `reply` | Replies to the intercom-triggered message of the current turn; otherwise falls back to the single unresolved inbound ask. With multiple pending asks, pass `to` or inspect with `pending` first. |
| `pending` | Lists unresolved inbound asks with sender, message ID, elapsed time, and a short preview, and your own asks still waiting for a reply with ask ID, target, elapsed time, and the question. |
| `cancel` | Cancels one of your pending asks by `askId`. A reply that still arrives is shown once, marked late. With `replyTo` instead, closes an ask sent to you without replying: it leaves `pending`, stays closed across restarts, and nothing is sent to its sender. |
| `status` | Shows connection status, session ID, every group this session belongs to (and, with a [reach policy](#reach-policies), its reachable groups), the count of active sessions visible through those memberships, and the broker's multi-node routing state with the number of other brokers live in the shared database. A `group` filter remains a read-only peek. |

To give two plain chat sessions a private shared membership, have both call:

```typescript
intercom({ action: "join", group: "api-review" })
```

Joining is additive: existing memberships remain active, and the broker updates presence without changing the session ID. Use `intercom({ action: "groups" })` to discover all available names and membership markers. `intercom({ action: "leave", group: "api-review" })` removes only that membership; `intercom({ action: "leave" })` resets to the home group resolved at startup. Rejected or unacknowledged changes leave client and inheritance state unchanged. Ordinary delivery requires a shared membership, while `contact_supervisor` retains its capability-based cross-group path.

Reconnection preserves the session's startup identity separately from its joined memberships. Groups explicitly left
stay absent after reconnect; the startup identity is not automatically added back to the membership list.

Sent and received messages are recorded in session history as `intercom_sent` / `intercom_received` entries.

### Targeting Sessions

Live-session lookup accepts:

- An exact full Intercom session ID.
- An exact case-insensitive session name.
- A unique 8-character hexadecimal prefix of a UUID-backed session ID.
- A connected session's Atomic session ID (the ID `atomic --session` resumes), when exactly one session you can see registered it.

Exact names and IDs take precedence, and an Atomic session ID is tried only after the other forms find nothing. Ambiguous prefixes report only authorized candidates and require the full UUID; other truncations are rejected. An isolated child can select its authorized supervisor by a unique UUID prefix without gaining access to unrelated groups.

A reopened session or a restored background subagent registers under the Intercom session ID it had before the restart, so peers can keep using the ID they saw in `intercom list`. The session records that ID in its history as an `intercom_session_identity` entry. The broker never gives an ID to a new registration while a live session holds it; the restarted session then gets a fresh ID. While the broker remembers who last held an ID, only that same Atomic session can take it back. With [multi-node routing](/intercom/operations#running-intercom-across-machines), the shared database confirms the ID first; if its broker stalls while it waits for that answer, the session still keeps the ID when the database wrote it for this session and no broker on another node presents it, and otherwise gets a fresh ID.

#### Sending to several sessions at once

`send` also accepts targets that name several recipients:

| Target | Reaches |
| --- | --- |
| `subagent-worker-*`, `subagent-*`, `*` | Every live session visible in your groups whose name matches, except you. `*` matches any run of characters and is case-insensitive; `*` alone reaches every visible session. |
| `subagents:*` | Every subagent this session launched, in any run, that is running, released, or paused. |
| `subagents:<runId>/*` | The same, for the children of one `subagent` run. |

Each recipient gets its own direct send, with the same delivery, refusals, receipts, and reconnect retries as sending to it by name. A paused subagent's copy is held for it while the process that paused it runs. A copy never [resumes a finished subagent](#messages-that-resume-a-finished-subagent): one to a subagent that ended gets the answer in [Subagents with no live session](#subagents-with-no-live-session). The result lists every recipient with its outcome: `delivered`, `queued`, `not delivered` with the reason, or `outcome unknown`. It is an error only when no recipient was reached. A glob that matches no visible session is an error that lists the closest visible names, and `subagents:` with no such child is an error too.

A name glob that matches more than one session, `*` alone included, needs `broadcast: true`. Without it nothing is sent: the result is an error that lists every match, so you can send to one by its exact name or repeat the send with `broadcast: true`. A glob that matches exactly one session sends to it without the flag. `subagents:*` and `subagents:<runId>/*` always reach every match and need no flag.

```typescript
intercom({ action: "send", to: "subagent-worker-*", message: "Scope changed", broadcast: true })
```

Patterns match only sessions you can already see in `intercom list`: they never reach outside your groups. `ask` and `replyTo` need one exact target, because a reply to a broadcast question would be ambiguous, so a pattern there is an error. Patterns match live sessions only.

Workflow stage targets (`workflow:<rootRunId>/...`) were removed with workflows in Atomic 0.10.0: a send, ask or reply to one gets the answer any unknown name gets, `Session not found`, and is never sent on. See [Mixed versions and workflows](/intercom/operations#mixed-versions-and-workflows) for how a 0.10.0 broker serves sessions of Atomic 0.9.x that still run workflows.

Agent list rows put the copyable exact ID first, followed by status and working directory. Meaningful names remain secondary metadata; redundant generated aliases are hidden only in the list, not removed from lookup. Copy the target rather than reconstructing it from a name.

Known non-agent IDs and names, such as internal control connections, are refused rather than delivered. Knowing an internal connection's ID does not bypass this broker policy, and supervisor delivery cannot bypass it either.

### Released subagents

A [released subagent](/subagents#released-subagents) stays addressable through the session that launched it: that session asks the broker to hold sends to the child's name and ids, and the broker tells it to wake the child when one arrives. Only that session owns the child's hold. The owner is the session that reserved the child first, or the one that authorized it as its supervisor when launching it. A session that reconnects with the same Intercom session id stays the owner. If the owner's connection closes while it keeps a released child, the broker keeps the child's hold for the owner's Atomic session: sends wait up to 20 seconds and then get `recipient_owner_suspended` (see [Subagents with no live session](#subagents-with-no-live-session)). When a session of the same Atomic session reconnects and reserves its released children again, it takes the child over and wakes it for the sends waiting then. Another session cannot reserve, drop or acknowledge the child.

A background subagent waiting on an `ask`, or on `contact_supervisor` with `need_decision` or `interview_request`, is released like any other waiting subagent when its broker uses local routing or [multi-node routing](/intercom/operations#running-intercom-across-machines). While multi-node routing is still starting or is unavailable, the subagent stays live and receives the reply as before. Its question stays open while it holds no session.

- **How the reply arrives:** reply as usual, with `reply` or a send with `replyTo`. The reply reaches the session that launched the subagent, and the subagent wakes with it as the result of its `ask` or `contact_supervisor` call.
- **Exactly once:** each question takes one reply, also when it is sent through another node's broker. The first is delivered once and reported `delivered` to you. A later reply to the same question is refused, and no reply is also queued as an ordinary message for the subagent. Sending the same reply again with the same message ID is answered from the first attempt and is not delivered twice.
- **When a reply is refused:** you get a not-delivered result, and nothing reaches the subagent, when any of these is true:
  - the session that launched the subagent has disconnected;
  - that session ended or dropped the subagent's hold;
  - the subagent itself ended or was stopped.

  When the subagent's `ask` already returned (it yielded before the subagent was released), its reply, or a refusal, is held for the subagent like any other send: the subagent wakes and gets it once as a `Reply to your ask` message.
- **Who receives held sends:** only the subagent that its owner relaunched, which registers with the supervisor capability the owner issued for it. A session that merely registers under the same name and group, with no capability or with one another session issued, receives none of the held sends and does not end the owner's hold.
- **Reply confirmation:** the owner confirms a reply once it has saved it. If it has not within about 8 seconds, the replier gets the [uncertain-outcome failure](/intercom/operations#how-it-works) and can reply again; a replier that disconnects while its reply waits can reply again after it reconnects. A message ID already waiting for confirmation of another reply is refused with `message_id_conflict`.
- **How long a question stays open:** as long as the subagent's call waits for it, counted from when the question was asked.
- **Where it works:** without multi-node routing, the replier and the subagent's launching session must be connected to the same broker on the same machine. With multi-node routing on, a question the subagent asked of a session on another node is kept in the shared database, and the replier can reply through any broker that shares it. The reply reaches the launching session's broker, in the order the replier sent its replies.
- **After a restart:** when the launching session reopens, the same question remains open until its original deadline; a reply wakes the child. If the broker itself restarts, a question asked of a session on the same broker loses its route, and the child receives the timeout instead. A question asked of a session on another node survives the restart: once the launching session reconnects, a reply reaches it, and a reply that was handed to it just before the restart is handed to it again and saved once.
- **Capacity:** the broker keeps at most 10,000 released-asker reply routes at once for questions asked on that broker; questions kept in the shared database do not count. If it reaches that limit, an additional route is refused, and its subagent gets one failed-ask message saying `The Intercom broker's released-subagent reply routes are full (limit 10000); this ask can no longer receive its reply`, which wakes it like any other failed ask. `broker_status` reports `droppedReleasedReplyRoutes`, the number refused at capacity since the broker started; the broker also logs the first overflow.

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
| `ReleasedChildReservationError` | `group_not_allowed` | Only from a broker of Atomic 0.9.x: the child is reserved in a `workflow:` group that this session is not a member of. A 0.10.0 broker allows every group. | Reserve from a session in that group, or omit `group`. |
| `ReleasedChildReservationError` | `invalid_frame`, `invalid_child_name`, `invalid_alias`, `too_many_aliases`, `invalid_group` | The request is malformed: 1–500 children per frame, a non-empty name other than `*`, at most 4 session-id aliases, and a string group. | Fix the named child and send the request again. |
| `UnknownReleasedChildError` | `unknown_released_child` | A wake acknowledgement names a child that no session has reserved. | Reserve the child first. |

A session can host lightweight sessions on its own broker connection with `IntercomClient.hostSessions`: each is listed and addressed like a connected session, messages for it arrive as `hosted_message` events, and `send(to, { hostedSender })` sends as it. Requests are refused with these typed errors; each carries `code`, `key` or `sessionId` naming the item when one caused it, a `hint`, and `retryable: false`. Check `isIntercomHostedSessionError` or the class, never the message. SDK integrations can import them with `serializeIntercomHostedSessionError` / `rehydrateIntercomHostedSessionError` from `@bastani/intercom`.

| Class | `code` | When | What to do |
| --- | --- | --- | --- |
| `HostedSessionRequestError` | `invalid_hosted_frame` | The request is malformed: 1–500 sessions per frame under distinct non-empty keys, or 1–500 session ids to remove. Nothing in it took effect. | Fix the request and send it again. |
| `HostedSessionRequestError` | `invalid_hosted_session` | A hosted session has no name, is not a valid agent registration, or has a malformed return address; or the hosting session has a [reach policy](#reach-policies) and the hosted session's group is not one it reaches. Nothing in its request took effect. | Fix the named item and send the request again. |
| `NotHostedSessionError` | `not_hosted_by_connection` | A send names a `hostedSender`, or a removal names a session, that this connection does not host. A refused send's result has this `reasonCode` and the error in `error`. | Send from, or remove through, the connection that hosts the session; after a reconnect, host it again. |

A hosting request the broker does not answer within 5 seconds fails with `IntercomHostedSessionTimeoutError` (`code` `hosted_session_timeout`, `phase` `"hosted-session-request"`, `requestType`, `sessionCount`, `timeoutMs`, `elapsedMs`, `hint`, `retryable: true`; `cause` is the failed health check when the broker stopped answering altogether). A hosting request a broker below protocol 3 refuses fails with `IntercomBrokerProtocolError`, which is not retried: replace the broker with `atomic intercom restart`.

With [multi-node routing](/intercom/operations#running-intercom-across-machines) on, a child reserved through one broker stays with its owner. A reservation that another session makes for it through a different broker is withdrawn as soon as the shared store refuses it.

### Subagents with no live session

When a subagent's session ends or loses its connection and the subagent is not released, the broker holds sends and asks to its name, Atomic session ID and Intercom session ID for up to 20 seconds. A subagent that reconnects under its launching session's authorization receives each held message once, in order. The session that launched the subagent reports how its run ended, and the broker answers held and later senders with a typed error instead of `Session not found`. The launching session makes the report again whenever it reconnects, and it ends when the subagent registers again. If the launching session's connection closes, what it reported stays for its Atomic session, and the session takes it over when it reconnects. A subagent that disconnects after its launching session did waits up to 20 seconds for that report, then the sender gets `recipient_disconnected`. Only the launching session and senders in the subagent's group are held or told anything.

The send result's `error` is an `IntercomRecipientGoneError` and `reasonCode` is its `code`. It carries `target` (as the send addressed it), `childName`, `childId` when the launching session reported it, a `hint` and `retryable`. Check `isIntercomRecipientGoneError`, `isSubagentRecipientEndedError`, `isSubagentRecipientDisconnectedError`, `isSubagentRecipientOwnerSuspendedError` or `isRetryableIntercomRecipientGoneError`, never the message. SDK integrations can import these, `IntercomRecipientGoneErrorCode`, and `serializeIntercomRecipientGoneError` / `rehydrateIntercomRecipientGoneError` from `@bastani/intercom`. An Intercom client older than this release receives only the error's message as the send's reason.

| Class | `code` | When | `retryable` | What to do |
| --- | --- | --- | --- | --- |
| `SubagentRecipientEndedError` | `recipient_completed` | The subagent's last run completed, and the send did not [ask to resume it](#messages-that-resume-a-finished-subagent) or could not. | `false` | Its launching session continues it with `subagent({ action: "resume", id: "<childId>", message })`. |
| `SubagentRecipientEndedError` | `recipient_failed` | The subagent's last run failed. | `false` | Same as above. |
| `SubagentRecipientEndedError` | `recipient_stopped` | The subagent was paused, quit or interrupted. | `false` | Same as above. |
| `SubagentRecipientEndedError` | `recipient_cancelled` | The subagent was cancelled for good. | `false` | Launch a fresh subagent if its work is still needed. |
| `SubagentRecipientDisconnectedError` | `recipient_disconnected` | The subagent disconnected, did not reconnect within 20 seconds, and its launching session did not say why. | `true` | Check `subagent({ action: "status" })` in its launching session, or try again shortly. |
| `SubagentRecipientOwnerSuspendedError` | `recipient_owner_suspended` | The subagent is released and the session that launched it, which wakes it, is suspended or disconnected; the send waited 20 seconds, or could not wait. | `true` | Try again once that session is back. |

A launching session reports at most 500 subagents per request; a malformed report is refused with the `ReleasedChildReservationError` codes above, and a report naming a subagent another session owns with `not_owner`.

### Messages that resume a finished subagent

A `send` or `ask` from the `intercom` tool to one subagent by name or ID asks to resume it if it has ended (`SendOptions.wakeEndedRecipient`; SDK integrations set it themselves). What happens depends on how the subagent's last run ended:

| Last run | Result | What the subagent gets |
| --- | --- | --- |
| Completed or failed | Returns at once with `queued: true` and `target: "resuming subagent"`. | The session that launched it resumes it in its own session, with its own model, tools and agent, and a prompt naming who sent the message. The message reaches it as an ordinary Intercom message before that prompt. |
| Paused or quit (or interrupted with its parent) | Returns at once with `queued: true` and `target: "paused subagent"`. The subagent is not resumed. | The message waits until the session that launched it continues it, and reaches it after what it is continued with. |
| Cancelled for good, or gone | The refusal in the table above (`recipient_cancelled`), as before. | Nothing. |

The session that launched the subagent keeps it: its result, completion notice, `/tasks` row, budget, and `pause` or `quit` stay there, and its transcript shows which session's message resumed it. An `ask` stays open: its reply arrives later as a message (`Reply to your ask <id> from <name>`). If the message cannot reach the subagent after all, its sender gets one delivery failure for it (a failed ask, or `Intercom delivery failed`), for example when the launching session declines (the subagent was cancelled meanwhile), does not answer within 20 seconds, the resumed subagent does not start within an hour, or the session that launched it ends, or stays away for 7 days in a row. A message for a paused subagent has no time limit while the session that launched it is connected: it fails only when nothing can continue the subagent any more, because the subagent is cancelled or gone, or that session ends, or stays away for 7 days in a row. Senders outside the subagent's group still get `Session not found`.

#### Across restarts

These messages outlive the broker. Each is written before its sender is told it is queued: to `ended-child-queue.sqlite` in the Intercom directory (owner-only), or, with [multi-node routing](/intercom/operations#running-intercom-across-machines) on, to the shared database, in tables named with the configured prefix (`<prefix>intercom_ended_child_queue`, `…_bodies`, `…_wakes`, `…_meta`; brokers of earlier versions ignore them). After a broker restart, a crash or a machine restart included, the next broker takes them up again in the order they were sent:

- When the session that launched the subagent is back and reports the subagent again, a subagent that completed or failed is resumed once for its messages (the resume counts toward the bounds below, which also outlive the broker), and a paused or quit one keeps them until it is continued. A subagent that is already starting or running gets them when it registers. Each message reaches it once, and an `ask` still gets its reply, also when the asker is away by then: the reply is held for it.
- The session that launched the subagent is waited for while it is away, whether it closed or the broker restarted, for 7 days in a row; once it is back the count starts again, and while it is connected there is no limit.
- A message the broker had already handed to the subagent just before it stopped, which the subagent had not confirmed saving, may already be there: it does not resume the subagent again, it is handed over again the next time the subagent is back (a copy it already saved is ignored), and if it fails, the failure says it may already have reached the subagent.
- A sender that sent a message again with the same ID because the restart cut off its answer is answered `queued` again; the message is kept once.

Limits: when the store cannot be opened (for example it is corrupt or unreadable) within 2 seconds of the first session registering, the broker keeps these messages in memory as before. With a shared database, the 2 seconds start once multi-node routing has started, which takes longer on a cold start or with a remote database; the broker waits at most 5 seconds in all, as long as connecting waits for the database, and stops waiting if routing fails to start. When the broker keeps them in memory, after its next restart, each sender is told once that its message was lost, unless it had just reached the subagent. The same happens when a broker of an earlier Atomic version, which keeps no such messages, serves the agent directory in between, or when `storage` switches between local and shared: the next broker that opens the store discards what it kept rather than deliver a message its sender was told was lost. A message that cannot be written because another process holds the store's write lock for 5 seconds is not queued, and its sender gets a delivery failure at once.

Disk space: once no message waits, `ended-child-queue.sqlite` gives the space its messages took back, a small step at a time, so the file and its log return to about 120 KiB; a file written by an earlier build is converted to do so the first time a broker starts with its queue empty, and keeps its size until then. In a shared database, the space the deleted rows leave is the database's own to reuse or reclaim, through its own maintenance (for example `VACUUM`, or autovacuum on PostgreSQL).

Resuming is bounded so agents cannot wake each other without end. A subagent is resumed by messages at most 6 times in 10 minutes, and a chain of resumes, each caused by a message from a subagent the previous one resumed, stops after 4. A message beyond either bound is refused with the subagent's ended refusal and the reason. At most 256 messages and 32 MiB wait for one subagent, and 256 MiB for all of them on one broker, counted as kept: in the store, each message as written there, with its JSON escaping and its sender's registration (a message whose text grows past 32 MiB when written, such as one made mostly of control characters, cannot wait for a subagent); broker status reports the waiting bytes as `queuedBytes`. A message counts against these limits from when it is queued until the store has deleted it, after it reached its subagent or its sender was told it failed. If another process holds the store's lock then, the message keeps counting until the broker deletes it once that process lets go. A restarted broker counts what the store kept as it reads the messages to take them up again, which costs no more reads, and no more time, than before. Until the count is done, a message for a subagent that finished or was paused waits for it, at most 2 seconds, and is then queued, refused with the size-limit reason if it does not fit, or, if the count has not finished by then, refused saying Intercom is still counting, to be sent again shortly; a count that fails is tried again until it succeeds. Other messages and registrations never wait for it. A failure kept for a sender that is away counts only the little it keeps to tell it. A queued message is never dropped to make room: when a subagent's queue is over a limit, for example after two of its queues merged when the session that launched it came back, every message in it is kept and new messages to it are refused with that reason until it is back under the limit. As a last resort, the local file never grows past 1,088 MiB; a message that does not fit gets the same refusal as a full queue. A copy of a pattern send (`subagents:*`, `name-*`), a reply, a message from an Intercom client older than this release, or a send through an older broker never resumes a subagent and gets the answers in the table above. With [multi-node routing](/intercom/operations#running-intercom-across-machines), only senders on the launching session's broker resume a subagent this way; a sender on another node gets the [offline-session queue](/intercom/operations#offline-sessions), as before.

### Groups

Every session belongs to a non-empty set of intercom **groups**. Sessions with no group configured retain exactly the legacy behavior: they belong only to the implicit `"default"` group and can see and message each other. A session can ordinarily discover, resolve, and message another session when their membership sets intersect; exact-ID sends with no shared membership are rejected by the broker.

- `list` still lists sessions. Without a filter it returns the union of sessions visible through any of your memberships; with `group`, it gives a read-only view of that one group.
- `groups` lists every currently available group, its connected-session count, and whether this session is a member.
- `join` adds one membership. `leave` removes the named membership, while bare `leave` resets the complete set to the startup home group.
- `status` reports the complete membership set. `session_joined`/`session_left`/`presence_update` events are delivered whenever a membership change affects visibility.

A session's home group is resolved with this precedence: explicit task/subagent group > inherited launching-session group > the `group` an SDK host set with [`createAgentSession({ intercom })`](/sdk#intercom-group-and-reach) > env `ATOMIC_INTERCOM_GROUP` (legacy `PI_INTERCOM_GROUP`) > Intercom `config.json` `"group"` > the [project group](/intercom/operations#project-groups) `project:<owner>/<repo>` while multi-node routing is on > `"default"`.

Supervisor coordination is granted by the launching parent and can cross groups only for that authorized relationship. Ordinary sends remain membership-isolated. Reconnects preserve authorized relationships; joining a group does not create one.

#### Reach policies

An SDK host can give a session a reach policy with [`createAgentSession({ intercom: { group, reachable } })`](/sdk#intercom-group-and-reach) and change `reachable` later with `session.intercom.setReachable(groups)`. For such a session:

- It reaches sessions that belong to its home group, to one of its reachable groups, or to a subgroup under its home group (`<group>/…`, where its subagents run). It lists, sends to and asks only those. A send or ask to any other session is refused with `Target session is outside this session's Intercom reach (…)`, or `Session not found` for a name it cannot see, and is never queued or held.
- Reach is one way. A session that lists B's group reaches B, but B reaches it only if B's own policy or memberships allow it. A reply to an ask the session received is always delivered.
- `groups` lists only its home and reachable groups, each with its session count, even when empty. `join` accepts only those names, `leave` can't remove the home group, bare `leave` returns to the home group, and a `list` or `status` peek is limited to the groups it reaches.
- Narrowing `reachable` leaves any joined group that is no longer reachable. The change applies from the session's next call. A send or ask already read by the broker keeps its earlier reach, including while waiting for a subagent to reconnect or for another machine to deliver it. A send or ask whose outcome a lost connection left unknown is not retried under a different reach, including changes made while reconnecting. The result reports the unknown outcome, so check whether it arrived before sending it again.
- Its subagents each get a policy of their own: their group as home and no reachable groups. A subagent's requested `group` is placed under the session's home group. Sessions it hosts on its connection only answer the asks they receive. `contact_supervisor` keeps its capability-based route.

The broker holds each session's policy and refuses an out-of-policy list, peek, `groups`, join, leave, presence update, send or ask itself, so a client that skips the tool cannot get around it. A session with a policy registers only with a broker of this version or later; an older broker is replaced automatically, and a broker that cannot be replaced fails the connection with `IntercomReachUnsupportedError` until `atomic intercom restart`. Sessions without a policy keep the membership rules above.

### Answering a sender outside your groups

A message can reach a session from a sender outside its groups: a session with a [reach policy](#reach-policies) writes to a group it reaches, a supervisor answers its child, or a child reports to its supervisor. The recipient can answer that sender with `send` or `ask`, using the name or ID its message shows, without joining any group. This return path is narrow:

- It leads only to the session whose message reached you. It never lets you reach anyone else, and it does not add the sender to your `intercom list`. Only an explicit `send` or `ask` to that sender uses it: a pattern send such as a name glob or `subagents:*` never does.
- It belongs to that session, not to its name or ID. When the sender quits for good the path closes, and a different session that later takes the same name or ID cannot be reached through it.
- You can send at most **3 messages** within **30 minutes** of the sender's latest message to you. Each new message from that sender opens the path again with a fresh count and window. A message the sender retries, or one handed to you again, is not a new message and opens nothing. A retried answer of yours is counted once.
- With [multi-node routing](/intercom/operations#running-intercom-across-machines), it works the same across machines, and an answer to a sender that went offline waits for it like any other message.
- A session with a [reach policy](#reach-policies) sends only within that policy and never uses a return path. A session without one that it writes to can still answer it this way.

Once the path has closed, a send to that sender is refused with `<sender> is outside your intercom groups and its return path has closed`, and it reopens when the sender writes to you again. Return paths are kept in the Intercom broker's memory, so restarting the broker closes them too. A name that a session in your own groups also has reaches that session, not the sender; use the sender's ID in that case. For a longer exchange, the sender can join your group.

### send vs ask vs reply

**`send`** is fire-and-forget — the tool returns immediately after delivery. By default it sends immediately, including in interactive sessions. If you want an approval dialog before non-reply sends, set `confirmSend: true` in config; replies that include `replyTo` still skip confirmation so reply-hint flows continue without an extra approval step.

**`ask`** never takes control away from the asker. It returns once the question is delivered, with an ask ID and whether the recipient is idle or busy (and what it is running, when known). It uses the same wait options as `bash`:

| `wait` | What the call does |
|---|---|
| omitted | Waits up to the automatic yield (default 10 seconds) and returns the reply inline if it comes in time |
| `{ kind: "foreground", budgetMs }` | Waits up to `budgetMs`, then yields |
| `{ kind: "background" }` | Returns right after delivery |

A call that yields, or that you interrupt, leaves the ask pending. An ask has no expiry. Its reply arrives later as an ordinary message on your own thread that starts `Reply to your ask <id> from <name>` and quotes your question. It starts a turn when you are idle; when you are busy, it arrives after the current tool call, like other incoming messages. A refusal, or a recipient session that ends before it replies, arrives the same way as a failed-ask message starting `Your ask <id> to <name> failed`. A session that is saved (not `--no-session`) and closes is treated as away, not ended, so its asks stay pending until it is resumed.

`pending` lists your asks that are still waiting, and `intercom({ action: "cancel", askId })` cancels one. A reply that arrives after you cancelled is still shown once, marked late. Restarting either session keeps the ask: when the asker resumes, the reply is delivered once; when the recipient resumes, it can still `reply`. A reply to a released subagent reaches it like any other send to it: it wakes the subagent and is shown once. A reply to any other asker that is closed is held for it and delivered once when it resumes, also across machines with multi-node routing; the recipient sees `Reply delivered (held for <asker> until it is back)`. If the recipient ends, or can no longer answer, while the asker is closed, the asker gets the failed-ask message when it resumes; a released subagent asker gets it the same way, and is woken for it. What waits for a session that does not come back within 7 days, or that ended for good, is dropped; you can always cancel an ask yourself. At most 1,000 asks wait for one closed recipient. An ask past that is not kept: when its recipient closes, the asker at once gets a failed-ask message saying `Session "<name>" went away and its queue of asks waiting for its return is full (limit 1000); this ask was not kept`. Asks already waiting, and replies held for a closed asker, are never dropped to make room. Only the asked recipient can answer an ask: a message from another session that names the ask arrives as an ordinary message. A forked session does not inherit its parent's asks. Each reply is shown once, however often a session restarts.

An ask sent to you stays in `pending` until you reply to it or close it with `intercom({ action: "cancel", replyTo })`. It is closed for you when no reply can reach it any more: when your `reply` is refused with `Pending question route does not authorize this public reply`, or is refused because the asker is one of your subagents and has ended. A restart closes the asks of your subagents that ended and lists them once in the recovery notice. A released or paused subagent keeps its ask, since a reply still reaches it. The `reply` result says when it closed the ask; send an ordinary message if the sender still needs the answer.

Up to `maxPendingAsks` calls (default: 6) may wait for a reply at the same time; further asks are still delivered and their replies arrive as messages. Exact sender/message correlation keeps out-of-order replies and selective disconnects from cross-settling another ask. A single-child launch retains the exception that a claimed parent ask ends that child and returns a dynamic `[TASK_CONTEXT]` handoff.

An `idle` registration does not guarantee reply capability. Completed, failed, interrupted, or cancelled noninteractive subagent children reject new asks immediately with `Target noninteractive child is terminal and cannot reply`; continue a resumable child with `subagent({ action: "resume", id, message })`, or launch a fresh child with explicit context instead. If termination wins after admission but before a reply, the exact pending ask fails explicitly too. Live interactive idle sessions remain askable. `send` transport behavior is unchanged; a retained registration is not a promise that a terminal child's model will consume a send.

**`contact_supervisor`** keeps a narrower policy: one blocking decision/interview wait per child may coexist with ordinary peer asks, but a second concurrent supervisor wait receives `Already waiting for a supervisor reply`. Claimed foreground handoffs allocate no waiter. Its decision and interview requests still wait for the reply, with a 10-minute timeout.

**`reply`** is receiver-side sugar for replying to an inbound ask. In the turn triggered by an incoming intercom message, `intercom({ action: "reply", message: "..." })` targets that exact sender and message automatically. If you reply later, it falls back to the single unresolved inbound ask; with multiple pending asks, use `pending` and pass `to`, or pass the listed message ID as `replyTo` to disambiguate multiple asks from the same sender. Under the hood this is still a normal `send` with the exact `replyTo` value.

Explicit selectors override the active turn: `to` selects a pending ask from that exact name/full session ID, and `replyTo` selects only that pending ask or the exact active ordinary message. Stale, unknown, or empty thread IDs fail without falling back. If both selectors are supplied, the sender must match the thread. If an ask is still open, inspect `pending` and reply using its exact message ID rather than replying implicitly to an unrelated notification. Multiple asks from the same sender require `replyTo`.

### From codemode scripts

[Codemode](/codemode) scripts can call `tools.intercom` with `list`, `status`, `pending`, and `send`. Each call goes through the same argument validation and permission hooks as a direct call, and resolves to a structured value:

| Action | Resolves to |
|---|---|
| `list` (optional `group`) | `{ action, groups, peekGroup?, sessions }` |
| `status` (optional `group`) | `{ action, sessionId, groups, sessions, outboundAsks }` |
| `pending` | `{ action, inbound: [{ messageId, from, fromSessionId, receivedAt, text }], outbound: [{ askId, to, askedAt }] }` |
| `send` | `{ action, target, outcome, messageId?, reason? }` |

Each entry of `sessions` is `{ sessionId, name?, cwd, state, activity?, groups, replyCapability?, self }`, where `state` is `idle`, `busy`, or `unknown` and `activity` says what a busy session is doing. A `send` outcome is `delivered`, `queued`, `refused` (with the `reason`), `unknown` (do not resend it automatically), or `cancelled`; a refused send resolves with its outcome rather than throwing.

From a script, `send` takes only an exact target: a live session name, or a full session ID or unique 8-hex prefix. A glob, `*`, or a `subagents:` target is refused, as is a send with `replyTo`. `ask`, `reply`, `cancel`, `join`, `leave`, and `groups` stay model-only: calling them from a script fails with a message to call the `intercom` tool directly.

```js
const { sessions } = await tools.intercom({ action: "list" });
const workers = sessions.filter((session) => !session.self && session.cwd.endsWith("/api"));
return Promise.all(workers.map((session) => tools.intercom({ action: "send", to: session.sessionId, message: "Rebase on main" })));
```

### Attachments

`send`, `ask`, and `reply` accept an `attachments` array of `{ type, name, content, language? }` objects where `type` is `"file"`, `"snippet"`, or `"context"`. Attachment content is included in the recipient's agent-visible message body. When a parent-targeted foreground `ask` is terminally handed off at the source, the same ordered attachment array is retained and rendered with the question for the launching parent; duplicate names and content are not rewritten. Attachments are supported in the protocol but not in the ALT+M compose overlay.

### Display metadata

`Message.content` may include an optional `displayRanges` array of `{ start, end }` UTF-16 code-unit ranges into `content.text`. Senders such as `contact_supervisor` populate `displayRanges` so the inbound message card displays only the human-readable body while keeping the model-facing `content.text` unchanged. `displayRanges` is UI-only metadata: it does not affect routing, admission, or delivery idempotency, and when it is absent or any range is out of bounds, overlapping, or invalid, the card renders `content.text` in full.

### Message size limits

A message's text can be at most **1 MiB** (UTF-8 bytes), and its text plus every attachment's name, language, and content at most **8 MiB**. Both the `intercom` tool and the broker refuse a larger message, which is not sent: `Intercom message text is <n> bytes, over the limit of 1048576 bytes (1 MiB); the message was not sent` or `Intercom message text and attachments total <n> bytes, over the limit of 8388608 bytes (8 MiB); the message was not sent`. To share more, save the content to a file and send its path.

A received message whose text and attachments total more than **50 KB** (UTF-8 bytes, the limit for tool output) does not enter the recipient's context whole. Its full text and attachments are saved to a file in the recipient's session directory (or its temporary directory for a session that has none), and the message card shows a short preview with the file's path, the way oversized tool results are shown. Read the file to see the rest. This also applies to messages from older Atomic versions that sent larger messages, and to saved messages shown when a session resumes.

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
| `group` | `"default"`, or the project group while multi-node routing is on | Home intercom group for this session (see [Groups](/intercom/reference#groups)). Overridden by env `ATOMIC_INTERCOM_GROUP` / `PI_INTERCOM_GROUP`, by an SDK host's `intercom` option, and by subagent per-session injection. |
| `joinAtStartup` | `true` | An interactive session joins Intercom a few seconds after it starts, so other sessions can list and message it before it uses Intercom. Set `false` to have interactive sessions join on first use, like print, JSON, RPC and SDK sessions. Overridden by env `ATOMIC_INTERCOM_JOIN_AT_STARTUP`: `0` turns it off and `1` turns it on. |

The default `npx --no-install tsx` pair uses Atomic's own runtime and does not require `npx`, `tsx`, or `bun` on `PATH`. Explicit custom commands still work; the broker script they receive is plain JavaScript (`broker/broker.bundle.mjs`) in an installed Atomic and TypeScript (`broker/broker.ts`) in a source checkout. For example, to use Bun from `PATH`:

```json
{
  "brokerCommand": "bun",
  "brokerArgs": []
}
```

Config validation is strict: every field is checked, and if the file is not valid JSON or any field has an invalid value, the whole config is rejected — an error is logged and all defaults are used.

Intercom publishes live session status automatically: sessions register as `idle`, switch to `thinking` while the agent is running, show `tool:<name>` during tool execution, and return to `idle` on completion. A configured `status` is appended as context instead of replacing the lifecycle status.

Activity is not reply capability. Session rows include `replyCapability: live` or `terminal` when the host supplies it; terminal noninteractive children cannot answer asks even if activity says `idle`. Missing capability metadata is not a guarantee that an ask can succeed.
