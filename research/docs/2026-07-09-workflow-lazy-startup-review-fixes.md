I’m unable to create `C:\dev\github_work\atomic-lazy-startup-worktree\research\docs\2026-07-09-workflow-lazy-startup-review-fixes.md` because this session exposes only read/search/list/todo tools and no file write/edit tool. Below is the exact Markdown content intended for that file.

```markdown
# Workflow Lazy Startup Review Fixes — 2026-07-09

## Analysis: packages/workflows Lazy Discovery Review Fixes

### Overview

The current workflow extension now seeds startup with bundled workflows synchronously and defers full workflow discovery to a later async warmup or to on-demand command/tool paths. The implementation preserves the public `ExtensionAPI` resource contract (`getWorkflowResources`, `refreshWorkflowResources`, and `disableAsyncDiscovery`) while routing lazy discovery through internal runtime-state methods.

Reviewer findings identify that some paths still assume startup discovery/config has completed: session restore reads config before lazy config is loaded, failed lazy discovery can become permanently sticky, `/workflow resume` and workflow-tool `resume` do not load definitions before registry-dependent resume, and background warmup promise/callback handling can be stale.

---

## Entry Points

- `packages/workflows/src/extension/extension-factory.ts:77` — extension factory creates runtime state and wires tool/command/lifecycle handlers.
- `packages/workflows/src/extension/extension-runtime-state.ts:59` — `createWorkflowExtensionRuntimeState()` owns lazy config/discovery state.
- `packages/workflows/src/extension/extension-lifecycle.ts:60` — `session_start` handler clears/restores workflow state and starts lazy discovery warmup.
- `packages/workflows/src/extension/workflow-command-registration.ts:50` — registers `/workflow` slash command and completion handler.
- `packages/workflows/src/extension/workflow-tool.ts:30` — builds the registered `workflow` LLM tool executor.
- `packages/workflows/src/extension/workflow-run-control-command.ts:112` — handles `/workflow connect|attach|pause|resume|interrupt|kill`.
- `packages/workflows/src/extension/discovery.ts:291` — full async workflow discovery from settings/project/global/package/bundled sources.
- `packages/workflows/src/extension/discovery.ts:405` — synchronous startup seed discovery from bundled manifest only.
- `packages/workflows/src/extension/config-loader.ts:356` — workflow config loader.
- `test/unit/extension.test.ts:236` — existing startup diagnostics test affected by deferred discovery.
- `test/unit/slash-dispatch-headless-basic.ts:213` — current lazy package-workflow discovery regression test for `/workflow list`.
- `test/unit/slash-dispatch-interrupt.ts:343` — current reload/refresh package-resource test.
- `test/unit/slash-dispatch-tool-reload-resume.ts:159` — current registered workflow-tool reload/refresh package-resource test.

---

## Core Implementation

### 1. Runtime state seeds only bundled workflows synchronously

`createWorkflowExtensionRuntimeState()` calls `discoverStartupWorkflowsSync()` during factory setup (`packages/workflows/src/extension/extension-runtime-state.ts:124`). That function delegates to `discoverBundledManifest()` (`packages/workflows/src/extension/discovery.ts:405-407`), which iterates only the bundled manifest exports (`packages/workflows/src/extension/discovery.ts:409-423`).

The startup runtime is created from that bundled-only registry (`packages/workflows/src/extension/extension-runtime-state.ts:125-137`). Full discovery is not performed at factory time.

### 2. Full discovery is deferred through `reloadWorkflowResourcesNow()`

`reloadWorkflowResourcesNow()` performs the full load path:

1. Blocks reload when in-flight workflows exist unless `allowInFlight` is true (`packages/workflows/src/extension/extension-runtime-state.ts:210-216`).
2. Loads workflow config via `loadWorkflowConfig()` (`packages/workflows/src/extension/extension-runtime-state.ts:217`).
3. Converts separate global/project config into scoped discovery config (`packages/workflows/src/extension/extension-runtime-state.ts:219-223`).
4. Loads package workflow paths through `refreshWorkflowResources()` or `getWorkflowResources()` (`packages/workflows/src/extension/extension-runtime-state.ts:205-208`, `224`).
5. Calls `discoverWorkflows()` with config and package paths (`packages/workflows/src/extension/extension-runtime-state.ts:224`).
6. Stores diagnostics/results (`packages/workflows/src/extension/extension-runtime-state.ts:218`, `225`).
7. Applies effective runtime config and recreates status writer, persistence port, and runtime (`packages/workflows/src/extension/extension-runtime-state.ts:226-249`).

### 3. Discovery source precedence is preserved

`discoverWorkflows()` applies source precedence in the documented order:

1. settings-project (`packages/workflows/src/extension/discovery.ts:321-329`)
2. project-local (`packages/workflows/src/extension/discovery.ts:331-335`)
3. settings-global (`packages/workflows/src/extension/discovery.ts:337-345`)
4. user-global (`packages/workflows/src/extension/discovery.ts:347-351`)
5. package workflows (`packages/workflows/src/extension/discovery.ts:353-360`)
6. bundled workflows (`packages/workflows/src/extension/discovery.ts:362-384`)

Duplicate handling is first-seen-wins through `registry.has(key)` checks in `applyBatch()` (`packages/workflows/src/extension/discovery.ts:210-218`) and bundled merge checks (`packages/workflows/src/extension/discovery.ts:366-376`).

### 4. Config loader keeps global/project scopes separate

`loadWorkflowConfig()` loads global candidates first (`packages/workflows/src/extension/config-loader.ts:364-382`) and project candidates second (`packages/workflows/src/extension/config-loader.ts:384-395`). It returns merged config plus separate `globalConfig` and `projectConfig` fields (`packages/workflows/src/extension/config-loader.ts:409-414`).

`toScopedDiscoveryConfig()` resolves project workflow paths relative to project root and global workflow paths relative to the agent dir, excluding global entries shadowed by project keys (`packages/workflows/src/extension/config-loader.ts:310-342`).

### 5. Slash command lazy loading is partial

The `/workflow` command completion handler loads workflow resources only when completions need workflow definitions (`packages/workflows/src/extension/workflow-command-registration.ts:61-65`). The predicate returns false for status/control/reload subcommands (`packages/workflows/src/extension/workflow-command-completions.ts:54-63`).

The command handler explicitly calls `ensureWorkflowResourcesLoaded()` for:

- `/workflow list` (`packages/workflows/src/extension/workflow-command-registration.ts:106-108`)
- `/workflow inputs <name>` via `showWorkflowInputs()` (`packages/workflows/src/extension/workflow-command-registration.ts:83-88`, `151-155`)
- interactive input picker schema lookup (`packages/workflows/src/extension/workflow-command-registration.ts:171-173`)
- normal workflow run dispatch (`packages/workflows/src/extension/workflow-command-registration.ts:195-198`)

It does not call `ensureWorkflowResourcesLoaded()` before routing control commands including `resume` (`packages/workflows/src/extension/workflow-command-registration.ts:102-105`).

### 6. Workflow tool lazy loading is partial

The workflow tool calls `ensureWorkflowResourcesLoaded()` for `get`, `list`, `inputs`, and `run` (`packages/workflows/src/extension/workflow-tool.ts:55-62`). It does not call it for `resume`; `resume` directly calls `workflowResumeAction()` with the current runtime (`packages/workflows/src/extension/workflow-tool.ts:99-100`).

This matters because `resumeFailedRun()` resolves the workflow definition from the runtime registry (`packages/workflows/src/extension/runtime.ts:342-355`), and durable resume passes the registry to the durable resume adapter (`packages/workflows/src/extension/runtime.ts:475-481`).

### 7. Session lifecycle currently starts warmup before restore but does not await config

On `session_start`, the lifecycle handler:

1. De-advertises `ask_user_question` in headless mode (`packages/workflows/src/extension/extension-lifecycle.ts:60-62`).
2. Kills/clears existing workflow state using the current persistence port (`packages/workflows/src/extension/extension-lifecycle.ts:62-67`).
3. Enables notifications (`packages/workflows/src/extension/extension-lifecycle.ts:68-69`).
4. Starts lazy workflow discovery warmup (`packages/workflows/src/extension/extension-lifecycle.ts:70-74`).
5. Emits immediate diagnostics from current refs (`packages/workflows/src/extension/extension-lifecycle.ts:75-80`).
6. Restores persisted runs using `runtimeState.configLoadRef.current?.config` (`packages/workflows/src/extension/extension-lifecycle.ts:83-95`).

Because `startWorkflowDiscoveryWarmup()` defers work to a macrotask (`packages/workflows/src/extension/extension-runtime-state.ts:260-265`), `configLoadRef.current` is still usually null when restore reads it. Restore then falls back to `{ resumeInFlight: "ask", persistRuns: true }` (`packages/workflows/src/extension/extension-lifecycle.ts:84-91`).

---

## Reviewer Findings and Required Fixes

### Finding 1: Config must load before session restore

#### Existing behavior

`session_start` reads restore config from `runtimeState.configLoadRef.current?.config` (`packages/workflows/src/extension/extension-lifecycle.ts:83-91`), but the only current loader path is full lazy discovery (`packages/workflows/src/extension/extension-runtime-state.ts:217-224`). That path is scheduled after a macrotask in `startWorkflowDiscoveryWarmup()` (`packages/workflows/src/extension/extension-runtime-state.ts:260-265`).

Resulting data flow:

1. `session_start` starts (`packages/workflows/src/extension/extension-lifecycle.ts:60`).
2. Warmup is scheduled but not awaited (`packages/workflows/src/extension/extension-lifecycle.ts:70-74`).
3. Restore reads `configLoadRef.current?.config`, normally null (`packages/workflows/src/extension/extension-lifecycle.ts:83-91`).
4. `restoreOnSessionStart()` receives fallback values (`packages/workflows/src/extension/extension-lifecycle.ts:89-90`).
5. Actual config is loaded later by `reloadWorkflowResourcesNow()` (`packages/workflows/src/extension/extension-runtime-state.ts:217-238`).

#### Required implementation change

Add an internal config-only load path in `extension-runtime-state.ts` that:

- Calls `loadWorkflowConfig()` without importing workflow modules.
- Updates `configLoadRef.current`.
- Applies `withWorkflowDefaults()` to update:
  - runtime config ref,
  - lifecycle notification config ref,
  - status writer,
  - persistence port.
- Does not call `discoverWorkflows()`.
- Is safe to call repeatedly and before full discovery.

Then call that config-only loader from `session_start` before:

- `killAllRuns(... persistence: runtimeState.persistenceRef.current)` at `packages/workflows/src/extension/extension-lifecycle.ts:62`
- `restoreOnSessionStart()` at `packages/workflows/src/extension/extension-lifecycle.ts:86-93`

This preserves the public API because the change is internal to `WorkflowExtensionRuntimeState`.

#### Focused tests needed

Add/update `test/unit/extension.test.ts`:

- Test: `session_start loads workflow config before restore without evaluating workflow modules`.
- Fixture:
  - Create project config with `resumeInFlight: "auto"` or `persistRuns: false`.
  - Provide a session manager with an in-flight `workflow.run.start` entry.
  - Trigger captured `session_start`.
- Assert:
  - Restore observes configured `resumeInFlight`, not default `"ask"`.
  - No package workflow module marker is evaluated during config-only load.
  - Existing public `ExtensionAPI` shape is unchanged.

---

### Finding 2: Startup diagnostics must remain observable after deferred discovery

#### Existing behavior

Diagnostics formatting is null-safe: it reads config diagnostics and discovery diagnostics with optional chaining (`packages/workflows/src/extension/workflow-command-surfaces.ts:48-59`).

`session_start` currently emits diagnostics twice:

- immediately from current refs (`packages/workflows/src/extension/extension-lifecycle.ts:75-80`)
- later from warmup callback (`packages/workflows/src/extension/extension-lifecycle.ts:70-74`)

The existing test `session_start warns when discovered workflows fail validation` expects a discovery warning immediately after awaiting `session_start` (`test/unit/extension.test.ts:236-290`). With lazy discovery, invalid package workflow evaluation happens after deferred warmup, so the immediate assertion can miss the warning.

#### Required implementation change

Keep diagnostics compatible by preserving both channels:

1. Immediate diagnostics after config-only load for config errors.
2. Deferred diagnostics after workflow discovery warmup for discovery/import/validation errors.

The warmup callback should only notify for the active warmup generation/promise so stale warmups do not emit stale diagnostics.

#### Focused tests needed

Update `test/unit/extension.test.ts:236-290` rather than restoring eager workflow module evaluation:

- Keep the invalid workflow resource fixture.
- Trigger `session_start`.
- Wait for the deferred warmup notification path.
- Assert:
  - notification type is `"warning"`;
  - message includes `Workflow discovery diagnostics`;
  - message includes invalid file name;
  - message includes validation reason.

Add a separate config-only diagnostics test:

- Invalid config JSON/shape should notify during session startup without package workflow evaluation.

---

### Finding 3: Failed lazy discovery can become permanently sticky

#### Existing behavior

`ensureWorkflowResourcesLoaded()` stores a lazy promise when discovery has not completed (`packages/workflows/src/extension/extension-runtime-state.ts:252-258`).

`reloadWorkflowResources()` also writes `lazyDiscoveryPromise = reload` while running (`packages/workflows/src/extension/extension-runtime-state.ts:195-203`).

The current promise ownership can leave a rejected outer promise in `lazyDiscoveryPromise`:

1. `ensureWorkflowResourcesLoaded()` calls `reloadWorkflowResources()` on the RHS (`packages/workflows/src/extension/extension-runtime-state.ts:254-255`).
2. `reloadWorkflowResources()` internally assigns `lazyDiscoveryPromise = reload` (`packages/workflows/src/extension/extension-runtime-state.ts:198`).
3. `ensureWorkflowResourcesLoaded()` assigns the returned outer promise to `lazyDiscoveryPromise` (`packages/workflows/src/extension/extension-runtime-state.ts:255`).
4. `reloadWorkflowResources()` finally compares against the inner `reload` promise and does not clear the outer promise (`packages/workflows/src/extension/extension-runtime-state.ts:201-203`).
5. Future `ensureWorkflowResourcesLoaded()` calls await the same rejected promise instead of retrying (`packages/workflows/src/extension/extension-runtime-state.ts:254-257`).

#### Required implementation change

Refactor lazy discovery promise ownership so only the function that creates a lazy promise clears that same promise by identity.

Required behavior:

- On success: `discoveryRef.current` becomes non-null and subsequent ensure returns.
- On failure: `lazyDiscoveryPromise` is cleared, allowing a later ensure to retry.
- Explicit `/workflow reload` and workflow-tool reload should not poison lazy ensure state after failure.
- Keep `workflowReloadQueue` serialization (`packages/workflows/src/extension/extension-runtime-state.ts:188-197`).

A safe shape is:

- keep `reloadWorkflowResources()` as the explicit reload API;
- do not let it overwrite an existing lazy owner promise unless deliberately called as a lazy load;
- in `ensureWorkflowResourcesLoaded()`, assign a local promise and clear only if `lazyDiscoveryPromise === localPromise`.

#### Focused tests needed

Add slash-dispatch test using package resources:

- First `pi.getWorkflowResources()` or `pi.refreshWorkflowResources()` throws.
- First `/workflow list` observes the failure path.
- Second call returns a valid workflow resource.
- Second `/workflow list` succeeds and includes the workflow.

Add workflow-tool test:

- Registered `workflow` tool `action: "list"` first fails lazy discovery.
- Second call retries and succeeds.

---

### Finding 4: Stale workflow warmup callback/error guards are missing

#### Existing behavior

`startWorkflowDiscoveryWarmup()` assigns `lazyDiscoveryPromise` to an async IIFE (`packages/workflows/src/extension/extension-runtime-state.ts:260-265`), then unconditionally clears it and calls `onSettled` in `.finally()` (`packages/workflows/src/extension/extension-runtime-state.ts:273-276`).

Because `reloadWorkflowResources()` also mutates `lazyDiscoveryPromise` (`packages/workflows/src/extension/extension-runtime-state.ts:198`), a stale warmup can clear or report after another discovery attempt has taken ownership.

#### Required implementation change

Guard warmup catch/finally by promise identity or generation:

- Capture the warmup promise in a local.
- In `.catch()`, log only if the warmup is still current.
- In `.finally()`, clear `lazyDiscoveryPromise` and call `onSettled` only if the warmup is still current.
- Do not let a stale warmup callback emit diagnostics for a later session/discovery state.

This can share the same promise ownership helper as the retryability fix.

#### Focused tests needed

Add `extension.test.ts` or slash-dispatch test:

- Start session warmup with a delayed package resource discovery.
- Trigger another on-demand discovery before warmup settles.
- Resolve the stale warmup.
- Assert:
  - active discovery promise is not cleared by stale warmup;
  - diagnostics callback is emitted once for the active discovery;
  - stale errors do not log/notify.

---

### Finding 5: `/workflow resume` needs on-demand workflow loading

#### Existing behavior

`workflowSlashHandler()` routes `resume` directly to `handleRunControlCommand()` before any resource ensure (`packages/workflows/src/extension/workflow-command-registration.ts:100-105`).

`handleRunControlCommand()` then resolves durable and failed-run resume through the current runtime registry:

- durable resume uses `deps.runtimeForContext(ctx)` (`packages/workflows/src/extension/workflow-run-control-command.ts:64`);
- durable preparation and filtering happen before resume (`packages/workflows/src/extension/workflow-run-control-command.ts:66-70`);
- failed resumable live runs call `resumeFailedRun()` (`packages/workflows/src/extension/workflow-run-control-command.ts:328-330`, `399-401`);
- durable target fallback is used when a live run is not found (`packages/workflows/src/extension/workflow-run-control-command.ts:347-353`).

`resumeFailedRun()` requires the workflow definition to exist in the registry (`packages/workflows/src/extension/runtime.ts:352-355`). Durable resume also receives the current registry (`packages/workflows/src/extension/runtime.ts:475-481`).

With lazy startup, custom/package workflow definitions may not be in the runtime when `/workflow resume` runs.

#### Required implementation change

Extend `WorkflowRunControlDeps` with an internal `ensureWorkflowResourcesLoaded` callback.

In `/workflow resume` paths only:

- call `ensureWorkflowResourcesLoaded()` before durable listing/preparation/resume;
- call it before `resumeFailedRun()` continuation paths.

Do not force discovery for `connect`, `attach`, `pause`, `interrupt`, or `kill`, because those operate on live store state and should remain lightweight.

This preserves public APIs: `WorkflowRunControlDeps` is internal to the workflows extension wiring.

#### Focused tests needed

Add slash-dispatch resume tests:

1. `/workflow resume <failed-run-id>`:
   - Seed store with failed resumable run whose `name` is from a package workflow resource.
   - Do not pre-load discovery.
   - Invoke `/workflow resume <id>`.
   - Assert package workflow resource is evaluated/loaded before `resumeFailedRun()` and result is not `workflow_not_found`.

2. `/workflow resume <durable-workflow-id>`:
   - Prepare durable metadata for a workflow supplied only by package resource.
   - Invoke resume without prior `/workflow list`.
   - Assert discovery occurs and resume uses the package workflow definition.

---

### Finding 6: Workflow tool `resume` needs on-demand workflow loading

#### Existing behavior

`makeExecuteWorkflowTool()` ensures resources for `get`, `list`, `inputs`, and `run` (`packages/workflows/src/extension/workflow-tool.ts:55-62`) but not for `resume` (`packages/workflows/src/extension/workflow-tool.ts:99-100`).

The resume action can call `runtime.resumeFailedRun()` for failed resumable runs (`packages/workflows/src/extension/workflow-tool-control.ts:169-193`). That runtime method requires `registry.get(source.name)` (`packages/workflows/src/extension/runtime.ts:352-355`).

#### Required implementation change

In `workflow-tool.ts`, call `ensureWorkflowResourcesLoaded()` before `workflowResumeAction()`.

Keep non-registry inspection/control actions lightweight:

- `status`
- `stages`
- `stage`
- `transcript`
- `send`
- `pause`
- `interrupt`
- `kill`

#### Focused tests needed

Add registered workflow tool test:

- Create package workflow resource with marker.
- Seed failed resumable run named after that workflow.
- Invoke registered `workflow` tool with `{ action: "resume", runId }` before `/workflow list`.
- Assert marker increments once and result is not `workflow_not_found`.

Also add failure/retry variant if first resource refresh throws, mirroring Finding 3.

---

### Finding 7: MCP startup warmup needs post-connect cancellation cleanup

#### Existing behavior

`packages/mcp/startup-warmup.ts` schedules background direct-tool warmup after a macrotask (`packages/mcp/startup-warmup.ts:22-31`). It checks `shouldContinue()` before connecting each server (`packages/mcp/startup-warmup.ts:41-47`) and after all results (`packages/mcp/startup-warmup.ts:59-66`).

Inside the per-server task, after `state.manager.connect()` returns, metadata is built and state/cache are mutated without another cancellation check (`packages/mcp/startup-warmup.ts:45-51`).

The MCP extension stores a cancel handle in `startupWarmupCancel` (`packages/mcp/index.ts:206-210`) and cancels it on new session start or shutdown (`packages/mcp/index.ts:133-145`, `239-244`). The handle is not cleared when warmup settles.

#### Required implementation change

In `scheduleMcpStartupWarmup()`:

- Check `shouldContinue()` again immediately after `state.manager.connect()` and before:
  - `buildToolMetadata()`,
  - `state.toolMetadata.set()`,
  - `updateMetadataCache()`.

Add an optional `onSettled` callback or return a promise-bearing handle so `packages/mcp/index.ts` can clear `startupWarmupCancel` only when the settled warmup is still the active one.

In `packages/mcp/index.ts`:

- Clear `startupWarmupCancel` after the active warmup settles.
- Guard the clear by generation/state identity so stale warmups cannot clear a newer cancel handle.

#### Focused tests needed

Add MCP warmup test:

- Fake manager `connect()` resolves after cancellation.
- Cancel warmup after connect starts but before it resolves.
- Assert no metadata/cache/status update occurs after cancellation.
- Assert active cancel handle is cleared after settled active warmup, and stale warmup does not clear a newer handle.

---

## Data Flow Summary

### Startup path

1. Factory creates runtime state (`packages/workflows/src/extension/extension-factory.ts:77-89`).
2. Runtime state synchronously discovers bundled workflows only (`packages/workflows/src/extension/extension-runtime-state.ts:124-137`).
3. Lifecycle handlers are registered (`packages/workflows/src/extension/extension-factory.ts:106-107`).
4. `session_start` starts warmup and restores session state (`packages/workflows/src/extension/extension-lifecycle.ts:60-97`).
5. Warmup later calls full reload/discovery (`packages/workflows/src/extension/extension-runtime-state.ts:260-265`).
6. Full reload loads config, package resources, custom workflows, and rebuilds runtime (`packages/workflows/src/extension/extension-runtime-state.ts:217-249`).

### `/workflow list` path

1. Command handler receives subcommand (`packages/workflows/src/extension/workflow-command-registration.ts:100-106`).
2. Calls `ensureWorkflowResourcesLoaded()` (`packages/workflows/src/extension/workflow-command-registration.ts:106-108`).
3. Reads `runtimeProxy.registry.all()` (`packages/workflows/src/extension/workflow-command-registration.ts:108-115`).
4. Emits chat-surface list (`packages/workflows/src/extension/workflow-command-registration.ts:116`).

### `/workflow resume` path

1. Command handler routes to run-control before ensure (`packages/workflows/src/extension/workflow-command-registration.ts:102-105`).
2. Run-control creates runtime from current registry (`packages/workflows/src/extension/workflow-run-control-command.ts:64`).
3. Durable or failed-run resume uses registry-dependent runtime methods (`packages/workflows/src/extension/workflow-run-control-command.ts:68-73`, `328-330`, `399-401`).
4. Runtime lookup fails if the workflow definition is absent from lazy registry (`packages/workflows/src/extension/runtime.ts:352-355`).

### Workflow tool resume path

1. Tool receives `action: "resume"` (`packages/workflows/src/extension/workflow-tool.ts:40-54`).
2. It skips lazy ensure and calls `workflowResumeAction()` (`packages/workflows/src/extension/workflow-tool.ts:99-100`).
3. Resume action may call `runtime.resumeFailedRun()` (`packages/workflows/src/extension/workflow-tool-control.ts:186-193`).
4. Runtime requires registry definition (`packages/workflows/src/extension/runtime.ts:352-355`).

---

## Existing Tests Covering Lazy Discovery

- `test/unit/slash-dispatch-headless-basic.ts:213-239` — verifies `session_start` does not synchronously evaluate package workflow modules and `/workflow list` triggers discovery.
- `test/unit/slash-dispatch-interrupt.ts:291-317` — verifies `/workflow reload` is blocked while workflows are in flight.
- `test/unit/slash-dispatch-interrupt.ts:319-340` — verifies `/workflow reload` reports package-resource failures.
- `test/unit/slash-dispatch-interrupt.ts:343-390` — verifies `/workflow reload` calls `refreshWorkflowResources()` and completions see refreshed workflow.
- `test/unit/slash-dispatch-interrupt.ts:396-433` — verifies reload falls back to `getWorkflowResources()` when refresh is absent.
- `test/unit/slash-dispatch-tool-reload-resume.ts:127-157` — verifies tool reload is direct, not implemented by sending a slash command.
- `test/unit/slash-dispatch-tool-reload-resume.ts:159-219` — verifies registered workflow tool reload refreshes package resources before discovery.
- `test/unit/extension.test.ts:236-290` — existing startup warning test that needs deferred-warmup-aware synchronization.

---

## Required Focused Test Matrix

| Area | Test file | Behavior |
|---|---|---|
| Config before restore | `test/unit/extension.test.ts` | `session_start` loads workflow config before `restoreOnSessionStart()` and before persistence cleanup decisions. |
| Startup diagnostics | `test/unit/extension.test.ts` | Invalid workflow resource still emits warning after deferred warmup; invalid config emits warning without workflow module evaluation. |
| Retry failed lazy discovery | `test/unit/slash-dispatch-headless-basic.ts` or new focused unit | First lazy discovery failure clears promise; second `/workflow list` retries and succeeds. |
| Tool retry failed lazy discovery | `test/unit/slash-dispatch-tool-reload-resume.ts` | Registered workflow tool retries after first lazy discovery failure. |
| Slash resume lazy ensure | `test/unit/slash-dispatch-resume.ts` | `/workflow resume` loads package/custom workflow definitions before registry-dependent resume. |
| Tool resume lazy ensure | `test/unit/slash-dispatch-tool-reload-resume.ts` | `workflow` tool `{ action: "resume" }` loads definitions before `resumeFailedRun()`. |
| Warmup stale guard | `test/unit/extension.test.ts` or focused runtime-state test | Stale warmup does not clear current lazy promise or emit stale diagnostics. |
| MCP warmup cancellation | MCP unit test | Cancellation after connect but before metadata mutation prevents cache/state/status changes and clears active cancel handle on settle. |

---

## API Preservation Notes

No public API changes are required.

Preserve:

- `ExtensionAPI.getWorkflowResources()` (`packages/workflows/src/extension/public-types.ts:173`)
- `ExtensionAPI.refreshWorkflowResources()` (`packages/workflows/src/extension/public-types.ts:174`)
- `ExtensionAPI.disableAsyncDiscovery` (`packages/workflows/src/extension/public-types.ts:203`)
- `makeExecuteWorkflowTool()` export (`packages/workflows/src/extension/index.ts:10`)
- slash command name/handler contract (`packages/workflows/src/extension/workflow-command-registration.ts:50-69`)
- workflow tool action schema including `resume` and `reload` (`packages/workflows/src/extension/public-types.ts:235-293`)

Internal interface changes are acceptable for:

- `WorkflowExtensionRuntimeState` (`packages/workflows/src/extension/extension-runtime-state.ts:41-57`)
- `WorkflowSlashCommandDeps` (`packages/workflows/src/extension/workflow-command-registration.ts:37-48`)
- `WorkflowRunControlDeps` (`packages/workflows/src/extension/workflow-run-control-command.ts:26-31`)
- MCP warmup handle/options (`packages/mcp/startup-warmup.ts:9-16`)

---

## Minimal Implementation Checklist

1. Add config-only loader/apply path to `extension-runtime-state.ts`.
2. Call config-only loader from `session_start` before persistence cleanup and restore.
3. Refactor lazy discovery promise ownership so failures clear and retry.
4. Add identity/generation guards to workflow warmup catch/finally and diagnostics callback.
5. Add `ensureWorkflowResourcesLoaded` dependency to run-control and call it for `resume` paths.
6. Call `ensureWorkflowResourcesLoaded()` before workflow-tool `resume`.
7. Add post-connect cancellation check and active-handle cleanup to MCP warmup.
8. Add focused tests listed above.
9. Keep public extension/tool/slash APIs unchanged.
```
