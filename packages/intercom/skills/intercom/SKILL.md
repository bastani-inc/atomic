---
name: intercom
description: |
  Streamline session-to-session coordination with the intercom extension. Send
  messages, delegate tasks, and coordinate work across multiple atomic sessions on
  one machine, or on machines that share storage. Use for planner-worker
  workflows, cross-session context sharing, and real-time collaboration between
  sessions.
---

# Intercom Skill

Use this skill when you need to coordinate work across multiple atomic sessions
running on one machine, or on several machines that share storage with
multi-node routing on. Intercom enables direct 1:1 messaging between
sessions for delegation, context sharing, and collaborative workflows.

When you are supervising with the `subagent` skill, delegated child agents can
escalate to you via `contact_supervisor` if the subagent runtime supplied child
bridge metadata. This skill covers how to handle those orchestrator-side
escalations, and how children talk to each other as peers.

## When to Use

- **Task delegation**: Split work between a planner session and worker sessions
- **Context handoffs**: Send findings from a research session to an execution session
- **Clarification loops**: Worker asks questions, planner answers, work continues
- **Multi-session workflows**: Coordinate between specialized sessions (frontend/backend, research/implementation)
- **Peer coordination**: Sibling subagents debate findings, hand off evidence, divide ownership, and learn from each other without routing through the supervisor

## Core Patterns

### Pattern 1: Planner-Worker Delegation

The most common pattern. One session holds the big picture, others do hands-on work.

**Setup** (in each session):
```
/name planner    # Terminal 1
/name worker     # Terminal 2
```

**Planner delegates a task** (fire-and-forget):
```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Task-3: Add retry logic to API client. Key files: src/api/client.ts. Ask if anything's unclear."
})
```

**Worker asks for clarification** (never blocks):
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Should I use exponential backoff or fixed intervals?"
})
// → A quick reply comes back as the result. Otherwise the ask stays pending and the
//   reply arrives later as a message: "Reply to your ask <id> from planner".
//   Keep working on what you can meanwhile; do not ask again.
```

**Worker reports completion**:
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Task-3 complete. Added exponential backoff (100ms → 1600ms, max 5 retries). Ready for task-4?"
})
```

### Pattern 2: Quick Status Check

Before sending, verify who's connected. Full session UUIDs or their unique 8-hex prefixes can be used as targets. Each list row leads with a copyable full session ID. Names are secondary; redundant generated aliases are omitted from the list but remain valid targets.

```typescript
intercom({ action: "list" })
// → - `6332faab-1111-4222-8333-123456789abc` [idle] /workspace (model) name: planner
intercom({ action: "ask", to: "6332faab-1111-4222-8333-123456789abc", message: "Which option should I use?" })
```

Live sessions accept an exact full Intercom session ID, a unique 8-hex prefix of a visible UUID-backed session, or an exact case-insensitive name. Ambiguous prefixes require a listed full UUID. Workflow stage targets (`workflow:<rootRunId>/...`) were removed with workflows in Atomic 0.10.0 and are refused.

### Runtime named groups

Plain chat sessions can add and remove group memberships without restarting:

```typescript
// Add a membership. Existing memberships remain active.
intercom({ action: "join", group: "api-review" })

// Discover every available group and see membership markers.
intercom({ action: "groups" })

// Remove one membership, or reset to home by omitting group.
intercom({ action: "leave", group: "api-review" })
intercom({ action: "leave" })
```

`list` still lists sessions: without a filter it returns every peer sharing at least one membership. `default` remains shared, while `true` and `auto` remain reserved. With multi-node routing on, a session with no configured group joins its repository's `project:<owner>/<repo>` group instead of `default`. Later subagents inherit the most recently joined membership. Ordinary `send`/`ask` requires a shared membership, with two exceptions: authorized `contact_supervisor` traffic, and an answer to a sender outside your groups whose message reached you.

### Answer a sender outside your groups

