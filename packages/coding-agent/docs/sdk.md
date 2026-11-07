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

For the standalone SQLite facade and adapter conformance suite, see [SQLite storage API](/storage).

Not sure the SDK is the right integration mode? Compare it with RPC and JSON mode on [Programmatic use](/programmatic).

To serve an agent over HTTP, see [Embedding Atomic in a web server](/sdk/web-server), which walks through a Next.js App Router route that streams session output to a browser.

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

Use `await resolveRestoredModelReference(provider, modelId, modelRuntime)` to resolve a saved model without selecting a settings default. It returns the authenticated exact model, reconstructs eligible custom or dynamic IDs, or returns `undefined` when restoration is unavailable. Import it from `@bastani/atomic` and check the result before creating a session when restoration must not fall back to another model.

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
- Treat a headless workflow launch as acceptance, not completion. Inspect its run ID/status. After reconnecting, resume that run and bind the new adapter with `session.bindExtensions({ humanInput })`; do not start a second run to answer an outstanding question. Restore journal access before retrying a storage failure.
- Always `await session.dispose()` in `finally`, including on failure. Disposal is asynchronous and can reject with `ShutdownFailed` after attempting all cleanup; do not hide that rejection or call `process.exit()` to force a successful shutdown. Each session owns its own work, even when services are shared.

MCP servers and web providers still require their normal configuration and credentials. Importing the SDK does not connect them or take over standard input. Route host diagnostics through `extensionBindings.onDiagnostic`; a missing provider or extractor is an error, not an empty successful result.

If creation reports `BuiltinUnavailable`, reinstall the complete package and its dependencies rather than copying only `dist/index.js` into your application.

## Migrating from the experimental client

The `@bastani/atomic/client` entrypoint is no longer available because upstream Pi stopped publishing its client and protocol packages. Use `createAgentSession()` from `@bastani/atomic` in-process, or [RPC mode](/rpc) with `--mode rpc` or `@bastani/atomic/rpc-entry`. Pin the previous release if you still need the experimental client. The CLI, RPC mode, extensions and workflows are unaffected.

## Experimental Harness factory

