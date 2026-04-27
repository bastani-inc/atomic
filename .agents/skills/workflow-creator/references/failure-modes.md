# Failure Modes

Common, **silent** ways workflows break across Claude Code, Copilot CLI, and
OpenCode — and the wrong-vs-right patterns to avoid them.

**Read this before you ship a multi-session workflow.** Most failures here
don't throw — they produce degraded output that looks plausible, which is
the hardest kind of bug to catch in review.

## When to consult

- Before writing a planner → orchestrator → reviewer handoff (Copilot / OpenCode)
- When a stage receives context from a prior stage and the output smells off
- When a review/fix loop works on small inputs but drifts on large ones
- When a JSON/markdown parser in a helper stops matching the model's output
- When you cannot explain where a particular sentence in a downstream prompt came from

## Silent vs. loud

| Severity | What happens | Detection |
|---|---|---|
| **Silent** | Wrong output, no exception. Downstream stages consume garbage. | Requires end-to-end observation. Easy to miss in review. |
| **Loud** | Exception thrown, stage aborts. | Stack trace surfaces in logs. |

Silent failures are catalogued first below. Loud failures are grouped at the end.

---

## Quick reference

| # | Failure | Affected | Silent? |
|---|---|---|---|
| [F1](#f1-copilot-getlastassistanttext-returns-empty-string) | Copilot: `getLastAssistantText` returns empty string | Copilot | silent |
| [F2](#f2-copilot-subagent-messages-pollute-getmessages-stream) | Copilot: subagent messages pollute `getMessages()` stream | Copilot | silent |
| [F3](#f3-opencode-result-parts-contain-non-text-parts) | OpenCode: `result.data.parts` contains non-text parts | OpenCode | silent |
| [F4](#f4-claude-ssessionquery-returns-sessionmessage-extract-text-with-extractassistanttext) | Claude: `s.session.query()` returns `SessionMessage[]` — extract text with `extractAssistantText(result, 0)` | Claude | silent |
| [F5](#f5-fresh-session-wipes-prior-stage-context) | Fresh session wipes prior stage context | Copilot, OpenCode | silent |
| [F6](#f6-planner-prompts-that-dont-request-trailing-commentary-produce-empty-handoffs) | Planner prompts that don't request trailing commentary produce empty handoffs | all | silent |
| [F7](#f7-continued-sessions-accumulate-state-across-loop-iterations) | Continued sessions accumulate state across loop iterations (lost-in-middle) | all | silent |
| [F8](#f8-fenced-block-parsers-break-when-the-model-adds-prose) | Fenced-block parsers break when the model adds prose before/after | all | silent |
| [F9](#f9-ssave-receives-the-wrong-shape) | `s.save()` receives the wrong shape for the SDK | all | silent |
| [F10](#f10-copilot-sendandwait-default-60s-timeout-throws) | Copilot: `sendAndWait` default 60s timeout throws (use `send` by default) | Copilot | loud |
| [F11](#f11-provider-level-resume-tries-to-swap-agents) | Provider-level resume tries to swap agents | Copilot, OpenCode | loud |
| [F12](#f12-parallel-siblings-read-each-others-transcripts) | Parallel siblings read each other's transcripts | all | loud |
| [F13](#f13-forgetting-to-await-ctxstage) | Forgetting to `await` `ctx.stage()` | all | silent |
| [F14](#f14-using-a-pending-sessionhandle-before-completion) | Using a pending `SessionHandle` before completion | all | silent |
| [F15](#f15-headless-stage-errors-are-invisible-in-the-graph) | Headless stage errors are invisible in the graph | all | silent |
| [F16](#f16-claude-importing-sdk-query-inside-a-non-headless-stage) | Claude: importing the SDK `query()` inside a non-headless stage (anti-pattern) | Claude | silent |
| [F17](#f17-duplicate-registration-throws-at-composition-root) | Duplicate registration throws at composition root | all | loud |
| [F22](#f22-ctxstage-with-no-llm-query-spawns-an-empty-idle-pane) | `ctx.stage()` with no LLM query spawns an empty, idle pane | all | silent |

---

## Silent failures

### F1. Copilot: `getLastAssistantText` returns empty string

**Symptom.** The orchestrator (or any downstream stage) receives an empty
`plannerNotes` / `reviewerOutput` despite the prior agent running successfully
and producing visible output in the TUI.

**Root cause.** Copilot emits an **empty terminating `assistant.message` event**
after every turn that included a tool call. The actual prose + toolRequests
live in the earlier `assistant.message` event; the trailing one has
`content: ""` and no `toolRequests`. Picking `.at(-1).data.content` reliably
lands on the empty terminator and throws away the real content.

Verified empirically with a toy script against Copilot CLI 1.0.22: a
single-turn "think then call tool" prompt produced 2 assistant.message
events, `[{length: 512, toolRequests: 1}, {length: 0, toolRequests: 0}]`.
The second one is what `.at(-1)` returns.

The event type carries both `content: string` and `toolRequests?: [...]` —
see `node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts:1408-1455`.

This means the bug affects **any** stage whose final turn includes a tool
call — not just tool-calls-only turns. Planner, reviewer, debugger, and
orchestrator stages all hit it if they end on a tool invocation.

**Affected SDKs.** Copilot only.

### ❌ Wrong

```ts
function getLastAssistantText(messages: SessionEvent[]): string {
  const assistantMessages = messages.filter(
    (m): m is Extract<SessionEvent, { type: "assistant.message" }> =>
      m.type === "assistant.message",
  );
  return assistantMessages.at(-1)?.data.content ?? "";
}
```

### ✅ Right

```ts
/** Concatenate every top-level assistant turn's non-empty content. */
function getAssistantText(messages: SessionEvent[]): string {
  return messages
    .filter(
      (m): m is Extract<SessionEvent, { type: "assistant.message" }> =>
        m.type === "assistant.message" && !m.data.parentToolCallId,
    )
    .map((m) => m.data.content)
    .filter((c) => c.length > 0)
    .join("\n\n");
}
```

**Detection.** Log the returned text length after every `getAssistantText`
call during development. An empty or surprisingly short string for a stage
that clearly ran is the signature.

---

### F2. Copilot: subagent messages pollute `getMessages()` stream

**Symptom.** Downstream stages receive a snippet of text that doesn't match
what the top-level agent said — it looks like a subagent's output.

**Root cause.** `assistant.message` events carry a `parentToolCallId?: string`
field, documented as *"Tool call ID of the parent tool invocation when this
event originates from a subagent"*. When the top-level agent delegates,
`getMessages()` returns **the complete history including subagent messages**.
Filters that don't exclude `parentToolCallId` can pick a subagent's final
message via `.at(-1)`.

**Affected SDKs.** Copilot.

### ❌ Wrong

```ts
messages.filter((m) => m.type === "assistant.message")
```

### ✅ Right

```ts
messages.filter(
  (m) => m.type === "assistant.message" && !m.data.parentToolCallId,
)
```

**Detection.** Same as F1 — diff what you extract against the TUI
scrollback for the top-level agent.

---

### F3. OpenCode: `result.data.parts` contains non-text parts

**Symptom.** Concatenated response text contains `[object Object]`,
truncated content, or swallows tool-call payloads into the prompt.

**Root cause.** `client.session.prompt()` returns `result.data.parts: Part[]`
where parts can be `type: "text" | "tool" | "file" | "reasoning" | ...`.
Naive `.map(p => p.text).join()` emits `undefined` for non-text parts.

**Affected SDKs.** OpenCode.

### ❌ Wrong

```ts
const text = result.data!.parts.map((p) => p.text).join("\n");
```

### ✅ Right

```ts
function extractResponseText(
  parts: Array<{ type: string; [key: string]: unknown }>,
): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: string; text: string }).text)
    .join("\n");
}
```

**Detection.** Grep extracted text for `[object Object]` or `undefined`.

---

### F4. Claude: `s.session.query()` returns `SessionMessage[]` — extract text with `extractAssistantText`

**Symptom.** Workflow code tries to access `.output` or `.text` on the
result of `s.session.query()` and gets `undefined`, or passes the result
directly to a string parser that throws.

**Root cause.** `s.session.query()` returns `SessionMessage[]` — the native
Claude Agent SDK type. It does NOT return a `{ output: string }` object or a
raw TUI scrollback string. The assistant's text lives inside structured content
blocks within those messages and must be extracted explicitly.

**Affected SDKs.** Claude.

### ❌ Wrong

```ts
// result is SessionMessage[], not { output: string }
const result = await s.session.query(prompt);
const parsed = JSON.parse(result.output);  // TypeError: result.output is undefined
```

### ✅ Right — use `extractAssistantText(result, 0)`

```ts
import { extractAssistantText } from "@bastani/atomic/workflows";

const result = await s.session.query(prompt);
const text = extractAssistantText(result, 0);
// Now `text` is the concatenated assistant prose for this turn
```

`extractAssistantText(msgs, afterIndex)` walks `SessionMessage[]` from
`afterIndex` forward, pulls `TextBlock.text` from each `assistant` message's
content array, and joins them with newlines.

The ralph helpers in `src/sdk/workflows/builtin/ralph/helpers/prompts.ts`
(`parseReviewResult`, `extractMarkdownBlock`) use this pattern — always
extract text first, then parse.

**Detection.** Log `typeof result` after `s.session.query()`. If it's
`object` (an array), you need `extractAssistantText`. Accessing `.output`
on an array returns `undefined`.

---

### F5. Fresh session wipes prior stage context

**Symptom.** The orchestrator says "I don't see a task list" or "what
specification are you referring to?" even though the planner clearly ran.

**Root cause.** `client.createSession()` / `client.session.create()` always
returns a **fresh, empty conversation**. The CLIENT object is just the
transport — each session is independent. The new session sees only what you
put in its first prompt.

**Affected SDKs.** Copilot, OpenCode. (Claude's session model is
different — context accumulates within the same SDK session, so this failure
mode does NOT apply to `s.session.query()`.)

### ❌ Wrong

```ts
await ctx.stage({ name: "planner" }, {}, { agent: "planner" }, async (s) => {
  await s.session.send({ prompt: buildPlannerPrompt((s.inputs.prompt ?? "")) });
  s.save(await s.session.getMessages());
});
// orchestrator is a fresh session — it has no idea what the planner produced
await ctx.stage({ name: "orchestrator" }, {}, { agent: "orchestrator" }, async (s) => {
  await s.session.send({ prompt: buildOrchestratorPrompt() });
  s.save(await s.session.getMessages());
});
```

### ✅ Right — explicit handoff

```ts
const plannerHandle = await ctx.stage(
  { name: "planner" },
  {},
  { agent: "planner" },
  async (s) => {
    await s.session.send({ prompt: buildPlannerPrompt((s.inputs.prompt ?? "")) });
    const messages = await s.session.getMessages();
    s.save(messages);
    return getAssistantText(messages); // see F1 for getAssistantText
  },
);

await ctx.stage(
  { name: "orchestrator" },
  {},
  { agent: "orchestrator" },
  async (s) => {
    await s.session.send({
      prompt: buildOrchestratorPrompt(
        (s.inputs.prompt ?? ""),
        { plannerNotes: plannerHandle.result },
      ),
    });
    s.save(await s.session.getMessages());
  },
);
```

Alternatives: write to shared state (`TaskCreate`/`TaskList`, files, git) and
have the next stage read from there, or keep the follow-up inside the same
stage callback when it needs the full live conversation. Provider-level resume
is an advanced same-role escape hatch, not the normal stage-to-stage handoff.

**Full write-up.** `agent-sessions.md` §"Critical pitfall: session lifecycle
controls what context is available".

---

### F6. Planner prompts that don't request trailing commentary produce empty handoffs

**Symptom.** F1 / F5 are fixed, extraction is correct — and the orchestrator
still receives empty `plannerNotes` because the planner's last turn legitimately
had no prose.

**Root cause.** This is a **prompt engineering** bug, not a code bug. When a
prompt ends with "call `TaskList` to verify" and does not explicitly ask for
trailing commentary, many models end the turn with just the tool call and
no text at all. There's nothing in any turn's `content` to extract because
the model never wrote any.

**Affected SDKs.** All three — though Claude's pane scrollback masks it by
still capturing something visible.

### ❌ Wrong — silent handoff

```ts
return `# Planning

${spec}

Decompose the specification into tasks via TaskCreate. After creating all
tasks, call TaskList to verify.`;
```

### ✅ Right — explicit trailing commentary requirement

```ts
return `# Planning

${spec}

Decompose the specification into tasks via TaskCreate. After creating all
tasks, call TaskList to verify.

## Final output (required)

After the TaskList call, write a short "Handoff Notes" section with:
- Risks or ambiguities the orchestrator must know about
- Any assumptions you made that could be wrong
- Ordering constraints that don't fit into task bodies

The orchestrator will run in a fresh session — anything not in your
TaskCreate calls or this section will be lost.`;
```

**Pair this fix with F1.** Even with the correct extraction helper, you need
the model to actually produce text for the helper to extract.

**Detection.** Log the extracted handoff text during development. An empty
string + a correctly-fixed extraction helper = F6.

---

### F7. Continued sessions accumulate state across loop iterations (lost-in-middle)

**Symptom.** A review/fix loop works on iterations 1-3 then starts
producing worse output — misidentifying files, hallucinating line numbers,
or "forgetting" a requirement that was clearly stated in the original spec.

**Root cause.** Each loop iteration adds turns to the same continued
session, and context grows past the attention window. The model starts
dropping middle-of-context information (classic lost-in-middle).

**Affected SDKs.** All three. Claude's session transcript accumulates every
intermediate turn, so long loops grow the context window substantially.

### ❌ Wrong — unbounded loop on a single session

```ts
await ctx.stage({ name: "review-loop" }, {}, {}, async (s) => {
  for (let i = 0; i < 20; i++) {
    await s.session.query(buildReviewPrompt());
    await s.session.query(buildFixPrompt());
  }
});
```

### ✅ Right — compact or reset between iterations

Options, in order of preference:

1. **Compact** — summarize prior turns via the SDK's compaction mechanism
   (Claude's `/compact`, OpenCode's summarizer, a sidecar summarization call
   for Copilot). Keeps decisions and file paths; drops verbose tool output.
2. **Offload to files** — write intermediate findings to files and reference
   them by path in the next iteration's prompt (`filesystem-context` skill).
3. **Fresh session per iteration with explicit handoff** — see F5's pattern;
   lose the in-session reasoning but gain a clean context window.

```ts
await ctx.stage({ name: "review-loop" }, {}, {}, async (s) => {
  const MAX_TURNS_BEFORE_COMPACT = 10;
  let turnsSinceCompact = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (turnsSinceCompact >= MAX_TURNS_BEFORE_COMPACT) {
      await s.session.query("/compact");
      turnsSinceCompact = 0;
    }
    await s.session.query(buildReviewPrompt());
    turnsSinceCompact += 1;
  }
});
```

**Consult.** `context-degradation`, `context-compression`, `context-optimization`.

**Detection.** Quality-vs-iteration chart. If quality degrades past
iteration N, N is your safe-turn budget before compaction.

---

### F8. Fenced-block parsers break when the model adds prose

**Symptom.** `JSON.parse(content)` throws, or a "matches the first fenced
block" regex picks up a code example inside prose instead of the actual
structured output.

**Root cause.** A prompt asks for `only JSON inside a single fenced block`
and the model adds a sentence of explanation, a "# Summary" heading, or
quotes a snippet of its own reasoning in a code fence earlier in the reply.

**Affected SDKs.** All three — this is a model-behavior issue, not
SDK-specific.

### ❌ Wrong

```ts
const parsed = JSON.parse(content);
// or:
const match = content.match(/```json\n([\s\S]*?)\n```/);
```

### ✅ Right — layered fallback: direct parse → last fenced block → last balanced object

```ts
export function parseReviewResult(content: string): ReviewResult | null {
  // 1. Direct JSON
  try {
    const parsed = JSON.parse(content);
    if (parsed?.findings && parsed?.overall_correctness) return parsed;
  } catch { /* fall through */ }

  // 2. LAST fenced code block (not the first — prose often quotes examples)
  const blockRe = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let lastBlock: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(content)) !== null) {
    if (m[1]) lastBlock = m[1];
  }
  if (lastBlock) {
    try {
      const parsed = JSON.parse(lastBlock);
      if (parsed?.findings && parsed?.overall_correctness) return parsed;
    } catch { /* fall through */ }
  }

  // 3. Last balanced object containing the required key
  // (implementation in src/sdk/workflows/builtin/ralph/helpers/prompts.ts)
  return null;
}
```

**Detection.** Fuzz test the parser against real model output captured
over several runs. If 1 in 20 runs fails to parse, you have F8.

---

### F9. `s.save()` receives the wrong shape

**Symptom.** `s.transcript("stage-name")` returns an empty or malformed
`content` string in the next stage.

**Root cause.** Each SDK has a different contract for what `s.save()`
expects, and the runtime doesn't type-check the argument beyond "anything".

**Affected SDKs.** All three — the mistake is in the workflow author's code.

### Correct shapes

| SDK | Correct argument |
|---|---|
| Claude | `s.save(s.sessionId)` — pass the session ID; the runtime reads the transcript file |
| Copilot | `s.save(await s.session.getMessages())` — pass `SessionEvent[]` |
| OpenCode | `s.save(result.data!)` — pass the `{ info, parts }` object |

### ❌ Wrong

```ts
// Claude — saves the wrong thing (result is SessionMessage[], not { output: string })
s.save(result.output);  // TypeError: result.output is undefined; use s.save(s.sessionId)

// Copilot — calling getMessages() BEFORE send() returns an empty array
const earlyMessages = await s.session.getMessages(); // [] — no turns yet
s.save(earlyMessages);

// Copilot — saving a single message instead of the full array
s.save((await s.session.getMessages()).at(-1));

// OpenCode — missing the data unwrap
s.save(result);
```

### ✅ Right

See the per-SDK examples in `SKILL.md` §"Write the Workflow File" and the
`SessionContext` reference table.

**Detection.** Read `s.transcript(name).content` in the next stage and
log the length. A 0-length or JSON-that-isn't-prose signature = F9.

---

## Loud failures (throw, but still worth knowing)

### F10. Copilot: `sendAndWait` default 60s timeout throws

**Symptom.** `Timeout after 60000ms waiting for session.idle`. Every
subsequent `ctx.stage()` call never executes — the throw propagates out of
`run()` and halts the workflow.

**Root cause.** The raw Copilot SDK's `sendAndWait(options, timeout?)`
defaults to a 60-second timeout that throws on expiry. Real agent work
(planners, reviewers, orchestrators) routinely exceeds this.

**Fix.** Use `send` instead. Inside an Atomic stage the runtime wraps
`s.session.send()` so it blocks until `session.idle` with **no timeout** —
the same blocking semantics as Claude's `query()` and OpenCode's
`session.prompt()`. The wrapper lives in `wrapCopilotSend`
(`src/sdk/runtime/executor.ts`) and is installed per-stage.

```ts
// Correct: send() in an Atomic stage blocks until idle, no timeout.
await s.session.send({ prompt });
const messages = await s.session.getMessages(); // safe to read
```

**Do not reach for `sendAndWait` with a larger explicit timeout.** `send`
already waits for idle; `sendAndWait` just adds a throw-on-timeout failure
mode on top. If you catch yourself writing `sendAndWait(..., 5 * 60 * 1000)`
to "be safe", you want `send`.

---

### F11. Provider-level resume tries to swap agents

**Symptom.** Resumed Copilot / OpenCode session behaves as the original
agent instead of the requested new one — or the SDK throws "agent mismatch"
on resume.

**Root cause.** Each session is **bound to one agent at creation time**.
`resumeSession` reattaches the conversation but does not change the agent.

**Fix.** Use provider-level resume only for multi-turn work within the same
role. To swap agents, create a new session (fresh) and forward context via
F5's pattern. In normal workflow code, prefer a same-stage multi-turn session
over trying to reopen a prior stage.

---

### F12. Parallel siblings read each other's transcripts

**Symptom.** `s.transcript("sibling-name")` inside a parallel session
throws or returns empty.

**Root cause.** `s.transcript()` only exposes **prior completed sessions** —
ones whose callback has returned and whose saves have flushed. Sessions
launched concurrently via `Promise.all([ctx.stage(...), ctx.stage(...)])` run
at the same time; forward-only data flow is enforced.

**Fix.** Restructure to either a linear chain, a "fan-out, then merge"
pattern where a subsequent session reads both, or use external
shared state (files, DB) if siblings genuinely need to coordinate.

```ts
// Fan-out → merge
// Strings used here for brevity; prefer handles (s.transcript(handle)) when one is in scope.
const describe = await ctx.stage({ name: "describe" }, {}, {}, async (s) => { /* ... */ });

const [summarizeA, summarizeB] = await Promise.all([
  ctx.stage({ name: "summarize-a" }, {}, {}, async (s) => {
    const d = await s.transcript(describe); // OK — prior completed session (handle-based, preferred)
    // s.transcript("summarize-b") would fail here — sibling not yet complete
  }),
  ctx.stage({ name: "summarize-b" }, {}, {}, async (s) => {
    const d = await s.transcript(describe); // OK — prior completed session
  }),
]);

await ctx.stage({ name: "merge" }, {}, {}, async (s) => {
  const a = await s.transcript(summarizeA); // OK — handle-based, preferred over "summarize-a"
  const b = await s.transcript(summarizeB);
});
```

---

### F13. Forgetting to `await` `ctx.stage()`

**Symptom.** A session runs (its tmux window opens, the agent does work)
but the orchestrator doesn't wait for it. Subsequent sessions that depend
on its output via `transcript()` or `getMessages()` see empty or missing
data. The workflow may finish "successfully" before the session's callback
has returned.

**Root cause.** `ctx.stage()` returns a `Promise<SessionHandle<T>>`.
Without `await`, the session is spawned but the `.run()` callback continues
immediately. The session's save never reaches the `completedRegistry`
before downstream code tries to read it.

**Affected SDKs.** All three — this is a TypeScript control-flow bug, not
SDK-specific.

### ❌ Wrong

```ts
// Missing await — session fires but orchestrator doesn't wait
ctx.stage({ name: "research" }, {}, {}, async (s) => {
  // ... agent work ...
  s.save(s.sessionId);
});

// This runs before "research" completes
await ctx.stage({ name: "synthesize" }, {}, {}, async (s) => {
  const r = await s.transcript("research"); // empty or throws
});
```

### ✅ Right

```ts
await ctx.stage({ name: "research" }, {}, {}, async (s) => {
  // ... agent work ...
  s.save(s.sessionId);
});

await ctx.stage({ name: "synthesize" }, {}, {}, async (s) => {
  const r = await s.transcript("research"); // works
});
```

**Detection.** If a session's graph node shows as "running" while
downstream sessions are already executing, you likely dropped an `await`.
TypeScript's `@typescript-eslint/no-floating-promises` lint rule catches
this at compile time.

---

### F14. Using a pending `SessionHandle` before completion

**Symptom.** `handle.result` is `undefined` or stale, or
`s.transcript(handle)` throws / returns empty even though the session
eventually completes.

**Root cause.** `ctx.stage()` returns a `SessionHandle<T>` whose
`.result` is only populated after the callback returns. If you store the
promise but access the handle before awaiting it, the result field is
not yet set and the session is not in the `completedRegistry`.

**Affected SDKs.** All three.

### ❌ Wrong

```ts
// Start both but access handles before awaiting
const handleA = ctx.stage({ name: "a" }, {}, {}, async (s) => { /* ... */ return 42; });
const handleB = ctx.stage({ name: "b" }, {}, {}, async (s) => {
  // handleA is a Promise, not a resolved SessionHandle
  const transcript = await s.transcript(handleA); // fails
});
```

### ✅ Right

```ts
// Await first, then use the resolved handle
const handleA = await ctx.stage({ name: "a" }, {}, {}, async (s) => { /* ... */ return 42; });

await ctx.stage({ name: "b" }, {}, {}, async (s) => {
  const transcript = await s.transcript(handleA); // works — handleA is resolved
  console.log(handleA.result); // 42
});
```

For parallel sessions, use `Promise.all()` and access handles only after
all promises resolve:

```ts
const [a, b] = await Promise.all([
  ctx.stage({ name: "a" }, {}, {}, async (s) => { /* ... */ return "x"; }),
  ctx.stage({ name: "b" }, {}, {}, async (s) => { /* ... */ return "y"; }),
]);
// a.result === "x", b.result === "y"
```

**Detection.** TypeScript's type system helps — `ctx.stage()` returns
`Promise<SessionHandle<T>>`, not `SessionHandle<T>` directly. If you're
accessing `.result` without awaiting, the type will be `Promise`, not `T`.

---

### F15. Headless stage errors are invisible in the graph

**Symptom.** A workflow fails but the graph shows all visible stages as
completed. The error message references a session name that doesn't appear
in the graph panel.

**Root cause.** Headless stages (`{ headless: true }`) are invisible in the
workflow graph — they have no graph node, no tmux window, and no pane
preview. When a headless stage throws, the error is recorded in the
`failedRegistry` and the workflow halts, but the failure is only visible in
the orchestrator's error output and the session's `error.txt` file on disk.

**Affected SDKs.** All three — this is an executor-level behavior, not
SDK-specific.

### ❌ Wrong — no error context for headless stages

```ts
// Headless stage fails silently in the graph
const [a, b, c] = await Promise.all([
  ctx.stage({ name: "gather-a", headless: true }, {}, {}, async (s) => {
    throw new Error("API key expired"); // Fails — no graph node to show red
  }),
  ctx.stage({ name: "gather-b", headless: true }, {}, {}, async (s) => { /* ... */ }),
  ctx.stage({ name: "gather-c", headless: true }, {}, {}, async (s) => { /* ... */ }),
]);
```

### ✅ Right — wrap headless stages with descriptive error context

```ts
const [a, b, c] = await Promise.all([
  ctx.stage({ name: "gather-a", headless: true }, {}, {}, async (s) => {
    try {
      return await doWork(s);
    } catch (error) {
      throw new Error(`[gather-a] ${error instanceof Error ? error.message : String(error)}`);
    }
  }),
  // ... same pattern for b, c
]);
```

**Detection.** If a workflow fails and the graph shows no failed nodes,
check the orchestrator log (`orchestrator.log` in the session directory)
and look for `headless-<name>` in the error output. The session directory
at `~/.atomic/sessions/<run-id>/<name>-<id>/error.txt` contains the
full error for each failed headless stage.

---

### F16. Claude: importing the SDK `query()` inside a non-headless stage

**Symptom.** A reviewer / extractor / structured-output stage shows up in
the workflow graph as a tmux pane, but the pane sits idle on the Claude
welcome screen for the entire stage duration. The stage still produces a
result — but the visible session never moved. CPU and token cost double:
two Claude processes ran, one in the pane (idle) and one in-process (the
SDK call that actually did the work).

**Root cause.** The stage was registered without `headless: true`, so the
runtime spawned an interactive Claude TUI in a tmux pane and bound
`s.session` to it. The callback ignored that and called
`query()` from `@anthropic-ai/claude-agent-sdk` directly:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
// ...
ctx.stage({ name: "review" }, {}, {}, async (s) => {
  for await (const msg of query({ prompt, options: { outputFormat: ... } })) { /* ... */ }
});
```

That import bypasses `s.session` entirely. The runtime cannot route the
SDK call through the TUI it just started, so:

1. The visible pane never receives a prompt — the user sees a blank Claude
   session in the graph.
2. A second Claude process spins up in the orchestrator process to service
   the SDK call. Both processes count against rate limits and token spend.
3. Idle detection on the pane never fires because no prompt was ever sent;
   the runtime relies on session-state events that won't arrive, and stage
   completion happens only because the callback returned (not because the
   pane finished work).

The runtime exposes exactly two routes for an SDK feature:

| You want to use… | Stage shape | Code in callback |
|---|---|---|
| `outputFormat`, custom `agents`, `maxBudgetUsd`, etc. **without** a visible pane | `{ headless: true }` | `s.session.query(prompt, sdkOptions)` — wraps `HeadlessClaudeSessionWrapper.query()` which forwards `options` to the SDK |
| The visible TUI with a subagent | omit `headless` and pass `chatFlags: ["--agent", "<name>", ...]` | `s.session.query(prompt)` — sends through tmux send-keys |

The one option that does **not** exist is "visible pane + in-process SDK call".
That combination is always wrong — pick one route or the other.

**Affected SDKs.** Claude only. Copilot and OpenCode don't expose a
parallel "import the bare SDK" foot-gun in this codebase.

### ❌ Wrong — visible pane + bypassed-SDK call

```ts
import { query as claudeSdkQuery } from "@anthropic-ai/claude-agent-sdk";

await ctx.stage({ name: "review" }, {}, {}, async (s) => {
  // Visible TUI was started, but we're ignoring it.
  for await (const msg of claudeSdkQuery({
    prompt: reviewPrompt,
    options: {
      outputFormat: { type: "json_schema", schema: REVIEW_SCHEMA },
    },
  })) {
    if (msg.type === "result") { /* ... */ }
  }
  s.save(s.sessionId);
});
```

### ✅ Right (a) — visible TUI with subagent + chatFlags

When you want the user to watch the review happen, run the subagent in
the pane via `--agent` and parse JSON out of the assistant text. The
prompt should enumerate the schema fields so the model emits matching
JSON; a tolerant parser (last-fenced-block + last-balanced-object
fallback, F8) handles any prose the model adds:

```ts
await ctx.stage(
  { name: "review" },
  { chatFlags: ["--agent", "reviewer", "--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"] },
  {},
  async (s) => {
    const messages = await s.session.query(reviewPrompt);
    s.save(s.sessionId);
    return parseReviewResult(extractAssistantText(messages, 0));
  },
);
```

This is the pattern used by `src/sdk/workflows/builtin/ralph/claude/index.ts`
for its planner, orchestrator, reviewer, and debugger stages.

### ✅ Right (b) — headless stage with SDK options via `s.session.query()`

When you don't need the pane (e.g. background data gathering), set
`headless: true` and pass SDK options as the second argument to
`s.session.query()`. The runtime uses `HeadlessClaudeSessionWrapper`,
which calls the SDK's `query()` in-process and exposes the full options
surface (`agent`, `outputFormat`, `permissionMode`, `maxBudgetUsd`, etc.):

```ts
await ctx.stage(
  { name: "review", headless: true },
  {}, {},
  async (s) => {
    const messages = await s.session.query(reviewPrompt, {
      agent: "reviewer",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    s.save(s.sessionId);
    return extractAssistantText(messages, 0);
  },
);
```

> **Note on `--json-schema`.** The CLI's `--json-schema` flag requires
> `-p` (print mode) and therefore can't be passed via `chatFlags` to the
> interactive TUI. If you need SDK-validated structured output, use route
> (b) — set `headless: true` and pass `outputFormat: { type: "json_schema", schema }`
> in the `s.session.query()` options. Pair (a)'s visible TUI with a
> tolerant JSON parser instead. (Note: `s.session.query()`'s headless
> wrapper currently returns `SessionMessage[]` and discards the SDK
> result event's `structured_output` field — for now, parse JSON out of
> the assistant text either way.)

**Detection.**
1. Grep your workflow for `from "@anthropic-ai/claude-agent-sdk"` —
   `query`, `tool`, `createSdkMcpServer` and similar imports inside a
   `.run()` callback are the smell. Workflow code should import from
   `@bastani/atomic/workflows` and access the SDK exclusively through
   `s.client` and `s.session`.
2. Watch the workflow run. If a visible pane shows the Claude welcome
   screen for the entire duration of a stage and never receives a prompt,
   you have F16.
3. Cost monitoring. F16 roughly doubles the Claude process count — if
   stage spend looks 2× a single run, audit imports.

---

## Design checklist

Before shipping a multi-session workflow, walk the list:

- [ ] Copilot stages use `s.session.send` by default; `sendAndWait` only with an explicit user-requested timeout (F10)
- [ ] Every fresh-session handoff forwards context explicitly (F5)
- [ ] Every prompt whose output feeds a downstream stage explicitly requests trailing commentary (F6)
- [ ] Response-text extraction uses the per-SDK correct pattern (F1-F4)
- [ ] Structured-output parsers extract the LAST fenced block, not the first (F8)
- [ ] `s.save()` receives the per-SDK correct shape — Copilot uses `s.session.getMessages()` (F9)
- [ ] Loops over 10 iterations have a compaction / reset strategy (F7)
- [ ] Parallel groups only read from prior completed sessions, never siblings (F12)
- [ ] Every `ctx.stage()` call is `await`ed (F13)
- [ ] `SessionHandle` values are only used after the promise resolves (F14)
- [ ] If provider-level resume/fork is used at all, it stays within the same agent role (F11)
- [ ] Headless stage callbacks include descriptive error context so failures can be diagnosed without a graph node (F15)
- [ ] Claude stages never import `query` (or other entry points) from `@anthropic-ai/claude-agent-sdk` directly — go through `s.session.query()` so the runtime routes to the TUI (interactive) or the SDK (headless) consistently (F16)
- [ ] No duplicate `${agent}/${name}` registrations in the composition root (F17)
- [ ] Every `ctx.stage()` callback contains at least one LLM call (`s.session.query` / `s.session.send` / `s.client.session.prompt`); stages that are pure deterministic code have been demoted to plain TypeScript in `.run()` (F22)

---

### F17. Duplicate registration throws at composition root

**Symptom.** `createRegistry().register(wf)` throws immediately when
`wf` has the same `${agent}/${name}` key as an already-registered workflow:

```
[atomic] Duplicate workflow registration: "claude/my-workflow" is already registered.
Each (agent, name) pair must be unique.
```

**Fix.** Ensure each `(agent, name)` pair appears exactly once in the
composition root. Two cross-agent variants of the same logical workflow
(`"claude/ralph"` + `"copilot/ralph"`) are distinct keys — register both
without conflict.

---

### F22. `ctx.stage()` with no LLM query spawns an empty, idle pane

**Symptom.** A stage in the workflow graph opens a tmux window, the agent
CLI boots up, and then the pane just... sits there. No prompt ever gets
sent; the pane shows the Claude / Copilot / OpenCode welcome screen for
the entire stage duration. Users watching the graph see a completed stage
node whose pane was visibly empty, ask "why didn't it do anything?", and
lose trust in the workflow.

**Root cause.** A `ctx.stage()` callback that contains only deterministic
TypeScript — file I/O, `fetch()`, `child_process.exec`, `JSON.parse`, a
git command, a helper function — but no `s.session.query()` /
`s.session.send()` / `s.client.session.prompt()` call. The runtime sees
the stage as a valid unit of work (it spins up the pane, creates the SDK
session, runs the callback, tears everything down), but the session
itself never receives a prompt. Token cost is near-zero but the UX cost is
high: the empty pane is indistinguishable from a broken stage.

**Affected SDKs.** All three. The symptom is most obvious with Claude
because the pane is a full interactive TUI; Copilot and OpenCode show a
similarly idle welcome screen.

### ❌ Wrong — pure-TS work wrapped in a stage

```ts
// The previous stage returned a plan object. We want to write it to disk
// and set up some scratch directories before the next LLM call.
await ctx.stage({ name: "prepare-workspace" }, {}, {}, async (s) => {
  await fs.mkdir(".atomic/scratch", { recursive: true });
  await fs.writeFile(".atomic/scratch/plan.json", JSON.stringify(plan.result));
  execSync("git checkout -b ralph/wip");
  // ⚠️ No LLM call. A tmux pane opens, Claude boots, nothing ever
  // gets typed into it, the stage "completes", pane tears down.
});
```

### ✅ Right (a) — lift pure-TS work into `.run()` directly

```ts
// Run deterministic setup at the orchestrator level, outside any stage.
// No pane, no graph node, no confusion.
await fs.mkdir(".atomic/scratch", { recursive: true });
await fs.writeFile(".atomic/scratch/plan.json", JSON.stringify(plan.result));
execSync("git checkout -b ralph/wip");

// Next stage actually uses the LLM — a pane here makes sense.
await ctx.stage({ name: "implement" }, {}, {}, async (s) => {
  await s.session.query("Implement the plan in .atomic/scratch/plan.json.");
  s.save(s.sessionId);
});
```

### ✅ Right (b) — bundle deterministic work into the nearest LLM stage

When the TS logic is conceptually bound to a specific LLM call (e.g.
validating the query's response, writing a derived artifact from the
assistant text), put it inside the same callback:

```ts
await ctx.stage({ name: "plan" }, {}, {}, async (s) => {
  const messages = await s.session.query("Produce a plan as JSON.");
  const text = extractAssistantText(messages, 0);
  const plan = parsePlan(text);           // deterministic — fine here
  validatePlan(plan);                     // deterministic — fine here
  await fs.writeFile("plan.json", JSON.stringify(plan)); // fine here
  s.save(plan);
  return plan;
});
```

**Detection.**

1. Grep every `ctx.stage()` callback for at least one of:
   `s.session.query`, `s.session.send`, `s.client.session.prompt`. A
   callback with none is an F22 candidate.
2. Watch the workflow run in the TUI. If a stage's pane shows only the
   agent welcome banner for the whole duration and closes without ever
   echoing a prompt, you have F22.
3. Any stage whose only callback statements are `await fs.*`,
   `execSync`, `fetch`, `await s.save(...)`, or pure data manipulation
   is almost certainly F22 — there's no reason to pay for a pane just to
   run TypeScript the orchestrator could run directly.

**Legitimate exception.** Stages that spawn subordinate LLM work via
`s.stage()` (nested sub-sessions) are fine — the child stages carry the
LLM calls and the parent acts as a grouping scope. This pattern is rare
and usually better expressed with headless fan-out + `Promise.all`.
