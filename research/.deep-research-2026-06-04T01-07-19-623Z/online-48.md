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