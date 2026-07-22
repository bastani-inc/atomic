> Atomic can help you use the SDK. Ask it to build an integration for your use case.

# SDK

The SDK provides programmatic access to atomic's agent capabilities. Use it to embed atomic in other applications, build custom interfaces, or integrate with automated workflows.

**Example use cases:**
- Build a custom UI (web, desktop, mobile)
- Integrate agent capabilities into existing applications
- Create automated pipelines with agent reasoning
- Build custom tools that spawn sub-agents
- Test agent behavior programmatically

See [examples/sdk/](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/sdk) for working examples from minimal to full control.

## Quick Start

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@bastani/atomic";

// Set up credential storage and model registry
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

`ModelRuntime` is the canonical asynchronous provider runtime when an integration wants provider-owned credentials, dynamic catalogs, and native providers in one object:

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@bastani/atomic";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});
```

`ModelRuntime.create()` accepts custom `authPath`, `modelsPath`, credential storage, and runtime auth overrides. `ModelRegistry` and `AuthStorage` remain available as Atomic's synchronous compatibility facades. Use `readStoredCredential(provider, authPath?)` for a lightweight read of one stored provider credential.

Extensions supplied directly to SDK sessions can use the exported `InlineExtension` type. Extension APIs and event types include native `registerProvider(Provider)`, `registerEntryRenderer`, `entry_appended`, `before_provider_headers`, and `agent_settled`.

The package root also exports `buildContextEntries`, `sessionEntryToContextMessages`, and `CompactionEntry` for converting durable session branches into model context. The equivalent active-session operation is `sessionManager.buildContextEntries()`.

## Installation

Install `@bastani/atomic` as a project dependency with npm, pnpm, or Bun:

With npm:

```bash
npm install @bastani/atomic
```

With pnpm:

```bash
pnpm add @bastani/atomic
```

With Bun:

```bash
bun add @bastani/atomic
```

Atomic does not require package install scripts. If you want to disable dependency lifecycle scripts during the Atomic install, you can add `--ignore-scripts` to the install command.

The SDK is included in the main package. No separate SDK package is needed.

## Core Concepts

### createAgentSession()

The main factory function for a single `AgentSession`.

`createAgentSession()` uses a `ResourceLoader` to supply extensions, skills, prompt templates, themes, and context files. If you do not provide one, it uses `DefaultResourceLoader` with standard discovery.

```typescript
import { createAgentSession, SessionManager } from "@bastani/atomic";

// Minimal: defaults with DefaultResourceLoader
const { session } = await createAgentSession();

// Custom: override specific options
const { session } = await createAgentSession({
  model: myModel,
  tools: ["read", "bash"],
  // Or keep defaults and remove specific tools:
  // excludedTools: ["ask_user_question"],
  sessionManager: SessionManager.inMemory(),
});
```

### AgentSession

The session manages agent lifecycle, message history, model state, compaction, and event streaming.

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue messages during streaming
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Model, thinking, and context-window control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  setContextWindow(contextWindow: number, options?: { persistDefault?: boolean }): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;
  getAvailableContextWindows(): number[];
  supportsContextWindowSelection(): boolean;

  // State access
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // In-place tree navigation within the current session file
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }>;

  // Verbatim line compaction
  compact(options?: Partial<VerbatimCompactionParameters>): Promise<VerbatimCompactionResult>;
  abortCompaction(): void;

  // Abort current operation
  abort(): Promise<void>;

  // Cleanup
  dispose(): void;
}
```

`compact()` serializes older context to numbered lines, asks the session model for JSON deleted ranges, validates them, and mechanically reconstructs a durable verbatim transcript string. It appends a `compaction` entry with `details.strategy: "verbatim-lines"`; the recent tail remains ordinary messages. The model never authors replacement context text.

Session replacement APIs such as new-session, resume, fork, and import live on `AgentSessionRuntime`, not on `AgentSession`.