For the current supported integration, start with [createAgentSession()](#createagentsession) and the [SDK API reference](/sdk/reference).

## Core Concepts

### createAgentSession()

The main factory function for a single `AgentSession`.

`createAgentSession()` includes Atomic's shipped workflows, subagents, MCP, web access and Intercom, plus their bundled resources. It uses normal user, project and configured-package discovery when no `resourceLoader` is supplied. A custom loader supplies your resources; the factory adds shipped builtins without changing the loader's options. Services still need their existing configuration and credentials.

Use `builtins: { "web-access": false, intercom: false }` to disable specific shipped packages and their resources. Omitted keys remain enabled, including with `builtins: {}`. Tool selection is separate: `tools: []` and `noTools: "all"` expose no tools, including Intercom; `noTools: "all"` also overrides a nonempty allowlist. `excludedTools` wins over selection. Suppression survives reload. See [tool precedence](/sdk/reference#tools) for `defaultTools` and `noTools: "builtin"`.

Creation finishes extension startup before returning. Pass `extensionBindings` when startup hooks need your host bindings. Later `session.bindExtensions(...)` updates those bindings without replaying `session_start`; reload starts a new extension generation. Missing shipped assets reject with an error whose `code` is `BuiltinUnavailable` and whose message names the package. Reinstall the package rather than continuing with a partially available session.

Opening or binding a session never recovers work an earlier process left unfinished. That work includes restoring background subagents, replaying interrupted deliveries, and showing undelivered background results. Call `await session.startPendingRecovery("resume")` once you are ready to show its output. It runs once per session and resolves with a report: `{ replayed, dropped, completions, notices }`.

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

### Workspaces

Pass `workspace` to bind a session to a repository, branch and worktree. The value comes from `workspace({ … })`, the same one workflows use with `ctx.workflow` and `ctx.task`.

```typescript
import { createAgentSession, workspace } from "@bastani/atomic";

const api = workspace({ repo: "github.com/acme/product-service", base: "origin/main", branch: "feat/ticket-123" });

const { session, workspace: binding } = await createAgentSession({ workspace: api });
const reviewer = await createAgentSession({ workspace: api.readOnly() });
```

- **Resolution:** a local `repo` must be a repository root. A remote is cloned once per host into a shared store under `~/.atomic/repos/` and worktrees are added from it after a fetch, so they start from the remote as it is now. A missing branch is created from `base`. An existing worktree must belong to the repository and be on the branch. A worktree whose checkout was interrupted, for example by a crash, is added again on the next bind. Workspaces need git 2.33 or later. A `sessionManager` passed together with a workspace must already work inside its worktree, since shell commands run in its directory; one elsewhere fails with `WorkspaceConfigError` (field `sessionManager`). The check runs once the workspace is bound, because an `"auto"` worktree's path is known only then.
- **Working directory:** the session runs in the bound worktree. An explicit `cwd` resolves against it and must stay inside it.
- **Read-only:** a `"read-only"` workspace does not offer `write`, `edit` or `todo`, also when an explicit `tools` list names them, and refuses them if one is active anyway. Shell tools still run. This is not operating-system sandboxing.
- **Recording and resume:** the resolved binding is stored in the session as a `workspace_binding` entry and returned as `result.workspace` and `session.workspace`. Reopening that session with the same workspace restores the recorded binding: it verifies the repository and branch, re-adds a deleted worktree, and keeps the recorded base commit and label. To know the worktree before creating the session, for example to pass its directory as `cwd`, call `bindSessionWorkspace(workspace, sessionManager)` on the reopened session manager; it restores the recorded binding, or resolves the workspace when the session has none, and `createAgentSession` then reuses that binding.
- **Children:** subagent children inherit the workspace. A child of a read-only session stays read-only even when it passes its own workspace.
- **Changes:** `workspaceChangeSet(binding)` returns the committed changes since the base commit, and `publishPullRequest(changeSet, { draft: true })` pushes them and opens a pull request with the GitHub CLI.

Invalid options throw `WorkspaceConfigError`; binding failures reject with `WorkspaceBindingError` (for example `wrong-branch`, `cwd-outside-worktree`, or `git-unavailable` when git cannot be started). Both are checked before the session is created. See [Workspaces](/workflows/api-reference#workspaces) for the resolution rules, the binding record and the full error table.

### Shared resource admission

SDK hosts can pass `resourceAdmission` to `createAgentSession()` to share their own capacity policy across sessions and managed shell commands:

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

`capacity` is your host's admission service. `kind` is `"session"` or `"process"`. Make acquisition cancellation-aware and the returned release function idempotent. `resourceAdmissionSignal` cancels a wait for session capacity; children inherit the admission service, not that signal. Pass the same service whenever your runtime factory creates a replacement session.

A session holds its permit until clean disposal. A managed command holds its permit through background execution and confirmed process cleanup, even after an observation wait returns. Failed launches release their permits after rollback. Cleanup failures keep capacity reserved; inspect and resolve them instead of recycling a slot on a timer. Arbitrary processes created outside Atomic's managed command APIs are not counted.

Your admission service must reconcile abandoned holders after a host crash. Atomic does not treat lease expiry as cleanup proof or clear a service's retained permits automatically.

On Unix, Atomic calls `permit.bindProcess({ kind: "unix-process-group", id })` on a process permit once the command's process group exists and before the launch returns, if the permit provides it. Persist the identity with the permit so a replacement host can check whether the group is still alive before it frees the capacity. The identity only names the group and gives no right to signal it. Windows commands report no identity, so keep those permits reserved until normal cleanup confirms them. If `bindProcess` rejects, Atomic cancels the command, fails the launch, and releases the permit only after cleanup is confirmed.

A parent session keeps its permit while it waits for a child, so a child that queued for a permit could wait on its own parent. Atomic marks child sessions (subagents and other sessions built from `getChildSessionOptions()`) with `request.delegated`. For those requests, grant a permit immediately or throw. Never queue them or exceed the cap. A cap of one, or a cap filled by parents, therefore rejects delegation with your error instead of stalling. Set the cap above the number of parents that can be live at once if you need children to run.

Use `withResourceAdmission(resourceAdmission, async () => { ... })` to apply a service to SDK sessions and managed commands launched within an asynchronous operation, including commands using an existing task owner. An explicit session service wins for that session; commands in the operation use its scoped service. Pass `resourceAdmission: null` for a session that takes no permit even inside such a scope.

A child session built from `getChildSessionOptions()` uses only its parent's service, or none when its parent holds none: a scope the parent's turn happens to run in never applies to the parent's children.

A turn that a delivered message starts (an extension's `sendMessage`, `sendMessages` or `sendUserMessage`, or the session's `sendCustomMessage`, `sendCustomMessages` or `sendUserMessage`) runs under the receiving session's own service, or none when it holds none, wherever the message was sent from. A session's commands therefore never wait on the service of a scope that only sent it a message. `prompt()` still runs in its caller's scope.

### Session storage

`createAgentSession()` persists sessions in `~/.atomic/workflows/journal.sqlite` by default, under `session_` table prefixes; workflow runs default to the [journal store](/storage#the-workflow-journal-store). Pass `sessionStore` to choose storage explicitly:

```typescript
const { session } = await createAgentSession({
  sessionStore: { kind: "sqlite", path: "./sessions.sqlite", prefix: "project_" },
});
```

Other selections are `{ kind: "jsonl", dir }`, `{ kind: "memory" }`, `{ kind: "database", database, prefix? }`, and `{ kind: "adapter", module, options?, secrets?, prefix? }`. `database` must implement the async `SqliteDatabase` facade. Install your own driver and expose an adapter module for a remote database; Atomic bundles only its local `node:sqlite` adapter. See [Storage adapters](/storage).

`createAgentSession({ storage })` takes a selection in the form of the top-level `storage` setting, such as the one `teamProfileSelection()` returns, for both the session store and the session's `workflow` tool journal; `sessionStore` and `journal` outrank it for their domain. See [Team and CI setup](/guides/team-setup#from-the-sdk).

`sessionStore` also accepts a `SessionStore` instance. A supplied `sessionManager` takes precedence and remains caller-owned. Otherwise, explicit SDK storage wins over the process-level variables (`ATOMIC_SESSIONS_STORAGE` or the session-directory variable, then `ATOMIC_STORAGE`), `sessions.storage`, shared `storage`, and the persistent default. Memory is never a default or an opening-failure fallback. The `sessionDir` factory option has been removed; use a JSONL `sessionStore` selection instead. See [Session storage settings](/settings#sessions) for scope and path rules, and [Selecting storage per process](/storage#selecting-storage-per-process) to choose storage for the processes a host starts, such as `atomic --mode rpc` children, without editing settings.

Atomic closes stores it opens from a selection when the session is disposed, after pending writes finish. Supplied `SessionStore` instances and stores belonging to supplied managers remain caller-owned. With `{ kind: "database", database }`, Atomic closes its store but leaves your database open. Always await `session.dispose()` and close caller-owned stores when no session still uses them.

Resume by opening the ID in the chosen store, then pass that manager to the factory:

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

Await every `SessionManager` mutation before reading dependent state. Writes resolve after commit; a failure rejects with a typed error without publishing the failed entry. There is no `flush()` step. Extension `pi.appendEntry`, `pi.setSessionName`, `pi.setLabel`, and `pi.setThinkingLevel` also return promises. `ExtensionContext.sessionSignal` aborts when reload or shutdown starts, before admitted work is drained. Use it to stop waiting on long-running command resources, but keep awaiting any session write already started. See [SessionManager API](/session-format#sessionmanager-api) and [Storage errors](/storage#storage-errors).

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
3. Use `session.workflows.resume(runId)` ([Workflow run control](#workflow-run-control)), `/workflow resume <run-id>`, or the workflow tool's `resume` action.

Rebinding alone does not reopen a saved run. See [workflow operations](/workflows/operations) for inspection, graceful quit, and resume.

Launching without an adapter still preserves required gates and returns the run identity. Inspect status, then bind an authorized host or submit a validated answer. Headless CLI launches use the same execution defaults, but skip pickers and return without waiting for terminal completion. Explicit runtime execution restrictions still apply.

Only an actual `true` confirms a primitive approval. Choosing to stay on a questionnaire's stage does not advance it. Missing input never bypasses approval or an exhausted budget; obtain approval before explicitly resuming with a raised budget.

#### Diagnostics and provider state

`onDiagnostic` receives session-attributed operational diagnostics. Existing errors and tool results remain available without a callback. Third-party extensions can still write directly to the console; the callback does not intercept their output.

Rebinding host callbacks preserves pending MCP OAuth ownership. Authorization state and PKCE verifiers stay in memory for that SDK session; restart authorization after disposing it. Durable MCP tokens and client registrations still use server-name credential files. Separate sessions are not separate credential stores.

Web provider configuration caches are session-local. Configuration discovery and environment keys are unchanged; create a new session to pick up changed cached settings. GitHub extraction returns the owned clone path for use with file tools, so callers need not predict its directory.

### Stored session summaries

`session.sessionSummary` returns the current branch's latest `SessionSummaryEntry`, or `undefined` when none is available. Read `summary` for the generated text and `summarizedThroughId` for the last message it describes. `SessionManager.list()` and `SessionManager.listAll()` expose those same fields on each `SessionInfo`. Stored summaries remain readable when `sessionSummary.enabled` is false; that setting controls generation only.

### Worktree snapshots

A session saved to SQLite or a database adapter records the repository state of each checkout a turn changed. The CLI, TUI and `createAgentSession({ sessionManager })` restore missing or drifted checkouts into fresh worktrees before continuing, and `runtime.rehydrate()` does the same when it wakes a session. When `rehydrate()` wakes a session, each checkout the session worked in on this machine (a worktree this machine restored for it, or a checkout whose repository holds the commit of its latest snapshot) stays as it is, even if it changed since, and only the session's other checkouts are checked against its snapshots and restored when missing or different. Snapshot commits are content-addressed, so a clone where Atomic captured exactly the same state counts as one the session worked in; any other clone at the same path, for example on another machine, is checked first. The session's tools resolve paths under every checkout it recorded into the worktree that checkout was restored into, and never into another session's restores. Pass the stored session directly unless you want to choose its working directory explicitly with `cwd` or bind it with `workspace`:

```typescript
import { createAgentSession, SessionManager } from "@bastani/atomic";

const sessionManager = await SessionManager.open(store, sessionId);
const { session } = await createAgentSession({ sessionManager });
```

The session is reopened in its restored worktree; restoration rejects with `WorkspaceDriftError` when a checkout cannot be rebuilt. Missing Git or setup hooks fail before restoration with typed errors and remediation hints. `createAgentSession({ snapshots: { enabled: false } })` turns snapshots off for one session; the other fields (`includeUntracked`, `maxFileBytes`, `maxSnapshotBytes`, `fullEvery`) override `snapshots.*` settings. `captureWorktreeSnapshot()`, `restoreWorktreeSnapshot()`, `verifyWorktree()` and the `WorkspaceBinding` type are exported for hosts and schedulers that move work between machines; `session.sessionManager.getWorktreeRootMappings()` returns the restores a session went through. `session.exportToJsonl()` returns a promise and carries snapshot content inline. See [Resume on any machine](/guides/resume-on-any-machine) for setup hooks and [Worktree snapshots](/worktree-snapshots) for the API and error table.

### Workflow journal selection

Standalone workflow `run()` accepts `RunOpts.journal` to choose a local SQLite file, a caller-owned connection, process-local memory, or a supplied `RunJournal`:

```typescript
import { run } from "@bastani/atomic/workflows";

await run(myWorkflow, inputs, { journal: { path: "./workflow-runs.sqlite" } });
await run(myWorkflow, inputs, { journal: { memory: true } });
```

Use `{ database, prefix? }` for an async `SqliteDatabase` facade; Atomic never closes the caller-owned database. To use a driver selected by module specifier, pass `{ adapter, options?, secrets?, prefix? }`. Atomic bundles no remote drivers. A supplied `RunJournal` is used as-is. Memory is an explicit opt-in for tests or ephemeral runs and cannot recover runs after process exit. See [Storage adapters](/storage#selecting-an-adapter).

Custom journals implement the full `RunJournal` interface, including `deleteOwnedRun(lease, expectSeq?)` for atomic lease-fenced deletion with an optional sequence check. A stale lease rejects with `StaleLeaseError` without deleting the successor's data. Open a facade-backed journal with `await SqlRunJournal.open(database, { prefix })`, or use `await openSqlRunJournal(pathOrDatabase?)` for the node adapter. Validate custom journals with `registerRunJournalConformance`; see [Choosing the durable backend](/workflows/api-reference#choosing-the-durable-backend).

To choose the journal for the model-facing `workflow` tool of one SDK session, pass the same selection to `createAgentSession`. A session can use its own journal, for example to isolate tests, without setting `ATOMIC_WORKFLOW_JOURNAL_PATH`:

```typescript
const first = await createAgentSession({ journal: { path: "./first-runs.sqlite" } });
const second = await createAgentSession({ journal: { memory: true } });
```

Without a `journal` option, the session's own `workflows.journal` setting applies, including settings passed through `SettingsManager.inMemory({ workflows: { journal: { path: "./runs.sqlite" } } })`. A `memory: true` journal selected this way belongs to that session alone. Disposing a session closes the journals Atomic opened for it once no other session is using them, so runs kept in a memory journal end with the session. Atomic never closes a database or journal you supply.

Without a per-run or per-session option, `ATOMIC_WORKFLOWS_JOURNAL` or a non-empty `ATOMIC_WORKFLOW_JOURNAL_PATH` wins, then `ATOMIC_STORAGE`, then `workflows.journal`, then shared top-level `storage`. Setting both journal variables is a conflict. Nearer-scope settings replace whole selections. Relative settings paths resolve against Atomic home. The default journal is the [journal store](/storage#the-workflow-journal-store) in `~/.atomic/workflows/journal/`, which finds any of its runs by ID; an empty shared selection uses `~/.atomic/storage.sqlite`. A run saved in an explicitly selected journal resumes from that journal, or from the store after `atomic storage adopt`. Invalid configuration and storage failures reject rather than switching to memory. See [Workflow storage settings](/settings#workflow-storage) and [Selecting storage per process](/storage#selecting-storage-per-process).

### Intercom in standalone workflows

Workflow stages run by the standalone `run()` API can use Intercom when the stage has access to the `intercom` tool, including with `executionMode: "non_interactive"`. Atomic opens Intercom when an eligible stage starts and closes the workflow route when the run settles. Intercom remains unavailable when a stage excludes the tool or disables its builtin package. A local session that needs to steer a standalone run can join `workflow:<rootRunId>` and send to a stage or `workflow:<rootRunId>/**`. See [Programmatic usage](/workflows/api-reference#programmatic-usage) for details.

### Workflow run control

`session.workflows` controls this session's runs without slash commands or the model-facing `workflow` tool. A fresh session can inspect a durable root by its full UUID within the same working directory and journal. Inspection stays read-only and does not add the run to `listRuns()`.

```typescript
interface SessionWorkflows {
  listRuns(filter?: { status?: WorkflowRunFilterStatus; includeDurable?: boolean }): Promise<readonly WorkflowRunSummary[]>;
  getRun(runId: string): Promise<WorkflowRunDetail>;
  getStages(runId: string, filter?: { status?: WorkflowStageStatus }): Promise<readonly WorkflowRunStageSummary[]>;
  pause(runId: string, options?: { stageId?: string }): Promise<WorkflowRunControlOutcome>;
  pause(target: { all: true }): Promise<WorkflowRunControlOutcome>;
  quit(target: string | { all: true }): Promise<WorkflowRunControlOutcome>;
  resume(runId: string, options?: { stageId?: string; message?: string }): Promise<WorkflowRunControlOutcome>;
  waitForSettled(runId: string): Promise<void>;
  observe(observer: WorkflowActivityObserver): WorkflowActivitySubscription;
}
```

`listRuns()` and `getRun()` expose `label`, `identity`, `summary`, and `summarizedThrough` (Unix milliseconds). The identity prefers the label, then the objective/prompt input, then the run ID. Use `listRuns({ includeDurable: true })` to include stored resumable and completed top-level runs launched from the current project directory alongside this session's live runs. Stored runs must have a recorded session owner, matching the SDK's run-detail access rules, so a run you started with `/workflow` is not listed. A run control registered with `registerWorkflowRunControl` may implement the optional `listProjectRuns()`, which lists every top-level run recorded for the current project directory whoever started it; the bundled workflows extension does, and `history://workflows` uses it when present. The default remains this session's runs only. Saved summaries can lag current progress and remain readable with summary generation disabled.

`listRuns()` returns the same per-run data as `workflow status`: id, workflow name, status, active stages, and unanswered prompts (`awaitingInput`). Run IDs accept the full UUID or a unique 8-character prefix. `getRun()`, `getStages()`, `pause()` and `quit()` resolve a prefix against the runs this session holds and reject it at once when none matches, so pass the full UUID for a run recorded by an earlier process. `pause`, `quit` and `resume` resolve with the tool's acknowledged outcome: `action`, `runId` (`--all` for a batch), a `status` of `ok`, `running`, `paused`, `partial`, `noop` or `cancelled`, and a human-readable `message`. A `noop` means the request was understood and found nothing to change, such as pausing a run that already ended. A `partial` outcome means part of the request took effect. For `pause({ all: true })` and `quit({ all: true })`, `partial` means this call stopped at least one run and others are still active: `failedRuns` lists each run that is still active with its `runId`, a `reason` (for example `pause_failed` or `no_active_stages`) and a `message`, so check `outcome.status === "partial"` before treating a batch stop as complete. If active runs could not be stopped and this call stopped none, the call rejects with `WorkflowRunControlError` (`WORKFLOW_RUN_CONTROL_FAILED`) whose `failedRuns` carries the same list, even when other runs were already paused. Runs that are already paused or already ended are not failures, and a batch with no active run left to stop resolves as a `noop`. Call `getRun()` before retrying.

After an owning process crashes, create a new authorized SDK session with the original `cwd` and workflow journal. Keep the workflow definition available, then call `getRun(runId)` with the saved full UUID. Once the journal lease has expired (about two minutes without renewal), status reports `crashed`. `resume(runId)` claims the run under a new fenced lease, keeps its UUID, and replays completed checkpoints. This works with `SessionManager.inMemory()` and does not require reopening a session file. Concurrent recovery attempts admit only one executor; inspect again if another caller won the claim.

A run with a live foreign lease remains read-only, even while a long-running tool has not refreshed progress. `pause()` and `quit()` require the owning session. Missing ownership metadata, a different working directory, or unavailable journal storage prevents adoption. Use the full UUID to recover a foreign run.

Disposing an owning session with `await session.dispose()` stops its in-flight runs at their last checkpoint and records their release in the journal. Another authorized SDK session with the same `cwd` and journal can then call `resume(runId)`. The adopting session becomes the owner, and completed checkpoints replay without rerunning their callbacks.

A run reports `completed`, `failed` or `killed` to `workflow_lifecycle` and `session.workflows` as soon as it ends, and then records that ending in the journal. With a remote journal this takes a few round trips. `await session.dispose()` waits up to 10 seconds for runs in that window before it closes the journal. If the journal still cannot record an ending, `dispose()` rejects with `ShutdownFailed` and names the run, rather than leaving the journal showing it as `running`. To wait without disposing, for example before another process reads the journal, call `await session.workflows.waitForSettled(runId)`. It resolves once the ending is in the journal and the run's lease is released, resolves at once for a run this session is not executing, and rejects with `WorkflowRunStorageError` when the journal could not record the ending. It has no timeout of its own, so race it against your own deadline.

Workflow resume is project-scoped. SDK and workflow-tool resume calls for a run from a different `cwd` return an actionable error without changing it. To continue in a different project, fork the run instead: `forkRun(runId, { cwd })` from `@bastani/atomic/workflows`, the `workflow` tool's `fork` action, `/workflow fork <id>`, or `/workflow resume <id>` interactively with the fork confirmed. The fork receives a new run ID and copies saved progress; the original run is left untouched. See [`forkRun`](/workflows/api-reference#forkrun-runid-options). To keep the original ID, create the successor session with the original `cwd`.

```ts
await owner.dispose(); // quits in-flight runs at their last checkpoint and releases them

await successor.workflows.resume(runId); // adopts the run, even from another process
```

Switching sessions (`/new`, `/fork`, `/resume`) also releases the previous session's paused runs for adoption. Reloading does not release runs. A paused run whose owning session has not released it stays protected; finished runs are not resumable.

Journal fencing protects ownership and durable checkpoints, not arbitrary external effects. An interrupted `ctx.tool` callback can run again if its result was not checkpointed. Make external effects idempotent, for example by using a stable run/node operation key with an API that deduplicates requests.

If storage fails, preserve the journal and run ID, restore access, inspect the retained run, and resume explicitly. A failed pause leaves the local scheduler paused; resume retries the journal transition before releasing it. A failed resume keeps the scheduler paused and surfaces the error.

Pausing a run doesn't park a stage that is waiting on a prompt, including an `ask_user_question` delivered through `HostInput.questionnaire`. If no other work is active, `pause(runId)` and `pause({ all: true })` mark the run `paused` without cancelling its question. Questions not yet shown wait until the run resumes. A later pause counts it as already paused. If your host then answers an already-open prompt, the stage can continue its turn before you call `resume`. To keep a paused run fully stopped, hold prompt answers until you resume it.

Requests that cannot be carried out reject with a subclass of `WorkflowRunControlError`. Branch on `code` or use `instanceof`:

| Class | `code` | Meaning |
| --- | --- | --- |
| `WorkflowRunNotFoundError` | `WORKFLOW_RUN_NOT_FOUND` | The run ID is unknown or malformed, or a prefix is ambiguous or matches no run in this session. |
| `WorkflowRunOwnershipError` | `WORKFLOW_RUN_OWNED_ELSEWHERE` | Mutation requires another session's ownership, the run is still live, or the durable run is outside this host's recovery scope. Inspect it read-only when in scope; control live work from its owner. |
| `WorkflowRunNotResumableError` | `WORKFLOW_RUN_NOT_RESUMABLE` | The run completed, was killed, or has no durable progress to resume. |
| `WorkflowStageNotFoundError` | `WORKFLOW_STAGE_NOT_FOUND` | `stageId` matches no stage of the run, or the stage has no control to pause. |
| `WorkflowStageAmbiguousError` | `WORKFLOW_STAGE_AMBIGUOUS` | `stageId` matches more than one stage; pass a more specific identifier. |
| `WorkflowStageResumeUnsupportedError` | `WORKFLOW_STAGE_RESUME_UNSUPPORTED` | A durable run resumes as a whole; call `resume()` without `stageId`. |
| `WorkflowRunStorageError` | `WORKFLOW_RUN_STORAGE` | The workflow journal is unavailable, closed, or failed. Restore storage access and inspect the retained run before retrying. |
| `WorkflowRunControlError` | `WORKFLOW_RUN_CONTROL_FAILED` | Another failure; `message` explains it. |
| `WorkflowRunControlUnavailableError` | `WORKFLOW_RUN_CONTROL_UNAVAILABLE` | The workflows package is disabled, or the session was disposed. |

Each error carries the `runId` when one applies. A refused batch also carries `failedRuns`.

A host with a stop button can pause its session's runs and resume the same runs later:

```typescript
import { createAgentSession, WorkflowRunControlError } from "@bastani/atomic";

const { session } = await createAgentSession();

async function onStopClicked() {
  const outcome = await session.workflows.pause({ all: true });
  showStatus(outcome.message);
}

async function onResumeClicked() {
  for (const run of await session.workflows.listRuns({ status: "paused" })) {
    try {
      const outcome = await session.workflows.resume(run.runId);
      showStatus(`${run.name}: ${outcome.message}`);
    } catch (error) {
      if (!(error instanceof WorkflowRunControlError)) throw error;
      showStatus(`${run.name}: ${error.code}: ${error.message}`);
    }
  }
}
```

`pause` holds the live run and keeps it resumable in this process; `quit` retires the executor at a durability boundary so a later process can resume it. After `quit`, or when resuming a run from a previous process, `resume` follows the durable resume path: keep the workflow definition and durable storage available. See [pausing, quitting, and resuming](/workflows/operations#pausing-quitting-and-resuming) for what each action guarantees.

#### Observing workflow runs

To follow runs instead of polling `listRuns()`, call `session.workflows.observe(observer)`. It covers runs that the agent launches with the `workflow` tool, and needs no extension. The first frame is a `snapshot`. After it come `changed` and `removed` frames, delivered in order. Each callback finishes before the next one starts. Call `dispose()` on the returned subscription to stop. The frames and cursors follow the [workflow activity contract](/extensions/events#workflow-activity-and-lifecycle-hooks).

Each root summary carries a `graph` with the nodes of that root's workflow, including the nodes of nested child workflows. Nodes are `stage` nodes and `ctx.tool` nodes. Each one has an `id`, `kind`, `name`, `status`, `parentIds`, `runId`, `nodeId` (its run-local id), `depth`, and `executionOrder` when it is known. Tool nodes add their `ordinal`. A stage that is waiting on a prompt adds `pendingPrompt` with the prompt's `id`, `kind`, `message`, `choices`, and `createdAt`. A prompt that a run raises outside any stage appears in `graph.runPrompts` with the same fields and the `runId` that owns it. A node status change produces a `changed` frame. Frames are plain JSON-serializable objects.

```typescript
import type { WorkflowRootActivity } from "@bastani/atomic";

const roots = new Map<string, WorkflowRootActivity>();
const subscription = session.workflows.observe((frame) => {
  if (frame.kind === "snapshot") {
    roots.clear();
    // `recovering` or `unavailable` means activity is unknown, not idle.
    if (frame.availability === "ready") for (const root of frame.roots) roots.set(root.rootRunId, root);
  } else if (frame.kind === "changed") {
    roots.set(frame.root.rootRunId, frame.root);
    for (const node of frame.root.graph?.nodes ?? []) {
      renderNode(node.id, node.name, node.status, node.parentIds);
    }
  } else {
    roots.delete(frame.rootRunId);
  }
});

// Later:
subscription.dispose();
```

Observation can start before the workflows package has finished loading; the first snapshot then reports `availability: "unavailable"`, and a `ready` snapshot follows. The subscription survives `session.reload()`. After a reload, the observer receives a new snapshot with a new cursor `epoch`, so replace everything you knew. When the session is disposed, each observer receives a final `snapshot` with `availability: "unavailable"` before `dispose()` resolves; after that, `observe()` throws `WorkflowRunControlUnavailableError`. This stream reports root activity and graph state. It does not carry the events inside each stage.

### Workflow and subagent children

Children inherit the invoking session's model/auth runtime, settings, agent directory, human-input callbacks, and diagnostic sink. Choosing a child model or fallback does not switch to global credentials.

Workflow stages also inherit extensions supplied to the parent's `DefaultResourceLoader` through `additionalExtensionPaths` and `extensionFactories`. Factories run again for each stage. Keep parent-only setup in a session callback such as `session_start`, and return early from that callback when `ctx.subagentPolicy` is set. This skips the setup, not factory construction or handler registration. Do not rely on `pi.subagentPolicy` during factory construction: stage resources can load before the session policy is attached.

The child working directory resolves in this order:

1. The child's own `workspace`, with its explicit `cwd` resolved inside the worktree.
2. Explicit child `cwd`.
3. A supplied child `sessionManager.getCwd()`.
4. The invoking session's directory, which is the parent's worktree when the parent has a workspace.

Child-relative paths, including workflow report outputs, use the resolved child directory without changing the process working directory.

Omitted or `undefined` child options retain inherited configuration, including individual builtin flags and host bindings. Use `humanInput: null` to withdraw input explicitly; empty arrays and other explicit values keep their normal meanings, subject to the parent's capability ceiling.

Child tool selections can narrow the parent's selection, not expand it. Disabled builtin packages, excluded tools, empty allowlists and `noTools: "all"` remain suppressed in children and fallback attempts. Enable a needed capability on the parent before launching a child. Workflow stages and subagents still exclude recursive workflow tooling; subagents retain the single-level delegation limit.

Callbacks may be shared, but request and diagnostic `sessionId` values identify the originating child. Workflow questions also carry their run/stage identity. Group overrides retain the normal Intercom authorization rules. Disabling or excluding Intercom does not create a substitute supervisor grant. Reopening conversation history does not restore child authority.

An explicit child `extensionBindings.humanInput` overrides the inherited host, including for durable stage questionnaires. Setting it to `null` leaves those questions pending; rebinding the parent cannot answer on that child's behalf. Rebind the child to an authorized adapter to continue. Without a child override, pending stage questions follow parent host withdrawal and reattachment.

You may reuse the same adapter object when explicitly rebinding a child, even after the parent switches hosts. That child selection survives reload. An empty binding object does not select a new host or restore inheritance.

The inherited `isFallbackModelAllowed` predicate also applies when a workflow replaces its stage session to try a fallback. A rejected candidate is not executed. This predicate restricts fallback choices, not an explicitly selected primary model.

### Waiting workflow stages

A workflow stage that only waits on a long tool call does not keep its session in memory. Give the tool `detachable: true` (see [Detachable tool calls](/sdk/reference#detachable-tool-calls)); once a call of it outlasts the stage's `releaseWhenWaiting` threshold, the stage closes its session, frees its admission slot, and reopens the same session from the session store when the result arrives:

```typescript
import { run } from "@bastani/atomic/workflows";

const result = await run(reviewLoop, inputs, {
  releaseWhenWaiting: { afterMs: 30_000 },
  onStageLifecycleEvent: (runId, event) => {
    if (event.type === "stage_waiting") console.log(`${event.stageName} waits on`, event.wait.toolCalls);
    else console.log(`${event.stageName} resumed after ${event.waitedMs} ms`);
  },
});
```

The option also exists on each task, stage, chain and parallel step, `stage.release()` and `stage.rehydrate()` do the same between prompts, and the `StageWaitError` family reports refused releases. While a stage's session is released, including a stage the workflow held idle past its threshold, `stage.messages` and `stage.agent` throw `StageReleasedError` (`stage-released`): read the transcript with `await stage.readMessages()`, which leaves the session released, or call `await stage.rehydrate()` first. See the [workflow API reference](/workflows/api-reference#releasewhenwaiting) for the details and error codes.

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
  // Subscribe to an event stream; see "Event subscriptions" below
  subscribe(source: EventSource, handler: SessionEventHandler, options?: SessionSubscribeOptions): Subscription;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Typed control of the workflow runs this session owns
  readonly workflows: SessionWorkflows;

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
  compact(options?: SessionCompactOptions): Promise<VerbatimCompactionResult>; // Partial<VerbatimCompactionParameters> & { compactionModel?: string }
  abortCompaction(): void;

  // Background compaction
  readonly compaction: BackgroundCompactionState; // { state: "idle" | "running" | "ready" | "failed", upToEntryId?, startedAt?, error? }
  onCompactionReady(listener: (state: BackgroundCompactionState) => void): () => void;
  awaitBackgroundCompaction(): Promise<BackgroundCompactionState>;
  setBackgroundCompactionEnabled(enabled: boolean): void;
  setBackgroundCompactionThresholdPercent(percent: number): void;

  // Abort current operation
  abort(): Promise<void>;

  // Cleanup
  dispose(): Promise<void>;
}
```

Always `await session.dispose()` in `finally`. Disposal immediately refuses new work, cancels and drains owned operations, settles questions, shuts down extensions and releases session leases. Repeated calls await the same outcome.

A `ShutdownFailed` error contains component failures in `errors`; cleanup still attempts the remaining components. Stores opened by the SDK, including stores created from a `sessionStore` selection, are released after session work and shutdown handlers finish. A failed session initialization releases its acquired store too. Caller-supplied `SessionStore` instances, session managers, databases, and model runtimes retain their caller-managed lifetimes. Close a supplied store or database only after its other users are done. Disposing one session does not close another session's store or a shared journal. Use `abort()` to cancel current work without destroying the session.

Captured extension APIs also refuse new execution, mutations and registrations as soon as close or reload begins. Already-admitted `pi.exec()` calls remain part of the awaited drain; provide `signal` or `timeout` when invoking subprocesses that might not finish on their own. `abort()` alone does not retire the API. A rejected transactional reload restores the surviving generation's action admission.

Custom messages queued with `persistWhenStreaming: true` survive a successful reload and receive their model turn through the replacement extensions. An explicitly paused queue remains paused; call `resumeQueuedMessages()` before sending the next prompt. A rejected transactional reload retains the notices for the next prompt on the surviving generation.

#### Event subscriptions

`session.subscribe(source, handler, options?)` is the session-level form of the workflow [`ctx.subscribe`](/workflows/api-reference#workflowcontext): each event of `source` is handled by `handler(event, child)` without entering the session's context.

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

- `child.task({ prompt, model?, thinkingLevel?, tools?, noTools?, excludedTools? })` runs a short-lived in-process child session seeded with your prompt and the event, then disposes it. When the session closes, a running child is aborted and disposed, and `child.task` rejects with the session's `AbortError`. If aborting or disposing the child fails, that failure is on the error's `cleanupCause`; when several children of the subscription fail to clean up, `cleanupCause` is an `AggregateError` of their failures. The child inherits this session's model, tool limits and custom tools, and gets a `report_to_subscriber` tool, which an explicit `tools` allowlist keeps; with `noTools: "all"` the child cannot report, so call `child.report()` instead. The child is named `<name>#<n>/<event id>` (the id is URI-encoded), which is also what the report text and `EventReportDetails.child` show. It resolves `{ text, sessionId }`. A session built without `createAgentSession()` has no child sessions; `child.task` then fails with `SubscriptionChildUnavailableError`.
- `child.report(text)` delivers one `event_report` custom message into this session and starts a turn when it is idle (steering when it is streaming). A report sent while the session is in a turn is saved in the transcript before `report()` returns, so it survives a crash before the session reads it. Its `details` are `{ subscriptionId, eventId, child }`.

`options` takes `name`, `maxConcurrent` (default 4) and `maxRate`, with the semantics of `ctx.subscribe`. The session transcript records the subscription and each processed event id as custom entries, which never enter model context, so a session reopened on the same transcript drops events it already handled. Each child session that finishes adds one `event_subscription_child` entry with the child's name, event id, session id, number of reports and the first 500 characters of its answer, so you can see what each event did. Subscribing again in the same session starts a new subscription that handles every event again. If writing the subscription record or a processed-event record fails, `done` rejects with a `SubscriptionRecordError` (the handler itself succeeded, and the event is handled again after a reopen). Disposing the session cancels its subscriptions; their `done` rejects with an `AbortError`, and an event whose handler was still running is not recorded as processed. The returned `Subscription` has `id`, `done`, `stats()` and `close()`; pass `id` to `publishEvent()` to bridge your own webhooks. Event sources, `publishEvent` and the `SubscriptionError` family are documented in the [workflow API reference](/workflows/api-reference#event-sources).

#### Finishing admitted work

Disposal and reload wait for admitted callbacks, resource refreshes, and subprocesses. Ensure callbacks can settle independently of disposal, including work started by cleanup handlers. Give `pi.exec()` calls a timeout or cancellation signal, and await them in the handler so you can inspect failures. Never make cleanup wait for disposal itself.

Register cleanup before acquiring resources or starting asynchronous callbacks. Call the unsubscribe returned by `pi.events.on()` or a workflow publisher's `dispose()` when you no longer need it; both are idempotent. Generation cleanup releases remaining handles and reports failures.

#### Reload failures and resource ownership

Strict transactional reload failure leaves the original generation usable. Ordinary reload failure does not restore the retired generation. Both attempt cleanup of newly acquired resources and report cleanup failures through `ShutdownFailed` without hiding the original error.

Prefer acquiring extension resources in `session_start`. If a factory acquires them earlier, register `session_shutdown` immediately, even if `extensionsOverride` may later omit that factory. Capture cleanup handles when acquiring resources rather than rereading loader getters during cleanup.

Transactional reload dispatches candidate `session_start` before commit. Use `publishExtensionContextEffect(ctx, effect)` to publish shared lifecycle state only after commit and retiring-generation cleanup; rollback discards the effect. Outside a transactional candidate, it runs immediately. Awaiting the helper queues the effect, not its eventual execution, so startup must not depend on the effect's result.

For synchronous identity handoff, use `publishExtensionContextEffect(ctx, effect, "commit")`. This phase runs after the transaction commits and before predecessor authority is revoked or any retirement work is awaited. It must not return a promise or start asynchronous work; asynchronous callbacks are rejected and reported. The default `"start"` phase still runs after retirement, when reporter and task-host startup is safe.

Register generation-owned observer disposal with `registerExtensionContextRetirementEffect(ctx, dispose)` during `session_start`. Disposal is synchronous, runs before authority revocation and before rollback invalidation, and is independent of `session_shutdown` handler order. The returned function unregisters the effect. Keep awaited resource cleanup in `session_shutdown`; observer disposal must not quit or checkpoint preserved workflows.

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

Do not cache dialog functions across reload attempts. Retiring functions refuse new questions; after a rejected transaction, use the surviving session's current `ctx.ui`.

Shared loaders, event buses, settings, and `SessionManager` instances do not share live task ownership. Closing one session leaves another session's commands and borrowed discovery resources alone.

#### Session replacement and deferred cleanup

`await runtime.dispose()` refuses new replacements and waits for pending factories, startup, and cleanup. It also waits up to three seconds, counted from the start of disposal, for an OAuth token exchange still in flight, so a token the provider already rotated is saved before your host exits. No successor is published after closure. Host callbacks must settle independently of disposal. Call `runtime.dispose({ fromSignal: true })` when the host is shutting down because of `SIGTERM` or `SIGHUP`, so `session_shutdown` handlers receive `fromSignal: true` and can tell it from an explicit quit.

An extension command may await `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, or `session.reload()`. Its old generation remains owned until the command continuation finishes, and final disposal waits for that cleanup. Do not await disposal inside the continuation it must drain. Concurrent replacements are supported, and deferred cleanup failures remain visible.

After replacement or self-reload, use the new generation's APIs. Captured old `pi` and `ctx` actions cannot mutate the successor or acquire its resources. Old shutdown handlers may release captured resources, but cannot authorize successor work.

For replacement initiated outside the retiring session's work, outgoing shutdown finishes before successor creation. If it fails, replacement rejects without creating a successor. Handle creation, reload, replacement, and disposal failures rather than continuing as though cleanup succeeded.

#### Settings failures and operation IDs

Settings writes made through session APIs (for example, `setThinkingLevel(level, { persist: true })`) are attributed to that session. Unrecovered write failures make disposal reject with `ShutdownFailed`, even though the normal `SettingsManager.flush()` resolves and exposes errors through `drainErrors()`. Disposal does not consume that caller-owned error channel or attribute another borrower's writes to an idle sibling. Correct the storage fault and persist again before closing to recover.

Caller-supplied `executeBash()` IDs remain correlation IDs, not unique operation IDs. `abortBash(id)` cancels every active call with that exact ID; disposal cancels every owned call, including duplicates.

#### Compaction and tree navigation

`compact()` removes selected older transcript lines without asking the model to rewrite retained text. It appends a durable `compaction` entry with `details.strategy: "verbatim-lines"` and respects the configured recent-message count. See [Compaction](/compaction) for controls and [Session format](/session-format#compactionentry) for persisted fields.

Pass `compactionModel` to choose the compaction model for one call without changing settings. It accepts the same exact `provider/model` IDs as the [`compactionModel` setting](/compaction#compaction-model): a chat model, a registered classifier, or `morph/morph-compactor`. An unknown ID rejects before the active run is interrupted. A call made while another manual compaction is running joins that run and uses its model.

```typescript
await session.compact({ compactionModel: "typesafe/jev-latest", query: "keep the auth decisions" });
```

[Background compaction](/compaction#background-compaction) runs automatically once context passes `compaction.backgroundThresholdPercent`. `session.compaction` reports its state, `onCompactionReady()` runs when a result is saved, and `awaitBackgroundCompaction()` waits until no background task is running. `abortCompaction()` also cancels a running background task. Pass `compactionWake` to `createAgentSession` to receive the "compaction ready" notice outside the session:

```typescript
const { session } = await createAgentSession({
  compactionWake: { compactionReady: ({ sessionId, resultEntryId, upToEntryId }) => scheduleWake(sessionId) },
});
const state = await session.awaitBackgroundCompaction();
if (state.state === "failed" && isBackgroundCompactionError(state.error)) console.warn(state.error.code, state.error.hint);
```

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
  sessionManager: await SessionManager.create(process.cwd()),
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
- after a `switchSession()`, call `runtime.session.startPendingRecovery("resume")` to recover interrupted work
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

### Releasing idle sessions

A host that keeps many conversations doesn't need a live `AgentSession` for each one. `session.release()` lets go of everything the session holds in memory (its agent loop, extension instances, tool registry, listeners, timers, MCP connections and Intercom connection) and keeps only its saved history. `runtime.rehydrate(sessionId)` brings it back from storage when there is something for it to do.

```typescript
const released = await session.release(); // { sessionId, cwd, sessionFile? }

// Later, when a message for that conversation arrives:
const live = await runtime.rehydrate(released.sessionId);
await live.prompt("Here is the CI result you were waiting for.");
await live.release();
```

- `release()` refuses with a retryable `session-busy` error while a run, compaction, shell command, queued message (a steering or follow-up message, or one sent with `deliverAs: "nextTurn"`) or background task is active. Background tasks keep running: wait until they finish (or cancel them) and for `agent_settled`, then call it again. Calling it on a released session returns the same result.
- Subscribers get a `session_released` event before the session closes. After that, the instance behaves like a disposed session; use `runtime.rehydrate()` for a live one.
- `runtime.rehydrate(sessionId)` builds the session with the runtime's factory and passes the runtime's `services` to it as `options.services` when the cwd matches, so rehydrated sessions can share one resource loader, model runtime and settings. A factory that ignores `services` still works; it just builds its own. The rehydrated session runs beside `runtime.session` without replacing it. A session that is already live is returned as it is, concurrent calls for one id share one rehydration, and `runtime.dispose()` closes every session it rehydrated.
- If the runtime is disposed while `rehydrate()` is in flight, it rejects with the runtime's `SessionClosed` error. When closing the new session also failed, that failure is attached as the error's `cleanupCause`, a `release-failed` `AgentRehydrateError`. A rehydrated session that fails to close during `runtime.dispose()` is reported the same way inside its `ShutdownFailed` error.
- A session this node's storage doesn't hold fails at once with `session-not-found`, before the factory runs. When the node keeps sessions in local storage, the error's `hint` says so and names `atomic storage join <url> --token-file <path>`, after `atomic team leave` on a machine joined with `atomic team join`, which keeps sessions on each machine.
- A session released over an in-memory session store that your host keeps open, one opened for a `{ kind: "memory" }` selection, leaves process memory too: `release()` moves its history to a file of its own and keeps only its header, and `rehydrate()` reads the file once. What a woken session writes stays in memory until it is released again; the next release writes the session's history whole to a new file, renamed into place once complete, so a write cut short never leaves part of a file under a session's name. Re-releases request a copy-on-write clone (`COPYFILE_FICLONE`); filesystems without reflinks fall back to copying the whole previous history, so repeated small appends can still cost a full history-sized write per release.
  - **Where:** under the agent directory the store was opened with (`agentDir`; by default `ATOMIC_CODING_AGENT_DIR`, or `~/.atomic/agent`), in `released-history/<host-identity>/<pid>-<start>-<nonce>/`. The random owner nonce keeps process directories distinct even when PID namespaces report identical PIDs and start times are unknown; exit cleanup removes only the owner's registered directories. The host identity hashes the hostname, platform/kernel marker and boot identity, plus Linux's PID-namespace inode. Each store has a directory with a file per session: owner-only 0700/0600 on POSIX; Windows inherits the agent directory's ACL. The agent directory is not a temp directory, so temp cleaners leave the files alone while the process runs.
  - **Until when:** a session's file is removed with the session, a store's directory when its last handle closes, and the process's directories when the process exits. `process.exit()` counts, including Atomic's signal handlers; Atomic installs no extra signal handler for this. A worker thread removes its own stores when it exits by itself. Opening an in-memory session store on the main thread, or running the startup sweep when resolving any session store there, installs a process-wide worker-directory registry: main-thread exit also removes worker stores, including after `worker.terminate()` and even if main has since closed its store. Importing the SDK alone does not install it. Registration is asynchronous and never delays a release. If only workers open stores, main-thread cleanup is unavailable: close their stores before termination, or let the next matching startup sweep remove the leftovers.
  - **A killed process:** SIGKILL, fatal errors such as running out of heap, or signals without a handler leave plaintext history on disk. `worker.terminate()` also leaves its files until main-thread exit or a later sweep. A sweep only considers its own hostname, platform/kernel, PID namespace and boot, and removes a directory only when its pid and start-time check prove the owner is gone. Other identities (including old host-only directories) and uncertain lookups are left untouched. Boot/namespace identity lookup happens once; if it fails, sweeping is disabled.
  - **Failures:** a file that cannot be written keeps that history in memory and is reported once as a process warning (`process.on("warning")`) carrying a `SessionSpillError`. A missing store directory is recreated on a later write; history already deleted cannot be recovered. Length and an incremental FNV-1a checksum detect accidental corruption, including same-length valid JSON edits (not malicious tampering). A missing or corrupt file makes the load fail with a `SessionSpillError`, and a listing leaves that session out and reports it once (see [Storage errors](/storage#storage-errors)).
  - A custom `SessionStore` can implement `releaseSession(sessionId)` the same way; Atomic calls it after a session is released.

To release automatically, pass `releaseWhenIdle`:

```typescript
const { session } = await createAgentSession({ releaseWhenIdle: { afterMs: 5 * 60_000 } });
session.subscribe((event) => {
  if (event.type === "session_released") saveForLater(event.released.sessionId);
});
```

The session is released once it has been idle for `afterMs` milliseconds, from 0 to 2147483647 (about 24.8 days). A session that is busy when the time comes, for example with a background task still running, is checked again `afterMs` later. `releaseWhenIdle` is also accepted by `createAgentSessionFromServices()`, so a runtime factory can pass it through. An invalid value throws `AgentReleaseConfigError` before any session, store or timer is created.

Idle sessions wait on one process-wide `AgentWakeDispatcher` (`agentWakeDispatcher()`), not on timers of their own. Hosts can use it to wake their own released agents: register one handler per namespace with `handle(namespace, handler)`, then `deliver("<namespace>:<key>", wake)`. Wakes for one key are handled in the order they arrive, one batch at a time; a wake whose `id` is already queued or running for that key is delivered once.

A wake that fails with nobody waiting on it, such as a timed wake, is counted in `stats().unobservedFailures` and kept as `lastFailure`. Subscribe to these failures with `onUnobservedFailure(listener)`, which returns a function that unsubscribes; the `onUnobservedFailure` constructor option does the same for a dispatcher you create. `whenIdle(wakeKey?)` resolves once that key, or without a key the whole dispatcher, has nothing queued or running; timed wakes that are not due yet don't count.

```typescript
const dispatcher = agentWakeDispatcher();
const stop = dispatcher.onUnobservedFailure((error) => console.warn(error.message, error.fields));
await dispatcher.whenIdle();
stop();
```

Release and wake failures reject with `AgentRehydrateError` (or its subclass `AgentReleaseConfigError`). Branch on `code`, or use `isAgentRehydrateError()`, `isAgentReleaseConfigError()` and `isRetryableAgentRehydrateError()`, which also accept copies that crossed a process boundary. `serializeAgentRehydrateError()` and `rehydrateAgentRehydrateError()` carry the error across one with its `code`, `hint`, `fields` and cause chain. A cause that is itself an `AgentRehydrateError`, a `ToolDetachmentError` or a storage error comes back as that class, so `isRetryableAgentRehydrateError()` gives the same answer on both sides; any other cause comes back as an `Error` that keeps its `name`, `code` and `retryable`.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `AgentReleaseConfigError` | `invalid-release-policy` | `releaseWhenIdle` isn't `{ afterMs }` with `afterMs` a number from 0 to 2147483647. | `source`, `field`, `value` | Fix the option. Nothing was created. |
| `AgentRehydrateError` | `session-busy` | `release()` while a run, compaction, shell command, queued message or background task is active. `retryable` is `true`. | `sessionId`, `activity` | Wait for `agent_settled`, or for the session's background tasks to finish when `activity` is `background-tasks`, then release again. |
| `AgentRehydrateError` | `not-reopenable` | `release()`, or `createAgentSession({ releaseWhenIdle })`, on a session whose history lives in a private in-memory store (`SessionManager.inMemory()`): nothing could reopen it after release. It fails before any work. | `sessionId`, `storage` | Create the session over a store that outlives it: SQLite, JSONL, or a `MemorySessionStore` your host keeps and passes as `sessionStore`. |
| `AgentRehydrateError` | `session-not-found` | `rehydrate()` names a session this node's storage doesn't hold. | `sessionId`, `storage`, `localOnly` | Check the id. On local storage, join shared storage with `atomic storage join <url> --token-file <path>` if the session was saved on another node, after `atomic team leave` on a machine joined with `atomic team join`. |
| `AgentRehydrateError` | `no-wake-handler` | A wake was delivered to a namespace with no handler. | `wakeKey`, `namespace` | Register a handler for the namespace first. |
| `AgentRehydrateError` | `wake-handler-conflict` | A second handler was registered for a namespace. | `namespace` | Dispose the first handler before registering another. |
| `AgentRehydrateError` | `wake-failed` | The handler failed while rehydrating or waking the agent. The `cause` says why. | `wakeKey`, `wakes` | Fix the cause, then deliver the wakes again. |
| `AgentRehydrateError` | `release-failed` | `release()` could not close the session cleanly, for example because its store was unreachable, or the runtime could not close a session it rehydrated. The `cause` is the close failure. | `sessionId`, `storage` | The session's memory is released either way. Rehydrate it and check its last entries before you continue. |

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

A prompt that arrives while the session compacts is held until compaction ends. Its `preflightResult` reports `"queued"` as soon as the session holds it, and the prompt shows in `getSteeringMessages()`/`getFollowUpMessages()` while it waits. If `clearQueue()` returns the waiting prompt first, nothing is sent. If its turn fails to start once compaction ends, for example because credentials were removed, the message stays queued for the next turn and `prompt()` rejects with the cause.

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
- **During streaming without `streamingBehavior`**: Throws `AgentSessionBusyError` (`code: "agent_session_busy"`, guard `isAgentSessionBusyError`, both exported by `@bastani/atomic`); nothing is sent. Use `steer()` or `followUp()` directly, or specify the option.
- **`preflightResult(true)`**: Means the prompt was accepted, queued, or handled immediately.
- **`preflightResult(false)`**: Means preflight rejected before acceptance.

For explicit queueing during streaming:

```typescript
// Queue a steering message for delivery after the current assistant turn finishes its tool calls
await session.steer("New instruction");

// Wait for agent to finish (delivered only when agent stops)
await session.followUp("After you're done, also do this");
```

If the session is idle and already has messages when either is called, it starts a turn to deliver the message instead of leaving it queued. On a session with no messages yet, or after a run was stopped with `abort()`, the message stays queued until the next `prompt()`. A `prompt()` call made while that turn runs must pass `streamingBehavior`, or it fails with `AgentSessionBusyError`. Both `steer()` and `followUp()` expand file-based prompt templates but error on extension commands (extension commands cannot be queued). They return `"queued"` if the input was queued (including after an extension transformed it), or `"handled"` if an extension consumed it.

`clearQueue()` removes the queued steering and follow-up messages and returns them. `steering` and `followUp` hold each message as queued, after `input` hooks, skills and prompt templates changed it. `typed` holds the same messages, in the same order, as they were submitted: give the user those to send again, so the hooks and expansions run once more and not twice. `typed` is left out when every message was queued as submitted.

`images` holds each message's images at the same index as its text, with `undefined` for a message sent without images, so a caller that queues the messages again can give each one its own images back. It is left out when no cleared message had images. A workflow stage that gives up its session while it waits uses it, so messages queued at that moment reach the reopened session with their images.

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

### Collecting assistant output

`createTranscript()` does that bookkeeping for you. It turns session events into the assistant's output as ordered, JSON-serializable parts:

```typescript
import { createTranscript } from "@bastani/atomic";

const transcript = createTranscript();
session.subscribe((event) => transcript.apply(event));

await session.prompt("List the files here");
console.log(JSON.stringify(transcript.parts()));
```

`parts()` returns a fresh copy of the parts of every assistant message seen so far, including one still streaming:

- `{ type: "text", text }`
- `{ type: "thinking", thinking }`. Redacted thinking is left out.
- `{ type: "toolCall", id, name, arguments, result? }`. `result` appears once the tool reports progress or finishes. It holds `isError` and `isPartial`, which stays `true` until the tool finishes. If the message is aborted or fails, tool calls without a final result get an error result carrying the error message.

Events from tools called inside other tools (those with `parentToolCallId`) are ignored. By default, `result.content` holds the result's text content. To get a tool's structured `details` instead, pass `toolResult`:

```typescript
const transcript = createTranscript({
  toolResult: (toolName) => (toolName === "todo" ? "details" : "content"),
});
```

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
