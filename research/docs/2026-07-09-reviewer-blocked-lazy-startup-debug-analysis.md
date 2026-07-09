# Reviewer-blocked lazy startup regressions — debug analysis

Date: 2026-07-09  
Working tree: `C:/dev/github_work/atomic-lazy-startup-worktree`  
Review artifact: `C:/Users/ALEXLA~1/AppData/Local/Temp/atomic-ralph-run-7AzjZ0/review-round-latest.json`  
Mode: read-only source analysis; no code/test files edited.

## Summary

All reviewer-blocked findings still apply to the current working tree. The workflow regressions come from using cold/default state before cheap config loading or full lazy discovery has completed. The MCP/workflow warmup regressions come from background callbacks mutating stale state after lifecycle cancellation or rejecting unhandled.

Evidence captured with Bun:

- `bun test test/unit/extension.test.ts` still fails at `test/unit/extension.test.ts:283`: startup discovery diagnostics are absent when `session_start` returns.
- `persistRuns:false` project config is still ignored during `session_start` restore: an in-flight session entry restores as failed because `configLoadRef.current` is `null` at `packages/workflows/src/extension/extension-lifecycle.ts:84-90`.
- A transient `refreshWorkflowResources()` rejection still poisons future lazy discovery: two `/workflow list` attempts rethrew the first error and `refreshCalls=1`.
- `workflow` tool `action:"resume"` still returns `workflow_not_found` from a cold registry and does not call the lazy guard (`ensureCalls=0`).
- `/workflow resume <runId>` still returns `workflow_not_found` from a cold registry and does not call workflow resource refresh (`refreshCalls=0`).
- MCP startup warmup still writes metadata after cancellation while `connect()` is in flight (`state.toolMetadata.size === 1` in a fake delayed-manager repro).
- Workflow discovery warmup can still produce an unhandled rejection when its stale `ctx.ui.notify` callback throws.

## 1. Workflow config is loaded after persisted restore

**Status:** still applies. **Impact:** `persistRuns:false` and non-default `resumeInFlight` are ignored during startup restore.

### Code evidence

- `packages/workflows/src/extension/extension-lifecycle.ts:70-74` schedules `runtimeState.startWorkflowDiscoveryWarmup(...)` but does not wait for config loading.
- `packages/workflows/src/extension/extension-lifecycle.ts:83-93` immediately calls `restoreOnSessionStart(...)` with defaults when `runtimeState.configLoadRef.current` is `null`.
- `configLoadRef` starts as `null` at `packages/workflows/src/extension/extension-runtime-state.ts:138-139`.
- `loadWorkflowConfig()` is only reached inside full reload/discovery at `packages/workflows/src/extension/extension-runtime-state.ts:217-238`, called by the background path at `:260-265`.

### Root cause

The lazy-startup change coupled cheap config loading to heavy workflow discovery. `session_start` now restores persisted runs before config has been loaded, so restore falls back to `{ resumeInFlight: "ask", persistRuns: true }`.

### Required code changes

1. In `packages/workflows/src/extension/extension-runtime-state.ts`:
   - Add `ensureWorkflowConfigLoaded(): Promise<void>` to `WorkflowExtensionRuntimeState` near `:41-57`.
   - Extract the config-application portion of `reloadWorkflowResourcesNow` (`:217-238`) into a helper that updates `configLoadRef`, `runtimeConfigRef`, lifecycle notification config/installers, `statusWriterRef`, and `persistenceRef` without importing workflow modules.
   - Have `reloadWorkflowResourcesNow` call that helper with a fresh/forced config load, then perform `discoverWorkflows(...)` and rebuild `runtimeRef.current` at `:239-249`.
2. In `packages/workflows/src/extension/extension-lifecycle.ts`:
   - Around `:69-83`, call and await `runtimeState.ensureWorkflowConfigLoaded()` before formatting startup diagnostics and before `restoreOnSessionStart(...)`.
   - Keep workflow module discovery in the later warmup; only config file loading should become synchronous-for-restore.

### Tests to add

In `test/unit/extension.test.ts`, add focused `session_start` restore tests:

