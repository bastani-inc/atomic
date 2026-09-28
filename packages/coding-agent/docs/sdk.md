---
title: "SDK"
description: "Embed Atomic in a Node.js application."
---

> Atomic can help you use the SDK. Ask it to build an integration for your use case.

# SDK

Use the SDK to embed Atomic in an application, build a custom interface, or integrate agent capabilities into an automated workflow.

**Example use cases:**
- Build a custom UI (web, desktop, mobile)
- Integrate agent capabilities into existing applications
- Create automated pipelines with agent reasoning
- Build custom tools that spawn sub-agents
- Test agent behavior programmatically

See [examples/sdk/](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/sdk) for working examples from minimal to full control.

## On this page and its reference

This page covers the SDK quick start, its core concepts, and one complete example. Options, resource loaders, return types, run modes, and exports live in the [SDK API reference](/sdk/reference).

For a custom host that runs background work, see [Owner-bound task supervisor](/sdk/reference#owner-bound-task-supervisor-s1), [Supervised command SDK](/sdk/reference#supervised-command-sdk), and [Task transcript references](/sdk/reference#task-transcript-references).

Not sure the SDK is the right integration mode? Compare it with RPC and JSON mode on [Programmatic use](/programmatic).

## Quick Start

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@bastani/atomic";

const modelRuntime = await ModelRuntime.create();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("What files are in the current directory?");
} finally {
  await session.dispose();
}
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