A message can reach you from a session outside your groups: a session whose host-set reach policy reaches your group, a supervisor answering its child, or a child reporting to its supervisor. Answer it with `send` or `ask` to the name or ID its message shows, without joining a group. This return path leads only to that sender, allows up to 3 messages within 30 minutes of its latest message to you, and reopens with a fresh count each time it writes again. Pattern sends (name globs, `subagents:*`) never use it, and a session with a host-set reach policy never uses it.

```typescript
// A session outside your groups wrote to you; answer it by the name its message showed.
intercom({ action: "send", to: "main-session", message: "Done: report written to research/notes.md" })
```

After the window or the message count runs out, a send is refused with `<sender> is outside your intercom groups and its return path has closed`. Wait for the sender to write again, or, for a longer exchange, have it join your group.

### Pattern 3: Reply Naturally

When responding to an inbound ask, prefer `reply` instead of reconstructing raw IDs:

```typescript
// In the turn triggered by the ask:
intercom({
  action: "reply",
  message: "Use exponential backoff starting at 100ms."
})

// If replying later and there might be more than one pending ask:
intercom({ action: "pending" })
intercom({ action: "reply", to: "planner", message: "Use exponential backoff starting at 100ms." })
```

Explicit `to` selects that sender's pending ask even if another message triggered the current turn. Use `pending` and an exact pending message ID or unique 8-hex UUID prefix in `replyTo` when the sender has several asks. Prefixes resolve to the canonical full ID before fallback; collisions fail. Stale, unknown, empty, or sender-mismatched explicit selectors fail without replying to another thread. Omit both selectors only when you intend to reply to the active message, or otherwise the single pending ask.

### Pattern 4: Broadcast to Multiple Workers

Send one message to every matching session in one call:

```typescript
// Every visible session whose name matches the glob (never yourself, never outside your groups).
// broadcast: true says you mean every match; without it, a glob that matches more than one session is refused.
intercom({ action: "send", to: "worker-*", message: "Check for null pointer exceptions in your assigned files", broadcast: true })
// Every running, released or paused subagent you launched, or those of one run
intercom({ action: "send", to: "subagents:*", message: "Scope changed: skip the migration" })
intercom({ action: "send", to: "subagents:<runId>/*", message: "Wrap up and report" })
```

The result lists each recipient's outcome (delivered, queued, or not delivered with the reason). A glob that matches no session is an error that lists close names. A name glob that matches more than one session, `*` included, sends nothing without `broadcast: true` and lists the matches instead: pick one exact name for a private message, or add `broadcast: true` when every match should get it. A glob that matches one session sends to it. `subagents:` targets broadcast without the flag. `ask` takes only one exact target.

### Pattern 5: Send with Attachments

Share code snippets, files, or context:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Here's the fix for the auth issue:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: `function validateUser(user: User | null) {
  if (!user) throw new Error("User required");
  return user.email?.includes("@");
}`
  }]
})
```

### Pattern 6: Handle Subagent Escalations (Orchestrator Side)

When the `subagent` runtime spawns a delegated child and supplies child bridge
metadata, that child can reach you through `contact_supervisor`. You receive a
formatted message that includes run metadata:

```
**From subagent-worker-78f659a3-1**

Subagent needs a supervisor decision.
Run: 78f659a3
Agent: worker
Child index: 0

Which API should I use?
```

**Reply using `reply`:**

```typescript
// The reply hint in the incoming message will show the exact call:
intercom({ action: "reply", message: "Use the stable v2 API." })
```

This works because `reply` resolves the correct sender and message ID automatically.

**Three types of escalations to expect:**

| Type | What it means | How to respond |
|------|---------------|----------------|
| `need_decision` | Subagent is blocked and waiting for your answer. Has a 10-minute timeout. | Reply promptly with a clear decision. If you need more context, ask follow-up questions via `reply`. |
| `interview_request` | Subagent needs multiple structured answers in one blocking exchange. Has a 10-minute timeout. | Reply with plain JSON or a fenced `json` block using the provided `{ "responses": [...] }` shape. |
| `progress_update` | Subagent is sharing meaningful progress or a plan-changing discovery. Not blocking. | Read and acknowledge. No reply required unless you want to redirect. |

**When a subagent asks:**