- Temp project with `.atomic/extensions/workflow/config.json` containing `{ "persistRuns": false }`; fake `sessionManager.getEntries()` contains an in-flight `workflow.run.start`; after `session_start`, assert `store.runs().length === 0`.
- Temp project with `{ "resumeInFlight": "auto" }`; same in-flight entry; after `session_start`, assert the restored run is `running`, not failed.

## 2. Startup diagnostics test compatibility

**Status:** still applies; reproduced. **Current failure:** `bun test test/unit/extension.test.ts` fails at `test/unit/extension.test.ts:283`.

### Code/test mismatch

- `packages/workflows/src/extension/extension-lifecycle.ts:70-74` schedules discovery diagnostics for later.
- `packages/workflows/src/extension/extension-lifecycle.ts:75-77` checks diagnostics immediately, but `discoveryRef.current` is still `null`.
- `test/unit/extension.test.ts:236-290` still expects the discovery warning immediately after `await sessionStart(...)`; the failing assertion is at `:282-286`.

### Required test change

Update `test/unit/extension.test.ts:236-290` to assert eventual diagnostics:

- Add a small polling helper such as `waitForNotification(predicate, timeoutMs = 1000)`.
- After `await sessionStart(...)`, wait until a notification includes `Workflow discovery diagnostics`.
- Keep the existing assertions on warning type, `invalid-shape.js`, and `missing or incorrect __piWorkflow sentinel`.

This preserves the intended non-blocking startup behavior while keeping user-facing diagnostics covered.

## 3. Failed lazy discovery is not retryable

**Status:** still applies. **Impact:** one transient resource refresh failure can permanently break `/workflow list`, completions, and tool paths for the process.

### Code evidence

- `packages/workflows/src/extension/extension-runtime-state.ts:188-190` defines `workflowReloadQueue` and `lazyDiscoveryPromise`.
- `reloadWorkflowResources(...)` at `:195-204` creates an inner `reload` promise, stores it in `lazyDiscoveryPromise`, and clears only if `lazyDiscoveryPromise === reload`.
- `ensureWorkflowResourcesLoaded(...)` at `:252-257` assigns `lazyDiscoveryPromise = reloadWorkflowResources(...)`. Because `reloadWorkflowResources` is `async`, this overwrites the inner `reload` with the outer promise.

### Root cause

The cleanup checks the inner promise identity, but callers cache the outer async-function promise. On failure, the `finally` check does not clear `lazyDiscoveryPromise`, so future explicit loads await the same rejected promise and never call `refreshWorkflowResources()` again.

### Required code changes

Refactor `packages/workflows/src/extension/extension-runtime-state.ts:195-257` so only one promise identity is tracked:

- Add a queue-only helper, e.g. `queueWorkflowResourceReload(options): Promise<void>`, that updates `workflowReloadQueue` but does not mutate `lazyDiscoveryPromise`.
- Add a tracker helper that assigns a single promise to `lazyDiscoveryPromise` and clears it in `finally` if still current.
- Make `reloadWorkflowResources(...)` return the tracked promise instead of an `async` wrapper with a different identity.
- Make `ensureWorkflowResourcesLoaded(...)` use `const pending = lazyDiscoveryPromise ?? reloadWorkflowResources({ allowInFlight: options?.allowInFlight ?? true }); await pending;` without its own assignment.

### Tests to add

Add near the lazy list coverage in `test/unit/slash-dispatch-headless-basic.ts:213-239` or a new focused workflow lazy-discovery test:

- Register the workflow extension without calling `session_start`.
- `pi.refreshWorkflowResources` throws on first call and returns a valid package workflow path on second call.
- First `/workflow list` rejects with the transient error.
- Second `/workflow list` succeeds, `refreshCalls === 2`, and the workflow appears in the list.

## 4. Workflow tool `resume` does not lazy-load definitions

**Status:** still applies. **Impact:** cold `workflow` tool resume can return `workflow_not_found` for a package/project workflow that lazy discovery would load.

### Code evidence