`ModelRuntime.create()` accepts custom `authPath`, `modelsPath`, credential storage, and runtime auth overrides, plus the model-catalog options `allowModelNetwork`, `modelRefreshTimeoutMs`, `modelsStorePath`, and `modelsStore` (see [Model catalog persistence and refresh](/sdk/reference#model-catalog-persistence-and-refresh)). `ModelRegistry` and `AuthStorage` remain available as Atomic's synchronous compatibility facades. Use `readStoredCredential(provider, authPath?)` for a lightweight read of one stored provider credential.

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

### Migrating an existing Node host

Use the installed package's ESM exports, not checkout paths or extension-loader aliases:

```typescript
import { createAgentSession, type HostInput } from "@bastani/atomic";
import { workflow } from "@bastani/atomic/workflows";
import openClaudeDesign from "@bastani/atomic/workflows/builtin/open-claude-design";
```

For TypeScript Node applications, use `"type": "module"` in `package.json` and `module: "NodeNext"`, `moduleResolution: "NodeNext"`, and `strict: true` in `tsconfig.json`. Declaration checking works with `skipLibCheck: false`; disabling it is not required. No separate workflows install, ambient module declarations, source aliases, CLI process, or terminal is needed.

When upgrading an existing host:

- Remove manual registration of Atomic's shipped builtin extensions. They and their resources are included by default. Use `builtins` to disable packages; use `tools`/`excludedTools` to control tool access. An empty tool allowlist also excludes Intercom.
- Supply all five `HostInput` methods (`confirm`, `select`, `input`, `editor`, `questionnaire`) through `extensionBindings.humanInput`. Preserve question text and option values, honor each request's abort signal, and return literal `true` only for explicit approval. No adapter is not consent: ordinary dialogs reject with `HumanInputUnavailable`, while required durable workflow gates remain pending. Do not translate cancellation into approval.
- Treat a headless workflow launch as acceptance, not completion. Inspect its run ID/status. After reconnecting, resume that existing run and bind the new adapter with `session.bindExtensions({ humanInput })`; do not start a second run to answer an outstanding question. Durable resume requires working workflow persistence; inspect the original run's status and correct the reported database problem before retrying.
- Always `await session.dispose()` in `finally`, including on failure. Disposal is asynchronous and can reject with `ShutdownFailed` after attempting all cleanup; do not hide that rejection or call `process.exit()` to force a successful shutdown. Each session owns its own work, even when services are shared.

MCP servers and web providers still require their normal configuration and credentials. Importing the SDK does not connect them or take over standard input. Route host diagnostics through `extensionBindings.onDiagnostic`; a missing provider or extractor is an error, not an empty successful result.

If creation reports `BuiltinUnavailable`, reinstall the complete package and its dependencies rather than copying only `dist/index.js` into your application.

## Pi client

`@bastani/atomic/client` re-exports `@earendil-works/pi-client`. Pi 0.85 replaced the experimental `RemoteSession` lease API with its service-addressed Chord client; use the upstream client and agent service APIs for remote sessions.

## Experimental remote sessions

Use [Pi client](#pi-client) for the current remote-session API.

## Experimental Harness factory

For the current supported integration, start with [createAgentSession()](#createagentsession) and the [SDK API reference](/sdk/reference).

## Core Concepts

### createAgentSession()

The main factory function for a single `AgentSession`.

`createAgentSession()` includes Atomic's shipped workflows, subagents, MCP, web access and Intercom, plus their bundled resources. It uses normal user, project and configured-package discovery when no `resourceLoader` is supplied. A custom loader supplies your resources; the factory adds shipped builtins without changing the loader's options. Services still need their existing configuration and credentials.

Use `builtins: { "web-access": false, intercom: false }` to disable specific shipped packages and their resources. Omitted keys remain enabled, including with `builtins: {}`. Tool selection is separate: `tools: []` and `noTools: "all"` expose no tools, including Intercom; `noTools: "all"` also overrides a nonempty allowlist. `excludedTools` wins over selection. Suppression survives reload. See [tool precedence](/sdk/reference#tools) for `defaultTools` and `noTools: "builtin"`.

Creation finishes extension startup before returning. Pass `extensionBindings` when startup hooks need your host bindings. Later `session.bindExtensions(...)` updates those bindings without replaying `session_start`; reload starts a new extension generation. Missing shipped assets reject with an error whose `code` is `BuiltinUnavailable` and whose message names the package. Reinstall the package rather than continuing with a partially available session.

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

### Human input without a terminal

Pass `extensionBindings.humanInput` to answer extension dialogs and `ask_user_question` in a Node host. `HostInput` requires all five methods: `confirm`, `select`, `input`, `editor` and `questionnaire`. `QuestionParams` and `QuestionnaireResult` are exported from `@bastani/atomic`; questionnaire answers retain their question indices, answer kinds, selections, previews and notes.

Each callback receives a `HostInputOptions` argument with a runtime-generated `requestId`, the originating `sessionId`, and an `AbortSignal`. Stop presenting the question when the signal aborts.

Return an actual boolean from `confirm`, a supplied choice or `undefined` from `select`, and a string or `undefined` from text dialogs. Atomic preserves empty strings, whitespace and choice order. Malformed replies reject with `InvalidHostInput`; false, cancellation and rejected callbacks never approve an action.

```typescript
import { createAgentSession, type HostInput } from "@bastani/atomic";

async function attachApplication(humanInput: HostInput) {
  const { session } = await createAgentSession({
    extensionBindings: {
      humanInput,
      onDiagnostic: ({ level, source, message, sessionId }) => {
        console.log({ level, source, message, sessionId });
      },
    },
  });

  // Cancel current work and any outstanding ordinary questions.
  await session.abort();
  // Withdraw input while keeping the session available for noninteractive work.
  await session.bindExtensions({ humanInput: null });
  // Reattach the application's callbacks when it is ready to answer again.
  await session.bindExtensions({ humanInput });
  return session;
}
```

#### Binding and withdrawing an input adapter

`humanInput` has different omission rules at creation and during rebinding:

- At creation, omission means no input unless `uiContext` supplies a dialog bridge. Explicit callbacks override that bridge.
- On later binding, omission keeps the current adapter. `null` withdraws it and cancels pending ordinary questions.

Rebinding does not repeat startup hooks. Abort, reload, and disposal invalidate pending replies, including late successful replies from callbacks that ignore cancellation.

Extension authors should check `ctx.hasHumanInput` before asking questions and `ctx.hasUI` before rendering. Existing `ctx.ui.confirm/select/input/editor` calls use the host adapter; dialog timeouts cancel their requests. Without an adapter, ordinary dialogs reject with `HumanInputUnavailable`. The `ask_user_question` tool retains its compatible `{ answers: [], cancelled: true, error: "no_ui" }` details. `ui.custom` still requires a presentation host and is not part of `HostInput`.

#### Durable workflow approvals

Workflow input uses the same callbacks for stage questionnaires and nested workflows. Requests include `workflowRunId` and `workflowStageId`; combine them with `requestId` to associate a question with its run. Author semantic `ctx.ui` calls rather than terminal-specific branches so the definition works across hosts.

A durable approval stays pending when input is unavailable, cancelled, or invalid. Withdrawing the adapter neither approves the request nor discards the run. Bind a new adapter to present a live pending request again. It receives a fresh request ID; late answers to the withdrawn request cannot authorize work.

To continue a saved run in another session:

1. Keep its definition and durable storage available.
2. Bind the new host.
3. Use `/workflow resume <run-id>` or the workflow tool's `resume` action.

Rebinding alone does not reopen a saved run. See [workflow operations](/workflows/operations) for inspection, graceful quit, and resume.

Launching without an adapter still preserves required gates and returns the run identity. Inspect status, then bind an authorized host or submit a validated answer. Headless CLI launches use the same execution defaults, but skip pickers and return without waiting for terminal completion. Explicit runtime execution restrictions still apply.

Only an actual `true` confirms a primitive approval. Choosing to stay on a questionnaire's stage does not advance it. Missing input never bypasses approval or an exhausted budget; obtain approval before explicitly resuming with a raised budget.

#### Diagnostics and provider state

`onDiagnostic` receives session-attributed operational diagnostics. Existing errors and tool results remain available without a callback. Third-party extensions can still write directly to the console; the callback does not intercept their output.

Rebinding host callbacks preserves pending MCP OAuth ownership. Authorization state and PKCE verifiers stay in memory for that SDK session; restart authorization after disposing it. Durable MCP tokens and client registrations still use server-name credential files. Separate sessions are not separate credential stores.

Web provider configuration caches are session-local. Configuration discovery and environment keys are unchanged; create a new session to pick up changed cached settings. GitHub extraction returns the owned clone path for use with file tools, so callers need not predict its directory.

### Workflow and subagent children

Children inherit the invoking session's model/auth runtime, settings, agent directory, human-input callbacks, and diagnostic sink. Choosing a child model or fallback does not switch to global credentials.

The child working directory resolves in this order:

1. Explicit child `cwd`.
2. A supplied child `sessionManager.getCwd()`.
3. The invoking session's directory.

Relative paths resolve from the invoking session without changing the process working directory.

Omitted or `undefined` child options retain inherited configuration, including individual builtin flags and host bindings. Use `humanInput: null` to withdraw input explicitly; empty arrays and other explicit values keep their normal meanings, subject to the parent's capability ceiling.

Child tool selections can narrow the parent's selection, not expand it. Disabled builtin packages, excluded tools, empty allowlists and `noTools: "all"` remain suppressed in children and fallback attempts. Enable a needed capability on the parent before launching a child. Workflow stages and subagents still exclude recursive workflow tooling; subagents retain the single-level delegation limit.

Callbacks may be shared, but request and diagnostic `sessionId` values identify the originating child. Workflow questions also carry their run/stage identity. Group overrides retain the normal Intercom authorization rules. Disabling or excluding Intercom does not create a substitute supervisor grant. Reopening conversation history does not restore child authority.

An explicit child `extensionBindings.humanInput` overrides the inherited host, including for durable stage questionnaires. Setting it to `null` leaves those questions pending; rebinding the parent cannot answer on that child's behalf. Rebind the child to an authorized adapter to continue. Without a child override, pending stage questions follow parent host withdrawal and reattachment.

You may reuse the same adapter object when explicitly rebinding a child, even after the parent switches hosts. That child selection survives reload. An empty binding object does not select a new host or restore inheritance.

The inherited `isFallbackModelAllowed` predicate also applies when a workflow replaces its stage session to try a fallback. A rejected candidate is not executed. This predicate restricts fallback choices, not an explicitly selected primary model.

### AgentSession

The session manages agent lifecycle, message history, model state, compaction, and event streaming.

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue messages during streaming
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // Controlled queue-pause gate
  readonly queuedMessagesPaused: boolean;
  pauseQueuedMessages(): void;
  resumeQueuedMessages(): Promise<boolean>;

  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Model and thinking control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // State access
  agent: Agent;
  sessionManager: SessionManager;
  refreshContext(): void;
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
  dispose(): Promise<void>;
}
```

Always `await session.dispose()` in `finally`. Disposal immediately refuses new work, cancels and drains owned operations, settles questions, shuts down extensions and releases session leases. Repeated calls await the same outcome.

A `ShutdownFailed` error contains component failures in `errors`; cleanup still attempts the remaining components. Caller-supplied managers and model runtimes remain borrowed, and other sessions remain usable. Use `abort()` to cancel current work without destroying the session.

Captured extension APIs also refuse new execution, mutations and registrations as soon as close or reload begins. Already-admitted `pi.exec()` calls remain part of the awaited drain; provide `signal` or `timeout` when invoking subprocesses that might not finish on their own. `abort()` alone does not retire the API. A rejected transactional reload restores the surviving generation's action admission.

#### Finishing admitted work

Disposal and reload wait for admitted callbacks, resource refreshes, and subprocesses. Ensure callbacks can settle independently of disposal, including work started by cleanup handlers. Give `pi.exec()` calls a timeout or cancellation signal, and await them in the handler so you can inspect failures. Never make cleanup wait for disposal itself.

Register cleanup before acquiring resources or starting asynchronous callbacks. Call the unsubscribe returned by `pi.events.on()` or a workflow publisher's `dispose()` when you no longer need it; both are idempotent. Generation cleanup releases remaining handles and reports failures.

#### Reload failures and resource ownership

Strict transactional reload failure leaves the original generation usable. Ordinary reload failure does not restore the retired generation. Both attempt cleanup of newly acquired resources and report cleanup failures through `ShutdownFailed` without hiding the original error.

Prefer acquiring extension resources in `session_start`. If a factory acquires them earlier, register `session_shutdown` immediately, even if `extensionsOverride` may later omit that factory. Capture cleanup handles when acquiring resources rather than rereading loader getters during cleanup.

Do not cache dialog functions across reload attempts. Retiring functions refuse new questions; after a rejected transaction, use the surviving session's current `ctx.ui`.

Shared loaders, event buses, settings, and `SessionManager` instances do not share live task ownership. Closing one session leaves another session's commands and borrowed discovery resources alone.

#### Session replacement and deferred cleanup

`await runtime.dispose()` refuses new replacements and waits for pending factories, startup, and cleanup. No successor is published after closure. Host callbacks must settle independently of disposal.

An extension command may await `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, or `session.reload()`. Its old generation remains owned until the command continuation finishes, and final disposal waits for that cleanup. Do not await disposal inside the continuation it must drain. Concurrent replacements are supported, and deferred cleanup failures remain visible.

After replacement or self-reload, use the new generation's APIs. Captured old `pi` and `ctx` actions cannot mutate the successor or acquire its resources. Old shutdown handlers may release captured resources, but cannot authorize successor work.

For replacement initiated outside the retiring session's work, outgoing shutdown finishes before successor creation. If it fails, replacement rejects without creating a successor. Handle creation, reload, replacement, and disposal failures rather than continuing as though cleanup succeeded.

#### Settings failures and operation IDs

Settings writes made through session APIs (for example, `setThinkingLevel(level, { persist: true })`) are attributed to that session. Unrecovered write failures make disposal reject with `ShutdownFailed`, even though the normal `SettingsManager.flush()` resolves and exposes errors through `drainErrors()`. Disposal does not consume that caller-owned error channel or attribute another borrower's writes to an idle sibling. Correct the storage fault and persist again before closing to recover.

Caller-supplied `executeBash()` IDs remain correlation IDs, not unique operation IDs. `abortBash(id)` cancels every active call with that exact ID; disposal cancels every owned call, including duplicates.

#### Compaction and tree navigation

`compact()` removes selected older transcript lines without asking the model to rewrite retained text. It appends a durable `compaction` entry with `details.strategy: "verbatim-lines"` and respects the configured recent-message count. See [Compaction](/compaction) for controls and [Session format](/session-format#compactionentry) for persisted fields.

`session.navigateTree()` rejects during streaming, compaction, or branch summarization rather than queueing the navigation. The active branch stays unchanged. Wait for the operation to finish before retrying.

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
  preflightResult?: (success: boolean, disposition?: "handled" | "queued" | "started") => void;
}
```

`preflightResult` is called once per `prompt()` invocation:

- `true` when the prompt was accepted, queued, or handled immediately. The second argument says which: `"handled"` if an extension command or input handler consumed it, `"queued"` if it was queued during a run, or `"started"` if it started a run
- `false` when prompt preflight rejected before acceptance

It fires before `prompt()` resolves. `prompt()` still resolves only after the full accepted run finishes, including retries. Failures after acceptance are reported through the normal event and message stream, not through `preflightResult(false)`.

The `prompt()` method handles prompt templates, extension commands, and message sending:

```typescript
// Basic prompt (when not streaming)
await session.prompt("What files are here?");

// With images
await session.prompt("What's in this image?", {
  images: [{ type: "image", data: "...", mimeType: "image/png" }]
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

Both `steer()` and `followUp()` expand file-based prompt templates but error on extension commands (extension commands cannot be queued). They return `"queued"` if the input was queued (including after an extension transformed it), or `"handled"` if an extension consumed it.

`pauseQueuedMessages()` synchronously holds existing raw steering/follow-up entries before an abort boundary. Later context-bearing arrivals also stay queued without starting a provider turn. These include trigger-turn custom messages, batches, interrupts, `sendUserMessage()`, and ordinary `prompt()` calls.

The hold preserves content blocks, optional data, duplicate identities, raw text, message types, and order within each queue kind. Non-trigger custom messages remain history-only and do not start a turn.

`resumeQueuedMessages()` releases the hold exactly once but does **not** start or continue a model turn. Its promise resolves to `true` only when it released raw held steering/follow-up work, or `false` when none existed. The caller must use its explicit resume action, such as interactive chat submission or workflow resume, to drive execution.

`clearQueue()` clears the paused flag when it explicitly removes the final unowned held item. If a protected or interrupt-owned item remains, the gate stays paused.

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

// Model-visible messages are projected from session.sessionManager.
// agent.state.messages is a refreshed inspection cache; do not assign it for restoration.

// Replace tools
session.agent.state.tools = tools; // copies the top-level array

// Wait for agent to finish processing
await session.agent.waitForIdle();
```

Provider requests use `session.sessionManager` as the canonical finalized context. Assigning `session.agent.state.messages` does not replace persisted context and may be overwritten at the next request boundary. Restore externally stored history when constructing the session instead:

```typescript
const restoredManager = SessionManager.inMemory(process.cwd(), { id: sessionId }, entries);
const { session } = await createAgentSession({ sessionManager: restoredManager });
```

For an existing session, use `session.navigateTree(entryId)` to move its active branch. Use `session.sessionManager.appendMessage(...)` plus `session.refreshContext()` only when intentionally appending externally managed entries. A caller-supplied `prepareNextTurnWithContext` replacement context is still honored for exactly the request it prepared.

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
    
    // Session events (queue, compaction, retry)
    case "queue_update":
      console.log(event.steering, event.followUp);
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

To rebuild an assistant message from deltas, accumulate them in your own message object. In-process subscribers receive the provider's live partial in `message_start`, not a snapshot. The provider keeps appending to that object, so appending deltas yourself would duplicate text.

If you subscribe part-way through a turn, seed your object from `session.agent.state.streamingMessage`, if present, to include the deltas you missed.

## Options Reference

Moved to [SDK API reference](/sdk/reference#options-reference).

### Directories

Moved to [SDK API reference](/sdk/reference#directories).

### Model

Moved to [SDK API reference](/sdk/reference#model).

#### Model catalog persistence and refresh

Moved to [SDK API reference](/sdk/reference#model-catalog-persistence-and-refresh).

### API Keys and OAuth

Moved to [SDK API reference](/sdk/reference#api-keys-and-oauth).

### System Prompt

Moved to [SDK API reference](/sdk/reference#system-prompt).

### Tools

Moved to [SDK API reference](/sdk/reference#tools).

#### Bash tool behavior

Moved to [SDK API reference](/sdk/reference#bash-tool-behavior).

#### Waiting for existing shell tasks

Moved to [SDK API reference](/sdk/reference#waiting-for-existing-shell-tasks).

#### PowerShell tool behavior

Moved to [SDK API reference](/sdk/reference#powershell-tool-behavior).

#### Tools with Custom cwd

Moved to [SDK API reference](/sdk/reference#tools-with-custom-cwd).

### Custom Tools

Moved to [SDK API reference](/sdk/reference#custom-tools).

#### Structured output final results

Moved to [SDK API reference](/sdk/reference#structured-output-final-results).

### Extensions

Moved to [SDK API reference](/sdk/reference#extensions).

### Skills

Moved to [SDK API reference](/sdk/reference#skills).

### Context Files

Moved to [SDK API reference](/sdk/reference#context-files).

### Slash Commands

Moved to [SDK API reference](/sdk/reference#slash-commands).

### Session Management

Moved to [SDK API reference](/sdk/reference#session-management).

### Settings Management

Moved to [SDK API reference](/sdk/reference#settings-management).

## ResourceLoader

Moved to [SDK API reference](/sdk/reference#resourceloader).

## Return Value

Moved to [SDK API reference](/sdk/reference#return-value).

## Complete Example

```typescript
import { getModel } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@bastani/atomic";

// Create a runtime with custom credential storage and no models.json.
const authStorage = AuthStorage.create("/custom/agent/auth.json");
const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });

// Runtime API key override (not persisted). setRuntimeApiKey updates auth state;
// the scoped refresh updates that provider's catalog. getAuth, getRequestAuth, and
// stream/complete options also accept `signal`; request-auth setup is cancelled with
// the caller, uses one 15-second preparation bound per request, and does not keep
// waiting after the model stream has opened.
if (process.env.MY_KEY) {
  const providerId = "anthropic";
  const authController = new AbortController();
  await modelRuntime.setRuntimeApiKey(providerId, process.env.MY_KEY, { signal: authController.signal });
  await modelRuntime.refresh({ providers: [providerId], signal: authController.signal });
}

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
  modelRuntime,

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

Moved to [SDK API reference](/sdk/reference#run-modes).

### InteractiveMode

Moved to [SDK API reference](/sdk/reference#interactivemode).

### runPrintMode

Moved to [SDK API reference](/sdk/reference#runprintmode).

### runRpcMode

Moved to [SDK API reference](/sdk/reference#runrpcmode).

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

Moved to [SDK API reference](/sdk/reference#exports).

## Owner-bound task supervisor (S1)

Moved to [SDK API reference](/sdk/reference#owner-bound-task-supervisor-s1).

### Supervised command SDK

Moved to [SDK API reference](/sdk/reference#supervised-command-sdk).

### Task transcript references

Moved to [SDK API reference](/sdk/reference#task-transcript-references).