```typescript
// In the turn triggered by the incoming ask:
intercom({ action: "reply", message: "Use exponential backoff, max 3 retries." })
```

**When a subagent sends an interview request:**

Read the rendered questions in the incoming message and reply with the exact ids in JSON. `info` questions are context-only and do not need response entries:

```typescript
intercom({
  action: "reply",
  message: "```json\n{\n  \"responses\": [\n    { \"id\": \"api\", \"value\": \"Stable API\" },\n    { \"id\": \"constraints\", \"value\": \"Keep the public error shape unchanged.\" }\n  ]\n}\n```"
})
```

**If you receive multiple pending asks:**

```typescript
intercom({ action: "pending" })
// → Shows every unresolved ask with sender, exact message ID, age, and preview

intercom({ action: "reply", to: "subagent-worker-78f659a3-1", message: "Use the v2 API." })
// If that sender has multiple asks, select the exact listed thread:
intercom({ action: "reply", replyTo: "message-id", message: "Use the v2 API." })
```

**Important:** Only sessions where the `subagent` runtime supplied child bridge
metadata get the `contact_supervisor` tool. Normal sessions use the regular
`intercom` tool. If you see the formatted supervisor decision/progress update
message, treat it as a `contact_supervisor` escalation.

### Pattern 7: Constructive Quorum

Use constructive quorum when several fresh-context reviewers judge the same artifact and a tally could hide a defect one reviewer found or preserve another reviewer's misreading.

1. Each reviewer inspects independently and records a preliminary verdict before reading sibling findings or verdicts.
2. Run exactly one bounded evidence-exchange round: share concrete findings and evidence, challenge blocking claims, surface missed defects, and correct objective/acceptance-criteria misreadings. Do not continue into a second round.
3. Change a verdict only through evidence, never deference. Each reviewer emits its own final structured verdict and records whether the round changed it and which evidence caused the change.
4. Let the orchestrator count the final verdicts; this pattern does not change how they are counted.

Subagents launched in one parallel set share an Intercom group when Intercom is available, so sibling reviewers can coordinate without custom group wiring.

### Pattern 8: Peer Coordination Between Subagents

Peer-to-peer (swarm) is the default topology inside a delegation. There are no limits on communication between agents; it is encouraged whenever you need to. The supervisor is not a message relay: relaying adds latency, loses detail, and fills the supervisor's context, so siblings exchange evidence directly and self-organize. Children launched in one parallel set (or one explicit `group`) share an Intercom group. Any of them can list live siblings and message them directly. `contact_supervisor` is reserved for the supervisor; peer traffic uses ordinary `intercom`.

```typescript
// Any child: discover who is live in your group
intercom({ action: "list" })

// Broadcast: share a finding with every live sibling in your group
intercom({ action: "send", to: "*", message: "Root cause confirmed: cache key omits tenant id (src/cache.ts:52). Adjust your angle.", broadcast: true })

// Connect: pass what you found to the sibling who needs it
intercom({ action: "send", to: "codebase-analyzer-2", message: "Null handling lives in src/auth/session.ts:40-118 and src/auth/refresh.ts:12-60. Start there." })

// Coordinate: claim shared work so two writers do not collide
intercom({ action: "send", to: "worker-1", message: "I am running the integration suite now (~4 min). Do not start it; I will send the result." })

// Learn: reuse a sibling's verified reproduction
intercom({ action: "ask", to: "debugger-1", message: "What exact command and env reproduced the timeout? I want to reuse it, not rediscover it." })

