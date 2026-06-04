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