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