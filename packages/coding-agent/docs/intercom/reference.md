---
title: "Intercom reference"
sidebarTitle: "Intercom"
description: "Complete specification of the intercom tool, targeting rules, groups, delivery limits, SDK errors, and config.json."
---

## The `intercom` tool {#the-intercom-tool}

| Parameter | Type | Description |
| --- | --- | --- |
| `action` | string | `"list"`, `"groups"`, `"join"`, `"leave"`, `"send"`, `"ask"`, `"reply"`, `"pending"`, `"cancel"`, or `"status"`. |
| `to` | string | Exact session name, full session ID, or unique 8-hex session UUID prefix. `send` also accepts a session-name glob (`*` only) or `subagents:` target ([Sending to several sessions at once](#sending-to-several-sessions-at-once)). `ask` requires one exact target. |
| `message` | string | Message text for `send`, `ask`, or `reply`. |
| `broadcast` | boolean | For `send` to a session-name glob: set `true` to send to every matching session. Without it, a glob matching more than one session is refused with the match list. `subagents:` targets broadcast without this flag. |
| `attachments` | array | Optional `file`, `snippet`, or `context` attachments (`{ type, name, content, language? }`). |
| `delivery` | string | Case-sensitive mode for `send` and `ask`: `"steer"` (default, arrives after current tool calls without cancelling work), `"followUp"` (arrives after the recipient finishes and stops), or `"interrupt"` (cancels the current model call or cancellable tool call immediately). |
| `wait` | object | For `ask`: how long to wait for an inline reply before yielding, matching `bash`. Omit for the automatic yield (default 10 seconds), pass `{ kind: "foreground", budgetMs }` to wait up to a budget, or pass `{ kind: "background" }` to return at delivery. |
| `askId` | string | For `cancel`: any unique case-sensitive prefix (or full ID) of one of your pending outbound asks. If both `askId` and `replyTo` are passed to `cancel`, `askId` takes precedence and `replyTo` is ignored. |
| `replyTo` | string | Exact message ID or exact 8-hex UUID prefix of an unresolved inbound ask. With `reply`, overrides current-turn and pending-ask fallback. With `cancel`, closes that inbound ask without sending anything to its sender. |
| `group` | string | Group name for `join` or an optional targeted `leave`, or a read-only group filter for `list` and `status`. `send` and `ask` still require a shared membership or reach policy. |

### Actions

| Action | Behavior |
| --- | --- |
| `join` | Adds a trimmed named group membership, creating the group if needed. Waits for broker confirmation and reports the resulting membership set. Joining `default` while multi-node routing is on adds a warning. `true` and `auto` are reserved (case-insensitively) for subagent auto-groups. |
| `leave` | With `group`, removes that membership and keeps all others; if it was your only remaining group, returns you to your resolved startup home group (for example `project:<path>` under multi-node routing, or `"default"` locally). Without `group`, resets memberships to the startup home group. Reports the resulting membership set. |
| `groups` | Lists every group with at least one connected session, along with its session count and whether this session belongs to it. |
| `list` | Lists the current session and active sessions visible through your memberships. Pass `group` for a read-only view of one group. |
| `send` | Fire-and-forget delivery through ordinary Intercom. Requires `to` and `message`; cannot message the current session. |
| `ask` | Sends a question to a live recipient and returns at delivery with `askId`, `delivered`, and `recipient` (`name`, `state`, and `currentAction` when known). A reply within `wait` returns inline; otherwise the ask stays pending with no expiry and its reply arrives later as a message ([send vs ask vs reply](#send-vs-ask-vs-reply)). |
| `reply` | Answers the Intercom message that triggered the current turn, or falls back to the sole unresolved inbound ask. With multiple pending asks, pass `to` or inspect with `pending` and pass `replyTo`. |
| `pending` | Lists unresolved inbound asks (sender, message ID, elapsed time, and preview) and your pending outbound asks (ask ID, target, elapsed time, and question). |
| `cancel` | With `askId` (any unique case-sensitive prefix), cancels one of your outbound asks (a reply arriving later still displays once, marked late). With `replyTo` (exact full ID or exact 8-hex prefix), closes an inbound ask without replying; it leaves `pending`, stays closed across restarts, and sends nothing to the asker. If both `askId` and `replyTo` are passed, `askId` wins and `replyTo` is ignored. |
| `status` | Reports connection state, session ID, all group memberships (plus reachable groups when a [reach policy](#reach-policies) applies), visible active session count, and the broker's multi-node routing state with live peer broker count. Passing `group` performs a read-only peek. |

To give two chat sessions a private shared group, have both call:

```typescript
intercom({ action: "join", group: "api-review" })
```

Joining is additive and keeps existing memberships and the current session ID. Use `intercom({ action: "groups" })` to discover active groups. Call `intercom({ action: "leave", group: "api-review" })` to remove one group, or `intercom({ action: "leave" })` to reset to the startup home group. Rejected or unacknowledged changes leave membership state unchanged.

Reconnection preserves the startup home identity separately from joined memberships. Groups you explicitly left stay absent after reconnect, and the startup group is not automatically re-added.

Sent and received messages are stored in session history as `intercom_sent` and `intercom_received` entries.

### Targeting sessions

Live session lookup checks targets in this order:

1. **Exact full Intercom session ID** (case-sensitive).
2. **Exact session name** (case-insensitive). If multiple local sessions share the same name, lookup fails with `Multiple sessions named "<target>" are connected. Use the session ID instead.`
3. **Unique 8-character hexadecimal prefix** (`^[0-9a-f]{8}$/i`) of a standard UUID-format (`8-4-4-4-12`) session ID. Prefixes of 6, 7, or 9+ characters do not match.
4. **Atomic session ID** (case-sensitive, the ID passed to `atomic --session`), checked only when the rules above match nothing and exactly one visible session registered it.

Ambiguous prefixes list only authorized candidates and require the full UUID. Isolated subagents can target their authorized supervisor by a unique 8-hex UUID prefix without gaining access to unrelated groups.

Reopened sessions and restored background subagents reclaim their previous Intercom session ID so peers can keep using the ID printed by `intercom list`. The session persists this ID as an `intercom_session_identity` entry. While a live session holds an ID, another registration receives a fresh ID instead; once released, only that same Atomic session can reclaim it while the broker remembers its previous holder.

With [multi-node routing](/intercom/operations#running-intercom-across-machines), session ID reclaim works across machines once the shared database has the current schema (on PostgreSQL, run `atomic storage migrate` as the schema owner role):

- A session that disconnects cleanly reclaims its ID immediately on any machine.
- A session whose broker crashed reclaims its ID immediately on the same machine, or on another machine after the crashed broker's 30-second lease expires (until then it receives a fresh ID and automatically rebinds once the lease lapses).
- Messages addressed to either the reclaimed ID or the temporary fresh ID reach the session, and replies keep the ID the asker used.
- If a paused or disconnected broker reconnects after another host already reclaimed the session's ID, the stale registration disconnects and reconnects with a fresh ID.

#### Sending to several sessions at once

`send` supports multi-recipient targets:

| Target | Reaches |
| --- | --- |
| `subagent-worker-*`, `subagent-*`, `*` | Every visible live session in your groups whose name (or session ID if unnamed) matches, excluding yourself. **Only `*` is a wildcard** (case-insensitive); `?` and `[...]` match literally. |
| `subagents:*` | Every **running, released, or paused** subagent launched by this session across all runs. Does **not** include `quit` subagents. |
| `subagents:<runId>/*` | Every **running, released, or paused** subagent in one `subagent` run (`subagents:` prefix is case-sensitive; `<runId>` cannot contain `/` or `*`). Does **not** include `quit` subagents. |

Each recipient receives its own direct send (dispatched up to 16 concurrently) with standard receipts, refusals, and reconnect retries. Pattern sends never [resume a finished subagent](#messages-that-resume-a-finished-subagent): a copy targeting an ended subagent returns the refusal in [Subagents with no live session](#subagents-with-no-live-session). The result lists every recipient's outcome (`delivered`, `queued`, `not delivered` with reason, or `outcome unknown`) and errors only if zero recipients were reached. A glob matching no visible session returns an error listing up to 5 closest visible names.

A name glob matching more than one session (including `*`) requires `broadcast: true`. Without it, nothing is sent and the error lists every match so you can pick one exact name or repeat with `broadcast: true`. A glob matching a single session sends without the flag. `subagents:*` and `subagents:<runId>/*` never require `broadcast: true`. When `confirmSend: true` is set in an interactive session, a pattern send shows one confirmation prompt listing all matched recipients before sending.

```typescript
intercom({ action: "send", to: "subagent-worker-*", message: "Scope changed", broadcast: true })
```

Patterns match only live sessions visible in `intercom list` and never cross group boundaries. `ask` and `replyTo` require one exact target and reject patterns.

Workflow stage targets (`workflow:<rootRunId>/...`) were removed in Atomic 0.10.0 and return `Session not found` without sending. See [Mixed versions and workflows](/intercom/operations#mixed-versions-and-workflows).

Session list rows show the copyable session ID first, followed by status and working directory. Generated fallback aliases are hidden in list formatting while remaining valid lookup targets. Non-agent connections (such as internal control connections) are always refused as message targets.

### Groups

Every session belongs to a non-empty set of Intercom groups. Sessions with no explicit group belong only to `"default"` locally (or their [project group](/intercom/operations#project-groups) when multi-node routing is on). Ordinary discovery and messaging require at least one shared group membership; cross-group sends are rejected by the broker.

- **Case sensitivity.** Group names are case-sensitive (`"Team"` and `"team"` are separate groups). The reserved names `"true"` and `"auto"` are rejected case-insensitively by `join` and `leave`.
- **Leaving your last group.** Calling `leave` with `group` naming your only group returns you to your resolved startup home group (for example `project:<path>` under multi-node routing, or `"default"` locally). Calling `leave` with no `group` resets all memberships to your startup home group.
- **Persistence.** Joined and left memberships persist across restarts of the same session under the same home group, and are not inherited by forked sessions.
- **Commands.** `list` returns the union of sessions visible through your memberships (or a read-only peek of one `group`), `groups` lists all active groups, and `status` reports your complete membership set.

Home group resolution follows this precedence (highest first):

1. Explicit task or subagent `group`
2. Inherited launching-session group
3. SDK host `group` passed to [`createAgentSession({ intercom })`](/sdk#intercom-group-and-reach)
4. Environment variable `ATOMIC_INTERCOM_GROUP` (setting `ATOMIC_INTERCOM_GROUP=""` explicitly shadows legacy `PI_INTERCOM_GROUP` and falls through to `config.json`)
5. `"group"` in Intercom `config.json`
6. Project group `project:<path>` while multi-node routing is on
7. `"default"`

Supervisor authorization is granted by the launching parent and allows `contact_supervisor` to cross groups only for that parent-child relationship. Joining a group never grants supervisor access.

### Answering a sender outside your groups

A session can receive a message from outside its groups (for example from a session with a [reach policy](#reach-policies), or through supervisor escalation). The recipient may answer that sender directly using `send` or `ask` without joining a new group, subject to strict return-path limits:

- **Single-session scope.** The return path reaches only that specific sender by explicit `send` or `ask`, never by pattern send (`*`, `subagents:*`), and does not add the sender to `intercom list`.
- **Session-bound.** When the sender quits permanently, the path closes; another session taking the same name or ID later cannot be reached through it.
- **Count and window.** Up to **3 messages** within **30 minutes** of the sender's latest message to you. Each new message from that sender resets the count and 30-minute window. Retried deliveries do not reopen it, and retried answers count once.
- **Multi-node support.** Return paths work identically across machines, including offline-session queueing if the sender disconnects.
- **Reach-policy exclusion.** A session that has its own [reach policy](#reach-policies) never uses return paths; recipients without a reach policy can still answer it through a return path.

Once closed, sends to that sender fail with `<sender> is outside your intercom groups and its return path has closed`. Return paths live in broker memory and clear on broker restart. If a session inside your own groups shares the same name, address the external sender by session ID. For longer exchanges, join a shared group.

### send vs ask vs reply

**`send`** returns immediately after delivery (or queueing). It sends without prompting by default; set `confirmSend: true` in `config.json` to prompt once before single or broadcast non-reply sends in interactive sessions (replies carrying `replyTo` skip confirmation).

**`ask`** never blocks the caller indefinitely. It returns once the question is delivered with `askId`, recipient state (`idle` or `busy`), and `currentAction` when known. Wait behavior matches `bash`:

| `wait` | Behavior |
| --- | --- |
| Omitted | Waits up to the automatic yield (default 10 seconds) and returns the reply inline if it arrives in time. |
| `{ kind: "foreground", budgetMs }` | Waits up to `budgetMs`, then yields. |
| `{ kind: "background" }` | Returns immediately after delivery. |

If an `ask` yields or is interrupted, it stays pending with no expiry. Its reply arrives later as a message starting `Reply to your ask <id> from <name>` (starting a turn when idle, or arriving after the current tool call when busy). Refusals and recipient exits arrive as failed-ask messages starting `Your ask <id> to <name> failed`. Saved sessions that close (anything other than `--no-session`) count as away rather than ended, so their asks stay pending until they reopen.

**Pending ask persistence and limits:**

- Use `pending` to view waiting asks and `cancel` (`askId`) to cancel one. Replies arriving after cancellation still show once, marked late.
- Restarting either session preserves open asks and delivers each reply once (holding replies for closed askers with `Reply delivered (held for <asker> until it is back)`).
- Asks waiting on a session that stays away for more than 7 days, or ends permanently, are dropped. Forked sessions do not inherit their parent's asks.
- Each closed recipient holds at most 1,000 waiting asks; asks beyond that fail immediately with `Session "<name>" went away and its queue of asks waiting for its return is full (limit 1000); this ask was not kept`. Existing asks and held replies are never evicted.
- Only the asked recipient can answer an ask; messages naming the ask from another session arrive as ordinary messages.
- Up to `maxPendingAsks` asks (default `6`, shared with `contact_supervisor` blocking waits) can wait inline concurrently; further asks still send and deliver their replies as messages.

An inbound ask stays in `pending` until you reply to it or close it with `intercom({ action: "cancel", replyTo })`. It also closes automatically when no reply can reach the asker (for example if the asker was one of your subagents and ended, or if the broker rejects the route).

**Subagents and terminal reply capability.** Single-target `send` and `ask` calls from `intercom` to completed or failed subagents queue immediately and resume the subagent through its launching session. Calls to paused or quit subagents queue without resuming until the launching session continues them.

Only permanently cancelled (`killed`) subagents, pattern sends, calls past the wake rate or chain limits, or a still-connected registration marked `replyCapability: "terminal"` reject asks immediately with `Target noninteractive child is terminal and cannot reply; launch a fresh child with explicit context`. In-flight pending asks fail explicitly if the recipient terminates before replying. Live interactive idle sessions remain askable.

**`contact_supervisor`** allows one blocking `need_decision` (requires `message`) or `interview_request` wait per subagent at a time (coexisting with ordinary peer asks and sharing the `maxPendingAsks` capacity). A second concurrent supervisor wait fails with `Already waiting for a supervisor reply`. Blocking supervisor waits time out after 10 minutes. Only a direct single-child launch in an embedded SDK session without background task management uses the terminal `[TASK_CONTEXT]` fresh-child handoff when a blocking parent request is claimed.

**`reply`** targets the incoming Intercom message that triggered the current turn, or falls back to the single unresolved inbound ask. When multiple asks are pending, inspect with `pending` and pass `to` or the exact `replyTo` message ID (required when one sender has multiple open asks). Explicit `to` and `replyTo` selectors override the active turn, must match each other if both are provided, and fail without fallback when unknown or stale.

### Attachments

`send`, `ask`, and `reply` accept `attachments`: an array of `{ type, name, content, language? }` objects where `type` is `"file"`, `"snippet"`, or `"context"`. Attachment content appears inside the recipient's model-visible message body. In an embedded SDK session without background task management, a claimed direct single-child handoff preserves the same ordered attachments verbatim. Attachments are not exposed in the `Alt+M` compose overlay.

### Message size limits

Message text is capped at **1 MiB** (UTF-8 bytes), and text plus all attachment names, languages, and content is capped at **8 MiB**. Larger messages are refused without sending:

- Text over 1 MiB: `Intercom message text is <n> bytes, over the limit of 1048576 bytes (1 MiB); the message was not sent`
- Total over 8 MiB: `Intercom message text and attachments total <n> bytes, over the limit of 8388608 bytes (8 MiB); the message was not sent`

For larger payloads, write a file and send its path.

Any received message whose text and attachments exceed **50 KB** (UTF-8 bytes) is saved to a file in the recipient's session directory (or temporary directory when unsaved) instead of entering context whole. The chat card displays a preview and the file path, matching oversized tool output.

## Configuration

Create `~/.atomic/agent/intercom/config.json` (or under `ATOMIC_CODING_AGENT_DIR`, falling back to `PI_CODING_AGENT_DIR`; when `ATOMIC_CODING_AGENT_DIR` is unset, Atomic falls back to `~/.pi/agent/intercom/config.json` if the Atomic file is absent):

```json
{
  "brokerCommand": "npx",
  "brokerArgs": ["--no-install", "tsx"],
  "brokerStartupTimeoutMs": 30000,
  "confirmSend": false,
  "maxPendingAsks": 6,
  "replyHint": true,
  "status": "researching",
  "group": "default",
  "joinAtStartup": true
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `brokerCommand` | `"npx"` | Non-empty trimmed string naming the command used to start the local broker process. The default sentinel uses Atomic's own runtime without requiring `npx` or `tsx` on `PATH`. |
| `brokerArgs` | `["--no-install", "tsx"]` | String array of arguments passed to `brokerCommand` before the broker script path. |
| `brokerStartupTimeoutMs` | `30000` | Integer >= `1000`. Milliseconds a spawn attempt waits for a newly started broker to answer on its socket. |
| `confirmSend` | `false` | Boolean. Show a confirmation dialog before single or broadcast non-reply sends in interactive sessions with UI. |
| `maxPendingAsks` | `6` | Integer >= `1`. Maximum concurrent blocking reply waits per session (shared by `intercom` `ask` and `contact_supervisor`); further asks still send and deliver replies as messages. |
| `replyHint` | `true` | Boolean. Include the `intercom({ action: "reply", ... })` hint in incoming messages. |
| `status` | None | Optional custom string suffix appended after the automatic lifecycle status (for example `thinking · researching`). |
| `group` | `"default"`, or project group with multi-node routing | String setting the default home Intercom group ([Groups](#groups)). An empty string `""` falls through to the project group or `"default"`. Overridden by `ATOMIC_INTERCOM_GROUP` / `PI_INTERCOM_GROUP`, SDK host `intercom` policy, and subagent group injection. |
| `joinAtStartup` | `true` | Boolean. Have interactive sessions join Intercom automatically 3 seconds after startup. Set `false` to join on first Intercom use instead. Overridden by `ATOMIC_INTERCOM_JOIN_AT_STARTUP` (`0`/`false` disables, `1`/`true` enables; legacy `PI_INTERCOM_JOIN_AT_STARTUP`). |

Explicit custom broker commands remain supported. For example, to run the broker with Bun from `PATH`:

```json
{
  "brokerCommand": "bun",
  "brokerArgs": []
}
```

Config validation is strict for the 9 recognized keys above (unknown extra keys are ignored): if `config.json` is invalid JSON or any recognized key has an invalid type or range, the entire file is rejected, an error is logged, and all defaults apply.

Intercom publishes live session status automatically: sessions register as `idle`, switch to `thinking` while running, show `tool:<name>` during tool calls, and return to `idle` on completion. Any configured `status` string is appended rather than replacing lifecycle status.

Activity status is separate from reply capability. As an SDK/host metadata field, session rows expose `replyCapability` (`"live"` or `"terminal"`) when supplied by the host. A still-connected non-interactive child marked `"terminal"` rejects asks even if its activity reads `idle`, while a completed or failed subagent whose session has ended is resumed by single-target `send` or `ask` from the `intercom` tool.

## Subagent delivery and wake queues

### Released subagents

A [released subagent](/subagents#released-subagents) stays addressable through its launching session. That session asks the broker to hold sends to the subagent's name and IDs and wakes it when a message arrives. Only the launching session owns that hold; if its connection closes, sends wait up to 20 seconds and return `recipient_owner_suspended` until the same Atomic session reconnects and takes the hold back.

A background subagent waiting on an `ask` or on `contact_supervisor` (`need_decision` or `interview_request`) can be released while its question remains open, under both local and [multi-node routing](/intercom/operations#running-intercom-across-machines). While multi-node routing is starting or unavailable, the subagent stays live instead.

- **Reply delivery.** Reply normally using `reply` or `send` with `replyTo`. The reply goes to the launching session, which wakes the subagent with the answer as its tool result.
- **Exactly-once replies.** Each question accepts one reply across all nodes. Later replies to the same question are refused and never queued as ordinary messages. Retries with the same message ID return the first attempt's outcome.
- **When a reply is refused.** A reply fails without reaching the subagent if the launching session disconnected, dropped the hold, or ended, or if the subagent itself ended or was stopped. If the subagent's `ask` already yielded before release, the reply (or refusal) is held like an ordinary send and wakes the subagent as a `Reply to your ask` message.
- **Authorized receiver only.** Only the relaunched subagent presenting the launching session's supervisor capability receives held sends. Unrelated sessions registering the same name receive nothing and do not end the hold.
- **Save confirmation.** The launching session confirms the reply once saved. If it does not confirm within about 8 seconds, the replier gets an [uncertain-outcome failure](/intercom/operations#how-it-works) and may retry. Reusing a message ID already awaiting confirmation for another reply fails with `message_id_conflict`.
- **How long a question stays open.** A reply route backed by a live launching session stays open until answered or until the question's original deadline expires. A reply route whose launching session disconnected or never reserved the subagent is dropped once the launching session has been away for 7 days, matching away-session ask retention.
- **Multi-node and restarts.** Without multi-node routing, the replier and launching session must share a local broker, and a broker restart drops local reply routes (delivering a timeout to the subagent). With multi-node routing on, questions asked of remote peers live in the shared database and survive both session reopens and broker restarts.
- **Route capacity.** Each local broker keeps at most 10,000 local released-asker reply routes (shared-database routes do not count toward this cap). Past 10,000, new routes are refused and the subagent wakes with one failed-ask message: `The Intercom broker's released-subagent reply routes are full (limit 10000); this ask can no longer receive its reply`.

### Subagents with no live session

When a non-released subagent disconnects or ends, the broker holds sends and asks targeting its name, Atomic session ID, or Intercom session ID for up to 20 seconds. If it reconnects under its launching session's authorization, held messages deliver once in order.

Once the launching session reports how the run ended, senders in the subagent's group (and the launching session) receive either automatic resume queueing (see below) or a typed `IntercomRecipientGoneError` instead of `Session not found`. Other groups still receive `Session not found`. If no report arrives within 20 seconds, senders get retryable `recipient_disconnected`.

The send result exposes `reasonCode` and `error` (`target`, `childName`, optional `childId`, `hint`, `retryable`). Check `isIntercomRecipientGoneError`, `isSubagentRecipientEndedError`, `isSubagentRecipientDisconnectedError`, `isSubagentRecipientOwnerSuspendedError`, or `isRetryableIntercomRecipientGoneError` rather than matching text. Import these classes, guards, `IntercomRecipientGoneErrorCode`, and `serializeIntercomRecipientGoneError` / `rehydrateIntercomRecipientGoneError` from `@bastani/intercom`.

| Class | `code` | When | `retryable` | What to do |
| --- | --- | --- | --- | --- |
| `SubagentRecipientEndedError` | `recipient_completed` | The subagent completed, and the send did not [ask to resume it](#messages-that-resume-a-finished-subagent) or hit a wake bound. | `false` | Ask the launching session to run `subagent({ action: "resume", id: "<childId>", message })`. |
| `SubagentRecipientEndedError` | `recipient_failed` | The subagent failed. | `false` | Same as above. |
| `SubagentRecipientEndedError` | `recipient_stopped` | The subagent was paused, quit, or interrupted. | `false` | Same as above. |
| `SubagentRecipientEndedError` | `recipient_cancelled` | The subagent was permanently cancelled. | `false` | Launch a fresh subagent if its work is still needed. |
| `SubagentRecipientDisconnectedError` | `recipient_disconnected` | The subagent disconnected, did not reconnect within 20 seconds, and no owner report arrived. | `true` | Check `subagent({ action: "status" })` in the launching session, or retry shortly. |
| `SubagentRecipientOwnerSuspendedError` | `recipient_owner_suspended` | The subagent is released, but its launching session is disconnected or suspended. | `true` | Retry once the launching session reconnects. |

Launching sessions report at most 500 ended subagents per request; malformed reports fail with the `ReleasedChildReservationError` codes below.

### Messages that resume a finished subagent

A single-target `send` or `ask` from the `intercom` tool to a subagent by name or ID opts in to waking an ended recipient (`SendOptions.wakeEndedRecipient`; SDK callers set this option explicitly). Behavior depends on how the subagent ended:

| Last run | Immediate result | What happens next |
| --- | --- | --- |
| Completed or failed | Returns at once with `queued: true` and `target: "resuming subagent"`. | The launching session resumes the subagent in its own session (same model, tools, and agent) and delivers your message before the wake prompt. |
| Paused or quit (or interrupted with its parent) | Returns at once with `queued: true` and `target: "paused subagent"`. | The subagent is not resumed automatically. Your message waits until the launching session continues it, arriving after the continuation prompt. |
| Permanently cancelled or gone | Refused immediately with `recipient_cancelled`. | Nothing is queued. |

The launching session keeps ownership of the resumed subagent: its completion notice, `/tasks` entry, budget, and `pause`/`quit` controls stay in that session, and its transcript records who woke it. An `ask` stays open and delivers its answer later as `Reply to your ask <id> from <name>`.

If a queued message can no longer be delivered, the sender receives one delivery failure (a failed ask or `Intercom delivery failed`). Common causes are the subagent being cancelled, the launching session declining or missing the 20-second wake reply window, the resumed subagent failing to start within 1 hour, or the launching session ending or staying away for 7 days in a row.

Messages for paused subagents have no wait limit while the launching session stays connected. Senders outside the subagent's group still receive `Session not found`.

#### Across restarts

Queued messages for finished or paused subagents are persisted before the broker reports `queued`: locally in `ended-child-queue.sqlite` (owner-only, inside the Intercom directory), or in the shared database under the configured `prefix` when [multi-node routing](/intercom/operations#running-intercom-across-machines) is on.

After a broker restart, crash, or reboot, the next broker restores queued messages in order:

- When the launching session reconnects and reports the subagent, completed or failed subagents resume once for their queued messages, while paused or quit subagents keep waiting until continued.
- The broker waits up to 7 consecutive days while the launching session is away; reconnecting resets that 7-day counter, and connected launching sessions have no wait limit.
- A message already handed to the subagent just before a broker crash is redelivered on reconnect without triggering a duplicate resume, and a saved copy is ignored.
- A sender retrying the same message ID after a disconnect receives `queued` again without duplicating the stored message.

If the queue store cannot open at startup (after 2 seconds locally, or up to 5 seconds while waiting for a shared database), the broker falls back to memory and tells senders after a restart if any queued message was lost. Switching `storage` between local and shared also discards old unconsumed queues rather than redelivering messages already reported lost.

A write blocked by another process's lock for 5 seconds fails immediately. Local disk space is reclaimed automatically once the queue empties; shared databases reclaim deleted rows through their own maintenance, such as `VACUUM` or PostgreSQL autovacuum.

**Wake and queue limits:**

- **Wake rate limit.** At most 6 message-triggered resumes per subagent within 10 minutes.
- **Wake chain limit.** A chain of resumes triggered by previously woken subagents stops at depth 4. Exceeding either limit returns the subagent's ended refusal with the reason.
- **Queue capacity.** Up to 256 messages and 32 MiB per subagent, 256 MiB across one broker, and a 1,088 MiB local-file cap. Queued messages are never dropped to make room; new messages past a cap are refused until space frees up.
- **Scope.** Pattern sends (`subagents:*`, `name-*`), replies, and older clients never wake an ended subagent. Under [multi-node routing](/intercom/operations#running-intercom-across-machines), only senders on the launching session's broker trigger this wake queue; senders on other hosts use the [offline-session queue](/intercom/operations#offline-sessions).

## Programmatic and SDK reference

### From codemode scripts

[Codemode](/codemode) scripts can call `tools.intercom` with `list`, `status`, `pending`, and `send`. Calls run through standard validation and hooks and return structured values:

| Action | Resolves to |
| --- | --- |
| `list` (optional `group`) | `{ action, groups, peekGroup?, sessions }` |
| `status` (optional `group`) | `{ action, sessionId, groups, sessions, outboundAsks }` |
| `pending` | `{ action, inbound: [{ messageId, from, fromSessionId, receivedAt, text }], outbound: [{ askId, to, askedAt }] }` |
| `send` | `{ action, target, outcome, messageId?, reason? }` |

Each session object is `{ sessionId, name?, cwd, state, activity?, groups, replyCapability?, self }` (`state` is `"idle"`, `"busy"`, or `"unknown"`). A `send` outcome is `"delivered"`, `"queued"`, `"refused"` (with `reason`), `"unknown"` (do not automatically resend), or `"cancelled"`; refused sends resolve with their outcome rather than throwing.

Script `send` requires an exact target (session name, full session ID, or unique 8-hex prefix) and rejects globs, `*`, `subagents:`, and `replyTo`. Actions `ask`, `reply`, `cancel`, `join`, `leave`, and `groups` are model-only and fail if called from a script.

```js
const { sessions } = await tools.intercom({ action: "list" });
const workers = sessions.filter((session) => !session.self && session.cwd.endsWith("/api"));
return Promise.all(
  workers.map((session) => tools.intercom({ action: "send", to: session.sessionId, message: "Rebase on main" }))
);
```

### Reach policies

An SDK host can assign a reach policy via [`createAgentSession({ intercom: { group, reachable } })`](/sdk#intercom-group-and-reach) and update `reachable` dynamically with `session.intercom.setReachable(groups)`:

- The session can list, send to, and ask only sessions in its home group, its `reachable` groups, or subgroups under its home group (`<group>/...`, where its subagents run). Out-of-policy targets fail with `Target session is outside this session's Intercom reach (...)` (or `Session not found` for unseen names) and are never queued or held.
- Reach is one-way: reaching group B does not let group B initiate messages back unless B's own memberships or policy allow it. Replies to asks received by B are always allowed.
- `groups` lists only home and reachable groups (including empty ones), `join` accepts only those groups, `leave` cannot remove the home group, and `list`/`status` peeks stay within reach.
- Narrowing `reachable` automatically leaves removed groups from the next call onward. In-flight sends already accepted by the broker keep their original reach; sends with unknown outcomes after a disconnect are never retried under a changed reach.
- Subagents of a policy-constrained session inherit a reach policy with their own group as home (placed under the parent's home group if custom) and no additional reachable groups. `contact_supervisor` keeps its authorized route.

The broker enforces reach policies server-side. Sessions with a reach policy require a current broker; if an older broker cannot be replaced automatically, connection fails with `IntercomReachUnsupportedError` until you run `atomic intercom restart`.

### Hosted sessions and registration purpose (SDK)

Custom SDK hosts can optionally pass `recipientPurpose` (`"agent"` or `"control"`) when registering a session; omitting it defaults to `"agent"`. Invalid values are rejected, and a session's purpose cannot change after registration.

A session can host lightweight sessions on its broker connection via `IntercomClient.hostSessions` (messages arrive as `hosted_message` events, and `send(to, { hostedSender })` sends as them). Refusals return `IntercomHostedSessionError` subclasses (`code`, `key` or `sessionId`, `hint`, `retryable: false`), importable with `isIntercomHostedSessionError` and `serializeIntercomHostedSessionError` / `rehydrateIntercomHostedSessionError` from `@bastani/intercom`:

| Class | `code` | When | What to do |
| --- | --- | --- | --- |
| `HostedSessionRequestError` | `invalid_hosted_frame` | Malformed request: 1 to 500 sessions per request under distinct non-empty keys, or 1 to 500 IDs to remove. | Fix the request and resend. |
| `HostedSessionRequestError` | `invalid_hosted_session` | Missing name, invalid agent registration, malformed return address, or group outside the hosting session's [reach policy](#reach-policies). | Fix the named item and resend. |
| `NotHostedSessionError` | `not_hosted_by_connection` | Send named a `hostedSender`, or removal named an ID, not hosted by this connection. | Use the hosting connection, or re-host after reconnecting. |

A hosting request unanswered after 5 seconds fails with `IntercomHostedSessionTimeoutError` (`code: "hosted_session_timeout"`, `retryable: true`). An older broker that does not support hosted sessions fails with `IntercomBrokerProtocolError` until you run `atomic intercom restart`.

### Released-subagent SDK errors

With multi-node routing on, a conflicting reply to a shared-database released-asker question returns a typed `IntercomReleasedReplyError` (`code`, `messageId`, `questionId`, `childName`, `hint`, `retryable`) with `reasonCode` matching `code`. Check `isIntercomReleasedReplyError`, `isReleasedReplyAnsweredError`, `isReleasedReplyInFlightError`, or `isRetryableIntercomReleasedReplyError` rather than matching message text. Import these classes, guards, `IntercomReleasedReplyErrorCode`, and `serializeIntercomReleasedReplyError` / `rehydrateIntercomReleasedReplyError` from `@bastani/intercom`.

| Class | `code` | When | `retryable` | What to do |
| --- | --- | --- | --- | --- |
| `ReleasedReplyAnsweredError` | `released_reply_answered` | The launching session already accepted another reply to this question, or refused a duplicate handoff after a lost confirmation. | `false` | Do not resend this reply. Send a new ordinary message if the subagent needs follow-up. |
| `ReleasedReplyInFlightError` | `released_reply_in_flight` | Another reply to this question is currently being handed to the launching session. | `true` | Wait, then reply again if the question is still unanswered. |

Reservation, drop, and wake-acknowledgement requests are atomic per request: if one item is refused, nothing in the request takes effect. Errors carry `code`, `childName` when applicable, `hint`, and `retryable: false`. Import classes, `isIntercomReleasedChildError`, `IntercomReleasedChildErrorCode`, and `serializeIntercomReleasedChildError` / `rehydrateIntercomReleasedChildError` from `@bastani/intercom`.

| Class | `code` | When | What to do |
| --- | --- | --- | --- |
| `ReleasedChildReservationError` | `not_owner` | Another session owns the child (reserved it first or authorized it as supervisor). | Send the request from the owning session, or launch a new child. |
| `ReleasedChildReservationError` | `group_not_allowed` | An older broker rejected a `workflow:` group reservation from a non-member session. | Reserve from a session in that group, or omit `group`. |
| `ReleasedChildReservationError` | `invalid_frame`, `invalid_child_name`, `invalid_alias`, `too_many_aliases`, `invalid_group` | Malformed request: requests accept 1 to 500 children, non-empty names other than `*`, at most 4 session-ID aliases, and string groups. | Fix the invalid item and retry. |
| `UnknownReleasedChildError` | `unknown_released_child` | Wake acknowledgement named a child no session reserved. | Reserve the child first. |

### Broker errors

These classes belong to the `IntercomBrokerError` family and are exported from `@bastani/atomic` alongside `isIntercomBrokerError()`, `isIntercomBrokerProtocolError()`, `isIntercomBrokerUpgradeError()`, `isIntercomBrokerStopTimeoutError()`, and `isRetryableIntercomBrokerError()`.

| Class | `code` | When it happens | Fields | What to do |
| --- | --- | --- | --- | --- |
| `IntercomBrokerProtocolError` | `broker-protocol-unsupported` | The connected older broker does not support the requested feature (such as released-subagent holds or hosted sessions). | `feature`, `brokerProtocolMin`, `brokerProtocolMax`, `requiredProtocol`, `hint`, `retryable: false` | Run `atomic intercom restart` to replace the broker, then retry. |
| `IntercomBrokerUpgradeError` | `broker-upgrade-failed` | Replacing an older broker failed while stopping it (`phase: "stop"`) or starting its successor (`phase: "start"`). `atomic intercom upgrade` exits with status 1; active sessions retry on reconnect backoff once the previous broker exits. | `phase`, `previousPid`, `previousProtocolMax`, `hint`, `retryable: true`, `cause` | For `"stop"`, run `atomic intercom restart`. For `"start"`, wait for reconnect or run `atomic intercom restart`. |
| `IntercomBrokerStopTimeoutError` | `broker-stop-timeout` | A broker asked to shut down did not exit before the timeout (1 minute for upgrades, 10 seconds for `atomic intercom restart`). | `phase: "stop"`, `pid`, `timeoutMs`, `elapsedMs`, `hint`, `retryable: true` | Wait for the broker process to exit, or stop it manually, then retry. |

### Routing and project-group errors

Exported from `@bastani/atomic` with `isProjectGroupError()`, `isIntercomRoutingError()`, `isIntercomRoutingMismatchError()`, `isIntercomRoutingUnavailableError()`, `isIntercomRoutingTimeoutError()`, `isIntercomRoutingChangedError()`, and `isRetryableIntercomRoutingError()`. The `intercom` tool reports the error message and `hint` once with `code` in result details.

| Class | `code` | When it happens | Fields | What to do |
| --- | --- | --- | --- | --- |
| `ProjectGroupError` | `git-unavailable` or `git-failed` | Multi-node routing tried to derive `project:<path>` inside a Git repository, but `git` is missing or failed. Not retried in the background. | `cwd`, `detail`, `hint` | Install Git, fix the repository error, or set `ATOMIC_INTERCOM_GROUP` to skip the lookup. |
| `IntercomRoutingMismatchError` | `broker-routing-mismatch` | The broker routes across machines while the session joined implicitly as `default` (`reason: "implicit-default-on-remote-broker"`), or the session selected shared storage (`storage` or `ATOMIC_PROFILE=ci`) while the running broker started without it (`reason: "shared-storage-not-on-broker"`). Terminal until session restart. | `reason`, `group`, `hint`, `retryable: false` | Run `atomic intercom restart` (if the broker lacks shared storage), then restart the session or set `ATOMIC_INTERCOM_GROUP`. |
| `IntercomRoutingUnavailableError` | `broker-routing-unavailable` | The broker closed status without answering (`reason: "unsupported"`), sent an unreadable report (`"malformed"`), or is an older broker that could not be replaced while multi-node storage is active. | `reason`, `phase`, `hint`, `retryable: true`, optional `cause` | Run `atomic intercom restart` to replace the broker. |
| `IntercomRoutingTimeoutError` | `broker-routing-timeout` | The broker accepted the routing status check but did not answer in time. | `timeoutMs`, `elapsedMs`, `phase`, `hint`, `retryable: true` | Wait for reconnect backoff, or run `atomic intercom restart` if it persists. |
| `IntercomRoutingChangedError` | `broker-routing-changed` | The broker's routing mode changed between the session's status check and registration, so registration was refused. | `expectedAcrossMachines`, `hint`, `retryable: true` | Wait for automatic retry, or run `atomic intercom restart` if it persists. |