### createAgentSessionRuntime() and AgentSessionRuntime

Use the runtime API when you need to replace the active session and rebuild cwd-bound runtime state.
This is the same layer used by the built-in interactive, print, and RPC modes.

`createAgentSessionRuntime()` takes a runtime factory plus the initial cwd/session target. The factory closes over process-global fixed inputs, recreates cwd-bound services for the effective cwd, resolves session options against those services, and returns a full runtime result.

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@bastani/atomic";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});
```

`AgentSessionRuntime` owns replacement of the active runtime across:

- `newSession()`
- `switchSession()`
- `fork()`
- clone flows via `fork(entryId, { position: "at" })`
- `importFromJsonl()`

Important behavior:

- `runtime.session` changes after those operations
- event subscriptions are attached to a specific `AgentSession`, so re-subscribe after replacement
- if you use extensions, call `runtime.session.bindExtensions(...)` again for the new session
- creation returns diagnostics on `runtime.diagnostics`
- if runtime creation or replacement fails, the method throws and the caller decides how to handle it

```typescript
let session = runtime.session;
let unsubscribe = session.subscribe(() => {});

await runtime.newSession();

unsubscribe();
session = runtime.session;
unsubscribe = session.subscribe(() => {});
```

### Prompting and Message Queueing

`PromptOptions` controls prompt expansion, queueing behavior while streaming, and prompt preflight notifications:

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

`preflightResult` is called once per `prompt()` invocation:

- `true` when the prompt was accepted, queued, or handled immediately
- `false` when prompt preflight rejected before acceptance

It fires before `prompt()` resolves. `prompt()` still resolves only after the full accepted run finishes, including retries. Failures after acceptance are reported through the normal event and message stream, not through `preflightResult(false)`.

The `prompt()` method handles prompt templates, extension commands, and message sending:

```typescript
// Basic prompt (when not streaming)
await session.prompt("What files are here?");

// With images
await session.prompt("What's in this image?", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }]
});

// During streaming: must specify how to queue the message
await session.prompt("Stop and do this instead", { streamingBehavior: "steer" });
await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });
```

**Behavior:**
- **Extension commands** (e.g., `/mycommand`): Execute immediately, even during streaming. They manage their own LLM interaction via `pi.sendMessage()`.
- **File-based prompt templates** (from `.md` files): Expanded to their content before sending or queueing.
- **During streaming without `streamingBehavior`**: Throws an error. Use `steer()` or `followUp()` directly, or specify the option.
- **`preflightResult(true)`**: Means the prompt was accepted, queued, or handled immediately.
- **`preflightResult(false)`**: Means preflight rejected before acceptance.

For explicit queueing during streaming:

```typescript
// Queue a steering message for delivery after the current assistant turn finishes its tool calls
await session.steer("New instruction");

// Wait for agent to finish (delivered only when agent stops)
await session.followUp("After you're done, also do this");
```

Both `steer()` and `followUp()` expand file-based prompt templates but error on extension commands (extension commands cannot be queued).

### Agent and AgentState

The `Agent` class (from `@earendil-works/pi-agent-core`) handles the core LLM interaction. Access it via `session.agent`.

```typescript
// Access current state
const state = session.agent.state;

// state.messages: AgentMessage[] - conversation history
// state.model: Model - current model
// state.thinkingLevel: ThinkingLevel - current thinking level
// state.systemPrompt: string - system prompt
// state.tools: AgentTool[] - available tools
// state.streamingMessage?: AgentMessage - current partial assistant message
// state.errorMessage?: string - latest assistant error

// Replace messages (useful for branching or restoration)
session.agent.state.messages = messages; // copies the top-level array

// Replace tools
session.agent.state.tools = tools; // copies the top-level array

