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