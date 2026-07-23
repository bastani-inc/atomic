---
name: intercom
description: |
  Streamline session-to-session coordination with the intercom extension. Send
  messages, delegate tasks, and coordinate work across multiple atomic sessions on
  the same machine. Use for planner-worker workflows, cross-session context
  sharing, and real-time collaboration between sessions.
---

# Intercom Skill

Use this skill when you need to coordinate work across multiple atomic sessions
running on the same machine. Intercom enables direct 1:1 messaging between
sessions for delegation, context sharing, and collaborative workflows.

When you are supervising with the `subagent` skill, delegated child agents can
escalate to you via `contact_supervisor` if the subagent runtime supplied child
bridge metadata. This skill covers how to handle those orchestrator-side
escalations.

## When to Use

- **Task delegation**: Split work between a planner session and worker sessions
- **Context handoffs**: Send findings from a research session to an execution session
- **Clarification loops**: Worker asks questions, planner answers, work continues
- **Multi-session workflows**: Coordinate between specialized sessions (frontend/backend, research/implementation)

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

**Worker asks for clarification** (blocks until answer):
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Should I use exponential backoff or fixed intervals?"
})
// → Returns the planner's reply as the result
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

Before sending, verify who's connected. The short ID printed by `list` is directly usable by `send`, `ask`, and targeted `reply`:

```typescript
intercom({ action: "list" })
// → • planner (6332faab) — /workspace (model) [idle]
intercom({ action: "ask", to: "6332faab", message: "Which option should I use?" })
```

Intercom resolves exact full IDs first, exact case-insensitive names second, and unique ID prefixes last. A colliding prefix returns an ambiguity error; use a longer displayed ID or an exact name rather than guessing.

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

`reply` still preserves exact threading under the hood by sending the response with the original `replyTo` value.

### Pattern 4: Broadcast to Multiple Workers

Send to multiple sessions in parallel:

```typescript
const workers = ["worker-1", "worker-2", "worker-3"];
const task = "Check for null pointer exceptions in your assigned files";

// Fire-and-forget to all workers
workers.forEach(w => 
  intercom({ action: "send", to: w, message: task })
);
```

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

**If you receive multiple pending asks from different subagents:**

```typescript
intercom({ action: "pending" })
// → Shows all unresolved inbound asks with sender, elapsed time, and preview

intercom({ action: "reply", to: "subagent-worker-78f659a3-1", message: "Use the v2 API." })
```

**Important:** Only sessions where the `subagent` runtime supplied child bridge
metadata get the `contact_supervisor` tool. Normal sessions use the regular
`intercom` tool. If you see the formatted supervisor decision/progress update
message, treat it as a `contact_supervisor` escalation.

## Key Differences

| Action | Behavior | Use When |
|--------|----------|----------|
| `send` | Fire-and-forget | You don't need a response |
| `ask` | Blocks until reply (10 min timeout) | You need an answer to continue |
| `reply` | Responds to the active or pending inbound ask; `to` accepts a displayed short ID | You were asked something and need to answer naturally |
| `pending` | Lists unresolved inbound asks | You need to see who is waiting before replying |
| `list` | Returns all sessions with actionable short IDs and live status | You need to discover targets or choose an idle peer |
| `status` | Returns your connection state | Troubleshooting |

Inside workflows, `ask` may target a sibling stage that has already completed. If that stage retains a valid conversation, Atomic automatically schedules a post-mortem turn there and preserves the exact child-to-child reply thread; do not send a separate workflow follow-up. Missing, deleted, non-resumable, or failed-to-reopen completed targets return an actionable error. A parent or unrelated session cannot satisfy the pending ask.

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
cmux send --surface right 'cd /path/to/current/repo && pi\n'
```

Reference codebase:

```bash
cmux new-split right
sleep 0.5
cmux send --surface right 'cd /path/to/reference/repo && pi\n'
```

### Optional Fallback: tmux Worker or Scout Session

Same codebase:

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/pi-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/pi.sock"
SESSION=pi-worker
tmux -S "$SOCKET" new -d -s "$SESSION" -c "/path/to/current/repo" 'pi'
```

Reference codebase:

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/pi-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/pi.sock"
SESSION=pi-reference-auth
tmux -S "$SOCKET" new -d -s "$SESSION" -c "/path/to/reference/repo" 'pi'
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

- **10-minute timeout**: If no reply comes within 10 minutes, the ask fails
- **One at a time**: Cannot have multiple pending asks from the same session
- **Cannot self-target**: A session cannot ask itself
- **Concurrency-safe**: If several blocking requests (multiple `ask` calls, or
  `ask` plus `contact_supervisor`) race in the same session — for example from
  parallel tool calls — exactly one wins the reservation. Every other call gets
  a normal `"Already waiting for a reply"` tool error and can retry or fall
  back to `send`; the losing calls never disturb the winning ask.

```typescript
// Check if already waiting before asking
const result = await intercom({ action: "ask", to: "planner", message: "..." });
if (result.isError && result.content[0].text.includes("Already waiting")) {
  // Use send instead, or wait for current ask to complete
}
```

### `send` Behavior

- **No timeout**: Message is delivered or fails immediately
- **Confirmation dialogs**: If `confirmSend: true` in config, interactive sessions show a confirmation dialog
- **Replies skip confirmation**: Messages with `replyTo` never show confirmation dialogs

## Best Practices

### Use `ask` for blocking workflows

When the worker needs information to proceed:

```typescript
// GOOD: Worker blocks until planner responds
const reply = await intercom({
  action: "ask",
  to: "planner",
  message: "API rate limit is 100/min. Should I implement client-side throttling or batching?"
});
// Continue with the answer...
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

**"Already waiting for a reply"**
```typescript
// You can only have one pending ask at a time. Concurrent blocking requests
// (parallel asks, or ask + contact_supervisor) return this error safely; the
// winning request keeps waiting for its reply.
// Option 1: Use send instead
intercom({ action: "send", to: "planner", message: "..." });

// Option 2: Wait for the current ask to complete, then retry
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

**Ask timeout (after 10 minutes)**
```typescript
// The ask will reject with a timeout error
// Design your workflow so answers come within 10 minutes
// For longer tasks, use send + follow-up ask pattern
```

## Troubleshooting

### Session not appearing in list

1. Check intercom is enabled: `intercom({ action: "status" })`
2. Verify the target session has loaded pi-intercom
3. Ensure both sessions are on the same machine (intercom is same-machine only)

### Message not delivered

```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" or delivery failure reason
}
```

### Connection lost

Sessions automatically reconnect if the broker restarts. If persistently disconnected:

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
// For tasks that might exceed 10 minutes, use send + periodic asks

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