// Wait for agent to finish processing
await session.agent.waitForIdle();
```

### Events

Subscribe to events to receive streaming output and lifecycle notifications.

```typescript
session.subscribe((event) => {
  switch (event.type) {
    // Streaming text from assistant
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        // Thinking output (if thinking enabled)
      }
      break;
    
    // Tool execution
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_update":
      // Streaming tool output
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.isError ? "error" : "success"}`);
      break;
    
    // Message lifecycle
    case "message_start":
      // New message starting
      break;
    case "message_end":
      // Message complete
      break;
    
    // Agent lifecycle
    case "agent_start":
      // Agent started processing prompt
      break;
    case "agent_end":
      // Agent finished (event.messages contains new messages)
      break;
    
    // Turn lifecycle (one LLM response + tool calls)
    case "turn_start":
      break;
    case "turn_end":
      // event.message: assistant response
      // event.toolResults: tool results from this turn
      break;
    
    // Session events (queue, context-window, compaction, retry)
    case "queue_update":
      console.log(event.steering, event.followUp);
      break;
    case "context_window_changed":
      console.log(`Context window: ${event.contextWindow}`);
      break;
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      break;
  }
});
```

## Options Reference

### Directories

```typescript
const { session } = await createAgentSession({
  // Working directory for DefaultResourceLoader discovery
  cwd: process.cwd(), // default
  
  // Global config directory
  agentDir: "~/.atomic/agent", // default (expands ~)
});
```

Atomic reads primary `.atomic` locations first and legacy `.pi` locations for compatibility when multiple config directories are supported. Passing an explicit `agentDir` makes that directory the user override.

`cwd` is used by `DefaultResourceLoader` for:
- Project extensions (`.atomic/extensions/`, then legacy `.pi/extensions/`)
- Project skills:
  - `.atomic/skills/`, then legacy `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Project prompts (`.atomic/prompts/`, then legacy `.pi/prompts/`)
- Context files (`AGENTS.md` walking up from cwd)
- Session directory naming

`agentDir` is used by `DefaultResourceLoader` for:
- Global extensions (`extensions/`)
- Global skills:
  - `skills/` under `agentDir` (for example `~/.atomic/agent/skills/`; legacy `~/.pi/agent/skills/` is also considered by default)
  - `~/.agents/skills/`
- Global prompts (`prompts/`)
- Global context file (`AGENTS.md`)
- Settings (`settings.json`)
- Custom models (`models.json`)
- Credentials (`auth.json`)
- Sessions (`sessions/`)

When you pass a custom `ResourceLoader`, `cwd` and `agentDir` no longer control resource discovery. They still influence session naming and tool path resolution.

### Model

```typescript
import { getModel } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@bastani/atomic";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Find specific built-in model (doesn't check if API key exists)
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("Model not found");

// Find any model by provider/id, including custom models from models.json
// (doesn't check if API key exists)
const customModel = modelRegistry.find("my-provider", "my-model");

// Get only models that have valid API keys configured
const available = await modelRegistry.getAvailable();

const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh, max (when supported by the model)
  contextWindow: 1_000_000, // optional; must be supported by the selected model unless non-strict fallback is acceptable
  contextWindowStrict: true, // optional; return contextWindowError instead of warning/fallback when unsupported
  
  // Models for cycling (CTRL+P in interactive mode)
  scopedModels: [
    { model: opus, thinkingLevel: "high" },
    { model: haiku, thinkingLevel: "off" },
  ],
  
  authStorage,
  modelRegistry,
});
```

`ModelRegistry` keeps synchronous reads for SDK and extension compatibility, while catalog refresh is asynchronous. Await `modelRegistry.refresh()` before reading `getAll()`, `find()`, or `getAvailable()` when a provider may update its catalog. The refresh result reports `aborted` and per-provider `errors`; successful providers publish their new catalogs even if another provider fails, and failed or timed-out providers retain their last-known models.

If no model is provided:
1. Tries to restore from session (if continuing)
2. Uses default from settings
3. Falls back to first available model

Context-window selection is independent from `thinkingLevel`. `contextWindow` accepts a raw token count such as `400_000` or `1_000_000`; for most providers the value must be present in the model's supported context windows (`model.contextWindowOptions` plus the scalar default). GitHub Copilot is the only provider with rounded long-context budget handling: when a tiered Copilot model advertises a long tier below the branded request (for example `936_000` for a `1_000_000` request), Atomic selects the largest advertised Copilot long tier at or below the request instead of falling back to the short tier. Settings lookup first checks the selected model's `defaultContextWindows["provider/modelId"]` entry, then the optional global `defaultContextWindow` fallback; unsupported model-specific settings keep the model default and return `contextWindowWarning`, while unsupported global fallback values are ignored silently as not applicable to the active model. When you pass `contextWindowStrict: true`, an unsupported explicit selection is reported as `contextWindowError` so callers can fail before prompting. A successful explicit `contextWindow` startup option is journaled as a `context_window_change` entry even when it equals the scalar model default, so the user's explicit budget choice survives future settings changes and resume.

At runtime, use `session.getAvailableContextWindows()` to inspect supported values, `session.supportsContextWindowSelection()` to check whether more than one value is selectable, and `session.setContextWindow(tokens, { persistDefault })` to change the active model budget. `setContextWindow()` journals a `context_window_change` entry only when the active value changes. Passing `{ persistDefault: true }` also writes the effective selected budget to `defaultContextWindows["provider/modelId"]` in settings instead of the global fallback, so a Copilot prompt cap such as `936k` does not leak into Anthropic, Cursor, or other providers. Tree navigation replays the target branch's `context_window_change` state into the active model without adding another journal entry or changing settings. Larger provider context windows may consume more credits/cost, so opt into larger values deliberately. For catalog-advertised GitHub Copilot long-context models (including `github-copilot/gpt-5.5`, `github-copilot/claude-sonnet-5`, and `github-copilot/gemini-3.1-pro-preview`), selecting `1m` raises Atomic's local budget to the model's advertised `922k`/`936k` tier and sends `X-GitHub-Api-Version: 2026-06-01`; GitHub applies the long-context tier server-side by prompt token count, consumes more Copilot AI credits, and requires long-context/usage-based billing entitlement.

The package root exports the same context-window helpers and types used by the runtime: `parseContextWindowValue()`, `formatContextWindow()`, `validateContextWindowValue()`, `normalizeContextWindowOptions()`, `getModelDefaultContextWindow()`, `getSupportedContextWindows()`, `withContextWindowOptions()`, `selectContextWindow()`, `ContextWindowParseResult`, `ContextWindowSelection`, `ContextWindowSelectionError`, and `ContextWindowSelectionOptions`. Importing from `@bastani/atomic` also includes the `@earendil-works/pi-ai` `Model<Api>` augmentation for `contextWindowOptions` and `defaultContextWindow`, so SDK consumers can use the helper types without importing internal source paths.

> See [examples/sdk/02-custom-model.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/02-custom-model.ts)

### API Keys and OAuth

`AuthStorage` and `ModelRegistry` remain synchronous public SDK entry points. Token refresh is serialized under Atomic's credential-store lock, and the `authStorage` and `modelRegistry` session options remain available.

API key resolution priority (handled by AuthStorage):
1. Runtime overrides (via `setRuntimeApiKey`, not persisted)
2. Stored credentials in `auth.json` (API keys or OAuth tokens)
3. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
4. Fallback resolver (for custom provider keys from `models.json`)

OAuth credentials may provide an API key, request headers, and a credential-specific `baseUrl`. Atomic applies all three to the request. In particular, GitHub Copilot enterprise and token-specific endpoints replace the static model URL without dropping retries, attribution headers, fast mode, or extension request hooks.

```typescript
import { AuthStorage, ModelRegistry } from "@bastani/atomic";