- `packages/workflows/src/extension/workflow-tool.ts:55-62` guards `get`, `list`, `inputs`, and `run` with `await ensureWorkflowResourcesLoaded()`.
- `packages/workflows/src/extension/workflow-tool.ts:99-100` calls `workflowResumeAction(args, { runtime: getRuntime(), policy })` without the guard.
- `packages/workflows/src/extension/workflow-tool-control.ts:186-188` calls `deps.runtime.resumeFailedRun(...)` for failed continuations.
- `packages/workflows/src/extension/runtime.ts:352-354` returns `workflow_not_found` when the current registry lacks the workflow definition.

### Required code change

In `packages/workflows/src/extension/workflow-tool.ts:99-100`, change the `resume` branch to await lazy resources before reading the runtime:

- `await ensureWorkflowResourcesLoaded();`
- then `return workflowResumeAction(args, { runtime: getRuntime(), policy });`

Do not add this guard to purely store-based actions such as `status`, `pause`, `kill`, or `interrupt`.

### Tests to add

Add next to existing continuation tests in `test/unit/slash-dispatch-tool-continuation-failed.ts:127-236`:

- Create a failed resumable run whose `name` matches a workflow definition absent from the initial runtime registry.
- Use a runtime provider that initially returns an empty registry.
- Have `ensureWorkflowResourcesLoaded` swap the provider to a runtime containing the workflow definition.
- Call `{ action: "resume", runId }`.
- Assert `ensureCalls === 1` and the result starts a continuation instead of returning `workflow_not_found`.

## 5. `/workflow resume` does not lazy-load definitions

**Status:** still applies. **Impact:** explicit slash resume paths can fail before the registry is hydrated.

### Code evidence

- `packages/workflows/src/extension/workflow-command-registration.ts:102-104` dispatches `connect`, `attach`, `pause`, and `resume` to `handleRunControlCommand(...)` before any lazy resource guard.
- `packages/workflows/src/extension/workflow-run-control-command.ts:399-401` calls `deps.runtimeForContext(ctx).resumeFailedRun(...)` for failed resumable continuations.
- Durable resume also depends on the current registry: `workflow-run-control-command.ts:64-69` filters prepared durable entries against `runtime.registry`, and `:304-309` does the same for the interactive selector.

### Required code change

In `packages/workflows/src/extension/workflow-command-registration.ts:100-105`, add a guard for resume before run-control dispatch:

- If `subcommand === "resume"`, `await deps.ensureWorkflowResourcesLoaded()`.
- Then call `handleRunControlCommand(...)` as today.
- Leave `connect`, `attach`, and `pause` unblocked unless separate tests show they need discovery.

### Tests to add

Add a cold slash-resume test in `test/unit/slash-dispatch-resume.ts` near `:68-164` or in `test/unit/slash-dispatch-headless-control.ts`:

- Create a valid package workflow fixture matching a failed resumable stored run.
- Register the factory with `pi.refreshWorkflowResources` returning that fixture.
- Call `/workflow resume <runId>` immediately while discovery is cold.
- Assert `refreshCalls === 1` and the command does not throw/report `workflow_not_found`.
- Add a durable-resume variant if feasible: a durable catalog entry whose workflow name only exists in a lazy resource should list/resume after discovery.

## 6. MCP warmup mutates state after cancellation during `connect()`

**Status:** still applies. **Impact:** shutdown/restart can leave stale MCP connections and direct-tool cache/metadata behind.

### Code evidence

- `packages/mcp/startup-warmup.ts:41-51` checks `shouldContinue()` before `state.manager.connect(...)`, but not immediately after the awaited connect returns.
- After connect returns, it builds metadata and writes `state.toolMetadata`/cache at `:48-50`.
- Real `McpServerManager.connect()` inserts the connection before returning at `packages/mcp/server-manager.ts:61-64`.
- `packages/mcp/server-manager.ts:297-308` has `manager.close(name)` to remove and close that connection.

### Required code change

In `packages/mcp/startup-warmup.ts:46-51`:

- Immediately after `const connection = await state.manager.connect(name, definition);`, check `if (!shouldContinue())`.
- If cancelled, close/discard the connection before touching metadata/cache:
  - Prefer `await state.manager.close(name).catch(...)`, since real `connect()` has inserted the connection.
  - Optionally fall back to `connection.client.close()` / `connection.transport.close()` for fakes or unexpected manager behavior.
