---
title: "Intercom"
description: "Direct messaging between Atomic sessions on the same machine"
---

> Atomic sessions can talk to each other. Press ALT+M to message another session, or ask the agent to coordinate with a peer.

# Intercom

Atomic bundles `@bastani/intercom`, a first-party extension for direct 1:1 messaging between Atomic sessions on the same machine. Send context, findings, or requests from one session to another — whether you're driving the conversation or letting agents coordinate. Connections are lazy and tool-driven: the extension registers its commands and tools at startup, but a session does not connect until you or the model actually invoke Intercom. No separate install is needed.

**Key capabilities:**
- **Session messaging** - `send`, `ask` (blocking, 10-minute timeout), `reply`, `pending`, `list`, `groups`, and `status` via the `intercom` tool
- **Runtime groups** - Add or remove named memberships without restarting; joined sessions keep their broker IDs and later subagents inherit the most recently joined membership
- **Session and group discovery** - List connected sessions or every available group, including session counts and membership markers
- **Keyboard overlay** - ALT+M or `/intercom` opens a session picker and compose overlay
- **Attachments** - Share `file`, `snippet`, and `context` payloads between sessions
- **Subagent escalation** - Delegated children get a `contact_supervisor` tool for decisions, structured interviews, and progress updates
- **Run notifications** - Workflows and subagents deliver run results and control notices to a parent session over Intercom
- **Bundled skill** - `/skill:intercom` provides planner-worker, group, and escalation-handling patterns

**Example use cases:**
- Planner–worker splits across two terminals
- Research → implementation context handoffs
- Supervisor decisions and structured interviews for delegated subagents
- Pair debugging between sessions

## Where to go next

Intercom coordinates several Atomic sessions on one machine. Read this page for the quick start and the coordination patterns, then continue:

- [Intercom operations](/intercom/operations) — connection lifecycle, delivery behavior, notifications, shortcuts, internals, and limits.
- [Intercom reference](/intercom/reference) — the `intercom` tool contract and every intercom setting.

## Table of Contents

