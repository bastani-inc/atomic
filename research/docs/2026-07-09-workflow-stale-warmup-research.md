I’m unable to write `C:\dev\github_work\atomic-lazy-startup-worktree\research\docs\2026-07-09-workflow-stale-warmup-research.md` because this session exposes only read/search/list/todo tools and no file write/edit tool. Below is the Markdown content intended for that file.

```markdown
# Workflow Stale Warmup Research — 2026-07-09

## Analysis: Workflow lazy discovery warmup generation and stale registry publication

### Overview

The current `packages/workflows` lazy-startup implementation has already added config-only startup loading, retryable lazy discovery promise ownership, and lazy resource guards for `/workflow resume` and workflow-tool `resume`. The remaining stale-warmup path is that a background warmup from an earlier session can still execute `reloadWorkflowResourcesNow()` and mutate `configLoadRef`, `discoveryRef`, and `runtimeRef` after a later `session_start`, because generation checks only guard notification callbacks, not the reload publication itself.

### Entry Points

- `packages/workflows/src/extension/extension-runtime-state.ts:41-58` — `WorkflowExtensionRuntimeState` internal interface.
- `packages/workflows/src/extension/extension-runtime-state.ts:228-231` — `ensureWorkflowConfigLoaded()` config-only load path.
- `packages/workflows/src/extension/extension-runtime-state.ts:233-249` — reload queue and lazy promise tracking.
- `packages/workflows/src/extension/extension-runtime-state.ts:254-272` — `reloadWorkflowResourcesNow()` publishes config/discovery/runtime state.
- `packages/workflows/src/extension/extension-runtime-state.ts:274-280` — `ensureWorkflowResourcesLoaded()` on-demand lazy discovery.
- `packages/workflows/src/extension/extension-runtime-state.ts:282-312` — `startWorkflowDiscoveryWarmup()` background warmup and callback generation guard.
- `packages/workflows/src/extension/extension-lifecycle.ts:60-98` — `session_start` lifecycle sequence.
- `packages/workflows/src/extension/extension-lifecycle.ts:101-117` — `session_shutdown` lifecycle sequence.
- `test/unit/workflow-lazy-startup-continuation.test.ts:118-256` — current continuation tests for config-before-restore, retryable lazy discovery, and resume lazy loading.
- `test/unit/extension.test.ts:245-300` — current deferred discovery diagnostics test.

### Current Core Implementation

#### 1. Runtime state starts with bundled-only workflows

`createWorkflowExtensionRuntimeState()` synchronously calls `discoverStartupWorkflowsSync()` at `packages/workflows/src/extension/extension-runtime-state.ts:126`. The resulting startup registry is used to build the initial runtime at `packages/workflows/src/extension/extension-runtime-state.ts:127-139`.

The full discovery result is intentionally absent at startup: `discoveryRef` starts as `null` at `packages/workflows/src/extension/extension-runtime-state.ts:140`, and `configLoadRef` starts as `null` at `packages/workflows/src/extension/extension-runtime-state.ts:141`.

#### 2. Config-only startup load is already present

`ensureWorkflowConfigLoaded()` calls `loadWorkflowConfig()`, applies the config, and rebuilds the runtime without importing workflow modules at `packages/workflows/src/extension/extension-runtime-state.ts:228-231`.

`session_start` awaits that config-only path before persistence cleanup and restore at `packages/workflows/src/extension/extension-lifecycle.ts:60-63`. Restore then reads `runtimeState.configLoadRef.current?.config` at `packages/workflows/src/extension/extension-lifecycle.ts:84-92`.

Existing tests cover this behavior:

- `test/unit/workflow-lazy-startup-continuation.test.ts:119-137` — `persistRuns:false` is loaded before restore and does not call workflow resources.
- `test/unit/workflow-lazy-startup-continuation.test.ts:139-154` — `resumeInFlight:"auto"` is loaded before restore.
- `test/unit/workflow-lazy-startup-continuation.test.ts:156-172` — config diagnostics emit without workflow discovery.

#### 3. Retryable lazy discovery promise ownership is already present

The reload queue is maintained by `queueWorkflowResourceReload()` at `packages/workflows/src/extension/extension-runtime-state.ts:233-237`.

`trackLazyDiscovery()` stores exactly the passed promise in `lazyDiscoveryPromise` and clears it by identity in `finally` at `packages/workflows/src/extension/extension-runtime-state.ts:239-245`.

`reloadWorkflowResources()` returns the tracked queued reload at `packages/workflows/src/extension/extension-runtime-state.ts:247-249`.

`ensureWorkflowResourcesLoaded()` reuses an existing lazy promise or starts a tracked queued reload at `packages/workflows/src/extension/extension-runtime-state.ts:274-280`.

Existing test coverage:

- `test/unit/workflow-lazy-startup-continuation.test.ts:174-198` — first lazy discovery failure rejects, second `/workflow list` retries and succeeds.

#### 4. Resume lazy-loading is already present

`/workflow resume` now awaits lazy resources before run-control dispatch at `packages/workflows/src/extension/workflow-command-registration.ts:102-104`.

The workflow tool `resume` branch now awaits lazy resources before calling `workflowResumeAction()` at `packages/workflows/src/extension/workflow-tool.ts:99-101`.

Existing test coverage:

- `test/unit/workflow-lazy-startup-continuation.test.ts:199-223` — slash resume lazy-loads resources before failed-run registry lookup.
- `test/unit/workflow-lazy-startup-continuation.test.ts:226-255` — workflow tool resume lazy-loads resources before failed-run registry lookup.

### Stale Warmup Data Flow

The stale publication path is in the interaction between lifecycle generation, warmup ownership, and `reloadWorkflowResourcesNow()` publication.

1. A session starts at `packages/workflows/src/extension/extension-lifecycle.ts:60`.
2. `session_start` awaits config-only load at `packages/workflows/src/extension/extension-lifecycle.ts:62`.
3. It activates notifications at `packages/workflows/src/extension/extension-lifecycle.ts:70`, which increments `notificationGeneration` through `setNotificationsActive()` at `packages/workflows/src/extension/extension-runtime-state.ts:332-336`.
4. It starts background discovery warmup at `packages/workflows/src/extension/extension-lifecycle.ts:71-75`.
5. `startWorkflowDiscoveryWarmup()` captures the current `notificationGeneration` at `packages/workflows/src/extension/extension-runtime-state.ts:284`.
6. The warmup waits one macrotask, then queues full reload at `packages/workflows/src/extension/extension-runtime-state.ts:285-288`.
7. If a later session starts before that warmup settles, the later `session_start` may increment `notificationGeneration` through `setNotificationsActive(true)` at `packages/workflows/src/extension/extension-lifecycle.ts:70` and `packages/workflows/src/extension/extension-runtime-state.ts:332-336`.
8. The old warmup callback is suppressed because `isCurrentWarmup()` requires both `lazyDiscoveryPromise === pending` and the captured notification generation to match at `packages/workflows/src/extension/extension-runtime-state.ts:290-301`.
9. However, the old warmup still calls `queueWorkflowResourceReload()` at `packages/workflows/src/extension/extension-runtime-state.ts:287`.
10. The queue calls `reloadWorkflowResourcesNow()` at `packages/workflows/src/extension/extension-runtime-state.ts:233-235`.
11. `reloadWorkflowResourcesNow()` mutates shared runtime state with no generation/publish guard:
    - applies config at `packages/workflows/src/extension/extension-runtime-state.ts:262-263`;
    - loads package resources and discovers workflows at `packages/workflows/src/extension/extension-runtime-state.ts:269`;
    - writes `discoveryRef.current = result` at `packages/workflows/src/extension/extension-runtime-state.ts:270`;
    - rebuilds `runtimeRef.current` with `result.registry` at `packages/workflows/src/extension/extension-runtime-state.ts:271`.

### Exact Implementation Needed

#### 1. Add a discovery/session generation separate from notification generation

Add an internal generation counter in `extension-runtime-state.ts` near the existing `notificationGeneration` state at `packages/workflows/src/extension/extension-runtime-state.ts:78-80`.

Purpose:

- `notificationGeneration` currently controls whether stale warmups may notify.
- A new discovery/session generation must control whether a queued reload may publish config, discovery, and runtime mutations.
- This generation must be invalidated at the start of a later session before any awaited work.

Suggested internal shape:

```ts
let workflowDiscoveryGeneration = 0;

