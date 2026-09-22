---
title: SDK API reference
sidebarTitle: "SDK API"
description: SDK options, resource loaders, return values, run modes, and exports.
---

# SDK API reference

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
- Context files (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` walking up from cwd)
- Session directory naming

`agentDir` is used by `DefaultResourceLoader` for:
- Global extensions (`extensions/`)
- Global skills:
  - `skills/` under `agentDir` (for example `~/.atomic/agent/skills/`; legacy `~/.pi/agent/skills/` is also considered by default)
  - `~/.agents/skills/`
- Global prompts (`prompts/`)
- Global context files (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` under `agentDir`)
- Settings (`settings.json`)
- Custom models (`models.json`)
- Credentials (`auth.json`)
- Sessions (`sessions/`)

When you pass a custom `ResourceLoader`, `cwd` and `agentDir` no longer control resource discovery. They still influence session naming and tool path resolution.

### Model

```typescript
import { getModel } from "@bastani/pi-ai/compat";
import { ModelRuntime } from "@bastani/atomic";

const modelRuntime = await ModelRuntime.create();

// Find specific built-in model (doesn't check if credentials exist)
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("Model not found");

// Find any model by provider/id, including custom models from models.json
const customModel = modelRuntime.getModel("my-provider", "my-model");

// Get only models whose providers have configured authentication
const available = await modelRuntime.getAvailable();

const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh, max (when supported by the model)
  
  // Models for cycling (CTRL+P in interactive mode)
  scopedModels: [
    { model: opus, thinkingLevel: "high" },
    { model: haiku, thinkingLevel: "off" },
  ],
  
  modelRuntime,
});
```

`ModelRegistry` keeps synchronous reads for extension compatibility, while catalog refresh is asynchronous. Extensions should await `modelRegistry.refresh()` before synchronous `getAll()`, `find()`, or `getAvailable()` reads when a provider may update its catalog. New SDK integrations use `ModelRuntime`; `await modelRuntime.refresh()` reports `aborted` and per-provider `errors`, and failed providers retain their last-known models.

If no model is provided:
1. Tries to restore from session (if continuing)
2. Uses default from settings
3. Falls back to first available model

> See [examples/sdk/02-custom-model.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/02-custom-model.ts)

#### Model catalog persistence and refresh

`ModelRuntime.create()` restores cached catalogs from local persistence but does not contact
pi.dev unless you opt in. `allowModelNetwork` (default `false`) enables a create-time network
refresh, and `modelRefreshTimeoutMs` (default `15_000`) bounds how long that refresh may run
before it is aborted. Pass `refreshOnCreate: false` to skip the initial catalog and
availability refresh entirely; built-in models remain available.

```typescript
const refreshedRuntime = await ModelRuntime.create({
  allowModelNetwork: true,
  modelRefreshTimeoutMs: 15_000,
});
```

Remote catalogs are persisted locally so later runtimes can restore them without a network
request. The default file is `models-store.json` next to `models.json` — with the default
`modelsPath` that is `~/.atomic/agent/models-store.json`. Set `modelsStorePath` to choose
another location, or inject `modelsStore` to control persistence entirely; a runtime created
with `modelsPath: null` keeps its store in memory. Network refreshes are throttled to once
per provider every four hours unless forced. To force an immediate refresh, call
`await modelRuntime.refresh({ allowNetwork: true, force: true, signal })`. Setting
`ATOMIC_OFFLINE` (legacy alias `PI_OFFLINE`) disables model network access, and a
`refresh()` call that omits `allowNetwork` follows that same runtime network policy.

### API Keys and OAuth

`ModelRuntime` is the asynchronous SDK engine for provider composition, credentials, model catalogs, and requests. `ModelRegistry` remains a thin compatibility facade for extensions; `await modelRegistry.complete(model, context, options)` routes a request through its runtime with the resolved provider and auth. New SDK integrations should pass `modelRuntime` to `createAgentSession` and use `modelRuntime.complete()` directly when they issue standalone requests.

Credential resolution combines runtime API-key overrides, stored `auth.json` credentials, environment variables, and the active `models.json` provider configuration. OAuth acquisition is provider-owned and runs through `ModelRuntime.login()`.

