## 1. Must-read paths

- `packages/subagents/src/shared/fork-context.ts`  
  Core forked-context resolver. This is the main “session isolation” seam: it decides when a child run gets a branched session file vs. a fresh one.

- `packages/subagents/src/runs/shared/pi-spawn.ts`  
  Process-spawn compatibility layer for launching the Atomic/Pi CLI. Important if Rust replaces JS subprocess spawning or needs to preserve CLI handoff behavior.

- `packages/subagents/src/runs/shared/nested-events.ts`  
  Defines nested event routing, control inbox/sink, registry files, and event/control record formats. This is the key nested-events contract.

- `packages/subagents/src/runs/foreground/subagent-executor.ts`  
  Main orchestration path that wires together fork context, nested routes, session files, and child execution. Best place to understand end-to-end flow.

- `packages/subagents/src/runs/background/async-execution.ts`  
  Async child-run spawning and nested async routing. Relevant if Rust changes background execution or process model.

- `packages/subagents/src/runs/background/subagent-runner.ts`  
  Runner process bootstrap for spawned subagents. Good for understanding what state gets passed across process boundaries.

- `packages/subagents/src/runs/shared/pi-args.ts`  
  Defines the environment variables and CLI args used to propagate parent/child metadata, depth, path, and capability tokens.

- `packages/subagents/src/shared/types.ts`  
  Contains the subagent depth policy, nested-route types, and blocked-nesting messages. This is the policy layer for “how deep can children recurse?”

## 2. Supporting paths

- `packages/subagents/src/runs/foreground/chain-execution.ts`  
  Shows how session files are threaded through chain steps; useful for nested session isolation.

- `packages/subagents/src/runs/background/run-id-resolver.ts`  
  Resolves nested run IDs from routes and state; useful for tracking child processes in Rust.

- `packages/subagents/src/runs/background/run-status.ts`  
  Reads nested route state for status reporting.

- `packages/subagents/src/runs/background/async-job-tracker.ts`  
  Tracks live nested descendants; important if Rust needs equivalent bookkeeping.

- `packages/subagents/src/runs/background/stale-run-reconciler.ts`  
  Reconciles nested async descendants after crashes/restarts.

- `packages/subagents/src/extension/fanout-child.ts`  
  Child-side nested control/result handling via env and route files.

- `packages/subagents/src/extension/index.ts`  
  Extension entrypoint; shows how nested runtime cleanup is initialized.

- `packages/coding-agent/src/core/session-manager.ts`  
  The actual session persistence layer that `fork-context.ts` depends on.

- `packages/coding-agent/docs/session-format.md`  
  Session file contract you’ll need to preserve or intentionally replace in Rust.

- `packages/coding-agent/docs/rpc.md`  
  Useful if Rust will expose a new automation surface for child processes.

## 3. Entry points / symbols

- `createForkContextResolver(...)` in `packages/subagents/src/shared/fork-context.ts`  
- `resolveSubagentContext(...)` in `packages/subagents/src/shared/fork-context.ts`  
- `getPiSpawnCommand(...)` in `packages/subagents/src/runs/shared/pi-spawn.ts`  
- `resolvePiCliScript(...)` in `packages/subagents/src/runs/shared/pi-spawn.ts`  
- `createNestedRoute(...)` in `packages/subagents/src/runs/shared/nested-events.ts`  
- `resolveNestedRouteFromEnv(...)` / `resolveInheritedNestedRouteFromEnv(...)` in `nested-events.ts`  
- `writeNestedEvent(...)` / `writeNestedControlRequest(...)` / `writeNestedControlResult(...)` in `nested-events.ts`  
- `getSubagentDepthEnv(...)`, `checkSubagentDepth(...)`, `subagentDepthBlockedMessage(...)` in `packages/subagents/src/shared/types.ts`  
- `executeAsyncChain(...)` / `executeAsyncSingle(...)` in `packages/subagents/src/runs/background/async-execution.ts`  
- `runSync(...)` / foreground child orchestration in `packages/subagents/src/runs/foreground/execution.ts`  
- `subagent-executor` wiring around `sessionFileForIndex` in `packages/subagents/src/runs/foreground/subagent-executor.ts`

## 4. Gaps or uncertainty

- I could verify the main spawn/fork/nested-event flow, but not every helper in `subagent-executor.ts` without reading the whole file.
- The exact Rust migration shape is still unclear: these files show the compatibility surface, but not whether you want a full rewrite, a Rust host with JS plugins, or a hybrid subprocess model.
- The repo appears to keep legacy `pi_` env compatibility in a few places; I verified that in `nested-events.ts`, but not across all subprocess paths.