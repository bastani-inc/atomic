# Online Research — Partition 1: packages/atomic-sdk External Library Documentation

## Libraries Researched

All research was drawn from local `docs/` copies already checked into the repository, plus cached entries under `research/web/` from prior sessions. No external HTTP fetches were required.

---

#### @anthropic-ai/claude-agent-sdk (^0.2.132)

**Docs:** `docs/claude-code/agent-sdk/sdk-references/typescript.md`, `docs/claude-code/agent-sdk/guides/hooks.md`, `docs/claude-code/agent-sdk/guides/streaming-output.md`, `docs/claude-code/agent-sdk/guides/structured-output.md`, `docs/claude-code/agent-sdk/guides/user-input.md`, `docs/claude-code/agent-sdk/guides/subagents.md`, `docs/claude-code/agent-sdk/guides/permissions.md`, `research/web/2026-04-14-claude-agent-sdk-hil-transcript.md`

**Relevant behaviour:**

**`query()` function signature:**

```typescript
function query({
  prompt: string | AsyncIterable<SDKUserMessage>,
  options?: Options
}): Query; // extends AsyncGenerator<SDKMessage, void>
```

The `Query` object is an async iterable and also exposes `.setPermissionMode()` for dynamic permission mode switching mid-stream. Used in the SDK as the primary entry point for all Claude Agent SDK stages.

**Hook system — all hooks registered via `options.hooks`:**

- `PreToolUse` — fires before tool execution; can `allow`, `deny`, or inject `systemMessage`. Matcher regex filters by tool name. `hookSpecificOutput.permissionDecision` = `"allow" | "deny" | "ask"`. `updatedInput` modifies tool args (requires `permissionDecision: "allow"`).
- `PostToolUse` — fires after tool result; can inject `additionalContext`.
- `Stop` — fires when agent execution stops. Used by the Atomic stop-hook to deliver follow-up prompts and signal session completion.
- `SubagentStart` / `SubagentStop` — fire when subagents spawn/finish. Input includes `agent_id`, `agent_transcript_path`, `stop_hook_active`.
- `SessionStart` / `SessionEnd` — TypeScript-only; fires on session init/teardown.
- `TeammateIdle` — TypeScript-only; fires when a teammate becomes idle.
- `TaskCompleted` — TypeScript-only; fires when a background task completes.
- Async hook output (`{ async: true, asyncTimeout: ms }`) lets the agent proceed without waiting.

**Stop hook integration (Atomic-specific pattern):**
The stop-hook binary (`atomic _claude-stop-hook`) receives a JSON payload via stdin:

```typescript
interface ClaudeStopHookPayload {
    session_id: string;
    transcript_path?: string;
    cwd?: string;
    stop_hook_active?: boolean;
}
```

It returns `{ "decision": "block", "reason": "<next-prompt>" }` to inject the next turn's prompt without tmux send-keys. This is the mechanism documented in `docs/claude-code/agent-sdk/guides/hooks.md` where a `Stop` hook's JSON output `reason` is treated as the next user message.

**In-flight subagent tracking (`claude-inflight-hook`):**
`SubagentStart` / `SubagentStop` hook payloads carry `agent_id` and `session_id`. The inflight hook writes marker files under `~/.atomic/claude-inflight/<root_session_id>/<agent_id>`. `waitForInflightDrained()` blocks until all subagent markers are removed. This prevents the executor from advancing while backgrounded subagents still hold PTY resources on the tmux server.