// Default: uses ~/.atomic/agent/auth.json and ~/.atomic/agent/models.json,
// with legacy ~/.pi/agent/* compatibility reads when available.
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// Runtime API key override (not persisted to disk)
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");

// Custom auth storage location
const customAuth = AuthStorage.create("/my/app/auth.json");
const customRegistry = ModelRegistry.create(customAuth, "/my/app/models.json");

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: customAuth,
  modelRegistry: customRegistry,
});

// No custom models.json (built-in models only)
const simpleRegistry = ModelRegistry.inMemory(authStorage);
```

> See [examples/sdk/09-api-keys-and-oauth.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts)

### System Prompt

Use a `ResourceLoader` to override the system prompt:

```typescript
import { createAgentSession, DefaultResourceLoader } from "@bastani/atomic";

const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are a helpful assistant.",
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/03-custom-prompt.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/03-custom-prompt.ts)

### Tools

Specify which tools to expose by name:

- Built-in tool names enabled by default: `read`, `bash`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`
- `find` discovers filesystem paths by glob; `search` searches file contents with regex patterns across files, directories, globs, and internal URLs.
- `tools` is an allowlist: when provided, only the listed built-in, extension, and custom tool names are exposed.
- `excludedTools` is a blocklist: matching built-in, extension, and custom tool names are omitted from the final registry and active tool set. If both are provided, `tools` is applied first and `excludedTools` subtracts from it.
- `noTools: "all"` disables all tools
- `noTools: "builtin"` disables default built-ins while keeping extension and custom tools enabled, except names listed in `excludedTools`

```typescript
import { createAgentSession } from "@bastani/atomic";

