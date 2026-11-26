---
title: "Coordinate sessions with Intercom"
sidebarTitle: "Intercom guide"
description: "Send messages, ask non-blocking questions, and escalate subagent decisions between Atomic sessions."
---

Intercom provides direct and broadcast messaging between Atomic sessions on the same machine, or across multiple machines that share a [storage database](/storage#sharing-storage-across-hosts). You can send context, findings, or requests yourself, or let agents coordinate directly. No separate install is required.

New to Intercom? Start with [Intercom overview](/guides/intercom). For multi-machine setup, broker upgrades, and recovery, see [Operate Intercom](/intercom/operations). For the tool schema, settings, and SDK errors, see [Intercom reference](/intercom/reference). For programmatic group and reach control, see [Intercom group and reach in the SDK](/sdk#intercom-group-and-reach).

The `/intercom` command, `Alt+M` shortcut, and `intercom` tool are available as soon as Atomic starts. An interactive session joins Intercom automatically in the background 3 seconds after startup, so other sessions in its group can list and message it before it uses Intercom itself. Startup never waits for this connection.

Print (`-p`), JSON, RPC, and SDK sessions connect on first Intercom use or when they launch a subagent with Intercom. Interactive sessions do the same when startup join is disabled (`ATOMIC_INTERCOM_JOIN_AT_STARTUP=0` or `false`, legacy alias `PI_INTERCOM_JOIN_AT_STARTUP`, or `joinAtStartup: false` in [Intercom configuration](/intercom/reference#configuration) without `ATOMIC_INTERCOM_JOIN_AT_STARTUP=1` or `true`; unrecognized environment values are ignored). A subagent launched with Intercom connects as soon as its session starts and inherits the launching session's group unless the launch sets `group`.

**Key capabilities:**

- **Session messaging.** Call `send`, `ask`, `reply`, `pending`, `cancel`, `list`, `groups`, and `status` through the `intercom` tool. Calls to `ask` never block; late replies arrive as messages.
- **Runtime groups.** Add or remove named memberships without restarting. Joined sessions keep their Intercom session IDs, and later subagents inherit the most recently joined membership.
- **Session and group discovery.** List connected sessions or every active group with session counts and membership markers.
- **Keyboard overlay.** Press `Alt+M` or run `/intercom` to pick a session and compose a message.
- **Attachments.** Share `file`, `snippet`, and `context` payloads between sessions.
- **Subagent escalation.** Subagents receive `contact_supervisor` for decisions, structured interviews, and progress updates.
- **Run notifications.** Subagents deliver run results and activity notices to their launching session over Intercom.
- **Bundled skill.** Run `/skill:intercom` for planner-worker, group, broadcast, and escalation patterns.
- **Programmatic reach policies.** Embedded SDK hosts can constrain a session's reachable groups via [Intercom group and reach](/sdk#intercom-group-and-reach) and [Reach policies](/intercom/reference#reach-policies).

**Common use cases:**

- Planner and worker splits across two terminals.
- Research-to-implementation context handoffs.
- Supervisor decisions and structured interviews for subagents.
- Peer-to-peer coordination across parallel subagents.
- Pair debugging between sessions.

## Where to go next

Read this page for the quick start, coordination patterns, and supervisor escalation. Then continue to:

- [Operate Intercom](/intercom/operations) for connection lifecycles, delivery recovery, broker upgrades, and troubleshooting.
- [Running Intercom across machines](/intercom/operations#running-intercom-across-machines), [Sharing storage across hosts](/storage#sharing-storage-across-hosts), and [Set up teams and CI](/guides/team-setup) for multi-machine messaging through shared storage.
- [Intercom reference](/intercom/reference) for the `intercom` tool contract, targeting rules, error classes, and every Intercom setting.
- [Intercom group and reach in the SDK](/sdk#intercom-group-and-reach) and [SDK tools](/sdk/reference#tools) for programmatic reach policies and `builtins.intercom`.

## Quick start

### From the keyboard

Press **`Alt+M`** or run `/intercom` to open the session list overlay (`Alt+M` is bound by the Intercom extension rather than `keybindings.json`; `/intercom` always works as a fallback):

1. **Select a session.** Use arrow keys to choose a target session.
2. **Compose a message.** Type your message in the compose overlay.
3. **Send.** Press `Enter` to send or `Esc` to cancel.

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

// Send a message
intercom({ action: "send", to: "research", message: "Check if UserService.validate() handles null" })
// Output: Message sent to research

// Broadcast to matching sessions (requires broadcast: true) or to all launched subagents
intercom({ action: "send", to: "subagent-worker-*", message: "Scope changed: skip the migration", broadcast: true })
intercom({ action: "send", to: "subagents:*", message: "Stop and report what you have" })
// Output lists each recipient's outcome: delivered, queued, or not delivered with the reason

// Full session IDs printed by list are also valid targets
intercom({ action: "ask", to: "6332faab-1111-4222-8333-123456789abc", message: "Which validation path should I use?" })
// Quick replies return inline. Otherwise:
// Ask 4c4d8427-... delivered to research (busy: running bash).
// The reply arrives later as a message starting "Reply to your ask 4c4d8427-... from research".

// Ask without waiting, or wait up to a budget (same shape as bash)
intercom({ action: "ask", to: "research", message: "Any blockers?", wait: { kind: "background" } })
intercom({ action: "ask", to: "research", message: "Any blockers?", wait: { kind: "foreground", budgetMs: 60000 } })

// Inspect pending asks, cancel an outbound ask, or close an inbound ask without replying
intercom({ action: "pending" })
intercom({ action: "cancel", askId: "4c4d8427" })
intercom({ action: "cancel", replyTo: "9f2c1e07" })

// Check connection status
intercom({ action: "status" })
// Output: Connected: Yes, Session ID: abc12345-1111-4222-8333-123456789abc, Active sessions: 3

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

The reply hint is enabled by default and points to `intercom({ action: "reply", ... })`, so recipients rarely need raw sender or `replyTo` IDs. Idle recipients start a new turn immediately; busy interactive main sessions receive incoming messages when they become idle. Attachment content is included in the model-visible body, and messages are stored in Atomic session history.

The recipient saves each message to its session as soon as it arrives, and the sender sees `delivered` only after that save succeeds. If the recipient closes or crashes before showing a saved message, resuming it with `atomic --session <id>` or `/resume` replays unread messages once in arrival order when the sender is still connected.

Messages from a sender that is gone are recorded once in full without starting a turn. Messages whose sender cannot be checked yet (such as when Intercom is unreachable or a relaunched subagent has not reconnected) are deferred until the next reopen. Sessions started with `--no-session` are not saved, so their unread messages cannot be recovered.

Working subagents act on incoming `send` and `ask` messages in the same task and session according to the sender's case-sensitive `delivery` option (busy interactive main sessions wait until idle regardless of `delivery`):

| `delivery` | When a working subagent receives it | Use it for |
| --- | --- | --- |
| `"steer"` (default) | After its current tool calls finish. Current work is not cancelled. | Ordinary coordination, findings, and updates |
| `"followUp"` | After the subagent finishes and stops. | Low-priority notes or follow-up tasks |
| `"interrupt"` | Immediately. Current model call or cancellable tool call is cancelled, then the message runs next. | Urgent corrections or stop orders |

Any sender can set `delivery` per `send` or `ask` call, including peers, the supervisor, and you. An idle recipient starts a turn for any mode. For example, `intercom({ action: "send", to: "worker", message: "Stop; the spec changed", delivery: "interrupt" })` cancels the worker's current tool call. Tools that ignore cancellation finish first, and completed side effects are not undone.

Messages from one sender always reach the recipient in arrival order, whether delivered immediately, queued for idle, or replayed on resume. Startup messages join the original subagent task, and asks keep their reply threads. Subagent `pause` and `quit`, session cancellation, host stop, and permanently cancelled subagents take precedence over later messages.

Sending or asking a subagent that completed or failed resumes it automatically. The call returns at once with the message queued, the launching session resumes the subagent, and the subagent receives the message first. A paused or quit subagent is not resumed automatically; its messages wait with no time limit until the launching session continues it.

Queued messages survive broker restarts and deliver once in order. If delivery becomes impossible because the subagent was cancelled, the launching session ended, or the launching session stayed away for 7 days in a row, the sender gets one delivery failure. See [Messages that resume a finished subagent](/intercom/reference#messages-that-resume-a-finished-subagent).

A busy non-interactive recipient other than a running subagent can refuse a message without interrupting its work. A `delivered` receipt means the recipient saved the message, not that its model accepted it. Refusals keep the reply thread: an `ask` receives a failed-ask message (or an inline error while waiting), and a `send` delivers an **Intercom delivery failed** notice with a `Sent:` timestamp without triggering a standalone turn.

Atomic enables `intercom` by default, subject to tool allowlists, exclusions, and `noTools: "all"`. Include `"intercom"` in an explicit allowlist when you need it. An interactive session whose tool selection omits `intercom` does not join at startup. Print, JSON, RPC, and SDK sessions with `builtins: { intercom: false }` disable Intercom completely, and `/reload` does not restore it. See [SDK tools](/sdk/reference#tools) and [Reach policies](/intercom/reference#reach-policies) for programmatic setup, `session.intercom.setReachable()`, and `IntercomPolicyError`. `contact_supervisor` remains subagent-only.

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
| **Broadcast** | Sibling uses `send` to a group pattern | One agent shares a confirmed finding with every live sibling at once. |

Peer-to-peer coordination is the default for subagent swarms. Subagents launched together share an Intercom group, so they list each other and coordinate directly without routing messages through the supervisor. Routing peer exchanges through the supervisor adds latency, drops detail, and fills supervisor context. Reserve `contact_supervisor` for supervisor decisions. See [Peer coordination](/subagents#peer-coordination).

Swarm size scales with the task. For large parallel tasks, hundreds or thousands of agents can organize into named groups and coordinate peer-to-peer. Intercom groups have no member limit. See [Scaling a swarm](/subagents#scaling-a-swarm) for the concurrency settings that bound active subagents.

The bundled `/skill:intercom` skill contains ready-to-use patterns for planner-worker delegation, broadcasts, attachments, supervisor escalations, and peer coordination.

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

By default (`intercomBridge.mode: "always"` in `~/.atomic/agent/extensions/subagent/config.json`, documented in [Subagent config.json reference](/subagents/reference#subagent-config-json-reference)), every subagent launched by a session with Intercom active receives the subagent-only `contact_supervisor` tool alongside `intercom`. Atomic wires up the supervisor target automatically with no manual configuration. Normal sessions never see `contact_supervisor`.

Setting `intercomBridge.mode` to `"off"` (or `"fork-only"` for fresh subagents) limits `contact_supervisor` to agents that explicitly include it in their frontmatter tools list.

### Parameters and reasons

| Parameter | Type | Description |
| --- | --- | --- |
| `reason` | string | `"need_decision"` (blocking), `"interview_request"` (blocking structured questions), or `"progress_update"` (fire-and-forget). |
| `message` | string | Required for `progress_update`; strongly recommended for `need_decision` (an omitted `message` sends an empty question); optional note for `interview_request`. |
| `interview` | object | Required for `interview_request`: `{ title?, description?, questions: [...] }`. |

| Reason | Behavior | Use when |
| --- | --- | --- |
| `need_decision` | Waits inside the requesting subagent (up to 10 minutes) for the supervisor's correlated reply, then continues in that same subagent. | The subagent is blocked, uncertain, needs approval, or faces a product, API, or scope decision. |
| `interview_request` | Waits inside the requesting subagent (up to 10 minutes) for structured answers from the supervisor, then continues in that same subagent. | The subagent needs multiple machine-readable answers in one exchange. |
| `progress_update` | Fire-and-forget update to the supervisor. Returns immediately without waiting or disrupting siblings. | Meaningful progress or unexpected discoveries change the plan. |

Do not use `contact_supervisor` for routine completion handoffs; return the final subagent result normally. A parent's `subagent({ action: "wait" })` call yields so the supervisor can reply without cancelling active or queued siblings.

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

The supervisor receives the question with child and run identity plus a reply hint. Answer through `intercom({ action: "reply", message: "..." })`. If several questions are pending, run `intercom({ action: "pending" })` and pass the exact `replyTo`. Your answer returns as the subagent's tool result; never launch a replacement subagent just to answer it.

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

The subagent's tool result preserves the raw reply text and populates `details.structuredReply` when the JSON matches the expected question IDs and options. If JSON parsing or option validation fails, `details.structuredReply` is omitted and `details.structuredReplyParseError` describes the error while keeping the raw reply text.

### Embedded SDK sessions without background task management

When an embedded SDK session launches a single subagent directly without background task management, a blocking `need_decision` or `interview_request` ends that subagent instead of waiting in place. The caller receives terminal run metadata, ordered attachments, the original delegated task (including any structured interview questions), and a fresh-start `[TASK_CONTEXT]` call:

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

## Mixed versions

Atomic 0.10.0 removed workflows and `workflow:<rootRunId>/...` stage targets, which now return `Session not found`. Sessions of 0.9.x and 0.10.0+ still exchange ordinary sends, asks, and replies through whichever broker is running. See [Mixed versions and workflows](/intercom/operations#mixed-versions-and-workflows).

## Intercom vs. shared-room messengers

| Aspect | Intercom | Shared-room messengers |
| --- | --- | --- |
| **Model** | Direct messaging and group-scoped broadcasts | Shared broadcast channel or room |
| **Primary use** | Coordinating your own sessions, supervisor escalation, and peer-to-peer agent swarms on one machine or across shared storage | Swarms that read and append to one shared public feed |
| **Discovery** | Real-time broker registry, local or backed by shared storage | Shared room or file-based registry |
| **Messages** | Targeted 1:1 messages, ask/reply threads, and pattern broadcasts within groups | Public broadcasts visible to every room member |
| **Persistence** | Stored in each participant's Atomic session history | Shared room transcript or coordination files |

Use Intercom for coordinating your own sessions and for peer-to-peer agent swarms that benefit from targeted delivery, ask/reply threads, and group isolation. Use a shared-room messenger only when every participant should read and append to a single public feed.

## Related docs

- [Operate Intercom](/intercom/operations) for broker lifecycles, upgrades, recovery, and multi-machine routing.
- [Intercom reference](/intercom/reference) for tool parameters, targeting rules, reach policies, and error classes.
- [Sharing storage across hosts](/storage#sharing-storage-across-hosts) and [Set up teams and CI](/guides/team-setup) for shared PostgreSQL databases.
- [Intercom group and reach in the SDK](/sdk#intercom-group-and-reach) and [SDK tools](/sdk/reference#tools) for programmatic Intercom policies and `builtins.intercom`.
- [Storage and Intercom CLI commands](/reference/cli#storage-and-intercom-commands) for `atomic intercom` and `atomic storage` subcommands.
- [Run subagents](/subagents) for delegated subagent runs, supervisor coordination, and result delivery.
- [Orchestrate with codemode and subagents](/orchestration) for multi-step tasks and completion notices.
- [Skills](/skills) for reusable instructions like `/skill:intercom`.
- [Environment variables](/environment-variables) for Intercom environment variables.
- [Interactive use](/usage) for interactive commands and bundled extensions.

## Moved sections

<div id="how-connection-works" />

<div id="troubleshooting-initialization" />

<div id="subagent-notifications" />

<div id="subagent-control-notices" />

<div id="delivery-ordering" />

<div id="keyboard-shortcuts" />

<div id="how-it-works" />

<div id="limitations" />

- **Intercom operations:** [How connection works](/intercom/operations#how-connection-works), [Troubleshooting initialization](/intercom/operations#troubleshooting-initialization), [Subagent notifications](/intercom/operations#subagent-notifications), [Subagent control notices](/intercom/operations#subagent-control-notices), [Delivery ordering](/intercom/operations#delivery-ordering), [Keyboard shortcuts](/intercom/operations#keyboard-shortcuts), [How it works](/intercom/operations#how-it-works), [Limitations](/intercom/operations#limitations).

<div id="the-intercom-tool" />

<div id="actions" />

<div id="targeting-sessions" />

<div id="groups" />

<div id="send-vs-ask-vs-reply" />

<div id="attachments" />

<div id="configuration" />

- **Intercom reference:** [The intercom tool](/intercom/reference#the-intercom-tool), [Actions](/intercom/reference#actions), [Targeting sessions](/intercom/reference#targeting-sessions), [Groups](/intercom/reference#groups), [send vs ask vs reply](/intercom/reference#send-vs-ask-vs-reply), [Attachments](/intercom/reference#attachments), [Configuration](/intercom/reference#configuration).
