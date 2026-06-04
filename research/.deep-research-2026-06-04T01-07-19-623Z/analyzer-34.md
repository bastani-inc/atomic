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