## Partition 34: Subagent process spawning, forked context, nested events, and session isolation

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Fork vs fresh is a first-class execution mode**
  - `packages/subagents/src/shared/fork-context.ts` normalizes `requestedContext` to `"fork"` or `"fresh"`.
  - Only `"fork"` creates branched session files; otherwise the resolver is a no-op.
  - The fork path is tied to persisted parent session state: `getSessionFile()` + `getLeafId()` are required.

- **Session isolation is file-based, not in-memory**
  - `createForkContextResolver()` clones sessions by calling `openSession(...).createBranchedSession(leafId)`.
  - In `subagent-executor.ts`, child runs get their own `sessionRoot` and per-index `run-${idx}` directories, with fallback to `session.jsonl` when no forked file exists.

- **Nested event routing uses capability-scoped temp directories**
  - `createNestedRoute()` creates `NESTED_EVENTS_DIR/<rootRunId>-<capabilityToken>/{events,controls}`.
  - Route metadata is written to `route.json`, then re-validated on load in `resolveNestedRouteFromEnv()` and `findNestedRouteForRootId()`.

- **Nested events are the coordination backbone for parent/child visibility**
  - `nested-events.ts` defines event types like `subagent.nested.started|updated|completed`.
  - `subagent-executor.ts` emits nested foreground events only when inheriting a nested route.
  - `fanout-child.ts` polls control inboxes and writes control results back.

- **Cross-process control is request/result file IPC**
  - `readNestedControlRequests()` / `writeNestedControlResult()` implement a durable inbox/outbox pattern.
  - Requests are deduped with bounded in-memory `seen`/`inFlight` sets in `fanout-child.ts`.

- **Nested state is projected, sanitized, and bounded**
  - `sanitizeSummary()` clamps depth/steps/children; tests verify max limits.
  - `projectNestedEvents()` uses a stale-safe `.registry.lock` directory to serialize registry writes.

- **Process spawning is intentionally host-aware**
  - `pi-spawn.ts` resolves the current Atomic/Pi CLI dynamically from `process.argv[1]`, package metadata, or falls back to `APP_NAME`.
  - Tests assert it prefers the host bin and avoids hard-coded `pi`.

## 2. Variations / exceptions

- **Legacy `.pi` env compatibility is preserved**
  - `nested-events.ts` still reads `PI_*` env vars when canonical env names are absent.
  - The route env test explicitly covers canonical and legacy `PI_SUBAGENT_PARENT_*` values.

- **Forked context is optional and cached**
  - `createForkContextResolver()` caches forked session files per index.
  - If `requestedContext !== "fork"`, no session branching occurs at all.

- **Nested route inheritance can fail closed**
  - `resolveInheritedNestedRouteFromEnv()` swallows invalid routes and logs a warning.
  - `resolveNestedRouteFromEnv()` is strict and throws on invalid metadata/shape.

- **Child-safe fanout mode disables mutation**
  - `fanout-child.ts` registers `subagent` but blocks create/update/delete actions.
  - It only wires a minimal safe runtime state and a nested-control inbox listener.

## 3. Anti-patterns or risks

- **Filesystem IPC is heavily coupled and brittle**
  - Nested execution depends on temp dirs, route metadata files, lock dirs, and polling loops.
  - This is portable, but a Rust migration would need to preserve the exact file contract or replace it everywhere.

- **Legacy compatibility is part of the contract**
  - Support for `PI_*` env vars and host-package bin resolution suggests migration must handle old launchers, not just new ones.

- **Session identity and branch semantics are implicit**
  - `createForkContextResolver()` assumes the session manager can branch from the current leaf; Rust will need an equivalent session graph/leaf model.

- **Control handling is best-effort, not transactional**
  - `fanout-child.ts` retries failed result writes, keeps pending results, and eventually drops them.
  - That means eventual consistency, not guaranteed delivery.

- **Nested projections can drift from source**
  - `projectNestedEvents()` reconstructs state from files and caches processed event IDs; bugs here would desync parent UI from child reality.

## 4. Evidence index

- `packages/subagents/src/shared/fork-context.ts`
  - `resolveSubagentContext()`
  - `createForkContextResolver()`

- `packages/subagents/src/runs/shared/pi-spawn.ts`
  - `resolvePiCliScript()`
  - `getPiSpawnCommand()`

- `packages/subagents/src/runs/shared/nested-events.ts`
  - `createNestedRoute()`
  - `resolveNestedRouteFromEnv()`
  - `findNestedRouteForRootId()`
  - `applyNestedEvent()`
  - `projectNestedEvents()`
  - `readNestedControlRequests()`
  - `writeNestedControlResult()`