// Read-only mode
const { session } = await createAgentSession({
  tools: ["read", "search", "find", "ls"],
});

// Pick specific tools
const { session } = await createAgentSession({
  tools: ["read", "bash", "search"],
});

// Keep defaults but remove HITL prompts
const { session } = await createAgentSession({
  excludedTools: ["ask_user_question"],
});

// Allowlist first, then subtract exclusions
const { session } = await createAgentSession({
  tools: ["read", "bash", "ask_user_question"],
  excludedTools: ["ask_user_question"], // final tools: read, bash
});
```

#### Bash tool behavior

Atomic's built-in `bash` tool matches upstream pi: when `bash` is enabled, commands execute through the configured shell with the Atomic process permissions. Use `tools`, `excludedTools`, or `noTools` to decide whether a session exposes the `bash` tool at all. Atomic no longer provides a command-level allow/deny option for `bash`; use an operating-system/container sandbox or a custom tool/extension when you need command allowlisting or stronger isolation.

#### Tools with Custom cwd

When you pass a custom `cwd`, `createAgentSession()` builds selected built-in tools for that cwd.

```typescript
import { createAgentSession, SessionManager } from "@bastani/atomic";

const cwd = "/path/to/project";

// Use default tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(cwd),
});

// Or pick specific tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  tools: ["read", "bash", "search"],
  sessionManager: SessionManager.inMemory(cwd),
});
```

> See [examples/sdk/05-tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/05-tools.ts)

### Custom Tools

```typescript
import { Type } from "typebox";
import { createAgentSession, defineTool } from "@bastani/atomic";

// Inline custom tool
const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({
    input: Type.String({ description: "Input value" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `Result: ${params.input}` }],
    details: {},
  }),
});

// Pass custom tools directly
const { session } = await createAgentSession({
  customTools: [myTool],
});
```

Use `defineTool()` for standalone definitions and arrays like `customTools: [myTool]`. Inline `pi.registerTool({ ... })` already infers parameter types correctly.

Custom tools passed via `customTools` are combined with extension-registered tools. Extensions loaded by the ResourceLoader can also register tools via `pi.registerTool()`.

If you pass `tools`, include each custom or extension tool name you want enabled, for example `tools: ["read", "bash", "my_tool"]`. Use `excludedTools` to remove a custom or extension tool by name from the final exposed set.

#### Structured output final results

`structured_output` is not registered in normal agent sessions by default. Add it only when a caller needs a machine-readable final-answer contract by registering the exported factory as a custom tool:

```typescript
import { Type, type Static } from "typebox";
import {
  createAgentSession,
  createStructuredOutputTool,
  type StructuredOutputCapture,
} from "@bastani/atomic";