```typescript
import { AuthStorage, ModelRuntime } from "@bastani/atomic";

const authStorage = AuthStorage.create();
const modelRuntime = await ModelRuntime.create({ credentials: authStorage });

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

// Runtime API key override (not persisted to disk). Setting the key updates
// auth state; refresh the provider explicitly when its catalog must be current.
const providerId = "anthropic";
const authController = new AbortController();
await modelRuntime.setRuntimeApiKey(providerId, "sk-my-temp-key", { signal: authController.signal });
await modelRuntime.refresh({ providers: [providerId], signal: authController.signal });

// Custom credential and model configuration locations
const customRuntime = await ModelRuntime.create({
  authPath: "/my/app/auth.json",
  modelsPath: "/my/app/models.json",
});

const customSession = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime: customRuntime,
});

// Disable models.json while retaining built-in providers
const builtinsOnly = await ModelRuntime.create({ modelsPath: null });
```

> See the complete [`ModelRuntime` credential and model configuration example](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts).

### Structured decisions

Use `inferStructuredOutput()` with an explicit inference model for a single schema-validated semantic decision without starting an agent session or executing tools. It supports ordinary configured models and the decision-only Jev integrations listed by `getStructuredOutputProviders()` (direct TypeSafe, OpenRouter, Vercel AI Gateway, OpenCode Zen), and never reads `routerModel`. Gateway Jev reuses that gateway's existing authentication. The separate `inferRouterDecision()` entrypoint shares `routerModel` resolution for prerequisite workflow/subagent-auto routing only. Neither API changes the selected chat model or the `structured_output` tool. See [Structured decisions](/sdk/structured-decisions) for state preparation, examples, provider limits and failure handling.

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

- Built-in tool names enabled by default: `read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`
- `find` discovers filesystem paths by glob; `search` searches file contents with regex patterns across files, directories, globs, and internal URLs.
- `builtins` selects shipped packages independently of tools: keys are `workflows`, `subagents`, `mcp`, `web-access`, and `intercom`. Omitted, `{}`, and omitted keys enable packages. A `false` value removes that package's extensions and resources, including on reload; `true` enables it.
- `tools` is an allowlist of coding, extension, and custom tool names. `tools: []` exposes none, including Intercom.
- `excludedTools` removes matching names from the registry and active selection. Exclusions win over `tools`; unknown names are ignored.
- `noTools: "all"` exposes no tools, even with a nonempty `tools` allowlist. It does not remove package resources or authorize services.
- `noTools: "builtin"` suppresses coding-tool defaults when `tools` is omitted, keeping extension/custom tools except exclusions. An explicit `tools` list still wins over this mode.
- Configured `defaultTools` selects only initial coding tools when `tools` and `noTools` are omitted. It does not disable extension/custom tools.

