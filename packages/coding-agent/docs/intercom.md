---
title: "Coordinate sessions with Intercom"
sidebarTitle: "Coordinate sessions"
description: "Send messages, ask non-blocking questions, and escalate subagent decisions between Atomic sessions."
---

Intercom provides direct and broadcast messaging between Atomic sessions on the same machine, or across multiple machines sharing a [PostgreSQL database](/storage#sharing-storage-across-hosts). You can message another session yourself or let agents coordinate directly, with no separate install required.

| What you want | Use this |
| --- | --- |
| Send a message from the terminal UI | Press `Alt+M` or run `/intercom` |
| Send a fire-and-forget update or handoff | `intercom({ action: "send", to, message })` |
| Ask a question without blocking the caller | `intercom({ action: "ask", to, message })` |
| Answer an incoming ask | `intercom({ action: "reply", message })` |
| Escalate a subagent decision or interview | `contact_supervisor({ reason, message, interview? })` |
| Coordinate sessions across machines or teams | [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) |

## How sessions join

The `/intercom` command, `Alt+M` shortcut, and `intercom` tool are available as soon as Atomic starts. Interactive sessions join Intercom automatically in the background 3 seconds after startup, so other sessions in their group can list and message them right away without slowing startup.

Print (`-p`), JSON, RPC, and SDK sessions connect on first Intercom use or when they launch a subagent with Intercom. Interactive sessions do the same when startup join is disabled (`joinAtStartup: false` in [Intercom configuration](/intercom/reference#configuration), or `ATOMIC_INTERCOM_JOIN_AT_STARTUP=0` / `false`). Subagents launched with Intercom connect immediately before their first turn and inherit the launching session's group unless the launch sets `group`.

Atomic enables `intercom` by default unless excluded by tool allowlists, exclusions, or `noTools: "all"`. For programmatic setup, `builtins: { intercom: false }`, and group reach policies, see [SDK tools](/sdk/reference#tools) and [Reach policies](/intercom/reference#reach-policies).

## Quick start

### From the keyboard

<Steps>
  <Step title="Name your sessions (optional)">
    Run `/name planner` in one terminal and `/name worker` in another so each session has a readable target name.
  </Step>
  <Step title="Open the Intercom overlay">
    Press `Alt+M` or run `/intercom` to open the session list overlay (`Alt+M` is bound by the Intercom extension rather than `keybindings.json`; `/intercom` always works as a fallback).
  </Step>
  <Step title="Select a session and send">
    Use the arrow keys to pick a target session, press `Enter`, type your message, and press `Enter` to send (or `Esc` to cancel).
  </Step>
</Steps>

Sent messages are recorded in session history and confirmed with a notification.

### From the agent

Agents list sessions and exchange messages through the `intercom` tool. Tool calls and results render as compact transcript rows so message flows stay easy to scan:

```typescript
// List active sessions
intercom({ action: "list" })
// Output:
// **Current session** (groups: default):
// - `20d43841-1111-4222-8333-123456789abc` [self, idle] ~/projects/api (claude-sonnet-4) name: executor
// **Other visible sessions:**
// - `6332faab-1111-4222-8333-123456789abc` [same cwd, thinking] ~/projects/api (claude-sonnet-4) name: research

// Send a fire-and-forget message
intercom({ action: "send", to: "research", message: "Check if UserService.validate() handles null" })
// Output: Message sent to research

// Broadcast to matching sessions (requires broadcast: true) or to all launched subagents
intercom({ action: "send", to: "subagent-worker-*", message: "Scope changed: skip the migration", broadcast: true })
intercom({ action: "send", to: "subagents:*", message: "Stop and report what you have" })
// Output lists each recipient's outcome: delivered, queued, or not delivered with the reason

// Ask a non-blocking question (session IDs from list are valid targets too)
intercom({ action: "ask", to: "6332faab-1111-4222-8333-123456789abc", message: "Which validation path should I use?" })
// Quick replies return inline. Otherwise:
// Ask 4c4d8427-... delivered to research (busy: running bash).
// The reply arrives later as a message starting "Reply to your ask 4c4d8427-... from research".

// Control how long ask waits for an inline reply (same wait shape as bash)
intercom({ action: "ask", to: "research", message: "Any blockers?", wait: { kind: "background" } })
intercom({ action: "ask", to: "research", message: "Any blockers?", wait: { kind: "foreground", budgetMs: 60000 } })

// Inspect pending asks, cancel an outbound ask, or close an inbound ask without replying
intercom({ action: "pending" })
intercom({ action: "cancel", askId: "4c4d8427" })
intercom({ action: "cancel", replyTo: "9f2c1e07" })

// Check connection and routing status
intercom({ action: "status" })
// Output:
// **Intercom Status:**
// Connected: Yes
// Session ID: abc12345-1111-4222-8333-123456789abc
// Groups: default
// Active visible sessions: 3
// Multi-node routing: off: the shared storage selection names no database
// Your asks awaiting a reply: 0

// Send with attachments (file, snippet, or context)
intercom({
  action: "send",
  to: "worker",
  message: "Here is the fix:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: "function validate(user: User) { ... }"
  }]
})
```

### Receiving messages

Incoming messages appear inline in chat with the sender's details and a reply hint:

```text
**From research** (~/projects/api)

To reply, use the intercom tool: intercom({ action: "reply", message: "..." })

Found the issue: UserService.validate() does not check for null input.
See auth.ts:142-156.
```

The reply hint is enabled by default, so recipients can answer with `intercom({ action: "reply", message: "..." })` without tracking raw message IDs. Idle recipients start a new turn immediately, while busy interactive main sessions receive incoming messages when they become idle. Attachment content appears inside the model-visible body, and messages are stored in session history.

The recipient saves each message before confirming `delivered` to the sender. If a busy recipient closes or crashes before displaying a saved message, resuming it with `atomic --session <id>` or `/resume` replays unread messages once in arrival order when the sender is still connected. Messages from a sender that is gone are recorded once without starting a turn, and sessions started with `--no-session` cannot recover unread messages after exit.

### Delivery modes for working subagents

Working subagents act on incoming `send` and `ask` messages in their active session according to the sender's case-sensitive `delivery` option (busy interactive main sessions always wait until idle):

| `delivery` | When a working subagent receives it | Use it for |
| --- | --- | --- |
| `"steer"` (default) | After its current tool calls finish. Current work is not cancelled. | Ordinary coordination, findings, and updates |
| `"followUp"` | After the subagent finishes and stops. | Low-priority notes or follow-up tasks |
| `"interrupt"` | Immediately. Cancels the current model call or cancellable tool call, then runs the message next. | Urgent corrections or stop orders |

Any sender can set `delivery` per `send` or `ask` call, and an idle recipient starts a turn under any mode. For example, `intercom({ action: "send", to: "worker", message: "Stop; the spec changed", delivery: "interrupt" })` cancels the worker's current cancellable tool call; tools that ignore cancellation finish first, and completed side effects are not undone.

Messages from one sender always arrive in order, whether delivered immediately, queued for idle, or replayed on resume. Subagent `pause` and `quit`, session cancellation, host stop, and permanent cancellation take precedence over later messages.

### Offline and finished subagents

Sending or asking a completed or failed subagent resumes it automatically. The call returns immediately with the message queued, the launching session resumes the subagent, and the subagent receives the message as its next prompt. Messages to a paused or quit subagent wait in a queue with no time limit until the launching session continues it.

Queued messages survive broker restarts and deliver once in order. If delivery becomes impossible—because the subagent was cancelled, the launching session ended, or the launching session stayed away for 7 consecutive days—the sender receives one delivery failure. See [Messages that resume a finished subagent](/intercom/reference#messages-that-resume-a-finished-subagent).

A busy non-interactive recipient other than a running subagent can refuse a message without interrupting its work. Refusals keep the reply thread: an `ask` receives a failed-ask message (or an inline error while waiting), and a `send` delivers an **Intercom delivery failed** notice with a `Sent:` timestamp without starting a standalone turn.

## Coordination patterns

A common pattern splits a task between two terminal sessions: one holds the plan and review scope, while the other edits code. Start Atomic in both terminals and name them with `/name`:

```text
# Terminal 1                    # Terminal 2
/name planner                   /name worker
```

Confirm both sessions appear in `intercom({ action: "list" })`, then coordinate:

```typescript
// Planner delegates with send (fire-and-forget)
intercom({
  action: "send",
  to: "worker",
  message: "Task-3: Add retry logic to API client. Key files: src/api/client.ts, src/api/types.ts. Ask if anything is unclear."
})

// Worker hits an ambiguity, asks, and continues unblocked work
intercom({
  action: "ask",
  to: "planner",
  message: "Should retry apply to all endpoints or only idempotent ones? Also, max retry count and backoff strategy?"
})
// If planner replies within the wait budget, the answer returns inline.
// Otherwise the ask stays pending and arrives later as a message:
// Reply to your ask 4c4d8427-... from planner
// Only GET/PUT/DELETE, never POST. Max 3 retries, exponential backoff starting at 100ms.
```

| Pattern | Action | Why |
| --- | --- | --- |
| **Task delegation** | Planner uses `send` | Fire-and-forget. Planner does not need to wait for an answer. |
| **Clarification request** | Worker uses `ask` | Worker needs an answer to proceed and keeps working on unblocked tasks until the reply arrives. |
| **Discovery escalation** | Worker uses `ask` | Worker requests approval before changing direction. |
| **Completion report** | Worker uses `ask` | Planner may have follow-up instructions or the next task. |
| **Peer handoff** | Sibling uses `send` | A researcher or debugger passes file paths, evidence, or a reproduction straight to the sibling that needs it. |
| **Peer challenge** | Sibling uses `ask` | One reviewer or worker challenges another's finding with evidence while each still returns its own verdict. |
| **Ownership claim** | Sibling uses `send` | Parallel writers divide file ownership or serialize a shared build, test suite, or migration. |
| **Broadcast** | Sibling uses `send` with a pattern | One agent shares a confirmed finding with every live sibling at once. |

Peer-to-peer coordination is the default for subagent swarms. Subagents launched together share an Intercom group, so they list each other and coordinate directly without routing peer messages through the supervisor. Reserve `contact_supervisor` for supervisor decisions. See [Peer coordination](/subagents#peer-coordination) and [Scaling a swarm](/subagents#scaling-a-swarm).

<Tip>
Run `/skill:intercom` for ready-to-use planner-worker, group, broadcast, attachment, and escalation patterns.
</Tip>

Add this snippet to your project's `AGENTS.md` to guide when agents should coordinate across sessions:

```xml
<intercom>
Coordinate with other local Atomic sessions on related codebases. Use `/skill:intercom` for patterns.

**When:** Same codebase (parallel work), reference codebase (consulting patterns), related repos (shared libraries).

**Not when:** Unrelated codebases, trivial questions, or when you can proceed independently.

**Principle:** Prefer `send` for notifications; `ask` when you need an answer. `ask` never blocks: its reply arrives as a message.
</intercom>
```

## Escalate subagent decisions with `contact_supervisor`

By default (`intercomBridge.mode: "always"` in [Subagent `config.json` reference](/subagents/reference#subagent-config-json-reference)), every subagent launched by a session with Intercom active receives the subagent-only `contact_supervisor` tool alongside `intercom`. Atomic wires up the supervisor target automatically; normal sessions never see `contact_supervisor`.

Setting `intercomBridge.mode` to `"off"` (or `"fork-only"` for fresh subagents) limits `contact_supervisor` to agents that explicitly list it in their frontmatter tools.

### Parameters and reasons

| Parameter | Type | Description |
| --- | --- | --- |
| `reason` | string | `"need_decision"` (blocking), `"interview_request"` (blocking structured questions), or `"progress_update"` (fire-and-forget). |
| `message` | string | Required for `progress_update`. Optional for `need_decision` (omitting it sends an empty question, so always pass a clear question) and optional note for `interview_request`. |
| `interview` | object | Required for `interview_request`: `{ title?, description?, questions: [...] }`. |

| Reason | Behavior | Use when |
| --- | --- | --- |
| `need_decision` | Waits inside the requesting subagent (up to 10 minutes) for the supervisor's correlated reply, then continues in that same subagent. | The subagent is blocked, uncertain, needs approval, or faces a product, API, or scope decision. |
| `interview_request` | Waits inside the requesting subagent (up to 10 minutes) for structured answers from the supervisor, then continues in that same subagent. | The subagent needs multiple machine-readable answers in one exchange. |
| `progress_update` | Fire-and-forget update to the supervisor. Returns immediately without waiting or disrupting siblings. Under multi-node routing, queues automatically (`queued: true`) if the supervisor has no live session and delivers when the supervisor reconnects. | Meaningful progress or unexpected discoveries change the plan. |

Do not use `contact_supervisor` for routine completion handoffs; return the final subagent result normally. A parent's `subagent({ action: "wait" })` call yields so the supervisor can reply without cancelling active or queued siblings. If the broker refused a subagent's supervisor authorization when it registered, `contact_supervisor` retries that authorization once on the next call.

```typescript
// Blocked subagent asks for guidance
contact_supervisor({
  reason: "need_decision",
  message: "The auth service returns 403 instead of 401 for expired tokens. Should I treat 403 as a re-auth trigger or a hard failure?"
})

// Fire-and-forget progress update
contact_supervisor({
  reason: "progress_update",
  message: "Discovered the bug is in the retry wrapper, not the API client. Fixing the wrapper will also close issue #42."
})
// Output: Progress update sent to supervisor planner
```

### Answering a subagent as the supervisor

The supervisor receives the question with child and run identity plus a reply hint. Answer through `intercom({ action: "reply", message: "..." })`. If several questions are pending, run `intercom({ action: "pending" })` and pass the exact `replyTo`. Your answer returns as the subagent's tool result; do not launch a replacement subagent just to answer it.

### Structured interview replies

`interview_request` questions use `{ id, type, question, options?, context? }`:

- `questions` must be a non-empty array with unique, non-empty `id` strings.
- `type` must be `"single"`, `"multi"`, `"text"`, `"image"`, or `"info"` (`info` items provide context only and need no answer).
- `options` is **required** (non-empty array of strings or `{ label: string }` objects) for `single` and `multi`, and **rejected** for `text`, `image`, and `info`.
- `message` is optional.

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

Questions arrive without reordering or rewriting. Reply with plain JSON or a fenced code block (if a reply contains multiple fenced blocks, only the first is parsed):

```json
{
  "responses": [
    { "id": "api", "value": "Stable API" },
    { "id": "constraints", "value": "Keep the public error shape unchanged." }
  ]
}
```

The subagent's tool result preserves the raw reply text and populates `details.structuredReply` when the JSON matches the expected question IDs and options. If parsing or validation fails, `details.structuredReply` is omitted and `details.structuredReplyParseError` describes the error while keeping the raw reply text.

<Note>
**Embedded SDK sessions without background task management.** When an embedded SDK session launches a single subagent directly without background task management, a blocking `need_decision` or `interview_request` ends that subagent instead of waiting in place. The caller receives terminal run metadata, ordered attachments, the original delegated task (including any structured interview questions), and a fresh-start `[TASK_CONTEXT]` `subagent(...)` call to launch with the supervisor's answer.
</Note>

## Next steps

<Columns cols={2}>
  <Card title="Operate Intercom" href="/intercom/operations">
    Broker lifecycles, multi-machine routing over PostgreSQL, zero-downtime upgrades, and connection recovery.
  </Card>
  <Card title="Intercom reference" href="/intercom/reference">
    Complete `intercom` tool specification, targeting rules, groups, wake queues, `config.json`, and SDK errors.
  </Card>
  <Card title="Set up teams and CI" href="/guides/team-setup">
    Share Intercom across a team with PostgreSQL while keeping personal sessions local, plus CI runner setup.
  </Card>
  <Card title="Run subagents" href="/subagents">
    Delegated subagent runs, peer coordination, worktrees, run control, and released subagents.
  </Card>
</Columns>

- [Intercom group and reach in the SDK](/sdk#intercom-group-and-reach) and [SDK tools](/sdk/reference#tools) for programmatic reach policies and `builtins.intercom`.
- [Storage and Intercom CLI commands](/reference/cli#storage-and-intercom-commands) for `atomic intercom` and `atomic storage` subcommands.
- [Orchestrate with codemode and subagents](/orchestration) for scripted multi-step workflows.
- [Environment variables](/environment-variables) for Intercom environment overrides.
