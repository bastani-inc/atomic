## 1. Behavioral model

This partition is the **runtime seam** where the repo currently depends on three external TS packages:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-tui`

The repo’s own code uses them as the **agent/session engine**, **model/provider layer**, and **interactive TUI substrate**. The main composition point is `createAgentSession()` in `packages/coding-agent/src/core/sdk.ts`, while `packages/coding-agent/src/core/extensions/types.ts` exposes the public ABI that still imports types from all three deps.

From a Rust-migration perspective, this partition is not “just a dependency swap”; it defines the **compatibility contract** for:

- session lifecycle
- model streaming / provider hooks
- tool execution plumbing
- interactive UI rendering and events
- extension runtime integration

A Rust port therefore needs either:

1. a **full replacement** of these libraries in Rust, or
2. a **binding/bridge layer** that preserves their behavior at the TS boundary.

## 2. Key flows and invariants

### Core composition flow
1. CLI/runtime enters the agent stack.
2. `createAgentSession()` wires together:
   - session state
   - provider/model config
   - tool registry
   - extension runtime
   - UI/event hooks
3. Interactive mode consumes the resulting runtime and delegates rendering/input handling to `pi-tui`-backed abstractions.

### Extension ABI coupling
`packages/coding-agent/src/core/extensions/types.ts` is the strongest invariant here:
- external deps are not incidental; they are part of the exported type surface.
- Rust replacement must preserve equivalent concepts for:
  - tool definitions
  - provider config
  - runtime events
  - TUI widget/UI hooks

### Loader/runtime boundary
`packages/coding-agent/src/core/extensions/loader.ts` shows a dynamic loader model built on `jiti` and virtual modules. This means:
- the system currently expects **runtime-loaded TS/JS** behavior
- a pure Rust runtime cannot assume static compile-time plugins only
- the migration must decide whether to:
  - keep a JS plugin boundary,
  - replace it with a new Rust-native plugin ABI,
  - or execute plugins out-of-process

### Headless vs interactive split
The repo already has a softer compatibility surface in:
- `print-mode.ts`
- `modes/rpc/**`

Those are likely safer first migration targets than full interactive TUI parity, because they reduce dependence on `pi-tui`.

### Invariants to preserve
- same session semantics
- same tool invocation contract
- same extension capability model
- same model/provider behavior as observed by callers
- same interactive affordances if TUI parity is required

## 3. Tests / validation

This partition’s validation is mostly indirect:
- the locator identifies load-bearing tests in:
  - `packages/coding-agent/test/`
  - root `test/unit`
  - root `test/integration`
- but it is **not yet proven** whether CI covers every `packages/coding-agent` path equally.

Best validation targets for a Rust migration:
- session creation parity (`createAgentSession`)
- provider streaming parity
- tool execution parity
- extension loading/runtime behavior
- interactive mode smoke tests
- headless RPC/print mode compatibility

## 4. Risks, unknowns, and verification steps

### Biggest risk
The repo does **not** contain Rust scaffolding (`Cargo.toml`, `*.rs`), so there is no existing Rust boundary to extend. This is a greenfield replacement decision, not a gradual refactor.

### Unknowns
- whether the intended migration is:
  - CLI-only,
  - headless runtime first,
  - or full TUI + extension parity
- whether external `pi-*` dependencies should be:
  - rewritten in Rust,
  - embedded via FFI,
  - or wrapped through a JS subprocess
- how much of the current dynamic TS extension model must survive

### Verification steps
1. Define the minimal compatibility target:
   - CLI
   - headless automation
   - interactive TUI
   - full extension ecosystem
2. Inventory all call sites of:
   - `createAgentSession()`
   - extension/runtime types
   - interactive-mode TUI hooks
3. Decide plugin strategy:
   - Rust-native ABI
   - embedded JS runtime
   - subprocess bridge
4. Build a parity matrix for:
   - model streaming
   - tool execution
   - UI events
   - extension loading
   - session persistence

If you want, I can turn this into a **Rust migration decision matrix** for these three dependencies: **replace vs bind vs preserve via subprocess/JS bridge**.