// Debate: challenge a finding with evidence, then decide for yourself
intercom({ action: "ask", to: "reviewer-2", message: "You called the retry loop unbounded. client.ts:88 caps attempts at 5 — which path bypasses it?" })
```

How a swarm works:

- Coordinate proactively. Discover peers with `list` as soon as you start and again whenever new siblings may have joined, without waiting for the launcher to name them.
- Broadcast findings, claim files or expensive steps, hand work along a chain, ask and answer each other, and debate disagreements for as long as it is useful.
- Decide on evidence, not deference. A peer's approval, rejection, or claim is input to inspect, not a verdict to copy, and each agent still returns its own result.
- `contact_supervisor` is for supervisor decisions; explicit user approval gates and authorization for destructive or external actions still apply.
- Choose `delivery` per `send`/`ask` by urgency. The default `"steer"` arrives after the recipient's current tool calls finish and never cancels its work. Use `"interrupt"` when it must stop now (an urgent correction or a stop order), and `"followUp"` when the message can wait until it finishes (low priority, "after you're done").
- Peer asks and one blocking supervisor request may wait concurrently in the same child; mutual asks work when both sides process inbound work.
- Scale with the task. For very complex work or requested heavy parallelism, hundreds or thousands of agents self-organize into teams (named groups, nested subagent sets) and coordinate peer-to-peer like an organization. Groups have no member limit; team members reach their lead with `contact_supervisor`, and leads talk to each other in their shared group.

## Key Differences

| Action | Behavior | Use When |
|--------|----------|----------|
| `join` | Adds or creates a named membership in place | Sessions need another shared routing group |
| `leave` | Removes one named membership, or resets to home when omitted | Stop sharing one group or restore startup membership |
| `groups` | Lists every available group with counts and membership markers | Discover a group instead of guessing its name |
| `send` | Fire-and-forget to a live session; a name glob or `subagents:` target reaches every live match | You don't need a response |
| `ask` | Returns once delivered (or with the reply if it comes within `wait`); the reply otherwise arrives later as a message | You need an answer |
| `reply` | Responds to the active or pending inbound ask; `to` accepts an exact name/full session ID or unique 8-hex session UUID prefix | You were asked something and need to answer naturally |
| `pending` | Lists unresolved inbound asks and your own pending asks | You need to see who is waiting, or what you are still waiting for |
| `cancel` | Cancels one of your pending asks by `askId`; a later reply is shown once, marked late | You no longer need the answer |
| `list` | Returns all sessions sharing any membership, with full IDs and live status | Discover targets or choose an idle peer |
| `status` | Returns connection state and every current membership | Troubleshooting |

## Optional: Visible Peer Sessions via cmux, tmux, or psmux (Windows rewrite of tmux that has fully parity with tmux)

If no suitable intercom-connected peer session already exists and the task benefits from a long-lived visible conversation, you may spawn a new `atomic` session.

Prefer `cmux new-split right` over new surfaces or workspaces so both sessions are visible side by side.

If `cmux` is unavailable, `tmux` is an optional fallback when it is installed and relevant. Use it with a private socket so the session is isolated and observable.

Use spawned peer sessions only for:
- same-codebase worker/planner splits
- reference-codebase scouting
- long-lived visible conversations where the user benefits from watching both sides

Do not use this for unrelated repos, trivial questions, or work you can finish cleanly in the current session.

### Preferred: cmux Worker or Scout Session

Same codebase:

```bash
cmux new-split right
sleep 0.5
cmux send --surface right 'cd /path/to/current/repo && atomic\n'
```

Reference codebase:

```bash
cmux new-split right
sleep 0.5
cmux send --surface right 'cd /path/to/reference/repo && atomic\n'
```

### Optional Fallback: tmux Worker or Scout Session

Same codebase:

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/atomic-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/atomic.sock"
SESSION=atomic-worker
tmux -S "$SOCKET" new -d -s "$SESSION" -c "/path/to/current/repo" 'atomic'
```

Reference codebase:

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/atomic-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/atomic.sock"
SESSION=atomic-reference-auth
tmux -S "$SOCKET" new -d -s "$SESSION" -c "/path/to/reference/repo" 'atomic'
```

When you use `tmux`, tell the user how to watch it:

```bash
tmux -S "$SOCKET" attach -t "$SESSION"
```

After launch, name the new session clearly so it is easy to target:

```text
/name worker
/name reference-auth
```

Then coordinate from the current session:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Take task X. Ask if blocked."
})

intercom({
  action: "ask",
  to: "reference-auth",
  message: "How does this repo structure token refresh retries?"
})
```

### Spawn Decision Rule

