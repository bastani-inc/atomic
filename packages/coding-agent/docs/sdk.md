---
title: "TypeScript SDK"
sidebarTitle: "SDK"
description: "Embed Atomic agent sessions in Node.js applications with programmatic control over models, tools, storage, and human input."
---

Embed Atomic in Node.js applications (Node.js 24.20 or newer) to build custom UIs, power backend services, or drive automated workflows directly inside your Node.js process. Working examples live in [examples/sdk/](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/sdk).

- **Full options and exports:** [SDK API reference](/sdk/reference) (includes [Owner-bound task supervisor](/sdk/reference#owner-bound-task-supervisor), [Supervised command SDK](/sdk/reference#supervised-command-sdk), and [Task transcript references](/sdk/reference#task-transcript-references)).
- **Typed decisions:** [Structured decisions API](/sdk/structured-decisions).
- **Session storage:** [SDK storage guide](/sdk/storage) and [Storage backends](/storage).
- **HTTP streaming servers:** [Embed Atomic in a web server](/sdk/web-server) (Next.js App Router guide).
- **Compare modes:** [Programmatic integration](/programmatic).

## Quick start

Install `@bastani/atomic` (the SDK ships in the main package; install scripts are not required):

```bash
npm install @bastani/atomic
# or: pnpm add @bastani/atomic
# or: bun add @bastani/atomic
```

For TypeScript ESM projects, set `"type": "module"` in `package.json` and `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true` in `tsconfig.json`.

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

- **`ModelRuntime`:** Async runtime for credentials, native providers, and dynamic catalogs. Accepts `authPath`, `modelsPath`, `credentials`, runtime auth overrides, and catalog options (`allowModelNetwork`, `modelRefreshTimeoutMs`, `modelsStorePath`, `modelsStore`; see [Model catalog persistence and refresh](/sdk/reference#model-catalog-persistence-and-refresh)). Legacy synchronous facades `ModelRegistry` and `AuthStorage` remain available, and `readStoredCredential(provider, authPath?)` reads one stored credential.
- **Exact model restoration:** Call `await resolveRestoredModelReference(provider, modelId, modelRuntime)` to resolve an authenticated saved model (including custom or dynamic IDs) or receive `undefined` without falling back to a default.
- **Context helpers:** Root exports include `InlineExtension`, `buildContextEntries`, `sessionEntryToContextMessages`, `CompactionEntry`, and `sessionManager.buildContextEntries()`.

### Sharing Atomic's TypeBox registry {#sharing-atomics-typebox-registry}

Atomic ships its own TypeBox instance. If your app imports `typebox` directly, custom formats, settings, or locales will not reach Atomic's tool validation. Import from `@bastani/atomic/typebox` and its subpaths instead:

- `@bastani/atomic/typebox`
- `@bastani/atomic/typebox/compile`
- `@bastani/atomic/typebox/error`
- `@bastani/atomic/typebox/format`
- `@bastani/atomic/typebox/guard`
- `@bastani/atomic/typebox/schema`
- `@bastani/atomic/typebox/system`
- `@bastani/atomic/typebox/type`
- `@bastani/atomic/typebox/value`

## Core concepts

### Creating a session

`createAgentSession()` creates an `AgentSession` with bundled subagents, MCP, web access, and Intercom enabled by default, plus standard user, project, and package discovery unless you pass a custom `resourceLoader`.

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

- **Disable builtins or tools:** Pass `builtins: { "web-access": false, intercom: false }` to disable bundled packages. `tools: []` or `noTools: "all"` disables every tool including Intercom. `excludedTools` always wins and survives `/reload`. See [Tools](/sdk/reference#tools) for wildcard matching and MCP retention rules.
- **Startup hooks and rebinding:** `createAgentSession()` runs extension `session_start` hooks before resolving. Pass `extensionBindings` here if startup hooks need them; later `session.bindExtensions(...)` calls update bindings without replaying `session_start`.
- **Explicit recovery:** Opening a session never recovers interrupted work automatically. Call `await session.startPendingRecovery("resume")` once ready to display output; it returns `{ replayed, dropped, completions, notices }`.

### Workspaces

Bind a session to a Git repository, branch, and worktree with `workspace({ ... })` (requires Git 2.33+):

```typescript
import { createAgentSession, workspace } from "@bastani/atomic";

const api = workspace({ repo: "github.com/acme/product-service", base: "origin/main", branch: "feat/ticket-123" });

const { session, workspace: binding } = await createAgentSession({ workspace: api });
const reviewer = await createAgentSession({ workspace: api.readOnly() });
```

- **Resolution:** Local `repo` must point to a repository root. Remote repositories clone once under `<storageHome>/repos/` ([storage home](/storage#storage-home)) and create worktrees after fetching. Missing branches start from `base`; existing worktrees must match repository and branch (interrupted checkouts re-create automatically). Explicit `cwd` must stay inside the worktree, and an explicit `sessionManager` must already point inside it (`WorkspaceConfigError` otherwise).
- **Read-only (`api.readOnly()`):** Removes and blocks `write`, `edit`, and `todo` even if listed in `tools`. Shell tools still run because read-only workspaces are not an OS sandbox. Child sessions stay read-only even with their own workspace.
- **Persistence and PRs:** Bindings persist as a `workspace_binding` entry and restore on reopen (call `bindSessionWorkspace(workspace, sessionManager, signal?)` beforehand if you need the resolved path early). Inspect commits with `workspaceChangeSet(binding)` and open pull requests via `publishPullRequest(changeSet, { draft: true })`.
- **Errors:** Invalid options throw `WorkspaceConfigError`. Binding failures throw `WorkspaceBindingError` with one of these `code` values: `wrong-repository`, `wrong-branch`, `conflicting-worktree-input`, `invalid-repository`, `unknown-base`, `cwd-outside-worktree`, `git-unavailable`, `git-failed`, `filesystem-failed`, `drift`, `writer-conflict`, or `incomplete-worktree`.

### Shared resource admission

Enforce host-wide session and process capacity caps with `resourceAdmission`:

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

- `kind` is `"session"` or `"process"`. Honor `signal` inside `acquire()` (`resourceAdmissionSignal` cancels session wait; children inherit the service, not that signal) and keep release callbacks idempotent.
- **Deadlock rule (`request.delegated`):** Parent sessions hold their session permit while children run, so never queue `request.delegated` acquisitions. Grant immediately or throw, and size capacity above your maximum concurrent parents.
- **Permit lifetime and crash recovery:** Session permits release on clean `dispose()`; managed command permits release after confirmed process cleanup. On Unix, implement `permit.bindProcess({ kind: "unix-process-group", id })` to record process-group IDs for crash reconciliation (Windows reports no process-group identity).
- **Scoping:** Wrap async flows with `withResourceAdmission(service, fn)` (explicit session service wins; `resourceAdmission: null` opts out). Child sessions always use their own or parent service rather than a sender's scope.

### Session storage

Sessions default to local SQLite at `~/.atomic/workflows/journal.sqlite` with the `session_` table prefix. Override storage per session with `sessionStore`, `storage`, or an explicit `sessionManager`. Read the **[SDK storage guide](/sdk/storage)** for complete recipes across all five backends, `createAgentSessionRuntime()` wiring, `SessionManager` CRUD, `JsonlSessionStore` `exactDirectory` behavior, `npm install` vs `atomic install` adapter resolution, ownership and close rules, and `StorageError` handling.

| Backend | Package | How to pass it to `createAgentSession()` |
| --- | --- | --- |
| Local SQLite (default) | Built into `@bastani/atomic` (`@bastani/atomic/storage`) | `{ kind: "sqlite", path, prefix? }` or caller-owned `openNodeSqliteDatabase()` and `SqlSessionStore.open()` |
| JSONL directory | Built into `@bastani/atomic` | `{ kind: "jsonl", dir }` or caller-owned `JsonlSessionStore.open()` |
| In-memory | Built into `@bastani/atomic` | `new MemorySessionStore()` (caller-owned) or `{ kind: "memory" }` (discarded on `dispose()`) |
| libSQL / Turso | [`@bastani/atomic-storage-libsql`](/libraries/storage-libsql) | `{ kind: "adapter", module: LIBSQL_ADAPTER_PACKAGE, ... }` or caller-owned `openLibsqlDatabase()` |
| PostgreSQL (16+ for sessions) | [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) | `{ kind: "adapter", module: POSTGRES_ADAPTER_PACKAGE, ... }` or caller-owned `openPostgresDatabase()` |

Quick local SQLite session. Atomic opens the store and closes it in `dispose()`:

```typescript
import { createAgentSession } from "@bastani/atomic";

const { session } = await createAgentSession({
  sessionStore: { kind: "sqlite", path: "./sessions.sqlite", prefix: "project_" },
});
try {
  await session.prompt("Summarize recent commits");
} finally {
  await session.dispose();
}
```

Quick PostgreSQL session with a caller-owned database pool (`npm install @bastani/atomic-storage-postgres`):

```typescript
import { readFile } from "node:fs/promises";
import { createAgentSession } from "@bastani/atomic";
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

// Pass a username-only URL (embedded passwords reject with credential-in-url).
const pgDb = await openPostgresDatabase({
  url: "postgresql://atomic_runtime@db.example.com:5432/atomic",
  password: async () => (await readFile("/run/secrets/postgres-password", "utf8")).trim(),
});
try {
  const { session } = await createAgentSession({
    sessionStore: { kind: "database", database: pgDb, prefix: "project_" },
  });
  try {
    await session.prompt("Summarize recent commits");
  } finally {
    await session.dispose();
  }
} finally {
  await pgDb.close();
}
```

- **`sessionStore` vs. `storage`:** `sessionStore` accepts a `SessionStore` instance (`SqlSessionStore`, `JsonlSessionStore`, `MemorySessionStore`) or a tagged selection (`{ kind: "sqlite" | "jsonl" | "memory" | "database" | "adapter", ... }`). `storage` uses the `settings.json` shape returned by `teamProfileSelection()` (`{ path, prefix? }`, `{ database, prefix? }`, `{ memory: true }`, or `{ adapter, options?, secrets?, prefix? }`) and does not support JSONL.
- **Precedence:** Atomic resolves storage in order from `sessionManager`, `sessionStore`, `storage`, process flags and variables (`ATOMIC_SESSIONS_STORAGE` and `ATOMIC_STORAGE`), settings (`sessions.storage` before `storage`), and default SQLite. Memory is never an automatic fallback.
- **Ownership and mutations:** Atomic closes stores it opened from selection objects during `dispose()`, while leaving caller-owned `SessionStore`, `SessionManager`, and `database` instances open. Await every `SessionManager` write and every `atomic.appendEntry`, `setSessionName`, `setLabel`, `setThinkingLevel`, and `cycleThinkingLevel` call; there is no `flush()` method. `ExtensionContext.sessionSignal` aborts when reload or shutdown starts so extensions can cancel waits while finishing in-flight writes.

See the **[SDK storage guide](/sdk/storage)** for all five backends, `createAgentSessionRuntime()` wiring, `SessionManager` CRUD, `JsonlSessionStore` `exactDirectory` behavior, `npm install` vs `atomic install` adapter resolution, ownership and close rules, and `StorageError` handling. For CLI session commands, the full `SessionManager` method list, operator setup, and cross-machine resume, see [Sessions](/sessions), [SessionManager API](/session-format#sessionmanager-api), [Storage backends](/storage), and [Resume on any machine](/guides/resume-on-any-machine).

### Human input without a terminal

Pass `extensionBindings.humanInput` implementing all five `HostInput` methods (`confirm`, `select`, `input`, `editor`, `questionnaire`; `QuestionParams` and `QuestionnaireResult` are exported from `@bastani/atomic`):

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

- **Routing and abort:** Every method receives `{ requestId, sessionId, signal, timeout? }`. Route prompts by `sessionId` (child sessions inherit explicit `humanInput`; see [Session-local task prompts](/sdk/reference#session-local-task-prompts)) and dismiss UI immediately when `signal` aborts. Abort, reload, and disposal invalidate pending replies, including late replies from callbacks that ignored `signal`.
- **Return contracts:** `confirm` returns a boolean; `select` returns one of the supplied options or `undefined`; `input` and `editor` return a string or `undefined` (preserving whitespace and empty strings). Malformed replies reject with an `Error` tagged with `code: "InvalidHostInput"`; `false`, cancellation, and errors never approve.
- **Omission rules:** Omitting `humanInput` at creation leaves no input handler (unless `uiContext` supplies dialogs; without either, dialogs reject with an `Error` tagged with `code: "HumanInputUnavailable"` and `ask_user_question` returns `{ answers: [], cancelled: true, error: "no_ui" }`). Omitting `humanInput` on `bindExtensions()` keeps the current adapter; passing `null` withdraws it. `ui.custom` is not part of `HostInput`.
- **Diagnostics and session-local caches:** `onDiagnostic` receives session-attributed notices (it does not intercept `console.*`). MCP OAuth PKCE state and web-provider config caches remain session-local, while durable MCP tokens persist by server name.

### Stored session summaries

Read `session.sessionSummary` (`summary` and `summarizedThroughId`) or inspect `SessionManager.list()` / `listAll()`. Stored summaries remain readable when `sessionSummary.enabled` is `false`; `SessionManager.inMemory()` never generates summaries.

### Worktree snapshots

SQLite and adapter-backed sessions capture checkout state automatically. Passing a reopened `sessionManager` to `createAgentSession({ sessionManager })` (or `runtime.rehydrate()`) restores missing or drifted checkouts into fresh worktrees while leaving matching local checkouts untouched. If a checkout cannot be rebuilt or Git is unavailable, resume continues with a warning notice instead of failing fast:

```typescript
import { createAgentSession, SessionManager } from "@bastani/atomic";

const sessionManager = await SessionManager.open(store, savedSessionId);
const { session } = await createAgentSession({ sessionManager });
```

- By default in the SDK (`resume.waitForBlueprint: "tools"`), `createAgentSession()` returns immediately while blueprint setup runs in the background and gates tool calls. Call `await blueprintBuildSettled(sessionId)` to wait explicitly, register `onBlueprintBuildFinished(listener)` for warnings, or set `resume.waitForBlueprint: "prompt"` to block startup (see [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)).
- Override per-session snapshot settings with `createAgentSession({ snapshots: { enabled: false } })`. Exported helpers include `captureWorktreeSnapshot()`, `restoreWorktreeSnapshot()`, `verifyWorktree()`, `session.sessionManager.getWorktreeRootMappings()`, `latestResumeTimings()`, `formatResumeTimings()`, and `session.exportToJsonl()`. See [Worktree snapshots](/worktree-snapshots).

### Intercom group and reach

Isolate multi-session hosts in one process with broker-enforced `intercom` policies (also accepted by `createAgentSessionFromServices()`):

```typescript
const { session } = await createAgentSession({
  intercom: { group: "doc-1842", reachable: ["doc-1907"] },
});

await session.intercom.setReachable(["doc-1907", "doc-2011"]);
```

- `group` sets the session's home group (beating `ATOMIC_INTERCOM_GROUP`, config, and project groups). `reachable` lists up to 1,000 one-way target groups (targets may reply to asks, not initiate messages). Subagents with `group: "x"` live under `<group>/x` and never inherit `reachable`.
- Group names are trimmed of surrounding whitespace, cannot be empty, cannot exceed 1,024 characters, and cannot be the reserved names `"auto"` or `"true"` (case-insensitively). Duplicates and self-references in `reachable` are removed automatically.
- `setReachable()` updates live policy on the broker and leaves newly unreachable groups. Calling it on a session created without `intercom`, or passing an invalid group name or more than 1,000 reachable groups, throws `IntercomPolicyError` (which extends `TypeError`).

### Subagent children

Children inherit the parent's `ModelRuntime`, settings, `agentDir`, `scopedModels`, `fallbackModels`, `customTools`, `resourceAdmission`, `humanInput`, and diagnostics. Working directory resolves in order: child `workspace`, child `cwd`, child `sessionManager.getCwd()`, then parent `cwd` or worktree.

- Child tool lists can only narrow parent permissions, never expand them (`builtins`, `excludedTools`, `tools: []`, and `noTools: "all"` stay enforced).
- Pass explicit child `extensionBindings.humanInput` to override (or `null` to withdraw). Shared callbacks distinguish children by `sessionId`.

### Driving a session

`AgentSession` is the handle for prompting, queueing, model switching, events, compaction, and disposal:

```typescript
interface AgentSession {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(
    text: string,
    images?: ImageContent[],
    options?: Pick<PromptOptions, "source" | "expandPromptTemplates">,
  ): Promise<"handled" | "queued">;
  followUp(
    text: string,
    images?: ImageContent[],
    options?: Pick<PromptOptions, "source" | "expandPromptTemplates">,
  ): Promise<"handled" | "queued">;
  readonly queuedMessagesPaused: boolean;
  pauseQueuedMessages(): void;
  resumeQueuedMessages(): Promise<boolean>;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  subscribe(source: EventSource, handler: SessionEventHandler, options?: SessionSubscribeOptions): Subscription;

  sessionFile: string | undefined;
  sessionId: string;
  setModel(model: Model<Api>, options?: { persist?: boolean; thinkingLevel?: ThinkingLevel }): Promise<void>;
  setThinkingLevel(level: ThinkingLevel, options?: { persist?: boolean }): Promise<void>;
  cycleModel(direction?: "forward" | "backward", options?: { persist?: boolean }): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(options?: { persist?: boolean }): Promise<ThinkingLevel | undefined>;
  setCompactionModel(model: string, scope?: "global" | "project", options?: { persist?: boolean }): void;
  setDecisionModel(model: string, scope?: "global" | "project", options?: { persist?: boolean }): void;

  agent: Agent;
  sessionManager: SessionManager;
  refreshContext(): void;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  navigateTree(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
  ): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }>;
  compact(options?: SessionCompactOptions): Promise<VerbatimCompactionResult>;
  abortCompaction(): void;
  abort(options?: { pauseQueuedMessages?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}
```

**Clean stop and disposal:** Always `await session.dispose()` in `finally` (60 s drain limit). If any cleanup step fails or stalls, `dispose()` rejects with an `AggregateError` tagged with `code: "ShutdownFailed"` (inspect `error.errors` for the individual causes). Pass `{ pauseQueuedMessages: true }` when aborting before disposal so arriving background notices do not launch another turn:

```typescript
try {
  await session.prompt("Refactor the parser");
} finally {
  await session.abort({ pauseQueuedMessages: true });
  await session.dispose();
}
```

- `setModel(model, { thinkingLevel: "high", persist: true })` clamps unsupported thinking levels and optionally writes global defaults (project overrides still win at startup).
- `setCompactionModel(model, scope?, options?)` and `setDecisionModel(model, scope?, options?)` update the active session's compaction or decision model immediately without restarting or reloading. They save to `"global"` (default) or `"project"` settings unless `{ persist: false }` is passed. Pass `""` or `"auto"` for automatic selection, or an exact `provider/model` ID. Invalid values throw `CompactionConfigError` or `DecisionConfigError` synchronously. See [Compaction](/compaction) and [Structured decisions API](/sdk/structured-decisions).
- Extension APIs reject new actions with an `Error` tagged with `code: "SessionClosed"` once close or reload starts. Give `atomic.exec()` calls timeouts or abort signals. Custom messages with `persistWhenStreaming: true` survive reload.

#### Event subscriptions

Subscribe a session to external event streams without cluttering main context (`maxConcurrent` default `4`, optional `name` and `maxRate`):

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

- `child.task({ prompt, model?, thinkingLevel?, tools?, noTools?, excludedTools? })` runs a short-lived child session (`<name>#<n>/<eventId>`) equipped with `report_to_subscriber` (call `child.report()` directly if `noTools: "all"`), returning `{ text, sessionId }`. Disposing the parent aborts children (`AbortError`, with cleanup errors in `cleanupCause`); sessions not created by `createAgentSession()` fail with `SubscriptionChildUnavailableError`.
- `child.report(text)` sends an `event_report` custom message (`details: { subscriptionId, eventId, child }`), persisted before returning if streaming.
- Deduplication records processed event IDs in `event_subscription_processed` entries, and finished child answers are stored in `event_subscription_child` entries (up to 500 chars). Persistence failures reject `subscription.done` with `SubscriptionRecordError`. Pass `subscription.id` to `publishEvent()` to bridge custom webhooks.

#### Draining work on reload and shutdown {#finishing-admitted-work}

Disposal and reload drain admitted callbacks, model refreshes, and `atomic.exec()` subprocesses. Register cleanup before acquiring resources, pass timeouts or abort signals to subprocesses, unsubscribe `atomic.events.on()` listeners when finished, and never await disposal from inside a cleanup handler.

- `await runtime.dispose()` rejects new replacements, drains pending work, waits up to 3 s for in-flight OAuth token refreshes, and stops Intercom broker startup. Pass `{ fromSignal: true }` on `SIGTERM` or `SIGHUP` so `session_shutdown` handlers receive the signal flag.
- Unrecovered `persist: true` settings write failures cause `dispose()` to reject with `AggregateError` (`code: "ShutdownFailed"`). `executeBash()` IDs are correlation IDs: `abortBash(id)` cancels all active calls sharing that ID.
- For transactional reload lifecycle effects (`publishExtensionContextEffect`, `registerExtensionContextRetirementEffect`), see [Reload lifecycle and resource ownership](/sdk/reference#reload-lifecycle-and-resource-ownership).

#### Compaction and tree navigation

`session.compact({ query?, compactionModel? })` stops active runs, clears context or replaces it with output from a configured compactor model such as `morph/morph-compactor`, appends a `verbatim-lines` `compaction` entry, and returns `VerbatimCompactionResult` (`form: "cleared" | "compacted"`). It rejects with `CompactionStateError` (`code: "nothing-to-compact"`) when nothing new has entered context since the last boundary; concurrent calls coalesce. Call `session.setCompactionModel(model, scope?, options?)` to change the configured compactor live. A chat, classifier, or unknown `compactionModel` ID clears the context with a notice instead of failing. See [Compaction errors](/compaction/reference#compaction-errors), [Compaction](/compaction), and [Session format](/session-format#compactionentry).

```typescript
const result = await session.compact({ query: "keep the auth decisions" });
console.log(result.form, result.history?.boundaryEntry);
```

`session.navigateTree()` rejects if the session is currently streaming, compacting, or summarizing a branch, leaving the active branch unchanged.

### Replacing and rehydrating sessions

Use `createAgentSessionRuntime()` and `AgentSessionRuntime` when your host needs session replacement (`newSession()`, `switchSession()`, `fork()`, clone via `fork(entryId, { position: "at" })`, `importFromJsonl()`) with rebuilt working-directory services:

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

After any replacement, `runtime.session` points to the new session. Re-subscribe to events, call `bindExtensions()` again, and call `startPendingRecovery("resume")` after `switchSession()`.

### Releasing idle sessions

Free in-memory resources (agent loop, extensions, tools, timers, MCP and Intercom connections) for idle conversations with `session.release()`, and restore them on demand with `runtime.rehydrate(sessionId)`:

```typescript
const released = await session.release(); // { sessionId, cwd, sessionFile? }
const live = await runtime.rehydrate(released.sessionId);
await live.prompt("Here is the CI result you were waiting for.");
await live.release();
```

- **Auto-release:** Pass `releaseWhenIdle: { afterMs }` (`0` to `2,147,483,647` ms; invalid values throw `AgentReleaseConfigError`) to `createAgentSession()` or `createAgentSessionFromServices()`. If the session is still busy when the timer fires, Atomic reschedules for another `afterMs` instead of failing. Managed by the process-wide `agentWakeDispatcher()` (`handle`, `deliver`, `onUnobservedFailure`, `whenIdle`, `stats()`).
- **Lifecycle:** Emits `session_released` before closing. Rejects with retryable `session-busy` if streaming, compacting, running shells or background tasks, or holding queued messages. `rehydrate()` opens at the current context window (`readHistory()` and `readEntry()` fetch older entries), shares matching-cwd `services`, runs alongside `runtime.session` without replacing it, deduplicates concurrent calls, and closes on `runtime.dispose()`.
- **In-memory store spilling:** A directly constructed `new MemorySessionStore()` has no spill directory and keeps released session history in RAM. Opening a memory store through `resolveSessionStore(cwd, { agentDir, sessionStore: { kind: "memory" } })` enables disk spilling to private owner-only files (`0700`/`0600`) under `<agentDir>/released-history/` with integrity verification (`SessionSpillError` on missing or corrupt files; see [Storage errors](/storage#storage-errors)). Spill files clean up on exit and sweep on restart after crashes; worker-only hosts must close stores before `worker.terminate()`. Custom stores can implement `releaseSession(id)`, `readEntryRange(id, query)`, and `readForkWindow(id, entryId)`.

Release and wake errors throw `AgentRehydrateError` (guards `isAgentRehydrateError`, `isAgentReleaseConfigError`, `isRetryableAgentRehydrateError`; cross-process `serializeAgentRehydrateError` and `rehydrateAgentRehydrateError`):

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `AgentReleaseConfigError` | `invalid-release-policy` | Invalid `releaseWhenIdle.afterMs` (must be `0` to `2,147,483,647`). | `source`, `field`, `value` | Fix the option. |
| `AgentRehydrateError` | `session-busy` | `release()` called while active work or queued messages remain (`retryable: true`). | `sessionId`, `activity` | Wait for `agent_settled` or background tasks, then retry. |
| `AgentRehydrateError` | `not-reopenable` | Session uses private `SessionManager.inMemory()` or a session-owned memory store. | `sessionId`, `storage` | Use SQLite, JSONL, or a caller-owned `MemorySessionStore`. |
| `AgentRehydrateError` | `session-not-found` | Session missing in this node's storage. | `sessionId`, `storage`, `localOnly` | Verify ID, or join shared storage (`atomic storage join`). |
| `AgentRehydrateError` | `no-wake-handler` | Wake delivered to unregistered namespace. | `wakeKey`, `namespace` | Register handler with `handle()` first. |
| `AgentRehydrateError` | `wake-handler-conflict` | Duplicate handler for namespace. | `namespace` | Dispose existing handler first. |
| `AgentRehydrateError` | `wake-failed` | Wake handler failed (`cause` has detail). | `wakeKey`, `wakes` | Fix cause and redeliver. |
| `AgentRehydrateError` | `release-failed` | Clean close failed during release or runtime dispose (memory still released). | `sessionId`, `storage` | Rehydrate and inspect recent entries before continuing. |

### Prompting and message queueing

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  startTurnOnly?: boolean;
  source?: InputSource;
  preflightResult?: (success: boolean, disposition?: "handled" | "queued" | "started") => void;
}
```

- **Basic vs. streaming prompts:** `prompt()` expands file-based prompt templates and runs extension commands immediately even while streaming. Calling `prompt()` while streaming without `streamingBehavior` throws `AgentSessionBusyError` (`code: "agent_session_busy"`, guard `isAgentSessionBusyError`). Prompts arriving during compaction queue automatically.
- **`startTurnOnly`:** When `true`, `prompt()` starts a turn only if the session is idle and queued messages are not paused. Otherwise it sends and queues nothing, calls `preflightResult(true, "handled")`, and resolves with `undefined`.
- **`preflightResult(success, disposition?)`:** Fires once before `prompt()` settles (`true` with `"handled"`, `"queued"`, or `"started"`; `false` on preflight rejection).
- **`steer()` and `followUp()`:** Accept `(text, images?, options?)` and return `Promise<"handled" | "queued">`. They queue during streaming (or start a turn immediately if idle with existing messages; stay queued on empty or aborted sessions), expand templates, and reject extension commands.
- **Queue control:** `clearQueue()` returns `{ steering, followUp, typed?, images? }` (`typed` preserves pre-hook text so re-submitting does not re-run hooks). `pauseQueuedMessages()` holds queues across an abort boundary; `resumeQueuedMessages()` releases the hold once (returning `true` if held work existed) without starting a turn.

### Agent and AgentState

Access the underlying [`@bastani/atomic-agent-core`](/libraries/agent-core) `Agent` through `session.agent` (`state.messages`, `model`, `thinkingLevel`, `systemPrompt`, `tools`, `streamingMessage`, `errorMessage`, and `waitForIdle()`).

`session.sessionManager` is the source of truth for model context (see [SessionManager API](/session-format#sessionmanager-api)). Never mutate `session.agent.state.messages` directly to restore history. Instead, pass entries to `SessionManager.inMemory(cwd, { id }, entries)` before `createAgentSession()`, call `session.navigateTree()`, or append via `session.sessionManager.appendMessage()` followed by `session.refreshContext()`.

### Events and transcript collection

Subscribe with `session.subscribe((event) => ...)` for `message_start`/`message_update`/`message_end`, `tool_execution_start`/`update`/`end`, `agent_start`/`end`/`settled`, `turn_start`/`end`, `queue_update`, `compaction_start`/`end`, and retry events. Never mutate `message_start`'s live partial object (seed mid-turn subscribers from `session.agent.state.streamingMessage`).

Use `createTranscript()` to collect ordered JSON-serializable parts (`text`, `thinking`, and `toolCall` with `result`). Pass `toolResult: (name) => "details" | "content"` to prefer structured details over text; redacted thinking is omitted, and nested tool events (`parentToolCallId`) are ignored.

A `toolCall` part receives its `result` (`isError`, `isPartial`) once the tool emits progress or finishes, with `isPartial: true` until completion. If the message fails or aborts, unfinished tool calls receive an error result carrying the error message:

```typescript
import { createTranscript } from "@bastani/atomic";

const transcript = createTranscript();
session.subscribe((event) => transcript.apply(event));

await session.prompt("List the files here");
console.log(JSON.stringify(transcript.parts()));
```

## Complete example

```typescript
import { getModel } from "@bastani/atomic-ai/compat";
import { Type } from "@bastani/atomic/typebox";
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

## Runtime notes and errors

### Error classes vs. `.code`-tagged errors

- **`NativeModuleUnavailableError` is exported from `@bastani/atomic`** (`code: "NativeModuleUnavailable"`). `createAgentSession()` throws it when `@bastani/atomic-natives` cannot load or came from a different Atomic release.
- **`ShutdownFailed`, `HumanInputUnavailable`, `InvalidHostInput`, `BuiltinUnavailable`, and `SessionClosed` are NOT exported classes.** They are standard `Error` (or `AggregateError` for `ShutdownFailed`) instances tagged with string `.code` properties. Check `(error as { code?: string }).code === "HumanInputUnavailable"` (and `error instanceof AggregateError` for `ShutdownFailed`) rather than `instanceof`.

### Updating Atomic while your program runs

When `npm install`, `pnpm add`, or `bun add` replaces `@bastani/atomic` while a Node.js host is running, modules already loaded remain in memory while newly imported modules load from disk.

`createAgentSession()` verifies `@bastani/atomic-natives` before opening a session and throws `NativeModuleUnavailableError` when it cannot load or does not match the running release:

- If the native module was missing on disk, later calls retry once installed.
- If a native module from another release was already loaded, `createAgentSession()` continues throwing `NativeModuleUnavailableError` until the process restarts (updating its message once the matching release is reinstalled).

Also restart after an in-place update if your process launched on an older Atomic release or before importing `@bastani/atomic/rpc-entry`.

### Node 22 hosts

Atomic no longer runs on Node.js 22. It needs Node.js 24.20.0 or newer. To move a host off Node 22:

1. Run `node --version` to see which version you have.
2. Install the current Node.js 24 LTS release from [nodejs.org](https://nodejs.org/en/download), or with `nvm install 24`, `fnm install 24` or `mise use -g node@24`.
3. Reinstall your project's dependencies with the new Node.js, for example with `npm install`.
4. If you started your host with `node --experimental-async-context-frame` to make Node 22 faster, remove the flag. Node 24 doesn't need it and refuses to start with it.

See [Node.js version](/getting-started/installation#nodejs-version) for more on choosing a version.

### Migrating an existing Node host

- **Builtins load automatically:** Remove manual registration of shipped builtin extensions; disable selectively with `builtins` and restrict tools with `tools` / `excludedTools` (`tools: []` excludes Intercom too).
- **Host input:** Supply all five `HostInput` methods (`confirm`, `select`, `input`, `editor`, `questionnaire`) on `extensionBindings.humanInput`, honoring abort signals and returning literal `true` only on explicit approval (omission rejects with `code: "HumanInputUnavailable"`).
- **Removed `workflows` builtin:** Remove `workflows` from `builtins`; workflow SDK exports were removed. Convert older workflow files into skills ([Migrating workflows](/orchestration/migrating-workflows)).
- **Always `await session.dispose()` in `finally`:** Disposal is async and may reject with `AggregateError` (`code: "ShutdownFailed"`) after attempting all cleanup; do not swallow it or call `process.exit()`.
- **Diagnostics and packaging:** Capture operational events via `extensionBindings.onDiagnostic`. If creation fails with `code: "BuiltinUnavailable"`, reinstall the full package rather than copying only `dist/index.js`.
- **Removed experimental client:** `@bastani/atomic/client` was removed; embed `createAgentSession()` directly or drive [RPC mode](/rpc) (`--mode rpc` / `@bastani/atomic/rpc-entry`).

## API reference

All factory options, resource loaders, return types, run modes (`InteractiveMode`, `runPrintMode`, `runRpcMode`), exports, and supervised-task APIs are documented in the [SDK API reference](/sdk/reference).
