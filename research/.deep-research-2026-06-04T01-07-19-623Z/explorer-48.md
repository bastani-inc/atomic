## Partition 48: External `pi-agent-core`, `pi-ai`, and `pi-tui` dependency replacement or binding strategy

### Locator
## 1. Must-read paths

- `packages/coding-agent/package.json`  
  Load-bearing dependency list: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, plus build/packaging shape. This is the clearest “what must be replaced or bound” manifest.

- `packages/coding-agent/src/core/sdk.ts`  
  `createAgentSession()` is the main runtime composition point where agent core + AI provider + tools + session management are wired together.

- `packages/coding-agent/src/core/extensions/loader.ts`  
  The `jiti` loader + `VIRTUAL_MODULES` / `getAliases()` logic shows how TS extensions currently depend on the external packages and how a Rust host would need a plugin boundary.

- `packages/coding-agent/src/core/extensions/types.ts`  
  The public extension ABI. It imports types from all three external deps and defines the compatibility surface for tools/UI/provider hooks.

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`  
  The interactive TUI runtime is the strongest consumer of `pi-tui`; useful for judging whether Rust should replace or wrap the TUI.

- `docs/ci.md`  
  Explains what is bundled, what is published, and what CI validates. Critical for understanding whether Rust replaces the CLI only or the whole monorepo contract.

## 2. Supporting paths

- `packages/coding-agent/src/core/agent-session.ts`  
  Stateful session orchestration; likely the bridge between any Rust core and the current tool/session model.

- `packages/coding-agent/src/core/model-registry.ts`  
  Provider/model/auth registry logic; relevant if `pi-ai` is being replaced.

- `packages/coding-agent/src/core/tools/`  
  Especially `read.ts`, `bash.ts`, `edit.ts`, `write.ts`, `find.ts`, `ls.ts`, `todos.ts`. These define the runtime/tool contract that a Rust port must preserve.

- `packages/coding-agent/src/modes/print-mode.ts` and `packages/coding-agent/src/modes/rpc/`  
  Good candidate compatibility surfaces if Rust starts by preserving headless automation instead of the interactive TUI.

- `packages/subagents/src/tui/render.ts` and `packages/subagents/src/runs/shared/pi-spawn.ts`  
  Shows downstream dependence on `pi-tui` and process spawning behavior that a Rust migration may need to retain.

- `packages/workflows/src/extension/workflow-module-loader.ts`  
  Another `jiti`-based dynamic TS loading path; important because Rust cannot assume static compilation only.

- `packages/intercom/broker/`  
  A relatively self-contained IPC layer; likely easier to reimplement in Rust than the TUI/extension system.

- `packages/mcp/server-manager.ts`  
  MCP transport and lifecycle behavior; relevant if Rust replaces the extension host but keeps MCP support.

- `packages/web-access/extract.ts`, `github-extract.ts`, `video-extract.ts`  
  Non-core but useful if the migration includes bundled web/content tools.

## 3. Entry points / symbols

- `createAgentSession()` in `packages/coding-agent/src/core/sdk.ts`
- `createExtensionRuntime()` and `loadExtensions()`-adjacent logic in `packages/coding-agent/src/core/extensions/loader.ts`
- `VIRTUAL_MODULES` and `getAliases()` in `packages/coding-agent/src/core/extensions/loader.ts`
- `ExtensionAPI`, `ExtensionRuntime`, `ToolDefinition`, `ProviderConfig` in `packages/coding-agent/src/core/extensions/types.ts`
- `AgentSession` in `packages/coding-agent/src/core/agent-session.ts`
- `ModelRegistry` in `packages/coding-agent/src/core/model-registry.ts`
- `createReadTool`, `createBashTool`, `createEditTool`, `createWriteTool` in `packages/coding-agent/src/core/tools/*`
- `interactive-mode.ts` TUI orchestration in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `server-manager.ts` in `packages/mcp`
- `pi-spawn.ts` in `packages/subagents/src/runs/shared/pi-spawn.ts`
- `workflow-module-loader.ts` in `packages/workflows/src/extension/workflow-module-loader.ts`

## 4. Gaps or uncertainty

- I could verify the dependency usage and loader boundaries, but not a Rust target architecture in-repo: there is no `Cargo.toml` / `*.rs`.
- I could not verify whether `pi-agent-core`, `pi-ai`, and `pi-tui` are intended to be replaced wholesale vs bound through FFI/subprocesses; the repo only shows current TS usage.
- The exact minimal compatibility set for a Rust migration is still ambiguous: CLI-only, headless runtime, or full TUI + extension ABI parity.
- Some downstream usage is visible in fixtures/tests, but I did not verify every call site exhaustively; the high-signal references above are the best starting map.

### Pattern Finder
## 1. Established patterns

- **The repo treats `pi-agent-core`, `pi-ai`, and `pi-tui` as load-bearing platform libraries, not optional helpers.**
  - `packages/coding-agent/package.json` depends on all three directly.
  - `packages/coding-agent/src/core/sdk.ts` is the main boundary for agent/session/model/tool wiring.
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts` and many `modes/interactive/components/*` files are tightly coupled to `pi-tui`.

- **There are already “boundary” modules that would be the cleanest Rust replacement points.**
  - `src/core/sdk.ts`
  - `src/core/agent-session.ts`
  - `src/core/model-registry.ts`
  - `src/core/extensions/loader.ts`
  - `src/modes/interactive/*`
  These are the most obvious seams for either Rust-native reimplementation or FFI/proxy binding.

- **The repo uses adapter-style wrappers around upstream types.**
  - `src/core/messages.ts` extends `@earendil-works/pi-agent-core` via declaration merging.
  - `src/core/extensions/types.ts` defines the public extension ABI.
  - `src/core/extensions/loader.ts` aliases both `@earendil-works/*` and `@mariozechner/*` package names.
  This suggests the current design expects compatibility shims, not direct hard-coded internals.

- **UI is built as many small components over a shared TUI runtime.**
  - `modes/interactive/components/*`
  - `core/tools/ask-user-question/view/*`
  - `core/keybindings.ts`
  This is a strong signal that `pi-tui` replacement must preserve a component-oriented API, not just terminal drawing primitives.

## 2. Variations / exceptions

- **Some code is only lightly coupled to the external packages.**
  - Types only: `import type { ... } from "@earendil-works/pi-agent-core"` / `pi-ai` / `pi-tui`.
  - These are easier to swap with Rust-generated bindings or local type facades.

- **The `pi-*` aliases are still supported alongside `@earendil-works/*`.**
  - `src/core/extensions/loader.ts` maps both namespaces.
  - This shows the project already handles renames/compatibility layers, which is useful for a staged migration.

- **Not all TUI behavior is core platform behavior.**
  - Some parts are pure presentation (`components/*`).
  - Some parts are protocol-level (`interactive-mode.ts`, key handling, session selector, model selector).
  - Some parts are business logic embedded in UI files, which will be harder to port cleanly.

- **The package manifest already mixes internal and external responsibilities.**
  - `package.json` includes build/copy logic, bundled assets, and runtime dependencies together.
  - That means a Rust migration will likely need a new packaging story, not just code translation.

## 3. Anti-patterns or risks

- **Deep coupling to external TS APIs.**
  - `Agent`, `Model`, `Api`, `AssistantMessage`, `ThinkingLevel`, `Component`, `TUI` are used everywhere.
  - A Rust rewrite cannot “just replace imports”; it needs an API compatibility plan.

- **Dynamic plugin loading is a major migration blocker.**
  - `src/core/extensions/loader.ts` uses `jiti` and module alias rewriting.
  - Any Rust host must decide whether to:
    1. keep JS/TS plugins alive,
    2. re-spec the plugin ABI,
    3. or shell out to a JS sidecar.

- **TUI contracts are implicitly public.**
  - Many components rely on `pi-tui` primitives like `Container`, `Markdown`, `SelectList`, `Loader`, `Input`, `TUI`.
  - Replacing `pi-tui` means preserving rendering, focus, layout, keybinding, and markdown behavior.

- **ABI drift risk is high because the project uses declaration merging and cross-package type assumptions.**
  - Example: `messageTransformer` in `src/core/messages.ts`.
  - This is convenient in TS, but brittle when translated to Rust unless the message schema is frozen.

- **Package name compatibility is already a migration hazard.**
  - Both `@earendil-works/*` and `@mariozechner/*` appear in code and loader maps.
  - Rust migration should probably normalize on one canonical internal namespace early.

## 4. Evidence index

- `packages/coding-agent/package.json`
  - Direct deps on `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`
- `packages/coding-agent/src/core/sdk.ts`
  - Primary orchestration boundary for model/session/tool integration
- `packages/coding-agent/src/core/agent-session.ts`
  - Session/runtime wrapper around `Agent`
- `packages/coding-agent/src/core/model-registry.ts`
  - Model/auth/provider registry surface
- `packages/coding-agent/src/core/messages.ts`
  - Declaration merging against `pi-agent-core`
- `packages/coding-agent/src/core/extensions/loader.ts`
  - `jiti` loader + alias map for both package namespaces
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - Heavy `pi-tui` integration
- `packages/coding-agent/src/modes/interactive/components/*`
  - UI component ecosystem built on `pi-tui`
- `packages/coding-agent/src/core/tools/ask-user-question/view/*`
  - Rich custom UI built on TUI primitives
- `packages/coding-agent/src/core/keybindings.ts`
  - TUI-level keybinding coupling

If you want, I can turn this into a **Rust migration strategy matrix** next: *replace vs bind vs isolate* for each of the three libraries.

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

- **`@earendil-works/pi-agent-core` is the agent runtime, not just types.** Its docs describe:
  - `Agent`, `agentLoop`, `agentLoopContinue`
  - `AgentTool`
  - `convertToLlm`, `transformContext`
  - event streaming (`agent_start`, `turn_start`, `tool_execution_*`, `message_*`)
  - tool execution modes: `parallel` and `sequential`
  - custom message extension via declaration merging  
  Source: package docs for `@earendil-works/pi-agent-core` (fetched from npm page).

- **`@earendil-works/pi-ai` is the model/provider layer.** In this repo it supplies:
  - `Model`, `Api`, `Message`
  - `getModel`, `streamSimple`, `completeSimple`
  - OAuth/provider registry helpers (`registerApiProvider`, `getOAuthProviders`, etc.)
  - image/text content types used throughout the agent and TUI

- **`@earendil-works/pi-tui` is the terminal UI/rendering layer.** In this repo it supplies:
  - `TUI`, `Component`
  - widgets like `Box`, `Container`, `Markdown`, `Input`, `SelectList`, `Loader`
  - keybinding helpers and layout utilities
  - editor/theme/overlay primitives used by interactive mode

- **Your current packaging assumes those three packages are bundled or resolvable at runtime.**
  - `packages/coding-agent/src/core/extensions/loader.ts` statically imports all three into `VIRTUAL_MODULES`
  - it also maps both `@earendil-works/*` and `@mariozechner/*` specifiers
  - CI builds `@bastani/atomic` as a JS package plus binaries, not as a Rust artifact

## 2. Local implications

- **You cannot “just rewrite the CLI” first.** `pi-agent-core`, `pi-ai`, and `pi-tui` are woven into:
  - session orchestration (`sdk.ts`)
  - extension ABI (`extensions/types.ts`)
  - extension loading (`loader.ts`)
  - interactive mode (`interactive-mode.ts`)
  - tools, auth, compaction, and export paths

- **Best migration strategy is likely a split:**
  1. **Rust core** for session/tool/runtime orchestration
  2. **TS compatibility layer** temporarily for extensions/TUI, or replace them in stages
  3. **Stable IPC/FFI boundary** instead of direct TS imports

- **Most replaceable first:**
  - `pi-agent-core` → easiest to rehome in Rust because it is runtime/state/event/tool orchestration
  - `pi-ai` → next, if you define a Rust provider abstraction for models, streaming, and OAuth
  - `pi-tui` → hardest, because your interactive experience depends heavily on its widgets and component model

- **The extension loader is the main architectural blocker.**
  - Today it loads TS extensions dynamically with `jiti`
  - Rust cannot host that model natively
  - so the migration needs either:
    - a new plugin protocol (JSON-RPC/stdin/stdout/gRPC), or
    - a limited FFI boundary with statically linked plugins

- **A practical path is “headless first.”**
  - Preserve `print-mode` / RPC / noninteractive flows first
  - defer full TUI parity until later
  - keep TS UI as a thin client over Rust if needed

## 3. Version/API assumptions

- Current repo pins:
  - `@earendil-works/pi-agent-core ^0.78.0`
  - `@earendil-works/pi-ai ^0.78.0`
  - `@earendil-works/pi-tui ^0.78.0`
- Assumed stable APIs from local usage:
  - `Agent`, `AgentTool`, `agentLoop`, `streamSimple`, `completeSimple`, `TUI`, `Component`
- Assumption: these packages are **TypeScript-first libraries**, so a Rust port means replacing their runtime behavior, not just their type exports.

## 4. Unverified or unnecessary research

- I could not verify public docs for `pi-ai` and `pi-tui` beyond repo usage; the local code already shows their role clearly.
- I did **not** find evidence that the repo already has a Rust target or existing `Cargo.toml`.
- I did **not** verify whether the external packages are intended to be replaced wholesale or bridged through subprocess/FFI; the repo currently suggests a JS/TS runtime contract only.