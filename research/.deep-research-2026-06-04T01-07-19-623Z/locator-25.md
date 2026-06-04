## 1. Must-read paths

- `packages/workflows/src/runs/foreground/executor.ts`
  - Core workflow engine: `run`, `runTask`, `runParallel`, `runChain`, `resolveInputs`, readiness-gate helpers, max-depth guard, cancellation, persistence, child-workflow nesting.
  - This is the main TS runtime you’d replace or re-host in Rust.

- `packages/workflows/src/runs/foreground/stage-runner.ts`
  - Stage/session adapter layer: `createStageContext`, `StageSessionRuntime`, fallback model selection, prompt/steer/follow-up, pause/resume, output truncation.
  - Critical for understanding how a Rust engine would talk to agent sessions.

- `packages/workflows/src/runs/foreground/stage-control-registry.ts`
  - Live control plane for attached workflow stages: `createStageControlRegistry`, `StageControlHandle`, `WorkflowRunControlHandle`.
  - Important if Rust needs interactive attach/pause/resume semantics.

- `packages/workflows/src/runs/background/runner.ts`
  - Detached/background execution wrapper: `runDetached`, `buildDetachedAccepted`.
  - Shows what remains async vs synchronous in the workflow lifecycle.

- `packages/workflows/src/shared/types.ts`
  - Authoring/runtime contracts (`WorkflowDefinition`, `StageContext`, `WorkflowTaskOptions`, `WorkflowExecutionMode`, etc.).
  - This is the contract surface a Rust port must preserve or intentionally break.

- `packages/workflows/README.md`
  - High-level semantics: workflow authoring, child workflows, HIL, worktrees, discovery.
  - Good for understanding user-visible behavior that Rust must keep.

## 2. Supporting paths

- `packages/workflows/src/sdk-surface.ts`
  - Public runtime exports; useful for identifying the “minimal supported surface” for discovery/loading.

- `packages/workflows/src/extension/index.ts`
  - Workflow tool + slash-command integration; dispatches into the executor and stage runtime.

- `packages/workflows/src/extension/dispatcher.ts`
  - Direct bridge from workflow registry to executor.

- `packages/workflows/src/extension/runtime.ts`
  - Runtime wiring and nested workflow support.

- `packages/workflows/src/extension/wiring.ts`
  - How workflow stages are attached to SDK sessions; relevant to Rust hosting boundaries.

- `packages/workflows/src/runs/shared/worktree.ts`
  - Git worktree setup/cleanup used by workflow execution.

- `packages/workflows/src/runs/shared/graph-inference.ts`
  - Stage graph topology/frontier logic that executor depends on.

- `packages/workflows/src/runs/shared/validate-inputs.ts`
  - Input validation before execution starts.

- `packages/workflows/src/shared/store.ts`
  - Persistence model for workflow run/stage snapshots.

- `packages/workflows/src/shared/store-types.ts`
  - Snapshot/status schema; important for runtime/UI compatibility.

- `packages/workflows/src/shared/persistence-session-entries.ts`
  - JSONL/session persistence events (`run.start`, `stage.start`, etc.).

## 3. Entry points / symbols

- `run(def, inputs, opts)` in `packages/workflows/src/runs/foreground/executor.ts`
  - Main synchronous execution entry.

- `runTask(task, options?, runOptions?)`
- `runParallel(tasks, options?, runOptions?)`
- `runChain(chain, options?, runOptions?)`
  - Direct execution helpers built on the same executor.

- `resolveInputs(...)`
  - Input/default handling.

- `createStageContext(opts)` in `packages/workflows/src/runs/foreground/stage-runner.ts`
  - Builds the per-stage agent-session facade.

- `StageSessionRuntime`
  - The effective stage API surface.

- `createStageControlRegistry()`
  - In-memory stage-control table for pause/resume/attach.

- `runDetached(def, inputs, opts)` in `packages/workflows/src/runs/background/runner.ts`
  - Background execution entry.

- `WorkflowDefinition`, `StageContext`, `WorkflowTaskOptions`, `WorkflowRunContext`
  - The core type contracts from `packages/workflows/src/shared/types.ts`.

## 4. Gaps or uncertainty

- I did **not** verify the full contents of `executor.ts` beyond the main exports and the `run()` setup path; there are likely more semantics deeper in the file that matter for exact migration behavior.
- No Rust code exists in this repo, so there’s no prior crate boundary or FFI strategy to inspect.
- I did not verify whether `packages/workflows` tests are all run in CI versus only root `test/unit` and `test/integration`.
- The hardest migration unknown remains the `jiti`-based dynamic workflow loading and the SDK/session boundary; those are likely the biggest Rust compatibility decision points.