- `packages/subagents/src/runs/shared/nested-render.ts`
  - `countNestedRuns()`
  - `formatNestedRunStatusLines()`

- `packages/subagents/src/runs/foreground/subagent-executor.ts`
  - `createForkContextResolver(...)`
  - `sessionFileForIndex`
  - `writeNestedForegroundEvent(...)`
  - nested route setup around `inheritedNestedRoute`

- `packages/subagents/src/extension/fanout-child.ts`
  - `startNestedControlInboxListener()`
  - `buildNestedControlResult()`
  - child-safe `subagent` registration

- Tests
  - `test/unit/subagents-pi-spawn.test.ts`
  - `test/unit/subagents-nested-events.test.ts`
  - `test/unit/subagents-pi-args.test.ts`

### Analyzer
## 1. Behavioral model

This partition is a **process-boundary + session-isolation layer** for subagents.

- **`fork-context.ts`** decides whether a child run should reuse a fresh session or fork from the parent’s current leaf.
- **`pi-spawn.ts`** resolves how child processes invoke the CLI, preferring the installed Atomic/Pi entrypoint when available and falling back to `APP_NAME`.
- **`nested-events.ts`** creates and validates the on-disk nested-event channels (`events/`, `controls/`, `registry.json`) and projects them into run summaries.
- **`subagent-executor.ts`** wires everything together: it creates the nested route, resolves per-child session files, spawns foreground/async modes, and emits nested status events.
- **`async-execution.ts`** launches detached child runners via `jiti` + `node`, writes async config JSON, and publishes nested “started” events.
- **`subagent-runner.ts`** is the spawned worker process: it streams child stdout/stderr, updates status, and emits nested self updates/completions back to the parent route.

## 2. Key flows and invariants

### Session isolation / forked context
- `createForkContextResolver(..., requestedContext)` only activates when context is `"fork"`.
- It requires:
  - a persisted parent session file
  - a current leaf id
- It caches one forked session file per child index.
- It fails fast if:
  - no parent session exists
  - no leaf exists
  - the parent session file is missing on disk
  - `SessionManager.createBranchedSession()` returns nothing
  - the returned child session file does not exist

**Implication:** forked subagents depend on a stable session persistence contract; Rust would need an equivalent “branch current leaf into a child session file” operation.

### Child process spawning
- `getPiSpawnCommand()` resolves the executable/script path:
  - if `argv1` or package metadata points to a runnable JS script, use `process.execPath + script`
  - otherwise fall back to `APP_NAME`
- This preserves portability across installed CLI shapes.

**Implication:** Rust cannot assume a single binary shape; it must preserve both “script entry” and “command name” launch modes or intentionally break compatibility.

### Nested route creation and validation
- `createNestedRoute(rootRunId)` creates:
  - `.../nested-subagent-events/<rootRunId>-<capabilityToken>/events`
  - `.../controls`
  - a `route.json` with `rootRunId` and token
- Validation enforces:
  - safe ids only
  - both paths stay inside the nested root
  - event sink and control inbox share the same route root
  - route metadata matches env-provided ids/tokens

**Invariant:** the capability token is both a routing secret and a filesystem namespace boundary.

### Nested event lifecycle
- Children/runners append immutable event files.
- Parent-side projection reads and aggregates them into registry/status.
- Event types include:
  - `subagent.nested.started`
  - `subagent.nested.updated`
  - `subagent.nested.completed`
  - `subagent.nested.control-request`
  - `subagent.nested.control-result`

### Subagent executor control flow
- It resolves:
  - run id
  - inherited nested route (if any)
  - fork session resolver
  - session root and per-index session files
  - async vs foreground execution
- For inherited nested runs, it emits nested “started/updated/completed” summaries.
- Foreground runs keep an in-memory `foregroundControls` record and can be resumed later if session files exist.

### Async runner behavior
- `executeAsync*()` writes a config file, then spawns `subagent-runner.ts` through `jiti`.
- It detaches the process and returns a pid-based async status.
- If nested routing is inherited, it also emits nested async start events.

## 3. Tests / validation

Current unit coverage is decent for the seams this partition owns:

- **`subagents-pi-spawn.test.ts`**
  - fallback to `APP_NAME`
  - host package root resolution
  - bin selection from package metadata
  - runtime script invocation

- **`subagents-nested-events.test.ts`**
  - route containment validation
  - legacy `PI_*` env compatibility
  - request/result round-trips
  - summary sanitization and depth/child/step caps
  - stale runtime cleanup
  - registry lock behavior
  - processed-event replay cap
  - host-prefixed env key generation