const DecisionSchema = Type.Object({
  approved: Type.Boolean(),
  findings: Type.Array(Type.String()),
}, { additionalProperties: false });

type Decision = Static<typeof DecisionSchema>;
const capture: StructuredOutputCapture<Decision> = {
  called: false,
  value: undefined,
};

const structuredOutput = createStructuredOutputTool({
  schema: DecisionSchema,
  capture,
});

const { session } = await createAgentSession({
  customTools: [structuredOutput],
});
```

The tool parameters are exactly the supplied schema: with `DecisionSchema`, the model calls `structured_output({ approved, findings })`. Array and primitive schemas are also accepted by the factory when the target provider/tool runtime supports them; the captured value is whatever JSON value matches the schema. A successful call stores the params in `capture.value`, returns them as pretty-printed JSON tool-result text for text print mode, keeps the flat value in tool `details`, writes the same JSON to the configured `output.outputPath` when an `output` file sink is configured, and sets `terminate: true` so there is no extra follow-up assistant turn. Atomic relies on the tool schema instead of extra structured-output parsing or sidecar validation. Structured-output tool definitions opt out of oversized-result persistence.

Custom tool names are supported, and the prompt metadata follows the configured name. If you use a custom name such as `final_decision`, include that name in any explicit `tools` allowlist. If the standard `structured_output` name is required, register the factory with its default name:

```typescript
const finalDecision = createStructuredOutputTool({
  name: "final_decision",
  schema: DecisionSchema,
  capture,
});
// The model is prompted to call final_decision exactly once, not structured_output.

await createAgentSession({
  customTools: [finalDecision],
  tools: ["final_decision"], // only this tool is enabled
});

