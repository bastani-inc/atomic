---
title: "SDK"
description: "Embed Atomic in a Node.js application."
---

# SDK

<a id="on-this-page-and-its-reference" />

Embed Atomic in Node.js apps to build custom UIs, integrate agent sessions into backend services, or drive automated pipelines programmatically. Working examples live in [examples/sdk/](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/sdk).

- **Full options & exports:** [SDK API reference](/sdk/reference) (also covers [Owner-bound task supervisor](/sdk/reference#owner-bound-task-supervisor-s1), [Supervised command SDK](/sdk/reference#supervised-command-sdk), and [Task transcript references](/sdk/reference#task-transcript-references)).
- **SQLite & custom storage adapters:** [SQLite storage API](/storage).
- **Serving over HTTP:** [Embedding Atomic in a web server](/sdk/web-server) (Next.js App Router streaming guide).
- **Choosing an integration mode:** Compare SDK, RPC, and JSON on [Programmatic use](/programmatic).

## Quick Start

Install `@bastani/atomic` (the SDK ships in the main package; pass `--ignore-scripts` if you disable dependency install scripts):

```bash
npm install @bastani/atomic
# or: pnpm add @bastani/atomic
# or: bun add @bastani/atomic
```

Create a session, stream text deltas, and dispose cleanly in `finally`:

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

- **`ModelRuntime`:** Canonical async runtime for credentials, native providers, and dynamic catalogs. Accepts `authPath`, `modelsPath`, `credentials`, runtime auth overrides, and catalog options `allowModelNetwork`, `modelRefreshTimeoutMs`, `modelsStorePath`, and `modelsStore` (see [Model catalog persistence and refresh](/sdk/reference#model-catalog-persistence-and-refresh)). Legacy synchronous facades `ModelRegistry` and `AuthStorage` remain available; `readStoredCredential(provider, authPath?)` reads one stored credential.
- **Exact model restoration:** Call `await resolveRestoredModelReference(provider, modelId, modelRuntime)` to resolve an authenticated saved model (including custom/dynamic IDs) or get `undefined` without falling back to a default.
- **Extensions & context helpers:** Exported root types/helpers include `InlineExtension`, `registerProvider(Provider)`, `registerEntryRenderer`, `entry_appended`, `before_provider_headers`, `agent_settled`, `buildContextEntries`, `sessionEntryToContextMessages`, `CompactionEntry`, and `sessionManager.buildContextEntries()`.

## Installation

For TypeScript ESM Node apps, set `"type": "module"` in `package.json` and `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true` in `tsconfig.json` (typechecks cleanly with `skipLibCheck: false`). Import directly from `@bastani/atomic`:

```typescript
import { createAgentSession, type HostInput } from "@bastani/atomic";
```

### Node 22 hosts

On Node 22, `AsyncLocalStorage` runs on promise hooks. Once a session has run, they stay on for the whole process, and every `await` in your application costs more. Atomic keeps all of its context in one store, so the cost does not grow with the number of sessions. Node 24 and Bun have no such cost.

On Node 22.7 or a later 22.x release, start your host with `node --experimental-async-context-frame` to avoid it. The flag switches `AsyncLocalStorage` to Node 24's implementation for the whole process, so check any code of your own that relies on Node 22's behavior, such as `disable()`. Pass it on the host's own command line, not in `NODE_OPTIONS`: Node 24 and later refuse the flag, and commands your sessions' tools run inherit `NODE_OPTIONS`, so a newer Node among them would fail to start.

### Migrating an existing Node host

<a id="migrating-from-the-experimental-client" />
<a id="experimental-harness-factory" />

- **Builtins are automatic:** Remove manual registration of shipped builtin extensions; disable selectively with `builtins` and restrict tools with `tools` / `excludedTools` (`tools: []` also excludes Intercom).
- **Host input:** Supply all five `HostInput` methods (`confirm`, `select`, `input`, `editor`, `questionnaire`) on `extensionBindings.humanInput`, honoring abort signals and returning literal `true` only on explicit approval (missing adapter rejects with `HumanInputUnavailable`).
- **Removed `workflows` builtin:** Remove `workflows` from `builtins`; workflow SDK exports were removed. Convert older workflow files into skills ([Migrating workflows](/orchestration/migrating-workflows)).
- **Always `await session.dispose()` in `finally`:** Disposal is async and may reject with `ShutdownFailed` after attempting all cleanup; do not swallow it or call `process.exit()`.
- **Diagnostics & packaging:** Route operational events via `extensionBindings.onDiagnostic`. If creation throws `BuiltinUnavailable`, reinstall the full package rather than copying only `dist/index.js`.
- **Removed experimental client:** `@bastani/atomic/client` was removed; use `createAgentSession()` in-process or [RPC mode](/rpc) (`--mode rpc` / `@bastani/atomic/rpc-entry`).

## Core Concepts

### createAgentSession()

Creates a single `AgentSession` with bundled subagents, MCP, web access, and Intercom enabled by default (plus normal user/project/package discovery unless a custom `resourceLoader` is passed).

```typescript
import { createAgentSession, SessionManager } from "@bastani/atomic";

// Defaults with DefaultResourceLoader
const { session } = await createAgentSession();

// Custom selection
const { session: custom } = await createAgentSession({
  model: myModel,
  tools: ["read", "bash"],
  // Or keep defaults and remove specific tools:
  // excludedTools: ["ask_user_question"],
  sessionManager: SessionManager.inMemory(),
});
```

- **Disable builtins or tools:** Pass `builtins: { "web-access": false, intercom: false }` to disable packages. `tools: []` or `noTools: "all"` disables every tool including Intercom; `excludedTools` always wins and survives `/reload`. See [tool precedence](/sdk/reference#tools).
- **Startup hooks & rebinding:** `createAgentSession()` completes extension `session_start` before returning—pass `extensionBindings` here if startup hooks need them. Later `session.bindExtensions(...)` updates bindings without replaying `session_start`.
- **Explicit recovery:** Opening a session never auto-recovers interrupted work. Call `await session.startPendingRecovery("resume")` once ready to display output; returns `{ replayed, dropped, completions, notices }`.

### Workspaces

Bind a session to a Git repository, branch, and worktree with `workspace({ ... })` (requires Git 2.33+):

```typescript
import { createAgentSession, workspace } from "@bastani/atomic";

const api = workspace({ repo: "github.com/acme/product-service", base: "origin/main", branch: "feat/ticket-123" });

const { session, workspace: binding } = await createAgentSession({ workspace: api });
const reviewer = await createAgentSession({ workspace: api.readOnly() });
```

- **Resolution:** Local `repo` must be a repo root; remote repos clone once under `<storageHome>/repos/` ([storage home](/storage#storage-home)) and create worktrees after fetching. Missing branches start at `base`; existing worktrees must match repo and branch (interrupted checkouts re-create automatically). Explicit `cwd` resolves inside the worktree, and a supplied `sessionManager` must already be inside it (`WorkspaceConfigError` otherwise).
- **Read-only (`api.readOnly()`):** Removes and blocks `write`, `edit`, and `todo` (even if listed in `tools`; shell tools still run—not an OS sandbox). Children stay read-only even with their own workspace.
- **Persistence & PRs:** Saved as a `workspace_binding` entry and restored on reopen (call `bindSessionWorkspace(workspace, sessionManager)` beforehand if you need the path early). Inspect commits with `workspaceChangeSet(binding)` and open PRs via `publishPullRequest(changeSet, { draft: true })`. Invalid options throw `WorkspaceConfigError`; binding failures throw `WorkspaceBindingError` (`wrong-branch`, `cwd-outside-worktree`, `git-unavailable`).

### Shared resource admission

Enforce host-wide session and process capacity caps via `resourceAdmission`:

```typescript
import type { ResourceAdmission } from "@bastani/atomic";

const resourceAdmission: ResourceAdmission = {
  async acquire(kind, signal, request) {
    if (request?.delegated) {
      const permit = capacity.tryAcquire(kind);
      if (!permit) throw new Error("No capacity left for a delegated child session");
      return async () => permit.release();
    }
    const permit = await capacity.acquire(kind, { signal });
    return async () => permit.release();
  },
};
const { session } = await createAgentSession({ resourceAdmission });
```

- `kind` is `"session"` or `"process"`. Make `acquire` honor `signal` (`resourceAdmissionSignal` cancels session wait; children inherit the service, not that signal) and make release functions idempotent.
- **Deadlock rule (`request.delegated`):** Parents hold their session permit while children run, so **never queue** `request.delegated` acquisitions—grant immediately or throw, and size your cap above max concurrent parents.
- **Permit lifetime & crash recovery:** Session permits release on clean `dispose()`; managed command permits release after confirmed process cleanup (never recycle on a timer). On Unix, implement `permit.bindProcess({ kind: "unix-process-group", id })` to persist process-group identity for post-crash reconciliation (Windows commands report no identity).
- **Scoping:** Wrap async flows in `withResourceAdmission(service, fn)` (explicit session service wins; `resourceAdmission: null` opts out). Child sessions from `getChildSessionOptions()` and delivered-message turns always use their own/parent service rather than a sender's scope.

### Session storage

Sessions default to `~/.atomic/workflows/journal.sqlite` (`session_` prefix). Override with `sessionStore`, `storage` (same shape as `settings.json` `storage` or `teamProfileSelection()` — see [Team and CI setup](/guides/team-setup#from-the-sdk)), or an explicit `sessionManager`:

```typescript
const { session } = await createAgentSession({
  sessionStore: { kind: "sqlite", path: "./sessions.sqlite", prefix: "project_" },
});
```

- **Selections:** `{ kind: "sqlite", path, prefix? }`, `{ kind: "jsonl", dir }`, `{ kind: "memory" }`, `{ kind: "database", database, prefix? }`, `{ kind: "adapter", module, options?, secrets?, prefix? }`, or a `SessionStore` instance. Legacy `sessionDir` was removed.
- **Precedence:** `sessionManager` → `sessionStore` → `storage` → process env/flags (`ATOMIC_SESSIONS_STORAGE` / `ATOMIC_STORAGE` — see [Selecting storage per process](/storage#selecting-storage-per-process)) → settings (`sessions.storage` → `storage` — see [Session settings](/settings#sessions)) → default SQLite. Memory is never a fallback.
- **Package adapters:** Pass `additionalExtensionPaths: [packageRoot]` on `DefaultResourceLoader` before opening storage to select an embedded package adapter by name ([Adapters from Atomic packages](/storage#adapters-from-atomic-packages)).
- **Ownership & resume:** Atomic closes stores opened from selections during `dispose()` (leaving caller-owned `SessionStore`, `SessionManager`, and `database` instances open). Await every `SessionManager` mutation and `pi.appendEntry`/`setSessionName`/`setLabel`/`setThinkingLevel` (there is no `flush()`; see [Storage errors](/storage#storage-errors)):

```typescript
import { createAgentSession, resolveSessionStore, SessionManager } from "@bastani/atomic";

const store = await resolveSessionStore(process.cwd());
try {
  const manager = await SessionManager.open(store, savedSessionId);
  const { session } = await createAgentSession({ sessionManager: manager });
  try {
    await session.prompt("Continue the task");
  } finally {
    await session.dispose();
  }
} finally {
  await store.close();
}
```

`ExtensionContext.sessionSignal` aborts when reload or shutdown begins so extensions can cancel long waits while still awaiting already-started session writes.

### Human input without a terminal

<a id="binding-and-withdrawing-an-input-adapter" />
<a id="diagnostics-and-provider-state" />

Pass `extensionBindings.humanInput` implementing all five `HostInput` methods (`confirm`, `select`, `input`, `editor`, `questionnaire`; `QuestionParams` and `QuestionnaireResult` are exported):

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

  await session.abort();                            // Cancels active work and pending questions
  await session.bindExtensions({ humanInput: null }); // Withdraws input adapter
  await session.bindExtensions({ humanInput });       // Reattaches callbacks
  return session;
}
```

- **Routing & abort:** Each call receives `{ requestId, sessionId, signal, timeout? }`. Route prompts by `sessionId` (children inherit explicit `humanInput`; see [Session-local task prompts](/sdk/reference#session-local-task-prompts)) and dismiss UI immediately on `signal` abort. Plain RPC clients and SDK hosts that provide only `uiContext` keep receiving child dialogs through that presentation. Setting `mode: "tui"` alone does not enable held task prompts. Abort, reload, and disposal invalidate pending replies, including late successful replies from callbacks that ignore cancellation.
- **Return contracts:** `confirm` returns boolean; `select` returns a supplied option or `undefined`; `input`/`editor` return string or `undefined` (preserving whitespace/empty strings). Malformed replies reject with `InvalidHostInput`; `false`, cancellation, or errors never approve.
- **Omission rules:** Omitting `humanInput` at creation leaves no input (unless `uiContext` supplies dialogs; without either, dialogs reject with `HumanInputUnavailable` and `ask_user_question` returns `{ answers: [], cancelled: true, error: "no_ui" }`). Omitting it on `bindExtensions()` keeps the current adapter; passing `null` withdraws it. `ui.custom` is not part of `HostInput`.
- **Diagnostics & session-local caches:** `onDiagnostic` captures session-attributed notices (does not intercept third-party `console.*`). MCP OAuth PKCE state and web-provider config caches stay per session, while durable MCP tokens persist by server name.

### Stored session summaries

Read `session.sessionSummary` (`summary` and `summarizedThroughId`) or inspect `SessionManager.list()` / `listAll()`. Stored summaries stay readable when `sessionSummary.enabled` is `false`; `SessionManager.inMemory()` never generates summaries.

### Worktree snapshots

SQLite and adapter-backed sessions capture checkout state automatically. Passing a reopened `sessionManager` to `createAgentSession({ sessionManager })` (or `runtime.rehydrate()`) restores missing or drifted checkouts into fresh worktrees while leaving local matching checkouts untouched (rejects with `WorkspaceDriftError` if unrebuildable; missing Git fails fast):

```typescript
import { createAgentSession, SessionManager } from "@bastani/atomic";

const sessionManager = await SessionManager.open(store, sessionId);
const { session } = await createAgentSession({ sessionManager });
```

- By default in the SDK (`resume.waitForBlueprint: "tools"`), `createAgentSession` returns immediately while blueprint setup runs in the background and gates tool calls (`await blueprintBuildSettled(sessionId)` waits explicitly; `onBlueprintBuildFinished(listener)` receives warnings; set `resume.waitForBlueprint: "prompt"` to block startup — [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)).
- Override per-session snapshot settings via `createAgentSession({ snapshots: { enabled: false } })`. Exported helpers: `captureWorktreeSnapshot()`, `restoreWorktreeSnapshot()`, `verifyWorktree()`, `session.sessionManager.getWorktreeRootMappings()`, `latestResumeTimings()`, `formatResumeTimings()`, and `session.exportToJsonl()`. See [Worktree snapshots](/worktree-snapshots).

### Intercom group and reach

Isolate multi-session hosts in one process with broker-enforced `intercom` policies (also accepted by `createAgentSessionFromServices()`):

```typescript
const { session } = await createAgentSession({
  intercom: { group: "doc-1842", reachable: ["doc-1907"] },
});

await session.intercom.setReachable(["doc-1907", "doc-2011"]);
```

- `group` sets the session's home group (beating `ATOMIC_INTERCOM_GROUP`, config, and project groups). `reachable` lists up to 1,000 one-way target groups (targets can reply to asks, not initiate). Subagents with `group: "x"` live under `<group>/x` and never inherit `reachable`.
- `setReachable()` updates live policy on the broker and leaves newly unreachable groups. Calling it on a session created without `intercom`, or passing an empty/reserved group (`auto`) or >1,000 reachable groups, throws `IntercomPolicyError`.

### Subagent children

Children inherit the parent's `ModelRuntime`, settings, `agentDir`, `humanInput`, and diagnostics. Working directory resolves in order: child `workspace` → child `cwd` → child `sessionManager.getCwd()` → parent `cwd`/worktree.

- Child tool lists can only narrow—never expand—parent permissions (`builtins`, `excludedTools`, `tools: []`, `noTools: "all"` stay enforced).
- Pass explicit child `extensionBindings.humanInput` to override (or `null` to withdraw). Shared callbacks distinguish children by `sessionId`.

### AgentSession

Core session handle for prompting, queueing, model switching, events, compaction, and disposal:

```typescript
interface AgentSession {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  readonly queuedMessagesPaused: boolean;
  pauseQueuedMessages(): void;
  resumeQueuedMessages(): Promise<boolean>;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  subscribe(source: EventSource, handler: SessionEventHandler, options?: SessionSubscribeOptions): Subscription;

  sessionFile: string | undefined;
  sessionId: string;
  setModel(model: Model, options?: { persist?: boolean; thinkingLevel?: ThinkingLevel }): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  agent: Agent;
  sessionManager: SessionManager;
  refreshContext(): void;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }>;
  compact(options?: SessionCompactOptions): Promise<VerbatimCompactionResult>;
  abortCompaction(): void;
  abort(options?: { pauseQueuedMessages?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}
```

**Clean stop and disposal:** Always `await session.dispose()` in `finally` (60 s drain limit; rejects with `ShutdownFailed` carrying `errors` if a step stalls). To abort active work before disposing without letting background notices start a new turn, pass `{ pauseQueuedMessages: true }`:

```typescript
try {
  await session.prompt("Refactor the parser");
} finally {
  await session.abort({ pauseQueuedMessages: true });
  await session.dispose();
}
```

- `setModel(model, { thinkingLevel: "high", persist: true })` clamps unsupported thinking levels and optionally saves global defaults (project overrides still win at startup).
- Extension APIs reject new actions once close or reload begins; give `pi.exec()` calls timeouts or abort signals. Custom messages with `persistWhenStreaming: true` survive reload.

#### Event subscriptions

Subscribe a session to external event streams without polluting main context (`maxConcurrent` default `4`, optional `name` and `maxRate`):

```typescript
import { githubReviews } from "@bastani/atomic";

const subscription = session.subscribe(
  githubReviews({ repo: "acme/api", pr: 42 }),
  async (event, child) => {
    await child.task({ prompt: "Report a review only if it requests changes, with the files it names." });
  },
  { maxConcurrent: 2 },
);
// later: await subscription.close();
```

- `child.task({ prompt, model?, thinkingLevel?, tools?, noTools?, excludedTools? })` runs a short-lived in-process child (`<name>#<n>/<eventId>`) with `report_to_subscriber` (call `child.report()` directly if `noTools: "all"`), returning `{ text, sessionId }`. Disposing the session aborts children (`AbortError`, with cleanup errors in `cleanupCause`); sessions not built via `createAgentSession()` fail with `SubscriptionChildUnavailableError`.
- `child.report(text)` sends an `event_report` custom message (`details: { subscriptionId, eventId, child }`), persisted before returning if streaming.
- Deduplication uses transcript entries (`event_subscription_child`, up to 500 chars); persistence errors reject `subscription.done` with `SubscriptionRecordError`. Pass `subscription.id` to `publishEvent()` to bridge custom webhooks.

#### Finishing admitted work

Disposal and reload drain admitted callbacks, refreshes, and `pi.exec()` subprocesses. Always register cleanup before acquiring resources, pass timeouts/signals to subprocesses, unsubscribe `pi.events.on()` listeners when done, and never await disposal from inside a cleanup handler.

#### Reload failures and resource ownership

- **Transactional vs. ordinary reload:** Failed transactional reloads keep the previous generation usable; failed ordinary reloads do not. Both clean up newly acquired resources and report cleanup errors via `ShutdownFailed`.
- **Lifecycle effects:** Acquire resources in `session_start` (or register `session_shutdown` immediately if acquired earlier). Use `publishExtensionContextEffect(ctx, effect)` (default `"start"` phase after retirement, or synchronous `"commit"` phase before revocation) to publish shared state only on commit, and `registerExtensionContextRetirementEffect(ctx, dispose)` for synchronous pre-revocation cleanup. Never cache `ctx.ui` across reloads.

```typescript
import { publishExtensionContextEffect, type ExtensionFactory } from "@bastani/atomic";

const extension: ExtensionFactory = (pi) => {
  pi.on("session_start", (_event, ctx) =>
    publishExtensionContextEffect(ctx, () => {
      pi.events.emit("example:session-ready", { sessionId: ctx.sessionManager.getSessionId() });
    }),
  );
};
```

#### Session replacement and deferred cleanup

- `await runtime.dispose()` rejects new replacements, drains pending work, waits up to 3 s for in-flight OAuth token refreshes, and cancels/waits for Intercom broker startup. Pass `{ fromSignal: true }` on `SIGTERM`/`SIGHUP` so `session_shutdown` handlers see it.
- Extension commands awaiting `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, or `session.reload()` keep their generation alive until the command finishes; always switch to the new generation's APIs afterward.

<a id="settings-failures-and-operation-ids" />

- Unrecovered `persist: true` settings write failures make `dispose()` reject with `ShutdownFailed`. `executeBash()` IDs are correlation IDs—`abortBash(id)` cancels all active calls with that ID.

#### Compaction and tree navigation

`session.compact({ query?, compactionModel? })` stops active runs, clears context (or summarizes with an exact compactor model like `morph/morph-compactor`), appends a `verbatim-lines` `compaction` entry, and returns `VerbatimCompactionResult` (`form: "cleared" | "compacted"`). Rejects with `Nothing to compact` when nothing new entered context; concurrent calls coalesce. A chat, classifier or unknown `compactionModel` ID clears the context with a notice instead of failing. `compression_ratio` and `preserve_recent` are no longer options; they are ignored if passed. See [Compaction](/compaction) and [Session format](/session-format#compactionentry).

```typescript
const result = await session.compact({ query: "keep the auth decisions" });
console.log(result.form, result.history?.boundaryEntry);
```

`session.navigateTree()` rejects if streaming, compacting, or summarizing a branch (leaving the branch unchanged).

### createAgentSessionRuntime() and AgentSessionRuntime

Use `AgentSessionRuntime` when your host needs session replacement (`newSession()`, `switchSession()`, `fork()`, clone via `fork(entryId, { position: "at" })`, `importFromJsonl()`) with rebuilt cwd-bound services:

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
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: await SessionManager.create(process.cwd()),
});
```

After any replacement, `runtime.session` points to the new instance—re-subscribe to events, re-call `bindExtensions()`, and call `startPendingRecovery("resume")` after `switchSession()`.

### Releasing idle sessions

Free in-memory resources (agent loop, extensions, tools, timers, MCP/Intercom connections) for idle conversations with `session.release()`, and restore on demand with `runtime.rehydrate(sessionId)`:

```typescript
const released = await session.release(); // { sessionId, cwd, sessionFile? }
const live = await runtime.rehydrate(released.sessionId);
await live.prompt("Here is the CI result you were waiting for.");
await live.release();
```

- **Auto-release:** Pass `releaseWhenIdle: { afterMs }` (`0`–`2147483647` ms; invalid throws `AgentReleaseConfigError`) to `createAgentSession()` or `createAgentSessionFromServices()`. Driven by the process-wide `agentWakeDispatcher()` (`handle`, `deliver`, `onUnobservedFailure`, `whenIdle`, `stats()`).
- **Lifecycle:** Emits `session_released` before closing. Rejects with retryable `session-busy` if streaming, compacting, running shells/background tasks, or holding queued messages. `rehydrate()` opens at the current context window (`readHistory()`/`readEntry()` fetch older entries), shares matching-cwd `services`, runs alongside `runtime.session` without replacing it, deduplicates concurrent calls, and closes on `runtime.dispose()`.
- **In-memory store spilling:** Releasing a session in a host-owned `{ kind: "memory" }` store spills history to private owner-only files (`0700`/`0600`) under `<agentDir>/released-history/<host-identity>/<pid>-<start>-<nonce>/` using copy-on-write reflinks when supported, verified by length + incremental FNV-1a checksum (`SessionSpillError` on missing/corrupt files; see [Storage errors](/storage#storage-errors)). Cleaned on exit (and swept on matching-host restart after crashes; worker-only hosts must close stores before `worker.terminate()`). Custom stores can implement `releaseSession(id)`, `readEntryRange(id, query)`, and `readForkWindow(id, entryId)`.

Release and wake errors throw `AgentRehydrateError` (guards `isAgentRehydrateError`, `isAgentReleaseConfigError`, `isRetryableAgentRehydrateError`; cross-process `serializeAgentRehydrateError` / `rehydrateAgentRehydrateError`):

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `AgentReleaseConfigError` | `invalid-release-policy` | Invalid `releaseWhenIdle.afterMs` (must be `0`–`2147483647`). | `source`, `field`, `value` | Fix the option. |
| `AgentRehydrateError` | `session-busy` | `release()` called while active work or queued messages remain (`retryable: true`). | `sessionId`, `activity` | Wait for `agent_settled` or background tasks, then retry. |
| `AgentRehydrateError` | `not-reopenable` | Session uses private `SessionManager.inMemory()`. | `sessionId`, `storage` | Use SQLite, JSONL, or a host-owned `MemorySessionStore`. |
| `AgentRehydrateError` | `session-not-found` | Session missing in this node's storage. | `sessionId`, `storage`, `localOnly` | Verify ID, or join shared storage (`atomic storage join`). |
| `AgentRehydrateError` | `no-wake-handler` | Wake delivered to unregistered namespace. | `wakeKey`, `namespace` | Register handler with `handle()` first. |
| `AgentRehydrateError` | `wake-handler-conflict` | Duplicate handler for namespace. | `namespace` | Dispose existing handler first. |
| `AgentRehydrateError` | `wake-failed` | Wake handler failed (`cause` has detail). | `wakeKey`, `wakes` | Fix cause and redeliver. |
| `AgentRehydrateError` | `release-failed` | Clean close failed during release or runtime dispose (memory still released). | `sessionId`, `storage` | Rehydrate and inspect recent entries before continuing. |

### Prompting and Message Queueing

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean, disposition?: "handled" | "queued" | "started") => void;
}
```

- **Basic vs. streaming prompts:** `prompt()` expands file-based prompt templates and executes extension commands immediately even while streaming. Calling `prompt()` while streaming without `streamingBehavior` throws `AgentSessionBusyError` (`code: "agent_session_busy"`, guard `isAgentSessionBusyError`). Prompts arriving during compaction queue automatically.
- **`preflightResult(success, disposition?)`:** Fires once before `prompt()` settles (`true` with `"handled"`, `"queued"`, or `"started"`; `false` on preflight rejection).
- **`steer()` & `followUp()`:** Queue during streaming (or start a turn immediately if idle with existing messages; stay queued on empty/aborted sessions), return `"queued"` or `"handled"`, expand templates, and reject extension commands.
- **Queue control:** `clearQueue()` returns `{ steering, followUp, typed?, images? }` (`typed` keeps pre-hook raw text so re-submitting does not double-run hooks). `pauseQueuedMessages()` holds queues across an abort boundary; `resumeQueuedMessages()` releases the hold once (returning `true` if held work existed) without starting a turn.

### Agent and AgentState

Access the underlying [`@bastani/atomic-agent-core`](/libraries/agent-core) `Agent` via `session.agent` (`state.messages`, `model`, `thinkingLevel`, `systemPrompt`, `tools`, `streamingMessage`, `errorMessage`, and `waitForIdle()`).

`session.sessionManager` is the source of truth for model context—never assign `session.agent.state.messages` to restore history. Instead, initialize `SessionManager.inMemory(cwd, { id }, entries)` before `createAgentSession()`, use `session.navigateTree()`, or call `session.sessionManager.appendMessage()` + `session.refreshContext()`.

<a id="events" />
<a id="collecting-assistant-output" />

### Events & Transcript Collection

Subscribe with `session.subscribe((event) => ...)` for `message_start`/`message_update`/`message_end`, `tool_execution_start`/`update`/`end`, `agent_start`/`end`, `turn_start`/`end`, `queue_update`, `compaction_start`/`end`, and retry events. Do not mutate or append deltas onto `message_start`'s live partial object (it updates in place; seed mid-turn subscribers from `session.agent.state.streamingMessage`).

Use `createTranscript()` to collect ordered JSON-serializable parts (`text`, `thinking`, `toolCall` with `result`) automatically (pass `toolResult: (name) => "details" | "content"` to choose structured details over text). Redacted thinking is left out. A `toolCall` part's `result` appears once the tool reports progress or finishes; it holds `isError` and `isPartial`, which stays `true` until the tool finishes. If the message is aborted or fails, tool calls without a final result get an error result carrying the error message. Events from tools called inside other tools (those with `parentToolCallId`) are ignored:

```typescript
import { createTranscript } from "@bastani/atomic";

const transcript = createTranscript();
session.subscribe((event) => transcript.apply(event));

await session.prompt("List the files here");
console.log(JSON.stringify(transcript.parts()));
```

## Complete Example

```typescript
import { getModel } from "@bastani/atomic-ai/compat";
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

const authStorage = AuthStorage.create("/custom/agent/auth.json");
const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });

if (process.env.MY_KEY) {
  const providerId = "anthropic";
  const authController = new AbortController();
  await modelRuntime.setRuntimeApiKey(providerId, process.env.MY_KEY, { signal: authController.signal });
  await modelRuntime.refresh({ providers: [providerId], signal: authController.signal });
}

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

try {
  await session.prompt("Get status and list files.");
} finally {
  await session.dispose();
}
```

## RPC Mode Alternative

For non-Node languages or process isolation, run `atomic --mode rpc --no-session` over stdin/stdout instead of embedding the SDK. See [RPC](/rpc).

<a id="options-reference" />
<a id="directories" />
<a id="model" />
<a id="model-catalog-persistence-and-refresh" />
<a id="api-keys-and-oauth" />
<a id="system-prompt" />
<a id="tools" />
<a id="bash-tool-behavior" />
<a id="waiting-for-existing-shell-tasks" />
<a id="powershell-tool-behavior" />
<a id="tools-with-custom-cwd" />
<a id="custom-tools" />
<a id="structured-output-final-results" />
<a id="extensions" />
<a id="skills" />
<a id="context-files" />
<a id="slash-commands" />
<a id="session-management" />
<a id="settings-management" />
<a id="resourceloader" />
<a id="return-value" />
<a id="run-modes" />
<a id="interactivemode" />
<a id="runprintmode" />
<a id="runrpcmode" />
<a id="exports" />
<a id="owner-bound-task-supervisor-s1" />
<a id="supervised-command-sdk" />
<a id="task-transcript-references" />

## API Reference

All factory options, resource loaders, return types, run modes (`InteractiveMode`, `runPrintMode`, `runRpcMode`), exports, and supervised-task APIs are documented in the [SDK API reference](/sdk/reference).
