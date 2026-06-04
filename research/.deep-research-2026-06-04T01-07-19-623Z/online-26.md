## 1. Relevant external facts

- **Rust `std::process::Command` / `Child`**: spawning a process returns a `Child` handle; if you don’t explicitly wait/kill it, the child can keep running even after the handle is dropped.  
  Applies here: your current `job-tracker` is in-memory only, so a Rust rewrite must keep explicit child-handle ownership for background workflow runs.

- **Tokio `tokio::process::Command` + `tokio::signal`**: Tokio provides async process spawning and signal handling for graceful shutdown / `ctrl_c`.  
  Applies here: if background workflows become Rust tasks/processes, Tokio is the likely runtime for detached execution, cancellation, and shutdown handling.

- **Tokio graceful shutdown pattern**: a common pattern is to keep work in spawned tasks and stop them via cancellation or OS signal.  
  Applies here: maps closely to your `cancellation-registry` + `job-tracker` split.

- **Rust background job crates (`job`, `backie`, `workers`)**: these are Postgres-backed schedulers/queues for durable job tracking.  
  Applies here: if you want workflow status/job tracking to survive process restarts, an in-memory tracker is not enough; a Rust migration could move to a durable queue/store.

## 2. Local implications

- `packages/workflows/src/runs/background/status.ts` is the control plane: `status`, `kill`, `resume`, `pause`, `interrupt`.
- `job-tracker.ts` is **only live-process memory**; it is not the source of truth.
- `cancellation-registry.ts` currently aborts via `AbortController`, and explicitly **does not kill processes**.
- Therefore, a TypeScript→Rust migration has two choices:
  1. **Keep semantics the same**: Rust only replaces execution/runtime internals, while store/status APIs stay compatible.
  2. **Make tracking durable**: move run/job state into Rust-managed persistence so `status`/`resume` survive restarts.

Most important mapping:
- `statusRuns()` → query persisted run snapshots
- `killRun()` → abort runtime + mark store end state
- `resumeRun()` → restore paused stage state and reattach live handles
- `jobTracker` → Rust task/process registry or durable queue metadata
- `cancellationRegistry` → Rust cancellation tokens / child-process handles

## 3. Version/API assumptions

- Rust process control assumptions are based on current stable docs for:
  - `std::process::Command`
  - `std::process::Child`
  - `tokio::process::Command`
  - `tokio::signal`
- If you use Tokio, assume a modern 1.x release with async process/signal support.
- If you need restart-safe job tracking, assume a DB-backed queue crate (or custom persistence), not just in-memory structs.

## 4. Unverified or unnecessary research

- I did **not** verify the exact Rust crate you’d use for durable workflow tracking in this repo.
- I did **not** inspect your persistence schema deeply enough to confirm whether Rust must preserve JSON/session-file compatibility.
- For this partition, external research beyond Rust process/cancellation semantics is probably unnecessary unless you’re deciding on a specific Rust job framework.