Spawn a visible peer session only when all of these are true:
- no existing intercom-connected session already fits the need
- the work benefits from a long-lived visible peer session
- the peer session is either in the same codebase or in an intentional reference codebase
- `cmux` is available, or `tmux` is available as an intentional fallback

If neither `cmux` nor `tmux` is available, skip this path and use normal `intercom` workflows.

## Important Constraints

### `ask` Limitations

- **Terminal noninteractive children**: Completed, failed, interrupted, or cancelled subagents cannot reply, even if listed as `idle`. New asks fail immediately; an admitted ask fails if the child terminates before replying. Launch a fresh child with explicit context. Live interactive idle sessions remain askable; `send` semantics are unchanged.
- **Never blocks**: `ask` returns once delivered. `wait` works as in `bash`: omitted waits up to the automatic yield (default 10s), `{ kind: "foreground", budgetMs }` up to a budget, `{ kind: "background" }` not at all. An ask has no expiry; its reply arrives later as a message starting `Reply to your ask <id> from <name>`, and a refusal or an ended recipient as `Your ask <id> to <name> failed`
- **Bounded waiting**: Up to `maxPendingAsks` calls (default: 6) may wait for a reply at once; further asks are still delivered and their replies arrive as messages
- **Exact correlation**: Same-target and mixed-target asks may run together; out-of-order replies and peer disconnects settle only the matching sender/message pair
- **Cannot self-target**: A session cannot ask itself
- **Supervisor exclusivity**: One blocking `contact_supervisor` decision/interview may coexist with peer asks, but a second supervisor wait is refused with `Already waiting for a supervisor reply`

```typescript
// Fan out without waiting; each reply arrives as its own message.
intercom({ action: "ask", to: "architect", message: "Review the design", wait: { kind: "background" } });
intercom({ action: "ask", to: "qa", message: "Review the tests", wait: { kind: "background" } });
```

### `send` Behavior

- **No timeout**: Message is delivered or fails immediately
- **Confirmation dialogs**: If `confirmSend: true` in config, interactive sessions show a confirmation dialog
- **Replies skip confirmation**: Messages with `replyTo` never show confirmation dialogs

## Best Practices

### Use `ask` when you need an answer

When the worker needs information to proceed:

```typescript
// GOOD: Ask, keep working on what does not depend on the answer, and act on the
// "Reply to your ask <id> from planner" message when it arrives.
intercom({
  action: "ask",
  to: "planner",
  message: "API rate limit is 100/min. Should I implement client-side throttling or batching?"
});
```

### Use `send` for notifications

When you just want to inform:

```typescript
// GOOD: Fire-and-forget notification
intercom({
  action: "send",
  to: "reviewer",
  message: "PR #123 is ready for review. Key changes in auth.ts."
});
// Continue immediately, don't wait
```

### Include reply hints in messages

Make it easy for recipients to respond:

```typescript
// GOOD: Recipient sees exact command to reply
intercom({
  action: "send",
  to: "worker",
  message: `Found the issue in auth.ts:142. Use getUserById() instead of getUser().

Reply with: intercom({ action: "reply", message: "..." })`
});
```

### Name sessions meaningfully

Use `/name` so others can target you easily:

```
/name api-worker
/name frontend-dev
/name planner
```

## Error Handling

### Common Errors and Solutions

**"Already waiting for a supervisor reply"**
```typescript
// Supervisor decisions/interviews are exclusive per child. Ordinary peer
// asks may continue concurrently; wait for the current supervisor call.
```

**"Cannot message the current session"**
```typescript
// You cannot target yourself
// This usually means you confused session names - double-check the target
```

**"Session not found"**
```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" - check the name and list available sessions
  await intercom({ action: "list" });
}
```

**"... is outside your intercom groups and its return path has closed"**
```typescript
// You answered a sender outside your groups more than 3 times, or 30 minutes after its
// latest message. Wait until it writes to you again, or share a group with it.
```

**An ask that stays pending**
```typescript
// Asks do not expire. Check what you are still waiting for, and cancel what you no longer need.
intercom({ action: "pending" });
intercom({ action: "cancel", askId: "4c4d8427" });
```

