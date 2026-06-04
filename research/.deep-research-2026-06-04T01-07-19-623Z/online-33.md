## 1. Relevant external facts

- **Node.js `child_process.spawn()`** supports `detached: true`, `stdio: "ignore"`, and `subprocess.unref()` for true background work. This is the current pattern for keeping subagents alive after the parent returns.
- **Node.js `fs.watch()`** is best-effort, and on most platforms emits **`"rename"`** when files appear/disappear; it has caveats and can fall back to polling or break under watcher pressure.
- **`jiti`** is a runtime TypeScript/ESM loader for Node.js, including a CLI that can run `.ts` directly. This is the key reason the async runner can launch TS code without a build step.

## 2. Local implications

- This repo’s background subagent system is **deeply Node-specific**:
  - async launch uses `child_process.spawn(process.execPath, [jitiCliPath, runner, cfgPath])`
  - detached background execution depends on Node process semantics
  - result watching depends on `fs.watch()` + polling fallback
  - TS execution depends on `jiti`
- For a **Rust migration**, this subsystem must be redesigned, not just translated:
  - replace `spawn/unref/detached` with Rust process management
  - replace file watching with a Rust watcher crate or an explicit polling loop
  - remove `jiti` entirely; Rust cannot “run TS directly”
- Practically, this means the subagent runtime likely becomes:
  - a **Rust binary** that orchestrates background jobs
  - a separate **worker executable** or process protocol
  - filesystem or IPC-based result delivery that no longer assumes Node execution

## 3. Version/API assumptions

- Assumed docs:
  - **Node.js v26.x** `child_process` and `fs` docs
  - **jiti** current npm/GitHub docs
- Assumed behavior:
  - `fs.watch()` rename-event behavior and caveats
  - `spawn(...).unref()` semantics for detached children
  - `jiti` CLI exists and can execute `.ts` directly
- I have **not** yet verified which Rust runtime/crates you want to standardize on.

## 4. Unverified or unnecessary research

- I did **not** research the best Rust replacement crates yet.
- I did **not** map this to a full TS→Rust migration plan for the whole repo.
- For this partition, the main takeaway is: **async/background subagent behavior is one of the hardest pieces to port because it depends on Node-specific process, watcher, and TS-runtime behavior.**