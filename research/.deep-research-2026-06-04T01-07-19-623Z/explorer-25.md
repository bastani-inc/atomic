## Partition 25: Workflow foreground execution engine, stage runner, and executor semantics

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Three-layer workflow runtime split**
  - `executor.ts` orchestrates runs and stages.
  - `stage-runner.ts` owns per-stage `AgentSession` lifecycle and SDK adaptation.
  - `stage-control-registry.ts` holds live attach/pause/resume handles outside JSON snapshots.
  - This separation is explicit in comments and types like `RunOpts`, `InternalStageContext`, and `StageControlHandle`.

- **Lazy session creation**
  - `createStageContext()` defers `AgentSession` creation until first `prompt()`, `complete()`, `steer()`, or `followUp()`.
  - `__ensureSession()` is the internal hook used by the executor when it needs early attachment.

- **All user-facing stage calls go through a tracked wrapper**
  - In `executor.ts`, `prompt` and `complete` are routed through `runTrackedStageCall(...)`.
  - That wrapper handles concurrency slots, stage start bookkeeping, readiness gating, pause/resume, and finalization.

- **Deterministic stage output extraction**
  - `stage-runner.ts` prefers terminating tool results over assistant prose via `terminatingToolResultText(...)`.
  - This is driven by runtime tracking of `tool_execution_end` events and `terminate: true`.

- **Pause/resume is modeled as a deferred promise + abort**
  - `__requestPause()` aborts the live SDK session and waits on a deferred.
  - `__resume()` resolves the deferred with an optional follow-up message.
  - The executor distinguishes controlled pause from real failure.

- **Model fallback is a first-class loop**
  - `buildModelCandidatesFromCatalog(...)`, `modelAttempts`, `selectedModel`, and `notifyModelFallbackMetaChange()` show a reusable fallback pattern.
  - Candidate-specific `thinkingLevel` is applied before session creation.

- **Run-level and dependency-level control are separate**
  - The registry tracks which handles still participate in workflow cascade control versus merely remaining attachable.
  - `detachControl()` removes a stage from run-level pause/resume without killing the live chat handle.

- **Workflow tasks are normalized before execution**
  - Helpers like `taskStageOptions()`, `taskPromptOptions()`, `directTaskWithDefaults()`, and `directTaskToStep()` flatten multiple authoring shapes into runtime stage inputs.
  - Shared defaults are applied via `withoutUndefinedProperties()` and `sharedTaskDefaultsFromOptions()`.

- **Parallel execution uses bounded worker fan-out**
  - `mapParallelSteps()` is a reusable concurrency primitive with `failFast` and aggregate-error semantics.

- **Output is always truncated before surfacing**
  - `truncateByLines()`, `truncateByBytes()`, and `truncateTaskOutput()` enforce size limits and annotate truncation.

- **Continuation/replay is topology-aware**
  - `createContinuationReplayIndex()` rebuilds stage identity and parent mapping from source run snapshots.

## 2. Variations / exceptions

- **Adapter shortcuts bypass the SDK**
  - If `adapters.prompt` exists, `prompt()` never touches `AgentSession`.
  - If `adapters.complete` exists, `complete()` also bypasses the session.

- **Eager session creation is conditional**
  - `runTrackedStageCall(..., eagerSession = true)` can pre-create the session only for prompt-paths and only when fast-mode or config conditions justify it.

- **Readiness gating is optional**
  - `confirmStageReadiness` or `usePromptNodesForUi` enables the gate.
  - Otherwise the stage advances without gating.

- **Workflow context can come from multiple sources**
  - `cwd`, `chainDir`, worktree config, and stage-level overrides all influence resolved paths.

- **Direct-task mode and chain mode diverge**
  - `runTask`, `runParallel`, and `runChain` all reuse pieces of the same executor, but task/direct mode has extra worktree expansion and naming logic.

- **Fallback model behavior is skipped when no explicit config exists**
  - If there are no fallback models, the code avoids the candidate loop entirely.

## 3. Anti-patterns or risks

- **Large monolithic executor**
  - `executor.ts` contains input resolution, prompt gating, worktree orchestration, replay, direct-task mode, continuation, and finalization in one file.
  - This is a strong Rust-migration pressure point: many intertwined concerns.