function currentWorkflowDiscoveryGeneration(): number {
  return workflowDiscoveryGeneration;
}

function isWorkflowDiscoveryGenerationCurrent(generation: number): boolean {
  return workflowDiscoveryGeneration === generation;
}
```

#### 2. Expose an internal lifecycle invalidation method

Extend `WorkflowExtensionRuntimeState` at `packages/workflows/src/extension/extension-runtime-state.ts:41-58` with an internal method, for example:

```ts
beginWorkflowSession(): void;
```

or:

```ts
invalidateWorkflowDiscovery(): void;
```

This is not a public `ExtensionAPI` change. The public API entries remain unchanged at `packages/workflows/src/extension/public-types.ts:173-174` and `packages/workflows/src/extension/public-types.ts:203`.

The invalidation method should:

1. Increment the workflow discovery generation.
2. Clear any tracked lazy owner so the later session can schedule its own warmup:
   ```ts
   lazyDiscoveryPromise = null;
   ```
3. Clear `discoveryRef.current` so on-demand lazy paths do not treat a previous session’s discovery as loaded:
   ```ts
   discoveryRef.current = null;
   ```
4. Rebuild the runtime back to the bundled startup registry, preserving the current config/persistence refs:
   ```ts
   rebuildRuntime(startupDiscovery.registry);
   ```

The startup bundled registry is already available as `startupDiscovery.registry` from `packages/workflows/src/extension/extension-runtime-state.ts:126-129`.

#### 3. Call invalidation at the very beginning of `session_start`

Call the new runtime-state invalidation method at the top of the `session_start` handler in `extension-lifecycle.ts`, before `await runtimeState.ensureWorkflowConfigLoaded()` at `packages/workflows/src/extension/extension-lifecycle.ts:62`.

This ordering matters because `ensureWorkflowConfigLoaded()` is awaited. If the generation is not invalidated until `setNotificationsActive(true)` at `packages/workflows/src/extension/extension-lifecycle.ts:70`, an older warmup can still publish while the later session is suspended inside config loading.

The required lifecycle order should be:

1. Invalidate workflow discovery/session generation.
2. De-advertise `ask_user_question` for headless sessions.
3. Await config-only load.
4. Clean up old runs/store/forms/controls.
5. Activate notifications.
6. Start the new session’s warmup.
7. Restore persisted runs using current config.

So the important change is around `packages/workflows/src/extension/extension-lifecycle.ts:60-63`.

#### 4. Invalidate on shutdown as well

On `session_shutdown`, call the same invalidation method before or alongside `runtimeState.setNotificationsActive(false)` at `packages/workflows/src/extension/extension-lifecycle.ts:114-117`.

This prevents an in-flight warmup from publishing after shutdown when no later `session_start` has yet occurred.

#### 5. Pass generation into queued reload work

Change the queue/reload path so each reload captures the generation at scheduling time and passes it to `reloadWorkflowResourcesNow()`.

Current flow:

- `queueWorkflowResourceReload(options)` calls `reloadWorkflowResourcesNow(options)` at `packages/workflows/src/extension/extension-runtime-state.ts:233-235`.
- `reloadWorkflowResources()` tracks that queued promise at `packages/workflows/src/extension/extension-runtime-state.ts:247-249`.
- `ensureWorkflowResourcesLoaded()` creates a queued reload at `packages/workflows/src/extension/extension-runtime-state.ts:276-278`.
- `startWorkflowDiscoveryWarmup()` queues a reload after a macrotask at `packages/workflows/src/extension/extension-runtime-state.ts:285-288`.

Needed flow:

```ts
function queueWorkflowResourceReload(
  options?: { allowInFlight?: boolean },
  generation = currentWorkflowDiscoveryGeneration(),
): Promise<void> {
  const reload = workflowReloadQueue.then(() => reloadWorkflowResourcesNow(options, generation));
  workflowReloadQueue = reload.catch(() => {});
  return reload;
}
```

Then:

- `reloadWorkflowResources()` should capture the current generation when called.
- `ensureWorkflowResourcesLoaded()` should capture the current generation when it starts a new lazy reload.
- `startWorkflowDiscoveryWarmup()` should capture the current generation before the macrotask and pass that same generation to the queued reload.

#### 6. Guard before publishing config and again before publishing discovery/runtime

`reloadWorkflowResourcesNow()` currently publishes config before discovery at `packages/workflows/src/extension/extension-runtime-state.ts:262-263`, then publishes discovery/runtime at `packages/workflows/src/extension/extension-runtime-state.ts:270-271`.

Add generation checks inside `reloadWorkflowResourcesNow()`:

1. After `loadWorkflowConfig()` returns and before `applyWorkflowConfig(configResult)`.
2. After `discoverWorkflows()` returns and before `discoveryRef.current = result` / `rebuildRuntime(result.registry)`.

Required behavior:

- If the generation is stale before config application, return without mutating `configLoadRef`, runtime config refs, notification config refs, status writer, persistence port, discovery ref, or runtime ref.
- If the generation becomes stale after config application but before discovery publication, return without writing `discoveryRef.current` or rebuilding the runtime with the stale registry.
- Current-generation reloads keep the current behavior: config is applied, discovery is saved, and runtime is rebuilt.

A safe shape:

```ts
async function reloadWorkflowResourcesNow(
  options?: { allowInFlight?: boolean },
  generation = currentWorkflowDiscoveryGeneration(),
): Promise<void> {
  const activeRuns = inFlightRunCount();
  // keep existing in-flight checks

  const configResult = await loadWorkflowConfig();
  if (!isWorkflowDiscoveryGenerationCurrent(generation)) return;

  applyWorkflowConfig(configResult);

  const hasGlobal = configResult.globalConfig != null;
  const hasProject = configResult.projectConfig != null;
  const discoveryConfig = hasGlobal || hasProject
    ? toScopedDiscoveryConfig(configResult.globalConfig ?? null, configResult.projectConfig ?? null, { projectRoot: process.cwd() })
    : undefined;

  const result = await discoverWorkflows({
    config: discoveryConfig,
    packageWorkflowPaths: await loadPackageWorkflowPaths(),
  });

  if (!isWorkflowDiscoveryGenerationCurrent(generation)) return;

  discoveryRef.current = result;
  rebuildRuntime(result.registry);
}
```

This keeps the existing public return type `Promise<void>` and avoids introducing public API changes.

#### 7. Keep retryable lazy discovery ownership unchanged

The current retryability fix should remain:

- `trackLazyDiscovery()` stores and clears one promise identity at `packages/workflows/src/extension/extension-runtime-state.ts:239-245`.
- `ensureWorkflowResourcesLoaded()` reuses or starts a tracked promise at `packages/workflows/src/extension/extension-runtime-state.ts:274-280`.

When invalidating a session, setting `lazyDiscoveryPromise = null` is compatible with the identity guard:

- the old promise’s finalizer will not clear a newer promise because `trackLazyDiscovery()` checks `lazyDiscoveryPromise === pending` at `packages/workflows/src/extension/extension-runtime-state.ts:241-242`;
- a later session can start its own warmup instead of being blocked by an old pending warmup.

#### 8. Update warmup currentness to use discovery generation for reload and notification generation for UI

`startWorkflowDiscoveryWarmup()` currently captures `notificationGeneration` at `packages/workflows/src/extension/extension-runtime-state.ts:284` and uses it in `isCurrentWarmup()` at `packages/workflows/src/extension/extension-runtime-state.ts:290`.

Needed split:

- Capture `const discoveryGeneration = currentWorkflowDiscoveryGeneration()` for reload publication.
- Optionally keep `const notificationGenerationAtSchedule = notificationGeneration` for notification callback currentness.
- Before queueing after `deferToMacrotask()`, check discovery generation. If stale, return without queueing.
- Pass the captured discovery generation into `queueWorkflowResourceReload({ allowInFlight: true }, discoveryGeneration)`.
- In the finalizer, call `onSettled` only when:
  - `lazyDiscoveryPromise === pending`;
  - discovery generation is still current;
  - notification generation is still current;
  - `notificationsActive` is true.

This preserves the existing stale-callback protection at `packages/workflows/src/extension/extension-runtime-state.ts:290-301` while adding stale-publication protection.

### Data Flow After the Fix

#### Session A warmup superseded by Session B

1. Session A starts and invalidates to generation `1`.
2. Session A schedules warmup with generation `1`.
3. Session B starts before Session A’s warmup settles.
4. Session B invalidates to generation `2`, clears `lazyDiscoveryPromise`, clears `discoveryRef.current`, and rebuilds bundled-only runtime.
5. Session B schedules its own warmup with generation `2`.
6. Session A’s warmup resumes:
   - if it has not queued reload yet, the generation check prevents queueing;
   - if it has already queued/running reload, `reloadWorkflowResourcesNow(..., 1)` returns before publishing once it sees current generation is `2`.
7. Session B’s warmup runs as generation `2` and is the only warmup allowed to publish `discoveryRef.current` and rebuild the runtime registry.

#### Explicit lazy discovery remains retryable

1. A cold `/workflow list` calls `ensureWorkflowResourcesLoaded()` at `packages/workflows/src/extension/workflow-command-registration.ts:107-108`.
2. `ensureWorkflowResourcesLoaded()` starts a tracked queued reload at `packages/workflows/src/extension/extension-runtime-state.ts:276-278`.
3. If resource loading fails, `trackLazyDiscovery()` clears `lazyDiscoveryPromise` by identity at `packages/workflows/src/extension/extension-runtime-state.ts:239-245`.
4. A later `/workflow list` starts a new reload, preserving the behavior tested at `test/unit/workflow-lazy-startup-continuation.test.ts:174-198`.

### Test Coverage Needed

Add a focused stale-warmup regression test, preferably in `test/unit/workflow-lazy-startup-continuation.test.ts` near the existing lazy startup continuation tests at `test/unit/workflow-lazy-startup-continuation.test.ts:118-256`, or in `test/unit/extension.test.ts` near the lifecycle diagnostics test at `test/unit/extension.test.ts:245-300`.

#### Test: stale warmup cannot publish old registry into later session

Behavior to verify:

- Session A starts and begins a delayed warmup resource refresh.
- Session B starts before Session A’s refresh resolves.
- Session A’s refresh resolves with an “old session” workflow.
- Session B’s warmup later resolves with a “new session” workflow.
- `/workflow list` shows the new workflow and does not show the old workflow.
- The old warmup does not set `discoveryRef.current` in a way that prevents Session B lazy discovery.

Fixture shape:

1. Register the workflows extension with `disableAsyncDiscovery: false`.
2. Implement `refreshWorkflowResources()` so:
   - call 1 returns a manually controlled promise resolving to `old-workflow.ts`;
   - call 2 returns a manually controlled promise resolving to `new-workflow.ts`.
3. Capture lifecycle handlers through `pi.on`.
4. Call `session_start` for Session A.
5. Flush the warmup macrotask so call 1 starts.
6. Call `session_start` for Session B before resolving call 1.
7. Resolve call 1 with the old workflow.
8. Flush queued work.
9. Ensure call 2 occurs.
10. Resolve call 2 with the new workflow.
11. Invoke `/workflow list`.
12. Assert:
    - rendered list includes the new workflow;
    - rendered list does not include the old workflow;
    - refresh was called twice.

This test distinguishes the desired behavior from the current implementation because the current `startWorkflowDiscoveryWarmup()` returns early for Session B when `lazyDiscoveryPromise !== null` at `packages/workflows/src/extension/extension-runtime-state.ts:283`, and Session A’s `reloadWorkflowResourcesNow()` can still publish its registry at `packages/workflows/src/extension/extension-runtime-state.ts:270-271`.

#### Test: stale warmup does not notify a later/stale UI

Existing diagnostics coverage waits for deferred diagnostics at `test/unit/extension.test.ts:291-296`.

Add a lifecycle-generation variant:

1. Session A starts with delayed invalid workflow discovery and UI A.
2. Session B starts before Session A discovery settles, using UI B.
3. Resolve Session A discovery.
4. Assert UI A receives no post-replacement discovery notification.
5. Resolve Session B discovery.
6. Assert only UI B receives current diagnostics, if diagnostics are present.

This complements the existing callback guard at `packages/workflows/src/extension/extension-runtime-state.ts:290-301`, but the main missing behavior is still reload publication guarding.

### Public API Preservation

No public API changes are required.

Keep unchanged:

- `ExtensionAPI.getWorkflowResources` at `packages/workflows/src/extension/public-types.ts:173`.
- `ExtensionAPI.refreshWorkflowResources` at `packages/workflows/src/extension/public-types.ts:174`.
- `ExtensionAPI.disableAsyncDiscovery` at `packages/workflows/src/extension/public-types.ts:203`.
- `WorkflowExtensionRuntimeState.reloadWorkflowResources(options?: { allowInFlight?: boolean }): Promise<void>` at `packages/workflows/src/extension/extension-runtime-state.ts:52`.
- `WorkflowExtensionRuntimeState.ensureWorkflowResourcesLoaded(options?: { allowInFlight?: boolean }): Promise<void>` at `packages/workflows/src/extension/extension-runtime-state.ts:51`.
- `WorkflowExtensionRuntimeState.startWorkflowDiscoveryWarmup(onSettled?: () => void): void` at `packages/workflows/src/extension/extension-runtime-state.ts:53`.

Internal-only additions are sufficient:

- a discovery/session generation counter;
- an internal lifecycle invalidation method on `WorkflowExtensionRuntimeState`;
- generation parameters inside the private queue/reload helpers.

### Minimal Implementation Checklist

1. Add `workflowDiscoveryGeneration` to `extension-runtime-state.ts`.
2. Add an internal `invalidateWorkflowDiscovery()` / `beginWorkflowSession()` method to `WorkflowExtensionRuntimeState`.
3. In that method:
   - increment discovery generation;
   - set `lazyDiscoveryPromise = null`;
   - set `discoveryRef.current = null`;
   - rebuild runtime with `startupDiscovery.registry`.
4. Call that method at the very start of `session_start`, before `await runtimeState.ensureWorkflowConfigLoaded()`.
5. Call that method on `session_shutdown` before or alongside `setNotificationsActive(false)`.
6. Pass captured discovery generation through `queueWorkflowResourceReload()` into `reloadWorkflowResourcesNow()`.
7. In `reloadWorkflowResourcesNow()`, check generation before `applyWorkflowConfig()` and before `discoveryRef.current = result` / `rebuildRuntime(result.registry)`.
8. In `startWorkflowDiscoveryWarmup()`, check generation before queueing after the macrotask and pass the captured generation to the queued reload.
9. Keep `trackLazyDiscovery()` identity cleanup unchanged so lazy discovery remains retryable.
10. Add the stale warmup regression test verifying that an old warmup cannot publish an old registry into a later session.
```