await createAgentSession({
  customTools: [createStructuredOutputTool({ schema: DecisionSchema, capture })],
  // Registers the standard structured_output tool for this session only.
});
```

> See [examples/sdk/05-tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/05-tools.ts)

### Extensions

Extensions are loaded by the `ResourceLoader`. `DefaultResourceLoader` discovers extensions from `~/.atomic/agent/extensions/` and `.atomic/extensions/` first, then legacy `~/.pi/agent/extensions/` and `.pi/extensions/`, plus settings.json extension sources.

```typescript
import { createAgentSession, DefaultResourceLoader } from "@bastani/atomic";

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: ["/path/to/my-extension.ts"],
  extensionFactories: [
    (pi) => {
      pi.on("agent_start", () => {
        console.log("[Inline Extension] Agent starting");
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

Extensions can register tools, subscribe to events, add commands, and more. See [Extensions](/extensions) for the full API.

**Event Bus:** Extensions can communicate via `pi.events`. Pass a shared `eventBus` to `DefaultResourceLoader` if you need to emit or listen from outside:

```typescript
import { createEventBus, DefaultResourceLoader } from "@bastani/atomic";

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  eventBus,
});
await loader.reload();

eventBus.on("my-extension:status", (data) => console.log(data));
```

> See [examples/sdk/06-extensions.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/06-extensions.ts) and [Extensions](/extensions)

### Skills

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type Skill,
} from "@bastani/atomic";

const customSkill: Skill = {
  name: "my-skill",
  description: "Custom instructions",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  source: "custom",
};

const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/04-skills.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/04-skills.ts)

### Context Files

```typescript
import { createAgentSession, DefaultResourceLoader } from "@bastani/atomic";

const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      { path: "/virtual/AGENTS.md", content: "# Guidelines\n\n- Be concise" },
    ],
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/07-context-files.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/07-context-files.ts)

### Slash Commands

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type PromptTemplate,
} from "@bastani/atomic";

const customCommand: PromptTemplate = {
  name: "deploy",
  description: "Deploy the application",
  source: "(custom)",
  content: "# Deploy\n\n1. Build\n2. Test\n3. Deploy",
};

const loader = new DefaultResourceLoader({
  promptsOverride: (current) => ({
    prompts: [...current.prompts, customCommand],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/08-prompt-templates.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/08-prompt-templates.ts)

### Session Management

Sessions use a tree structure with `id`/`parentId` linking, enabling in-place branching.

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@bastani/atomic";

// In-memory (no persistence)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// New persistent session
const { session: persisted } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

// Continue most recent
const { session: continued, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) {
  console.log("Note:", modelFallbackMessage);
}

// Open specific file
const { session: opened } = await createAgentSession({
  sessionManager: SessionManager.open("/path/to/session.jsonl"),
});

// List sessions
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Session replacement API for /new, /resume, /fork, /clone, and import flows.
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

// Replace the active session with a fresh one
await runtime.newSession();

// Replace the active session with another saved session
await runtime.switchSession("/path/to/session.jsonl");

// Replace the active session with a fork from a specific user entry
await runtime.fork("entry-id");

// Clone the active path through a specific entry
await runtime.fork("entry-id", { position: "at" });
```

**SessionManager tree API:**

```typescript
const sm = SessionManager.open("/path/to/session.jsonl");

// Session listing
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Tree traversal
const entries = sm.getEntries();        // All entries (excludes header)
const tree = sm.getTree();              // Full tree structure
const path = sm.getPath();              // Path from root to current leaf
const leaf = sm.getLeafEntry();         // Current leaf entry
const entry = sm.getEntry(id);          // Get entry by ID
const children = sm.getChildren(id);    // Direct children of entry

// Labels
const label = sm.getLabel(id);          // Get label for entry
sm.appendLabelChange(id, "checkpoint"); // Set label

// Branching
sm.branch(entryId);                     // Move leaf to earlier entry
sm.branchWithSummary(id, "Summary...");  // Branch with context summary
sm.createBranchedSession(leafId);       // Extract path to new file
```

> See [examples/sdk/11-sessions.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/11-sessions.ts) and [Session Format](/session-format)

### Settings Management

```typescript
import { createAgentSession, SettingsManager, SessionManager } from "@bastani/atomic";

// Default: loads from files (global + project merged)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create(),
});

// With overrides
const settingsManager = SettingsManager.create();
settingsManager.applyOverrides({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 5 },
});
const { session } = await createAgentSession({ settingsManager });

// In-memory (no file I/O, for testing)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  sessionManager: SessionManager.inMemory(),
});

// Custom directories
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create("/custom/cwd", "/custom/agent"),
});
```

**Static factories:**
- `SettingsManager.create(cwd?, agentDir?)` - Load from files
- `SettingsManager.inMemory(settings?)` - No file I/O

**Project-specific settings:**

Settings load from Atomic-first locations and merge:
1. Global: `~/.atomic/agent/settings.json`, then legacy `~/.pi/agent/settings.json`
2. Project: `<cwd>/.atomic/settings.json`, then legacy `<cwd>/.pi/settings.json`

Project overrides global. Nested objects merge keys. Setters modify global settings by default.

**Persistence and error handling semantics:**

- Settings getters/setters are synchronous for in-memory state.
- Setters enqueue persistence writes asynchronously.
- Call `await settingsManager.flush()` when you need a durability boundary (for example, before process exit or before asserting file contents in tests).
- `SettingsManager` does not print settings I/O errors. Use `settingsManager.drainErrors()` and report them in your app layer.

> See [examples/sdk/10-settings.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/10-settings.ts)

## ResourceLoader

Use `DefaultResourceLoader` to discover extensions, skills, prompts, themes, and context files.

```typescript
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@bastani/atomic";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
});
await loader.reload();

const extensions = loader.getExtensions();
const skills = loader.getSkills();
const prompts = loader.getPrompts();
const themes = loader.getThemes();
const contextFiles = loader.getAgentsFiles().agentsFiles;
```

## Return Value

`createAgentSession()` returns:

```typescript
interface CreateAgentSessionResult {
  // The session
  session: AgentSession;
  
  // Extensions result (for runner setup)
  extensionsResult: LoadExtensionsResult;
  
  // Warning if session model couldn't be restored
  modelFallbackMessage?: string;

  // Warning if a saved/default context window could not be applied to the selected model
  contextWindowWarning?: string;

  // Error if an explicit strict context-window selection is unsupported
  contextWindowError?: string;
}

interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
```

## Complete Example

```typescript
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@bastani/atomic";

// Set up auth storage (custom location)
const authStorage = AuthStorage.create("/custom/agent/auth.json");

// Runtime API key override (not persisted)
if (process.env.MY_KEY) {
  authStorage.setRuntimeApiKey("anthropic", process.env.MY_KEY);
}

// Model registry (no custom models.json)
const modelRegistry = ModelRegistry.create(authStorage);

// Inline tool
const statusTool = defineTool({
  name: "status",
  label: "Status",
  description: "Get system status",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: `Uptime: ${process.uptime()}s` }],
    details: {},
  }),
});

const model = getModel("anthropic", "claude-opus-4-5");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: "/custom/agent",
  settingsManager,
  systemPromptOverride: () => "You are a minimal assistant. Be concise.",
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: "/custom/agent",

  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,

  tools: ["read", "bash", "status"],
  customTools: [statusTool],
  resourceLoader: loader,

  sessionManager: SessionManager.inMemory(),
  settingsManager,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Get status and list files.");
```

## Run Modes

The SDK exports run mode utilities for building custom interfaces on top of `createAgentSession()`:

### InteractiveMode

Full TUI interactive mode with editor, chat history, and all built-in commands:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@bastani/atomic";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: "Hello",
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

### runPrintMode

Single-shot mode: send prompts, output result, exit:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runPrintMode,
  SessionManager,
} from "@bastani/atomic";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "Hello",
  initialImages: [],
  messages: ["Follow up"],
});
```

### runRpcMode

JSON-RPC mode for subprocess integration:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "@bastani/atomic";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runRpcMode(runtime);
```