- **Heavy reliance on internal escape hatches**
  - `__ensureSession`, `__requestPause`, `__resume`, `__sessionMeta`, `__modelFallbackMeta`, etc. indicate an internal API layered over a public one.
  - Rust porting should probably formalize these as explicit state-machine methods.

- **Runtime type inspection everywhere**
  - Many helpers infer shapes with `typeof`, object-key probing, and duck typing.
  - Examples: `askUserQuestionToolEvent()`, `readinessResultMeansAdvance()`, `asAgentSession()`, `extractMessageText()`.

- **Global singleton state**
  - `stageControlRegistry` is process-wide by default.
  - That simplifies integration but complicates test isolation and multi-runtime embedding.

- **Control flow hidden in comments and side effects**
  - Pause/resume, readiness gating, and continuation logic depend on event ordering and mutable captured state.
  - This is hard to translate cleanly unless rewritten as an explicit state machine.

## 4. Evidence index

- `packages/workflows/src/runs/foreground/executor.ts`
  - `RunOpts`, `runTrackedStageCall`, `askReadinessViaStageBroker`, `mapParallelSteps`, `createContinuationReplayIndex`, `runTask`, `runParallel`, `runChain`, `resolveInputs`
- `packages/workflows/src/runs/foreground/stage-runner.ts`
  - `createStageContext`, `promptWithFallback`, `promptWithPauseResume`, `terminatingToolResultText`, `__requestPause`, `__resume`, `__ensureSession`
- `packages/workflows/src/runs/foreground/stage-control-registry.ts`
  - `createStageControlRegistry`, `register`, `detachControl`, `run`, `clear`, `StageControlHandle`, `WorkflowRunControlHandle`

### Analyzer
## 1. Behavioral model

This partition is the **core synchronous workflow runtime** for `@bastani/workflows`:

- `run(def, inputs, opts)` is the main execution entry.
- `runTask`, `runParallel`, and `runChain` are convenience layers built on the same engine.
- `createStageContext()` turns each workflow stage into an **AgentSession-like** object, so workflow code can call `prompt`, `steer`, `followUp`, `compact`, `abort`, etc.
- The executor owns **run lifecycle**, **stage lifecycle**, **persistence**, **cancellation**, **pause/resume**, and **nested child workflow execution**.

For a Rust migration, this is the place where TS runtime semantics are most visible and hardest to preserve.

## 2. Key flows and invariants

### Execution flow
1. **Validate / resolve inputs**
   - `resolveInputs()` applies TypeBox defaults and enforces required fields.
   - `max_concurrency` is treated specially and normalized to a positive integer.

2. **Reject invalid depth early**
   - `maxDepth` is enforced before side effects.
   - If depth exceeds the limit, the run fails immediately.

3. **Create run bookkeeping**
   - run snapshot/persistence entries are created.
   - cancellation controller is registered.
   - continuation/resume metadata may be attached.

4. **Create stage contexts**
   - each stage gets a `StageContext` via `createStageContext()`.
   - stage options are stripped of workflow-only fields before SDK session creation.

5. **Stage execution / prompt loop**
   - stage context lazily creates the underlying SDK session.
   - `prompt`, `steer`, and `followUp` are mediated through the stage runner.
   - last assistant text is tracked, including terminating tool-result semantics.

6. **Pause/resume semantics**
   - a controlled pause is distinguished from a hard abort.
   - `__requestPause()` and `__resume()` coordinate with the executor.
   - paused descendants are cascaded via the stage-control registry.

7. **Readiness gate**
   - `confirmStageReadiness` can block advancement after an `ask_user_question`-style event.
   - if omitted, non-prompt-node runs usually proceed without gating.

8. **Child workflow nesting**
   - nested `ctx.workflow(...)` calls increment depth.
   - child run IDs are separately tracked and cleaned up.

### Important invariants
- **No side effects before maxDepth check.**
- **Stage control is per-stage, but cascade logic affects descendants.**
- **A stage’s SDK session may not exist until first prompt/attach.**
- **Terminating tool output overrides assistant prose for final stage output.**
- **Continuation replay is special-cased; replay mutation is rejected in resumed mode.**
- **Cancellation registry must unregister on both success and cleanup paths.**