- **`subagents-async-config.test.ts`**
  - async config file contents
  - owner-only permissions (`0o600` on non-Windows)

What’s not directly covered here:
- full end-to-end forked-session branching
- actual spawned child lifecycle
- resume/interrupt behavior across parent/child boundaries
- nested event projection under live concurrent processes

## 4. Risks, unknowns, and verification steps

### Main migration risks
- **Session branching is tightly coupled to `SessionManager`** and `jsonl` session persistence.
- **Nested events depend on filesystem semantics** (atomic rename, path containment, cleanup, lock dirs).
- **Legacy `PI_*` env compatibility is preserved intentionally**; Rust must decide whether to keep that.
- **Detached async execution depends on `jiti` + TS runner entrypoints**; a Rust rewrite likely removes this path entirely.
- **Foreground resume logic depends on persisted child session files** and exact `.jsonl` expectations.

### Unknowns
- Whether you want to preserve:
  1. TS plugin loading,
  2. TS session file format,
  3. CLI subprocess compatibility,
  4. or only the user-facing behavior.
- Whether Rust should:
  - replace just the runner/supervisor layer,
  - or also replace extension loading and session storage.

### Verify next
- Trace `SessionManager.open/createBranchedSession()` behavior.
- Inspect resume/interrupt paths in `subagent-executor.ts` and `subagent-runner.ts`.
- Confirm how nested registry projection merges children from events vs status files.
- Decide whether Rust will keep:
  - `.jsonl` sessions,
  - `route.json` + event/control inboxes,
  - `APP_NAME` command fallback,
  - legacy `PI_*` env vars.

### Online Researcher
## 1. Relevant external facts

- **Session persistence contract matters**: `packages/coding-agent/docs/session-format.md` says sessions are **JSONL** files with a tree structure via `id`/`parentId`, and current files are **version 3**. Forking relies on creating a branched session from an existing persisted file.
- **CLI handoff is path-sensitive**: `pi-spawn.ts` resolves whether to launch the CLI via a direct script path or via the `APP_NAME` command, so any Rust replacement must preserve “run from source vs installed package” behavior.
- **Nested routing is file-based and capability-gated**: `nested-events.ts` creates a per-root route directory, writes `route.json`, and validates `eventSink` / `controlInbox` paths and a `capabilityToken`. That means child coordination is not just env-based; it is also tied to filesystem state.
- **Legacy env compatibility exists**: `nested-events.ts` explicitly accepts both current `SUBAGENT_*` and legacy `PI_*` env names, so old parents can still route children.
- **Depth limits are enforced**: `shared/types.ts` (referenced in locator) defines depth policy and blocked-nesting messaging; nested children cannot recurse indefinitely.

## 2. Local implications

- A Rust migration should treat **session forking** as a first-class compatibility boundary, not an implementation detail.  
  The current code expects:
  - a persisted parent session file,
  - a current leaf id,
  - a branched session file returned by the session manager.
- **Nested subagent communication** should likely stay **filesystem-backed** unless you intentionally redesign it.  
  The repo currently uses:
  - nested event sinks,
  - control inboxes,
  - registry/route files,
  - cleanup of stale runtime dirs.
- **Process spawning semantics** must preserve current CLI behavior:
  - source checkout / direct script execution,
  - installed-package execution,
  - env propagation for parent/child metadata.
- The Rust rewrite likely needs a **compatibility layer** for:
  - env var names,
  - route file validation,
  - session file layout,
  - event record shapes,
  - depth checks.

## 3. Version/API assumptions

- **Session format assumed**: JSONL session files, header version **3**, tree-based branching with `id`/`parentId`.
- **Nested route contract assumed**:
  - `rootRunId`, `eventSink`, `controlInbox`, `capabilityToken`
  - route metadata stored in `route.json`
- **Env contract assumed**:
  - `SUBAGENT_PARENT_*` is primary
  - `PI_*` fallback remains supported
- **Rust migration assumption**: if Rust replaces TS subprocess orchestration, it must either:
  1. reimplement these contracts exactly, or
  2. deliberately version them and migrate both parent + child together.

## 4. Unverified or unnecessary research

- I did **not** need external ecosystem research to answer this partition; the local files already define the critical contracts.
- I did **not** verify every helper in `subagent-executor.ts`; the locator plus the files read are enough to identify the migration seams.
- The broader “TS → Rust” migration strategy is still open: this partition only covers **process spawning, fork context, nested events, and session isolation**.