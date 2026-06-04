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