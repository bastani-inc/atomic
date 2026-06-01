# Partition 5 — `examples/` (3,435 LOC): External Research Decision

## Decision: External research is NOT required.

All three per-agent session APIs are exhaustively documented in the repository's own
`docs/` tree, and the example files themselves are unambiguous canonical references.
The signatures, option shapes, and return types can be read directly without fetching
any remote page. What follows is a structured extraction of the three SDK patterns
from first-party sources already in the repo.

---

## Per-Agent Session API Inventory (from `examples/` + `docs/`)

### @anthropic-ai/claude-agent-sdk

**Local docs:** `docs/claude-code/agent-sdk/sdk-references/typescript.md`,
`docs/claude-code/agent-sdk/guides/structured-output.md`

**Relevant behaviour:**

`s.session.query(prompt, options?)` is the single call site used in every Claude
example. It is a wrapper around the SDK-level `query()` async generator. The atomic
SDK awaits the entire generator and returns the collected `SDKMessage[]` array
(typed as the generator's yield type).

Key option fields seen in examples:

```typescript
// examples/structured-output-demo/claude/index.ts:45-52
const result = await s.session.query(buildPrompt(topic), {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    outputFormat: {
        type: "json_schema",
        schema: LANGUAGE_FACTS_JSON_SCHEMA, // z.toJSONSchema(zodSchema, { target: "openapi-3.0" })
    },
});
// validated object is at: s.session.lastStructuredOutput
```

`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` is
the standard headless combination used whenever a stage is marked `headless: true`
(examples: `headless-test`, `structured-output-demo`, `hil-favorite-color-headless`).

After `query()`, the session Id is persisted with `s.save(s.sessionId)`. The string
sessionId is the artifact handed to the next stage's `s.transcript(handle)` call.

`extractAssistantText(result, 0)` (from `@bastani/atomic-sdk/workflows`) is the
helper used to pull the first assistant-turn text out of the returned message array.

**Where used (representative):**

| Call site                                                 | Notes                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `examples/hello-world/claude/index.ts:53`                 | Plain `query(prompt)` — two turns in sequence                                           |
| `examples/structured-output-demo/claude/index.ts:45`      | `query(prompt, { outputFormat: { type:"json_schema", schema } })`                       |
| `examples/headless-test/claude/index.ts:27–108`           | `query(prompt, { permissionMode, allowDangerouslySkipPermissions })` in parallel stages |
| `examples/review-fix-loop/claude/index.ts:69`             | `query()` returns `SDKMessage[]`; `extractAssistantText()` reads verdict string         |
| `examples/hil-favorite-color-headless/claude/index.ts:38` | headless query with disallowedTools injected by runtime                                 |

---

### @github/copilot-sdk

**Local docs:** `docs/copilot-cli/sdk.md`

**Relevant behaviour:**

`s.session.send({ prompt })` is the only call used in every Copilot example. It
queues a message and resolves the message ID (not the response). Response content
is recovered via `s.session.getMessages()` which returns `SessionEvent[]`.

```typescript
// examples/hello-world/copilot/index.ts:51-53
await s.session.send({ prompt });
s.save(await s.session.getMessages());
```

`SessionEvent` is a discriminated union. The assistant text is extracted by
filtering for `{ type: "assistant.message" }` and reading `.data.content`. The
headless-test copilot index defines a local helper:

```typescript
// examples/headless-test/copilot/index.ts:6-13
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

Structured output is achieved via `defineTool` (from `@github/copilot-sdk`), not a
response-format option. A Zod schema is passed as `parameters`; the SDK validates
tool-call arguments before firing `handler`:

```typescript
// examples/structured-output-demo/copilot/index.ts:46-54
const submitFacts = defineTool("submit_facts", {
    description: SUBMIT_TOOL_DESCRIPTION,
    parameters: LanguageFactsSchema, // z.object({ ... })
    skipPermission: true,
    handler: async (data: LanguageFacts) => {
        captured = data;
        return "Facts submitted.";
    },
});
// tool passed in stageOptions.tools; prompt instructs model to call it
```

`CustomAgentConfig` (from `@github/copilot-sdk`) allows inline subagent definition
at session creation time, with a `tools` allowlist that is resolved against the live
tool registry (including SDK-registered tools):

```typescript
// examples/reviewer-tool-test/copilot/index.ts:72-79
const inlineReviewer: CustomAgentConfig = {
    name: "reviewer",
    tools: ["execute", "read", "search", "submit_review"],
    prompt: "...",
};
```

**Where used (representative):**

| Call site                                                | Notes                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `examples/hello-world/copilot/index.ts:51`               | `session.send({ prompt })` + `getMessages()`                              |
| `examples/hil-favorite-color/copilot/index.ts:27–59`     | Two-stage HIL with `send()` + transcript handoff via `prior.content`      |
| `examples/structured-output-demo/copilot/index.ts:46–73` | `defineTool` with Zod schema; no `outputFormat` option                    |
| `examples/reviewer-tool-test/copilot/index.ts:61–106`    | `defineTool` + `CustomAgentConfig` inline subagent                        |
| `examples/headless-test/copilot/index.ts:39–125`         | `send()` + `getMessages()` in parallel stages; `SessionEvent` type import |

---

### @opencode-ai/sdk

**Local docs:** `docs/opencode/sdk.md`, `docs/opencode/server.md`

**Relevant behaviour:**

`s.client.session.prompt({ sessionID, parts, format? })` is the call used in every
OpenCode example. It is a direct HTTP call to the OpenCode server's `/session/{id}/prompt`
endpoint and returns `{ data: AssistantMessage }` synchronously (not a stream).

```typescript
// examples/hello-world/opencode/index.ts:54-58
const result = await s.client.session.prompt({
    sessionID: s.session.id,
    parts: [{ type: "text", text: prompt }],
});
s.save(result.data!);
```

The stage options third argument (the "provider options" slot) carries OpenCode-
specific session creation fields: `title` and `permission`. Every OpenCode example
passes a wildcard permission record:

```typescript
// examples/hello-world/opencode/index.ts:49-52 (stageOptions arg)
{
  title: "hello",
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}
```

This is required — OpenCode sessions do not auto-approve tool calls.

Structured output uses a `format` parameter in the same `prompt()` call:

```typescript
// examples/structured-output-demo/opencode/index.ts:48-55
const result = await s.client.session.prompt({
    sessionID: s.session.id,
    parts: [{ type: "text", text: buildPrompt(topic) }],
    format: {
        type: "json_schema" as const,
        schema: LANGUAGE_FACTS_JSON_SCHEMA,
    },
});
// validated object: (result.data!.info as { structured?: unknown })?.structured
```

`result.data!` is the `AssistantMessage`. Its parts array (for text extraction) and
`info.structured` field (for structured output) are the two result surfaces used
across examples.

```typescript
// examples/headless-test/opencode/index.ts:7-11 (local helper)
function extractResponseText(
    parts: Array<{ type: string; [key: string]: unknown }>,
): string {
    return parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { type: string; text: string }).text)
        .join("\n");
}
// usage: extractResponseText(result.data!.parts)
```

**Where used (representative):**

| Call site                                                | Notes                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `examples/hello-world/opencode/index.ts:54`              | `client.session.prompt({ sessionID, parts })`                                                         |
| `examples/hil-favorite-color/opencode/index.ts:30–76`    | Two-stage; transcript via `prior.content`; each stage needs fresh `sessionID`                         |
| `examples/structured-output-demo/opencode/index.ts:48`   | `prompt()` + `format: { type:"json_schema", schema }`                                                 |
| `examples/headless-test/opencode/index.ts:39–170`        | Parallel stages; each awaits `prompt()` independently; no headless option needed (no interactive TUI) |
| `examples/parallel-hello-world/opencode/index.ts:42–118` | Fan-out/fan-in with `s.transcript()` handoff                                                          |

---

## Summary

External library documentation is not central to understanding the `examples/`
partition. The three session API surfaces are fully enumerated in the local `docs/`
tree and are directly visible in the example source files.

The rewrite implication is clear from the examples themselves: the three call shapes
that must collapse into a single pi-agent interface are:

1. **Claude** — `s.session.query(prompt, { permissionMode, outputFormat? })` → returns
   `SDKMessage[]`; structured output surfaces via `s.session.lastStructuredOutput`;
   session identity is a string ID passed to `s.save()`.

2. **Copilot** — `s.session.send({ prompt })` → fire-and-forget (returns message ID);
   response fetched separately via `s.session.getMessages()` → `SessionEvent[]`;
   structured output achieved only through `defineTool` with Zod `parameters`.

3. **OpenCode** — `s.client.session.prompt({ sessionID, parts, format? })` → returns
   `{ data: AssistantMessage }` directly; structured output via `format.type = "json_schema"`
   with result at `result.data.info.structured`; every session requires explicit
   `permission` records in the stage options.

The pi-agent unified interface must absorb these three divergent shapes into one
call — a single `session.run(prompt, options?)` or equivalent that normalises
prompt delivery, response retrieval, permission handling, and structured-output
extraction regardless of which underlying agent is in use.

No URLs were fetched. All findings derive from files within the repository:
`examples/**/*/index.ts`, `docs/claude-code/agent-sdk/`, `docs/copilot-cli/sdk.md`,
and `docs/opencode/sdk.md`.