- [Quick Start](#quick-start)
  - [From the Keyboard](#from-the-keyboard)
  - [From the Agent](#from-the-agent)
  - [Receiving Messages](#receiving-messages)
- [How Connection Works](/intercom/operations#how-connection-works)
- [The intercom Tool](/intercom/reference#the-intercom-tool)
  - [Actions](/intercom/reference#actions)
  - [Targeting Sessions and Pending Workflow Stages](/intercom/reference#targeting-sessions-and-pending-workflow-stages)
  - [Deferred delivery to pending stages](/intercom/reference#deferred-delivery-to-pending-stages)
  - [send vs ask vs reply](/intercom/reference#send-vs-ask-vs-reply)
  - [Attachments](/intercom/reference#attachments)
- [Coordination Patterns](#coordination-patterns)
- [Subagent Escalation: contact_supervisor](#subagent-escalation-contact_supervisor)
  - [When the Tool Appears](#when-the-tool-appears)
  - [The Three Reasons](#the-three-reasons)
  - [What the Supervisor Sees](#what-the-supervisor-sees)
  - [Structured Interview Replies](#structured-interview-replies)
- [Workflow and Subagent Notifications](/intercom/operations#workflow-and-subagent-notifications)
  - [Workflow Delivery Modes](/intercom/operations#workflow-delivery-modes)
  - [Subagent Control Notices](/intercom/operations#subagent-control-notices)
  - [Delivery Ordering](/intercom/operations#delivery-ordering)
- [Configuration](/intercom/reference#configuration)
- [Keyboard Shortcuts](/intercom/operations#keyboard-shortcuts)
- [How It Works](/intercom/operations#how-it-works)
- [Intercom vs Shared-Room Messengers](#intercom-vs-shared-room-messengers)
- [Limitations](/intercom/operations#limitations)
- [Related Docs](#related-docs)

## Quick Start

### From the Keyboard

Press **ALT+M** or run `/intercom` to open the session list overlay:

1. **Select a session** — Use arrow keys to pick a target session
2. **Compose message** — Write your message in the compose overlay
3. **Send** — Enter Send · Escape Cancel

Sent messages are recorded in session history and confirmed with a notification.

### From the Agent

The agent can list sessions and send messages using the `intercom` tool. Tool calls and results render as compact transcript rows so send/ask/reply flows are easy to scan:

```typescript
// List active sessions
intercom({ action: "list" })
// → **Current session** (groups: default):
// → - `20d43841-1111-4222-8333-123456789abc` [self, idle] ~/projects/api (claude-sonnet-4) name: executor
// → **Other visible sessions and workflow stages:**
// → - `6332faab-1111-4222-8333-123456789abc` [same cwd, thinking] ~/projects/api (claude-sonnet-4) name: research

// Send a message
intercom({ action: "send", to: "research", message: "Check if UserService.validate() handles null" })
// → Message sent to research

// The full session ID printed by list is also a valid target
intercom({ action: "ask", to: "6332faab-1111-4222-8333-123456789abc", message: "Which validation path should I use?" })

// Check connection status
intercom({ action: "status" })
// → Connected: Yes, Session ID: abc12345-1111-4222-8333-123456789abc, Active sessions: 3

// Send with attachments (code snippets, files, or context)
intercom({
  action: "send",
  to: "worker",
  message: "Here's the fix:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: "function validate(user: User) { ... }"
  }]
})
```

### Receiving Messages

When a message arrives, it appears inline in your chat with the sender's info and a reply hint:

```
**From research** (~/projects/api)

To reply, use the intercom tool: intercom({ action: "reply", message: "..." })

Found the issue — UserService.validate() doesn't check for null input.
See auth.ts:142-156.
```

The reply hint (enabled by default) points to `intercom({ action: "reply", ... })`, so recipients never need raw sender or `replyTo` IDs. Idle recipients get a new turn immediately; busy interactive recipients receive the message once they go idle. Attachment content is included in the agent-visible body, and messages are rendered inline and stored in Atomic session history.

Working subagents and live workflow stages treat `send` and `ask` as a priority interrupt queue. The recipient's current model call or cancellable tool is cancelled immediately, and the message is processed next within the same task, session, and stage generation; Intercom never launches another task or repeats the original prompt. A tool that ignores cancellation finishes first, and completed side effects are kept rather than undone or replayed. This works with foreground and background subagents. Messages received during startup join the original task, multiple messages retain arrival order, and an ask keeps its exact reply correlation after the cancelled turn. Explicit `interrupt`, owner cancellation, host stop, and terminal children or closed stages still win over later input. Use an exact connected child name or full session ID from `intercom list`; subagents are not workflow-stage paths.

A busy non-interactive recipient that is neither an admitted subagent nor a workflow stage can still refuse a message without interrupting its task. A successful `send` receipt acknowledges transport delivery, not acceptance by the recipient's model. The refusal carries the original reply thread: a waiting `ask` returns an error; otherwise the sender sees **Intercom delivery failed** feedback with a `Sent:` timestamp. That feedback bypasses the ordinary idle queue and does not trigger a standalone agent turn. During an active turn, protected delivery makes it visible and reconciles it at a protocol-safe boundary. Its wording describes the refused send, not the recipient's later activity.

Atomic treats ordinary `intercom` as a mandatory runtime tool in main chat and every workflow model stage. Tool allowlists, exclusions, `noTools`, optional-extension restrictions, and reloads cannot unload or deactivate it. Restrictions on every other tool are unchanged, and `contact_supervisor` remains subagent-only. Tool registration is lightweight; broker connection and heavy initialization remain lazy until an Intercom surface is used.

## How Connection Works

Moved to [Intercom operations](/intercom/operations#how-connection-works).

### Troubleshooting initialization

Moved to [Intercom operations](/intercom/operations#troubleshooting-initialization).

## The intercom Tool

Moved to [Intercom reference](/intercom/reference#the-intercom-tool).

### Actions

Moved to [Intercom reference](/intercom/reference#actions).

### Targeting Sessions and Pending Workflow Stages

Moved to [Intercom reference](/intercom/reference#targeting-sessions-and-pending-workflow-stages).

### Deferred delivery to pending stages

Moved to [Intercom reference](/intercom/reference#deferred-delivery-to-pending-stages).

### Groups

Moved to [Intercom reference](/intercom/reference#groups).

### send vs ask vs reply

Moved to [Intercom reference](/intercom/reference#send-vs-ask-vs-reply).

### Attachments

Moved to [Intercom reference](/intercom/reference#attachments).

## Coordination Patterns

The most natural use of Intercom is splitting a task between two sessions — one holds the big picture, the other does the hands-on work. Open two terminals, start Atomic in each, and name them so they can find each other:

```
# Terminal 1                    # Terminal 2
/name planner                   /name worker
```

Verify they see each other with `intercom({ action: "list" })`, then coordinate:

```typescript
// Planner delegates with send (fire-and-forget)
intercom({
  action: "send",
  to: "worker",
  message: "Task-3: Add retry logic to API client. Key files: src/api/client.ts, src/api/types.ts. Ask if anything's unclear."
})

// Worker hits an ambiguity — asks and waits
intercom({
  action: "ask",
  to: "planner",
  message: "Should retry apply to all endpoints or just idempotent ones? Also, max retry count and backoff strategy?"
})
// → Reply from planner: Only GET/PUT/DELETE — never POST. Max 3 retries, exponential backoff starting at 100ms.
// Worker continues implementing with the answer, same turn, full context.
```

| Pattern | Action | Why |
|---------|--------|-----|
| **Task delegation** | Planner uses `send` | Fire-and-forget. Planner doesn't need to wait for an ack. |
| **Clarification request** | Worker uses `ask` | Worker needs the answer to proceed. Blocks until reply. |
| **Discovery escalation** | Worker uses `ask` | Worker needs approval before changing course. |
| **Completion report** | Worker uses `ask` | Planner might have follow-up instructions or the next task. |

The bundled `intercom` skill (`/skill:intercom`) has copy-paste ready patterns for planner-worker delegation, status checks, natural replies, broadcasting to multiple workers, attachments, and handling subagent escalations on the orchestrator side.

**Recommended:** Add this snippet to your project's `AGENTS.md` to help agents understand when to coordinate across sessions:

```xml
<intercom>
Coordinate with other local Atomic sessions on related codebases. Use `/skill:intercom` for patterns.

**When:** Same codebase (parallel work), reference codebase (consulting patterns), related repos (shared libraries).

**Not when:** Unrelated codebases, trivial questions, or when you can proceed independently.

**Principle:** Prefer `send` for notifications; `ask` only when blocked waiting for input.
</intercom>
```

## Subagent Escalation: contact_supervisor

When Atomic's [subagent runtime](/subagents) admits a delegated child, the child session gets a subagent-only `contact_supervisor` tool in addition to the regular `intercom` tool. Normal sessions never see `contact_supervisor`.

### When the Tool Appears

`contact_supervisor` is registered from the typed admission record. The record binds the supervisor target, canonical child identity, child index, session name, and any broker-issued capability to that in-process child session; none of those values are inherited from environment variables. If the parent did not grant supervisor coordination, the session receives only the regular `intercom` tool.

In parallel runs, a parent-targeted blocking ask waits in its original child execution. Foreground observations may yield so the parent can reply, but active and queued siblings retain their identities and execution capacity. Sends and progress updates never wait for a reply. A single-child launch retains the terminal fresh-child handoff when its exact live owner claims a blocking parent request.

| Parameter | Type | Description |
|-----------|------|-------------|
| `reason` | string | `"need_decision"` (blocking), `"interview_request"` (blocking structured questions), or `"progress_update"` (fire-and-forget) |
| `message` | string | The decision request, optional interview note, or progress update |
| `interview` | object | Required for `interview_request`: `{ title?, description?, questions: [...] }` |

### The Three Reasons

| Reason | Behavior | Use When |
|--------|----------|----------|
| `need_decision` | In parallel, waits for the supervisor's correlated reply and continues in the same child; single-child launches retain the claimed fresh-child handoff | The subagent is blocked, uncertain, needs approval, or faces a product/API/scope decision |
| `interview_request` | In parallel, waits for structured supervisor answers in the same child; single-child launches retain the claimed fresh-child handoff | The subagent needs multiple machine-readable answers from the supervisor in one exchange |
| `progress_update` | Fire-and-forget update to the supervisor; does not end the child | Meaningful progress or unexpected discoveries that change the plan |

Do not use `contact_supervisor` for routine completion handoffs—return the final subagent result normally. Parallel requests use ordinary Intercom delivery and reply waiting without cancelling the batch. Single-child blocking reasons retain interception before broker connection or waiter admission when the exact live child claims them.

```typescript
// Blocked subagent asks for guidance
contact_supervisor({
  reason: "need_decision",
  message: "The auth service returns 403 instead of 401 for expired tokens. Should I treat 403 as a re-auth trigger or a hard failure?"
})
// → In parallel: the supervisor replies through Intercom; this child continues with the answer.
// → Single-child claimed handoff: parent receives [TASK_CONTEXT] for a fresh child.

// Fire-and-forget progress update
contact_supervisor({
  reason: "progress_update",
  message: "Discovered the bug is in the retry wrapper, not the API client. Fixing the wrapper will also close issue #42."
})
// → Progress update sent to supervisor planner
```

### What the Supervisor Sees

For a parallel child, the supervisor receives the question with its child/run identity and a reply hint. Answer through `intercom({ action: "reply", message: "..." })`; if several questions are pending, use `pending` and the exact `replyTo`. The answer returns as the requesting child's tool result. Do not launch a replacement child to answer it.

Single-child claimed handoffs instead include terminal run metadata, ordered attachments, the original delegated task, and an explicit fresh-start `[TASK_CONTEXT]` call. That legacy single-child path still requires a new run identity for follow-up work.

For a single-child claimed handoff, the fresh-start instruction has this form:

```text
Subagent yielded for parent input (worker, child 1).
Previous run (terminal): 78f659a3
Question:
Which API should I use?

Start a fresh subagent with a new run identity, replacing <SUPERVISOR_ANSWER> with your answer:
subagent({
  "agent": "worker",
  "task": "[TASK_CONTEXT] ... Continue with this supervisor answer: <SUPERVISOR_ANSWER>"
})
```

### Structured Interview Replies

`interview_request` questions use the shape `{ id, type, question, options?, context? }` where `type` is `single`, `multi`, `text`, `image`, or `info` (`info` questions are context-only and need no response):

```typescript
contact_supervisor({
  reason: "interview_request",
  message: "Please answer these before I continue the migration.",
  interview: {
    title: "API migration choices",
    questions: [
      { id: "api", type: "single", question: "Which API should I target?", options: ["Stable API", "Experimental API"] },
      { id: "constraints", type: "text", question: "What constraints should I preserve?" }
    ]
  }
})
```

In parallel, questions arrive without reordering or rewriting. The supervisor can reply with plain or fenced JSON using this stable shape, which keeps answers tied to question IDs:

```json
{
  "responses": [
    { "id": "api", "value": "Stable API" },
    { "id": "constraints", "value": "Keep the public error shape unchanged." }
  ]
}
```

The parallel child's tool result preserves the raw reply text and includes `details.structuredReply` when the answer matches the expected question IDs and options. A single-child claimed handoff instead carries the structured questions into its fresh task context and does not create an Intercom reply.

## Workflow and Subagent Notifications

Moved to [Intercom operations](/intercom/operations#workflow-and-subagent-notifications).

### Workflow Delivery Modes

Moved to [Intercom operations](/intercom/operations#workflow-delivery-modes).

### Subagent Control Notices

Moved to [Intercom operations](/intercom/operations#subagent-control-notices).

### Delivery Ordering

Moved to [Intercom operations](/intercom/operations#delivery-ordering).

## Configuration

Moved to [Intercom reference](/intercom/reference#configuration).

## Keyboard Shortcuts

Moved to [Intercom operations](/intercom/operations#keyboard-shortcuts).

## How It Works

Moved to [Intercom operations](/intercom/operations#how-it-works).

## Intercom vs Shared-Room Messengers

| Aspect | Intercom | Shared-room messengers |
|--------|----------|------------------------|
| **Model** | Direct 1:1 messaging | Shared chat room |
| **Primary use** | User orchestrating sessions | Autonomous agent swarms |
| **Discovery** | Broker-based (real-time) | File-based registry |
| **Messages** | Private, session-to-session | Broadcast to all agents |
| **Persistence** | In Atomic session history | Shared coordination files |

Use a shared-room messenger for multi-agent swarms working on one shared task. Use Intercom when you want to manually coordinate your own sessions or have one agent reach out to another specific session.

## Limitations

Moved to [Intercom operations](/intercom/operations#limitations).

## Related Docs

- [Subagents](/subagents) for delegated child runs, foreground coordination, and result delivery.
- [Workflows](/workflows) for multi-stage automation and run notifications.
- [Skills](/skills) for reusable instructions like `/skill:intercom`.
- [Usage](/usage) for environment variables and the bundled-extension overview.