## 3. Tests / validation

Evidence from the repo shows focused unit coverage around this engine:

- `test/unit/executor-phase-c.test.ts`
  - required input validation
  - compiled-definition enforcement
  - single-stage execution basics
- `test/unit/readiness-gate-decision.test.ts`
  - stage readiness gate behavior
- `test/unit/stage-control-registry.test.ts`
  - pause/resume fan-out behavior
- `test/unit/wiring.test.ts`
  - SDK-backed stage runtime wiring
- `test/unit/shared-runtime-ports.test.ts`
  - runtime port integration
- `test/unit/dispatcher.test.ts`
  - workflow dispatch and persistence expectations

This is good coverage for the main contract, but it’s still mostly **behavioral seam tests**, not a full end-to-end replay of all workflow modes.

## 4. Risks, unknowns, and verification steps

### Biggest Rust-migration risks
- **Stage/session adapter semantics** are tightly coupled to `@bastani/atomic`’s AgentSession API.
- **Pause/resume is stateful and subtle**; easy to break user-facing behavior.
- **Dynamic workflow authoring/loading** is outside this partition but directly feeds it.
- **Persistence format compatibility** must remain stable if you want existing runs to survive.

### Unknowns
- I did not fully inspect every branch of `executor.ts`; there are likely more edge cases deeper in the file.
- It’s unclear whether all workflow-package tests run in CI or only the root-level suite.
- Exact behavior around some nested-run/continuation combinations still needs confirmation.

### Verification steps for a Rust rewrite
- Recreate these tests first:
  - input resolution
  - maxDepth rejection
  - stage pause/resume
  - readiness gate
  - child workflow nesting
- Then verify:
  - session JSONL/persistence compatibility
  - stage-control attach/resume behavior
  - terminating tool-result handling
  - cancellation cleanup on all exit paths

If you want, I can turn this into a **Rust migration map** for this partition: what to port, what to stub, and what can stay in JS temporarily.

### Online Researcher
## 1. Relevant external facts

- No external library behavior appears necessary for this slice yet.
- The main relevant contract is the repo’s own workflow API surface:
  - `run(def, inputs, opts)`
  - `runTask(...)`
  - `runParallel(...)`
  - `runChain(...)`
  - `createStageContext(...)`
  - `createStageControlRegistry()`
  - `runDetached(...)`
- The migration risk is less about third-party APIs and more about preserving the repo’s current workflow semantics:
  - foreground execution
  - stage/session attachment
  - pause/resume/attach control
  - nested workflows
  - persistence snapshots
  - worktree handling
  - input resolution / validation
  - cancellation and max-depth guards

## 2. Local implications

- `packages/workflows/src/runs/foreground/executor.ts` is the core engine to re-host or rewrite in Rust.
- `stage-runner.ts` is the bridge between workflow execution and the agent/session runtime; Rust must preserve this boundary or replace it with a compatible host interface.
- `stage-control-registry.ts` implies an in-memory live-control model for interactive runs; Rust will need equivalent state + handle semantics.
- `shared/types.ts` is the most important compatibility surface. A Rust port should treat these as the canonical contract until intentionally breaking them.
- Background execution (`background/runner.ts`) looks like a wrapper around the foreground engine, so Rust should likely implement foreground semantics first, then build detached execution on top.
- The likely migration strategy is:
  1. preserve the TypeScript-defined workflow data model
  2. port execution semantics to Rust
  3. keep JS/TS as a thin adapter if session/tooling integration still lives in the host
  4. only then consider replacing the runtime boundary more broadly

## 3. Version/API assumptions

- No external version assumptions were needed from the locator.
- The important API assumptions are local and implied:
  - the executor’s exported functions are the public compatibility layer
  - `WorkflowDefinition`, `StageContext`, `WorkflowTaskOptions`, and `WorkflowRunContext` are the schema boundary
  - behavior compatibility matters more than TypeScript syntax compatibility

## 4. Unverified or unnecessary research

- I did not need external docs to interpret this partition.
- I did not verify the full internals of `executor.ts`; deeper semantics may still affect a Rust port.
- I did not research Rust-specific implementation patterns yet, because the immediate need here is understanding the TS workflow engine contract and migration boundary.