Workflow and subagent children inherit these restrictions. Child allowlists intersect with the parent selection, including during model fallback. A child cannot restore a parent-disabled package or excluded tool. See [child configuration](/sdk#workflow-and-subagent-children) for model/auth, host callback and working-directory inheritance.

```typescript
import { createAgentSession } from "@bastani/atomic";

// Read-only tools; Intercom is not selected.
const { session } = await createAgentSession({
  tools: ["read", "search", "find", "ls"],
});

// Pick specific tools.
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
  excludedTools: ["ask_user_question"], // active tools: read, bash
});
```

#### Bash tool behavior

Atomic's built-in `bash` tool matches upstream pi: when `bash` is enabled, commands execute through the configured shell with the Atomic process permissions. Use `tools`, `excludedTools`, or `noTools` to decide whether a session exposes the `bash` tool at all. Atomic no longer provides a command-level allow/deny option for `bash`; use an operating-system/container sandbox or a custom tool/extension when you need command allowlisting or stronger isolation.

#### Waiting for existing shell tasks

Both Bash and PowerShell factories accept `{ action: "wait", id: taskId, budgetMs: 1000 }` with a trusted `taskOwner` binding. No command is executed. `BashToolInput` and `PowerShellToolInput` distinguish command launches from existing-task waits; narrow by `action` before reading `command`.

`budgetMs` is optional, finite, and non-negative. Omission uses the owner's command wait policy and zero polls. Results keep the `WaitOutcome` in `details.observation`, available exit information in `details.exitCode`, and retained output in text content. Failure and cancellation metadata remain in the settled observation. Yielded waits advance through bounded retained-output pages for the same owned task, even when the tool is recreated. Partial UTF-8 characters continue on the next page. Settled waits return all retained output again, subject to labelled gaps and truncation. Aborting the call releases only its observation. A binding from `AgentTaskHost.ownerBinding` also releases waits for incoming owner messages.

Do not mix wait arguments with launch fields. Unknown or foreign IDs and unbound waits are rejected before execution hooks. Custom `operations.exec` does not provide existing-task ownership. See [Background tasks](/background-tasks) for examples and lifetime rules.

#### PowerShell tool behavior

`createPowerShellTool()` and `createPowerShellToolDefinition()` provide the same tool used by interactive sessions. When their default local operations execute on native Windows, they prefer `pwsh.exe`, fall back to `powershell.exe`, and throw a clear error when neither executable is available. `createLocalPowerShellOperations()` and `getPowerShellConfig()` are also exported for custom integrations. The PowerShell factories expose the current `ATOMIC_*` and legacy `PI_*` session snapshot by default; set `exposeSessionEnvironment: false` to opt out.

PowerShell tools and local operations accept a trusted `taskOwner` binding and the same
`wait` observation policy as bash. Owned native Windows execution automatically yields
after the owner's command budget (normally 10000 ms); explicit per-call budgets override it,
and execution timeout remains separate. Task descriptions retain the original command text.
Without a supported owner, explicit background requests are refused and foreground execution waits for completion.

```typescript
import { createPowerShellTool } from "@bastani/atomic";

const powershell = createPowerShellTool("C:\\path\\to\\project");
```

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

`ToolDefinition.constrainedSampling` is part of the public SDK and survives `defineTool()`, `customTools`, tool wrappers, session/staged inspection, and isolated execution. Use `{ type: "json_schema", strict: "prefer" | "require" }`, `{ type: "grammar", variants: { openai_lark?: string, openai_regex?: string } }`, or `false`. `prefer` can fall back; `require` fails when the active model cannot enforce strict JSON Schema. Grammar constraints require one required string parameter and capable model metadata. Public inspection preserves optional-property identity exactly: an omitted key stays absent, an explicitly present `undefined` stays present, and `false` or a config object remains unchanged. The exported `ConstrainedSamplingConfig` type and [extension reference](/extensions/authoring#constrained-sampling) define the exact shape. Typed RPC clients receive the four model capability flags through optional `ModelInfo.compat`; see [RPC](/rpc/protocol#get_available_models).

Factory-created `createBashTool()` instances receive the same execution-time `ATOMIC_SESSION_*`/`PI_SESSION_*` model and session snapshot as the built-in bash tool. Set `exposeSessionEnvironment: false` only when the subprocess must not receive it. `MessageRenderOptions.outputPad` is likewise passed to normal and isolated custom message renderers.

Normal sessions also expose `kill({ id: taskId })` for their owned bash and PowerShell background tasks. Include `kill` when using a `tools` allowlist if the agent should be able to stop those tasks. The exported `createKillTool` and `createKillToolDefinition` factories accept `KillToolOptions.taskOwner`, a trusted execution-time callback returning the same owner binding used by shell launch. Without a binding they reject execution. The result details preserve the supervisor's `CancelReceipt`, including its decision, execution outcome, and cleanup state. See [Background tasks](/background-tasks#stop-a-shell-task-from-a-tool-call).

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

The tool parameters are exactly the supplied schema. With `DecisionSchema`, the model calls `structured_output({ approved, findings })`. The factory also accepts array and primitive schemas when the target provider/tool runtime supports them; the captured value is whatever JSON value matches the schema.

A successful call:

- Stores the parameters in `capture.value`.
- Returns pretty-printed JSON tool-result text for text print mode and keeps the flat value in tool `details`.
- Writes the same JSON to `output.outputPath` when an `output` file sink is configured.
- Sets `terminate: true`, preventing an extra follow-up assistant turn.

Atomic relies on the tool schema, not extra structured-output parsing or sidecar validation. Structured-output tool definitions opt out of oversized-result persistence.

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

`createAgentSession()` preserves the resources from a supplied loader and adds Atomic's shipped builtin extensions and resources. Repeated references to a shipped builtin load it once. Your loader's arrays and discovery options are not rewritten. Existing tool selection and collision rules still apply.

Pass `extensionBindings` to `createAgentSession()` to install `uiContext`, `mode`, `commandContextActions`, `shutdownHandler` or `onError` before startup hooks run. Creation awaits startup and resource discovery. A failed startup shuts down the partially created session before rejecting. Rebinding updates the host without replaying `session_start`; reload emits one start for its new generation. Remove manual post-creation startup calls from integrations that only used them to initialize extensions.

Strict reloads (`failOnExtensionErrors: true`) require the loader's transactional `prepareReload()` support so a failed candidate cannot mutate live state before validation. `DefaultResourceLoader` provides that support. Custom loaders without it remain compatible with ordinary reloads, but strict reload fails before calling their mutating `reload()` method.

Use `await session.dispose()` rather than fire-and-forget cleanup. It seals admission immediately and waits for owned work, extension shutdown, persistence and lease release. Concurrent disposal calls return the same promise. Catch `ShutdownFailed` to inspect its component `errors`; a rejected close is not successful cleanup, and the session stays closed. Do not add a manual MCP, Intercom or workflow teardown sequence. Caller-supplied settings, storage and model runtimes remain caller-owned.

`AgentSessionRuntime` uses the same awaited close when replacing sessions and transfers configured host bindings before the replacement starts. Reload invalidates old input requests and extension subscriptions while retaining host configuration. Live durable workflows retain their existing runtime ownership across reload and session replacement; final owner disposal waits for their shutdown. A late answer from an old generation cannot authorize replacement work.

Settings persistence failures can make disposal reject. Repair storage and repeat the write before closing; disposal does not consume the caller's `SettingsManager.drainErrors()` channel. Duplicate `executeBash()` IDs remain correlation IDs, and `abortBash(id)` cancels every active call with that ID.

Ensure callbacks settle independently of disposal. For reload, replacement, and resource ownership guidance, see [SDK lifecycle](/sdk#finishing-admitted-work).

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
}

interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
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
inferStructuredOutput
inferRouterDecision
resolveRouterModel
getStructuredOutputProviders
JEV_STRUCTURED_OUTPUT_PROVIDER
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
type StructuredOutputRequest
type StructuredOutputResult
type StructuredOutputModel
type RouterModelSelectionOptions
type RouterDecisionRequest
type StructuredChoiceQuestion
type ExtensionFactory
type ExtensionAPI
type ToolDefinition
type Skill
type PromptTemplate
type Tool
```

For extension types, see [Extensions](/extensions) for the full API.

## Owner-bound task supervisor (S1)

For trusted custom hosts, the package exports `AgentTaskHost` and its integration types, not the raw native supervisor. Bind the actual host scope and a mandatory `authorizeLaunch` guard. Never accept ownership or authorization from model-supplied input or reconstruct a lease from a task ID or saved history.

`startAgentTask(intent, operation, runnerFactory)` returns a Result containing `{taskId, lease}` after setup. The factory receives the original `AbortSignal`, reference, and `reportActivity` context. Return separate `result` and `cleanup` promises; report cleanup only when it is confirmed. Replaying the same operation reuses execution without calling another factory.

Use `observeAgentLaunch(taskId, policy?)`, `waitForTask`, `resolveTask`, `cancelTask`, `watchOwnerTasks`, and `close` within the bound owner. Observation returns Result/WaitOutcome. Yielding or cancelling an observation does not stop execution. Cancellation and cleanup failures remain observable; owner close may remain pending until your runner acknowledges cleanup.

### Supervised command SDK

For shell integration, use the exported Bash and PowerShell factories with a trusted `taskOwner` binding. Execution timeout and observation budget are separate. The automatic command wait is normally 10000 ms; `until-settled` waits for completion. A yielded command remains owned, and later waits can read retained output with explicit omission markers.

Without a supported owner, explicit background execution is refused. Native Windows legacy WSL `bash.exe` is not supported for owned commands; run Atomic inside WSL instead. See [waiting for shell tasks](#waiting-for-existing-shell-tasks) and [Background tasks](/background-tasks) for caller usage.

### Task transcript references

Task inspectors show references to the bound child conversation, excluding thinking and non-conversation entries. An unbound or empty history reports `Transcript unavailable`. Saved history is not authority to restart or control a task.
