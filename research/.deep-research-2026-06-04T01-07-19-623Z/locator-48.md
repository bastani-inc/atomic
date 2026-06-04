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