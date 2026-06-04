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