- Return `{ name, ok: false }` after closing.
- Only then handle `needs-auth`, build metadata, mutate `state.toolMetadata`, and call `updateMetadataCache(...)`.

Also consider hardening `packages/mcp/index.ts:206-209` so `onDirectToolsChanged` re-checks generation/state inside the callback before registering direct tools.

### Tests to add

Extend `test/unit/mcp-lazy-startup.test.ts` after the existing tests at `:44-88`:

- Temporarily unset/restore `MCP_DIRECT_TOOLS` because this environment may set it to `__none__`.
- Build a fake `McpExtensionState` with a `directTools:true` server and a manager whose `connect()` blocks until the test resolves it.
- Schedule `scheduleMcpStartupWarmup(state)`.
- Wait until `connect()` starts, call `handle.cancel()`, then resolve the connection.
- Assert `state.toolMetadata.size === 0`, the fake connection/manager was closed, and `onDirectToolsChanged` was not called.

## 7. Workflow warmup callbacks can outlive sessions and reject unhandled

**Status:** still applies. **Impact:** background discovery can call stale `ctx.ui` after session replacement/shutdown and produce unhandled promise rejections.

### Code evidence

- `packages/workflows/src/extension/extension-lifecycle.ts:70-74` passes an `onSettled` callback that closes over `ctx` and calls `ctx.ui.notify`.
- `packages/workflows/src/extension/extension-runtime-state.ts:266-276` attaches `.catch(...).finally(...)` to `lazyDiscoveryPromise`, but does not catch the promise returned by `.finally(...)`.
- The finalizer calls `onSettled?.()` with no lifecycle generation guard and no `try/catch`.
- `session_shutdown` only calls `runtimeState.setNotificationsActive(false)` at `packages/workflows/src/extension/extension-lifecycle.ts:115`; the pending callback still runs later.

### Required code changes

In `packages/workflows/src/extension/extension-runtime-state.ts`:

- Add a workflow warmup/lifecycle generation counter near `notificationsActive` (`:77`), incremented on every `setNotificationsActive(...)` call (`:296-300`) so repeated `session_start` and shutdown invalidate old callbacks.
- In `startWorkflowDiscoveryWarmup(...)` (`:260-276`), capture the generation at schedule time.
- In the finalizer:
  - Always clear `lazyDiscoveryPromise` if it is still the scheduled warmup promise.
  - Skip `onSettled` if the generation is stale or `notificationsActive` is false.
  - Wrap `onSettled?.()` in `try/catch` and debug-log failures instead of rejecting.
  - Add a terminal `.catch(...)` to the `.finally(...)` chain as defense in depth.

`packages/workflows/src/extension/extension-lifecycle.ts:70-74` can keep a small callback, but runtime-state should catch stale `ctx.ui` access. A local `try/catch` around the callback body is also acceptable.

### Tests to add

Add to `test/unit/extension.test.ts`:

1. **No unhandled rejection from stale notification**
   - Create invalid workflow config or an invalid workflow resource so background diagnostics are non-empty.
   - Pass `ctx.ui.notify` that throws `new Error("extension ctx is stale: notify")`.
   - Attach `process.on("unhandledRejection", handler)`, call `session_start`, wait a short tick/timeout, remove the handler.
   - Assert no unhandled rejection was captured.
2. **No stale-session notification after shutdown/restart**
   - Make resource discovery slow.
   - Start session A, then call `session_shutdown` or a new `session_start` before discovery settles.
   - Resolve discovery and assert the stale session UI did not receive diagnostics.

## Validation commands after implementing fixes

Run from `C:/dev/github_work/atomic-lazy-startup-worktree`:

```bash
bun test test/unit/extension.test.ts
bun test test/unit/mcp-lazy-startup.test.ts
bun test test/unit/slash-dispatch-headless-basic.ts test/unit/slash-dispatch-resume.ts test/unit/slash-dispatch-tool-continuation-failed.ts
bun test test/unit/slash-dispatch-headless-control.ts test/unit/slash-dispatch-tool-reload-resume.ts
bun run typecheck
bun run check:file-length
```

If new tests are placed in a new focused file, include that file in the focused `bun test` command as well.