## Troubleshooting

### Session not appearing in list

1. Check Intercom connection status: `intercom({ action: "status" })`
2. Verify the target session has loaded Atomic's bundled Intercom extension
3. Ensure both sessions use the same machine's broker, or that multi-node routing is on and both machines share storage (`intercom({ action: "status" })` shows a `Multi-node routing:` line)

### Message not delivered

```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" or delivery failure reason
}
```

### Connection lost

Sessions automatically reconnect if the broker restarts. A single `send`, `ask`, or `reply` call also owns up to three internal retries after a typed recoverable disconnect, with 1, 2, and 5 second delays. Do not supply a retry token. The tool preserves the original message ID, arguments, and reply route, and never extends the original 11-minute deadline. Confirmation appears only once.

Every new tool call is a new operation, even with identical text. If recovery cannot establish the result, the tool returns a terminal error with `outcome: "unknown"`: delivery may already have occurred. Do not repeat that operation automatically. Check with the recipient before intentionally sending again. Cancellation stops new attempts; a successful receipt still reports success. An accepted ask cancelled or timed out before its reply also warns against resending. Initial nondelivery and unrelated errors do not start recovery.

Broker acceptance is retained for 12 minutes, so acknowledgement loss does not duplicate delivery and a deduplicated ask remains replyable. An implicit reply keeps its original sender/question snapshot across retries, so later inbound asks cannot redirect it. Durable SQLite stores keyed HMAC digests rather than message/attachment text; its key and database artifacts are owner-only on POSIX. Missing, malformed, uncertain, or capacity-bound authority fails closed rather than risking a duplicate.

Fresh calls reserve one of 1,000 client identity slots before confirmation, target resolution, or send; existing internal retries remain usable at capacity. Client retry state is released when the call ends, without deleting broker authority. The broker and local result relay allow 10,000 live delivery records; the broker also bounds digest/routing authority to 64 MiB. Capacity refusal never evicts a still-valid delivery identity.

If the session remains disconnected after those retries:

```typescript
intercom({ action: "status" })
// Check if broker is running and restart if needed
```

## Common Workflows

### Research → Implementation Handoff

```typescript
// Research session finds relevant code
intercom({
  action: "send",
  to: "impl-session",
  message: "Found the bug. The issue is in validateUser() - it doesn't check for null.",
  attachments: [{
    type: "snippet",
    name: "validate.ts",
    language: "typescript",
    content: `// Line 45-52 - missing null check
function validateUser(user: User) {
  return user.email?.includes("@"); // crashes if user is null
}`
  }]
});
```

### Pair Debugging

```typescript
// Session A encounters error
intercom({
  action: "ask",
  to: "session-b",
  message: "Getting 'Cannot read property of undefined' at line 78. Can you check if data.users is populated before this call?"
});

// Session B investigates and replies
intercom({
  action: "reply",
  message: "data.users is null. The fetch failed silently. Add error handling in loadUsers()."
});
```

### Progress Reporting

```typescript
// Worker sends periodic updates
intercom({ action: "send", to: "planner", message: "Task-1 complete (15min). Starting Task-2." });
// ... work ...
intercom({ action: "send", to: "planner", message: "Task-2 complete (30min). Task-3 blocked - need API key." });
// ... get unblocked ...
intercom({ action: "send", to: "planner", message: "Task-3 complete. All done." });
```

### Long-Running Task with Checkpoints

```typescript
// For long tasks, use send for progress and ask at decision points

// 1. Initial send with full context
intercom({
  action: "send",
  to: "worker",
  message: "Implement user authentication. This will take 30+ minutes. I'll check in at milestones."
});

// 2. Worker sends progress via send (no timeout)
intercom({ action: "send", to: "planner", message: "Milestone 1: Login form complete (10min)" });

// 3. Worker asks for specific decision when needed
const decision = await intercom({
  action: "ask",
  to: "planner",
  message: "Should we use JWT or session cookies? Need decision to continue."
});
// Continue with decision...
```
