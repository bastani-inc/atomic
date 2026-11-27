---
title: "Use memory compaction"
sidebarTitle: "Memory compaction"
description: "Atomic's default compaction form: clear the context window with no model call and let the agent recall verbatim details from session history."
---

**Memory compaction** is Atomic's default form of compaction (active whenever `compactionModel` is unset, `""`, or `"auto"`). It requires no configuration, sends no extra model request, and needs no compaction parameters.

Instead of asking a model to write a lossy summary, Atomic clears the active context window and replaces it with a `Context cleared` boundary pointing to this session's verbatim history (`history://sessions/<session id>`). On the next turn, the agent searches and reads exact prior entries on demand using its own tools.

## How it works

<Steps>
  <Step title="Clear the active context window">
    Atomic writes a `Context cleared` compaction boundary. Nothing is lost: every earlier user message, assistant reply, tool call, and tool result stays verbatim in the session store.
  </Step>
  <Step title="Hand the agent an exact history pointer">
    After the boundary, the model sees only the system prompt and one `Context cleared` message naming:
    - how many tokens the earlier conversation held;
    - the exact `history://sessions/<session id>` URL for this session;
    - which saved entries hold the earlier conversation, the boundary's entry position, and the total entry count;
    - any `/compact` focus instructions you passed.
  </Step>
  <Step title="Recover exact details on demand">
    In its next turn, the agent searches the exact session URL first (a plain `history://sessions` search skips the current session), then reads narrow ranges of about 200 saved entries with `read history://sessions/<id>:N-M`. It follows continuation URLs when reads stop early and opens saved full tool-output links (`tool-output://` or `artifact://`) when it needs untruncated command or tool output.
  </Step>
</Steps>

### Example boundary message

```text
Context cleared. Your earlier conversation (182,340 tokens) is no longer in your context window. It is stored verbatim in this session's history at history://sessions/019f6a2e-...: entries 1-4210 hold the earlier conversation, this boundary is entry 4211, and the history has 4211 entries now. Before you continue, recover what the task needs from there.

Recover what you need, in this order:
1. Every <keepContext> span, verbatim and whole: search history://sessions/019f6a2e-... for "keepContext". ...
2. The user's objectives and latest requests; constraints and prohibitions ...

How to recover:
- Search first ...

Then continue the task.
```

See [Recalling earlier work](/sessions#recalling-earlier-work) for how `history://` URLs read and search saved entries.

### Recovery priority

The boundary directs the agent to recover information in order:

1. Every `<keepContext>` span verbatim and whole by searching the session URL for `keepContext`.
2. The user's objectives and latest requests, constraints and prohibitions, decisions and their rationale, key identifiers (branches, worktrees, pull requests, run IDs, file paths, commands), open work, and needed tool results, preferring the most recent records.

## `keepContext` tags

Wrap constraints or facts the agent must not lose in `<keepContext>` and `</keepContext>`:

```text
<keepContext>
You are researching only. Do not implement code changes.
</keepContext>
```

The tags do not pin text in the context window automatically. Instead, the boundary recovery instructions tell the agent to search session history for every tagged span and recover each one verbatim before anything else. Custom compaction models may also honor the tags.

<Tip>
Put each opening and closing tag on its own line. Tag constraints, prohibitions, acceptance criteria, and key identifiers, and keep spans short so recovery stays fast.
</Tip>

## Agents without `read` or `search` {#agents-without-read-or-search}

Agents whose tool allowlist omits `read` or `search` (such as restricted subagents) automatically receive one read-only tool named `session_history` after their first context clear, or on resume whenever `read` or `search` is absent.

`session_history` lets the agent search and read narrow entry ranges from its own session history without accessing any other session, file, or project, leaving all other tool restrictions intact. For exact `session_history` parameters, entry clamps, and output limits, see [The `session_history` tool](/compaction/reference#the-session_history-tool).

<Note>
Memory compaction also serves as the automatic fallback whenever a [custom compaction model](/compaction/custom-compactors) is unauthenticated, unreachable, times out, or returns unusable output.
</Note>
