## 1. Behavioral model

This partition is the **foreground orchestration layer** for subagents.

It decides, for a given `subagent` invocation, whether to:

- run a **single agent**
- run a **chain**
- run **parallel tasks**
- fall back to **async/background execution** when clarify/run-in-background is requested

Core behavior lives in `createSubagentExecutor(...)`, which:
- validates input
- resolves agent scope, cwd, session roots, intercom routing, and depth policy
- constructs execution context
- dispatches to `runSync(...)` for foreground single-agent work
- dispatches to `executeChain(...)` or async wrappers for multi-step work

`runSync(...)` is the actual **foreground child process runner**:
- resolves the target agent
- validates output mode and acceptance policy
- injects skills/system prompt
- builds spawn args/env
- launches the child CLI via `getPiSpawnCommand(...)`
- collects output, usage, artifacts, acceptance results, and progress metadata
- applies mutation/long-running safeguards and cleanup

## 2. Key flows and invariants

### Foreground dispatch rules
- **Single task** → `executeAsyncSingle(...)` only if async/clarify path is chosen; otherwise `runSync(...)` through orchestration.
- **Chain/parallel** → `executeAsyncChain(...)` for async mode, otherwise foreground chain execution.
- **Clarify + background requested** is a special path that still preserves depth/guard settings.

### Depth/guard propagation
A major invariant is that **subagent depth limits and workflow-stage guards are always propagated downward**:
- `resolveSubagentDepthPolicy(...)` computes the effective max depth and whether the current run is workflow-stage guarded.
- Child runs receive:
  - `maxSubagentDepth`
  - `workflowStageSubagentGuard`
- This applies to:
  - sequential chain children
  - parallel children
  - async handoff paths

If depth is exceeded, execution is blocked before dispatch with a structured error message.

### Child process boundary
`runSync(...)` does **not** execute the agent in-process. It:
- builds CLI args with `buildPiArgs(...)`
- resolves the CLI executable with `getPiSpawnCommand(...)`
- spawns a separate process
- passes env including depth/guard state via `getSubagentDepthEnv(...)`

So the orchestration layer is a process supervisor, not the agent runtime itself.

### Acceptance and mutation safety
Foreground execution also enforces:
- acceptance prompt injection/evaluation
- output-mode validation
- completion/mutation guards
- long-running/mutating failure escalation
- artifact/session writing

These are part of the safety contract and are not optional plumbing.

## 3. Tests / validation

The strongest test signal here is:

- `test/unit/subagents-foreground-guard-propagation.test.ts`

It verifies that workflow-stage guard state is preserved across:
- sequential chain children
- parallel children
- async clarify-to-background handoff for both chain and single runs

That test confirms the key migration invariant: **guard state must survive orchestration transitions**.

What is not fully validated here:
- child-process launch behavior itself
- acceptance evaluation edge cases
- mutation guard escalation under real tool output
- full chain execution branches beyond guard propagation

## 4. Risks, unknowns, and verification steps

### Migration risks for Rust
1. **Process model coupling**
   - This code assumes the child agent is another CLI process.
   - A Rust rewrite must decide whether to preserve subprocess isolation or replace it with in-process execution.

2. **Guard semantics are load-bearing**
   - Depth limits and workflow-stage protection are threaded through many branches.
   - Losing them would change safety behavior, not just ergonomics.

3. **Async fallback depends on current JS ecosystem**
   - Background execution is tied to existing TS/CLI runtime assumptions.
   - Rust needs either a compatibility layer or a new async orchestration model.

4. **Acceptance/mutation behavior is intertwined**
   - These are not standalone checks; they influence exit codes, output, and progress state.

### Unknowns to verify next
- Exact behavior of `executeChain(...)` for background handoff and nested children
- Whether child process spawning is required for all compatibility cases
- Whether any hidden tests assert specific stderr/stdout formatting or session-file side effects
- How much of `pi`/`jiti`/TS runtime behavior is expected to remain stable in a Rust port

### Verification steps
- Trace `executeChain(...)` and `executeAsync*` to confirm every place depth/guard is forwarded.
- Run or inspect tests around:
  - nested subagent limits
  - acceptance failures
  - background clarify mode
  - worktree/cleanup behavior
- Decide early whether Rust will:
  - keep the CLI as a child process boundary, or
  - replace it with a native execution engine.