See [RPC documentation](/rpc) for the JSON protocol.

## RPC Mode Alternative

For subprocess-based integration without building with the SDK, use the CLI directly:

```bash
atomic --mode rpc --no-session
```

See [RPC documentation](/rpc) for the JSON protocol.

The SDK is preferred when:
- You want type safety
- You're in the same Node.js process
- You need direct access to agent state
- You want to customize tools/extensions programmatically

RPC mode is preferred when:
- You're integrating from another language
- You want process isolation
- You're building a language-agnostic client

## Exports

The main entry point exports:

```typescript
// Factory
createAgentSession
createAgentSessionRuntime
AgentSessionRuntime

// Auth and Models
AuthStorage
ModelRegistry

// Resource loading
DefaultResourceLoader
type ResourceLoader
createEventBus

// Constants and helpers
CONFIG_DIR_NAME
defineTool
STRUCTURED_OUTPUT_TOOL_NAME
createStructuredOutputTool
createStructuredOutputCapture
getAgentDir
getPackageDir
getReadmePath
getDocsPath
getExamplesPath
generateDiffString
generateUnifiedPatch
type EditDiffResult

// Session management
SessionManager
SettingsManager

// Tool factories
createCodingTools
createReadOnlyTools
createReadTool, createBashTool, createEditTool, createWriteTool
createGrepTool, createFindTool, createLsTool

// Types
type CreateAgentSessionOptions
type CreateAgentSessionResult
type StructuredOutputCapture
type StructuredOutputToolOptions
type ExtensionFactory
type ExtensionAPI
type ToolDefinition
type Skill
type PromptTemplate
type Tool
```

For extension types, see [Extensions](/extensions) for the full API.