**Streaming output:**
With `options.includePartialMessages: true`, the query emits `SDKPartialAssistantMessage` (`type: "stream_event"`) containing raw `RawMessageStreamEvent` objects from the Anthropic API. Key event types: `message_start`, `content_block_start`, `content_block_delta` (text: `text_delta`; tool input: `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop`. Without partial messages: stream emits `SDKAssistantMessage`, `SDKResultMessage`, `SDKSystemMessage`, `SDKCompactBoundaryMessage`. Extended thinking disables partial messages.

**Structured output via `outputFormat`:**

```typescript
options: {
  outputFormat: {
    type: "json_schema",
    schema: <JSONSchema> // or z.toJSONSchema(ZodSchema)
  }
}
```

Result appears in `message.structured_output` on the `ResultMessage` when `message.subtype === "success"`. On retry exhaustion: `subtype === "error_max_structured_output_retries"`. Structured output is incompatible with streaming (no deltas; result only in final `ResultMessage`).

**AskUserQuestion HIL via `canUseTool`:**

```typescript
options: {
    canUseTool: async (toolName, input) => {
        if (toolName === "AskUserQuestion") {
            // input.questions: Array<{ question, header, options: Array<{ label, description, preview? }>, multiSelect }>
            return {
                behavior: "allow",
                updatedInput: {
                    questions: input.questions,
                    answers: { [question]: label },
                },
            };
        }
        return { behavior: "allow", updatedInput: input };
        // or: return { behavior: "deny", message: "reason" };
    };
}
```

`AskUserQuestion` must be listed in `tools` if a restricted tool list is used. Not available in subagents. The `toolConfig.askUserQuestion.previewFormat` option enables HTML/markdown option previews. Live detection: check `toolName === "AskUserQuestion"` in `canUseTool`. Transcript-based detection: find `tool_use` blocks with `name === "AskUserQuestion"` that have no matching `tool_result` in subsequent user messages. The `SDKResultSuccess.deferred_tool_use` field signals that the session ended with a pending (unresolved) tool use.

**Permission modes:**
`options.permissionMode`: `"default"` | `"dontAsk"` | `"acceptEdits"` | `"bypassPermissions"` | `"plan"` | `"auto"`. Dynamic switch via `query.setPermissionMode(mode)`. `bypassPermissions` is inherited by all subagents and cannot be overridden. `dontAsk` converts any unmatched tool to a hard deny without calling `canUseTool`.

**Subagents via `agents` parameter:**

```typescript
options: {
  allowedTools: ["Read", "Grep", "Glob", "Agent"],
  agents: {
    "code-reviewer": {
      description: string,     // used by Claude to decide when to delegate
      prompt: string,          // subagent system prompt
      tools?: string[],        // restricted tool set; inherits all if omitted
      model?: "sonnet" | "opus" | "haiku" | "inherit",
      skills?: string[],
      mcpServers?: (string | object)[]
    }
  }
}
```

Subagents get fresh context windows; only the Agent tool prompt string crosses the boundary. Subagent transcripts stored at `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`. Resume a subagent by passing `options.resume: sessionId` and including the agent ID in the prompt. Tool was renamed `"Task"` → `"Agent"` in CC v2.1.63; SDK emits `"Agent"` in `tool_use` blocks but `"Task"` in `system:init` tools list.

**Session read functions:**

- `listSessions({ dir?, limit?, includeWorktrees? })` → `SDKSessionInfo[]` sorted by `lastModified` desc
- `getSessionMessages(sessionId, { dir?, limit?, offset?, includeSystemMessages? })` → `SessionMessage[]` in chronological order via `parentUuid` chain
- `getSubagentMessages(sessionId, agentId, options?)` → `SessionMessage[]`
- Session JSONL stored at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; encoded-cwd replaces all non-alphanumeric chars with `-`

**`getSessionMessages` and `getSessionInfo` imports:**

```typescript
import {
    getSessionMessages,
    query as sdkQuery,
    type SessionMessage,
    type SDKUserMessage,
    type Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";
```

**Where used in partition:**

- `packages/atomic-sdk/src/providers/claude.ts:26` — imports `getSessionMessages`, `query as sdkQuery`, `SessionMessage`, `SDKUserMessage`, `Options as SDKOptions`
- `packages/atomic-sdk/src/providers/claude-stop-hook.ts` — implements the Stop hook JSON protocol (`ClaudeStopHookPayload`, block/release/queue polling)
- `packages/atomic-sdk/src/providers/claude-inflight-hook.ts` — implements SubagentStart/Stop/TeammateIdle hook handlers; `ClaudeInflightHookPayload` carries `session_id`, `agent_id`, `agent_type`

**Dependencies pinning Atomic to Claude Agent SDK:**

- The entire `providers/claude.ts` abstraction (session lifecycle, tmux send-keys automation, JSONL watching for idle detection, stop-hook protocol)
- `providers/claude-stop-hook.ts` — stop hook binary and queue/release marker directory protocol
- `providers/claude-inflight-hook.ts` — inflight subagent tracking directory protocol
- All built-in workflow variants under `workflows/builtin/*/claude/` (ralph/claude, deep-research-codebase/claude, open-claude-design/claude)
- The `runtime/tmux.ts` export used by `claude.ts` for pane spawning

**Agent-agnostic seam:** The `createProviderValidator` factory from `types.ts` and the `OffloadResumeMetadata` interface from `runtime/offload-types.ts` are provider-neutral abstractions shared by claude/copilot/opencode adapters.

---

#### @github/copilot-sdk (^0.3.0)

**Docs:** `docs/copilot-cli/sdk.md`, `research/web/2026-04-14-copilot-sdk-hil-events.md`

**Relevant behaviour:**

**Client lifecycle:**

```typescript
const client = new CopilotClient({
  cliPath?: string,         // default: COPILOT_CLI_PATH env var or bundled instance
  cliArgs?: string[],
  cliUrl?: string,          // connect to existing server (skips spawn)
  port?: number,
  useStdio?: boolean,       // default: true
  gitHubToken?: string,
  useLoggedInUser?: boolean
});
await client.start();
// ...
await client.stop();
```

**Session creation (onPermissionRequest required):**

```typescript
const session = await client.createSession({
  model?: string,           // required when using custom provider
  onPermissionRequest: PermissionHandler,  // REQUIRED
  onUserInputRequest?: UserInputHandler,   // enables ask_user tool
  onElicitationRequest?: ElicitationHandler,
  tools?: Tool[],           // custom tools via defineTool()
  systemMessage?: SystemMessageConfig,
  infiniteSessions?: InfiniteSessionConfig,
  provider?: ProviderConfig,
  hooks?: SessionHooks
});
```

**`session.send()` / `session.sendAndWait()`:**

```typescript
await session.send({ prompt: string, attachments?, mode?: "enqueue"|"immediate" });
// sendAndWait blocks until session.idle event fires:
await session.sendAndWait({ prompt }, timeout?);
```

**`defineTool()` with Zod (the custom tool API):**

```typescript
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
defineTool("tool_name", {
  description: string,
  parameters: z.object({ ... }),
  skipPermission?: boolean,
  overridesBuiltInTool?: boolean,
  handler: async (args) => returnValue  // JSON-serializable or ToolResultObject
})
```

**HIL: `onUserInputRequest` (primary mechanism — RPC handler):**

```typescript
onUserInputRequest: async (request, invocation) => {
    // request.question: string
    // request.choices?: string[]
    // request.allowFreeform?: boolean (default true)
    return { answer: string, wasFreeform: boolean };
};
```

When provided, sends `requestUserInput: true` in `session.create` RPC, enabling the `ask_user` tool on the CLI. The CLI makes a direct `userInput.request` RPC call that must return the user's answer.

**HIL: passive event observation:**

```typescript
session.on("user_input.requested", (event) => {
    // event.data: { requestId, question, choices?, allowFreeform?, toolCallId? }
    // ephemeral: true — not persisted to disk
});
session.on("user_input.completed", (event) => {
    // event.data: { requestId }
    // ephemeral: true
});
session.on("session.idle", (event) => {
    // event.data: { backgroundTasks?: { agents, shells }, aborted? }
    // ephemeral: true — signals turn completion
});
```

`session.idle` is the canonical "turn done" signal; `sendAndWait` uses it internally.

**Permission handling:**
`onPermissionRequest(request, invocation)` receives `request.kind: "shell" | "write" | "read" | "mcp" | "custom-tool" | "url" | "memory" | "hook"`. Returns one of: `"approved"`, `"denied-interactively-by-user"`, `"denied-by-rules"`, `"denied-by-content-exclusion-policy"`, `"denied-no-approval-rule-and-could-not-request-from-user"`, `"no-result"`.

**COPILOT_CLI_PATH env detection:**
`CopilotClientOptions.cliPath` falls back to `COPILOT_CLI_PATH` env var, then bundled instance. The `isCopilotShim()` function in `providers/copilot.ts` detects Node.js/npm-loader shim files that should not be passed as the CLI executable (checks `.js` extension, `node_modules/.bin/` path, and `#!/usr/bin/env node` shebang in first 256 bytes).

**Session hooks (`SessionHooks`):**

```typescript
hooks: {
  onPreToolUse: async (input, invocation) => ({ permissionDecision, modifiedArgs?, additionalContext? }),
  onPostToolUse: async (input, invocation) => ({ additionalContext? }),
  onUserPromptSubmitted: async (input, invocation) => ({ modifiedPrompt? }),
  onSessionStart: async (input, invocation) => ({ additionalContext? }),
  onSessionEnd: async (input, invocation) => void,
  onErrorOccurred: async (input, invocation) => ({ errorHandling: "retry"|"skip"|"abort" })
}
```

**Infinite sessions (default on):**
Background compaction at configurable context thresholds. Events: `session.compaction_start`, `session.compaction_complete`. Workspace path: `~/.copilot/session-state/{sessionId}/` with `checkpoints/`, `plan.md`, `files/` subdirs.

**System message customisation:**
Three modes: append-only (default), `mode: "customize"` (section-level overrides: `replace | remove | append | prepend`), `mode: "replace"` (full override, removes guardrails). Section IDs: `identity`, `tone`, `tool_efficiency`, `environment_context`, `code_change_rules`, `guidelines`, `safety`, `tool_instructions`, `custom_instructions`, `last_instructions`.

**Where used in partition:**

- `packages/atomic-sdk/src/providers/copilot.ts:13` — imports `CopilotClientOptions`, `SessionConfig as CopilotSessionConfig` from `@github/copilot-sdk`; implements `isCopilotShim()`, `copilotSubprocessEnv()`, and resume adapter
- All built-in workflow variants under `workflows/builtin/*/copilot/`

**Dependencies pinning Atomic to Copilot SDK:**

- `providers/copilot.ts` — CLI path resolution, shim detection, subprocess env construction, session resume metadata
- `workflows/builtin/ralph/copilot/`, `workflows/builtin/deep-research-codebase/copilot/`, `workflows/builtin/open-claude-design/copilot/` — provider-specific workflow entry points

---

#### @opencode-ai/sdk (^1.14.40)

**Docs:** `docs/opencode/sdk.md`, `research/web/2026-04-14-opencode-sdk-hil-events.md`

**Relevant behaviour:**

**Client creation:**

```typescript
import { createOpencode } from "@opencode-ai/sdk"
const { client } = await createOpencode({
  hostname?: string,  // default: "127.0.0.1"
  port?: number,      // default: 4096
  signal?: AbortSignal,
  timeout?: number,
  config?: Config
})
// Or connect to existing server:
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })
```

**`session.prompt()` with `format` parameter (structured output):**

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "prompt text" }],
    model: { providerID: string, modelID: string },
    format?: {
      type: "json_schema",   // or "text" (default)
      schema: JSONSchema,
      retryCount?: number    // default: 2
    },
    noReply?: boolean        // true = inject context only, no AI response
  }
})
// result.data.info.structured_output — validated JSON
// result.data.info.error?.name === "StructuredOutputError" on failure
```

**Permission records:**

```typescript
client.postSessionByIdPermissionsByPermissionId({
    path: { id: sessionId, permissionId: string },
    body: {
        /* permission decision */
    },
});
```

**Event subscription (SSE stream):**

```typescript
const events = await client.event.subscribe();
for await (const event of events.stream) {
    // event is a member of the Event discriminated union
    console.log(event.type, event.properties);
}
```

**Session CRUD:**
`session.list()`, `session.get()`, `session.create()`, `session.delete()`, `session.abort()`, `session.messages()`, `session.message()`, `session.revert()`, `session.unrevert()`, `session.summarize()`, `session.init()` (creates AGENTS.md).

**OPENCODE_CLIENT env for headless HIL suppression:**
OpenCode only registers its interactive `question` tool when `OPENCODE_CLIENT` is one of `"app" | "cli" | "desktop"`. Setting `OPENCODE_CLIENT=sdk` (the `HEADLESS_OPENCODE_CLIENT_ID` constant) suppresses the question tool entirely for headless workflow stages. The `withHeadlessOpencodeEnv()` function in `providers/opencode.ts` wraps `createOpencode(...)` calls with reference counting to handle concurrent parallel stages safely.

**Where used in partition:**

- `packages/atomic-sdk/src/providers/opencode.ts:25` — `HEADLESS_OPENCODE_CLIENT_ID = "sdk"`, `withHeadlessOpencodeEnv()`, resume adapter
- All built-in workflow variants under `workflows/builtin/*/opencode/`

**Dependencies pinning Atomic to OpenCode SDK:**

- `providers/opencode.ts` — `OPENCODE_CLIENT` env management, headless question-tool suppression, session resume metadata
- `workflows/builtin/ralph/opencode/`, `workflows/builtin/deep-research-codebase/opencode/`, `workflows/builtin/open-claude-design/opencode/`

---

#### @opentui/core + @opentui/react (^0.2.3 each)

**Docs:** Referenced in `CLAUDE.md` as opentui skill; `docs/` has no dedicated OpenTUI doc page. The `components/workflow-picker-panel.tsx` and all TUI-layer files in `packages/atomic-sdk/src/tui/` and `packages/atomic-sdk/src/runtime/attached-footer.ts` depend on these.

**Relevant behaviour:**
OpenTUI provides a React-compatible reconciler for terminal UIs. The partition exports `./tui` (`src/tui/index.ts`), `./runtime/attached-footer` (`src/runtime/attached-footer.ts`), and `./workflows/components` (`src/components/workflow-picker-panel.tsx`), all of which render TUI panes/layouts via `@opentui/react`. The `SyntaxStyle` resource pattern (from codebase memory) requires `useEffect` cleanup calling `.destroy()` — not cleanup inside `useMemo`. This pattern is load-bearing in any OpenTUI component using syntax highlighting. No external fetch required for this library; behavior is documented via the `opentui` agent skill.

**Where used in partition:**

- `packages/atomic-sdk/src/components/workflow-picker-panel.tsx` — workflow picker UI panel
- `packages/atomic-sdk/src/runtime/attached-footer.ts` — footer rendering in the orchestrator runtime
- `packages/atomic-sdk/src/tui/index.ts` and related TUI helpers

---

#### zod (^4.4.3)

**Docs:** Referenced via `z.toJSONSchema()` in structured-output doc above.

**Relevant behaviour:**
Used for `WorkflowInput` schema definitions within `defineWorkflow` and for type-safe tool parameter definitions in workflow stages. The `z.toJSONSchema()` function (Zod 4) converts Zod schemas to JSON Schema for use with `outputFormat: { type: "json_schema", schema }` in both Claude Agent SDK and OpenCode SDK structured-output calls. Also used by `@bastani/atomic-sdk` for `WorkflowInput` validation. Agent-agnostic — not pinned to any specific coding agent.

---

#### commander / @commander-js/extra-typings (^14.0.3 / ^14.0.0)

**Relevant behaviour:**
Used for the `./cli` export (`src/cli.ts`). Provides typed command/subcommand parsing for any CLI entry points surfaced by the SDK package itself (e.g., the `atomic _claude-stop-hook` and `atomic _claude-inflight-hook` internal subcommands). Agent-agnostic.

---

#### ignore (^7.0.5)

**Relevant behaviour:**
Used in `src/lib/common-ignore.ts` (exported as `./lib/common-ignore`). Provides `.gitignore`-style pattern matching for file filtering in workflow file discovery and skill loading. Agent-agnostic.

---

#### yaml (^2.8.4)

**Relevant behaviour:**
Used for parsing/serialising YAML-format configuration files (e.g., skills, workflow definitions, settings). Agent-agnostic.

---

## Summary

The research above covers all external libraries that are central to the `packages/atomic-sdk/` partition's research question. The three agent-SDK dependencies (`@anthropic-ai/claude-agent-sdk`, `@github/copilot-sdk`, `@opencode-ai/sdk`) are the primary removal targets in the rewrite: each has a dedicated provider file (`providers/claude.ts`, `providers/copilot.ts`, `providers/opencode.ts`) plus three sets of built-in workflow entry points. The Claude Agent SDK's Stop/SubagentStart/SubagentStop/TeammateIdle hook protocol and the inflight-marker-directory synchronisation mechanism (`providers/claude-inflight-hook.ts`) are load-bearing for tmux-free session lifecycle management and must be re-platformed entirely. The Copilot SDK's `onPermissionRequest` + `onUserInputRequest` + `session.on("session.idle")` pattern and the OpenCode SDK's `OPENCODE_CLIENT` env suppression pattern are similarly provider-specific. All other dependencies (`zod`, `commander`, `ignore`, `yaml`, `@opentui/core/react`) are agent-agnostic and can be carried forward into the pi-coding-agent rewrite unchanged.
