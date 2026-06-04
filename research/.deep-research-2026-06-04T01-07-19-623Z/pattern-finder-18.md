## 1. Established patterns

- **JSON output is treated as a print-mode variant, not a separate engine.**  
  `src/main.ts` maps `appMode === "json"` to `runPrintMode(..., { mode: "json" })`, and `src/modes/print-mode.ts` switches behavior only on `"text" | "json"`.  
  Pattern: *same execution pipeline, different stdout contract*.

- **RPC is a strict JSONL protocol on stdin/stdout.**  
  `src/modes/rpc/rpc-mode.ts` uses `attachJsonlLineReader()` + `serializeJsonLine()` and emits line-delimited JSON responses/events.  
  Pattern: *framed JSON messages, not ad hoc console output*.

- **RPC compatibility is preserved through typed command/response contracts.**  
  `src/modes/rpc/rpc-types.ts` defines `RpcCommand`, `RpcResponse`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, and `RpcSessionState`.  
  Pattern: *protocol stability is enforced at the type level*.

- **Print mode suppresses UI-only features explicitly.**  
  `src/main.ts` excludes `ask_user_question` in `print`/`json` via `resolveExcludedToolsForAppMode()`.  
  Pattern: *headless modes disable interactive affordances up front*.

- **RPC mode substitutes UI with protocol messages.**  
  `rpc-mode.ts` maps extension UI calls (`select`, `confirm`, `input`, `setStatus`, `setWidget`, `setTitle`, etc.) into `extension_ui_request` packets.  
  Pattern: *UI abstraction boundary is preserved by translation, not reimplementation*.

- **Shared runtime is reused across all three modes.**  
  `src/main.ts` builds one `AgentSession`/runtime and routes to interactive, print, or RPC after setup.  
  Pattern: *mode differences happen at the edges; core session logic stays shared*.

## 2. Variations / exceptions

- **JSON mode is “all events”, text mode is “final answer only”.**  
  In `print-mode.ts`, `"json"` streams every event; `"text"` only prints the last assistant/custom message.

- **RPC supports richer interaction than print mode.**  
  `runRpcMode()` supports prompt, abort, model switching, compaction, session ops, and extension UI round-trips. Print mode is one-shot.

- **Some UI capabilities are intentionally unsupported in RPC.**  
  `rpc-mode.ts` stubs out or no-ops things like `custom()`, `setHeader()`, `setFooter()`, raw terminal input, and several working-indicator behaviors.

- **Binary/client compatibility is currently Node-shaped.**  
  `src/modes/rpc/rpc-client.ts` spawns `node dist/cli.js --mode rpc`, so the client assumes the shipped CLI is runnable as a Node entrypoint.

- **Tests show protocol stability is a first-class concern.**  
  `test/rpc-jsonl.test.ts` verifies LF-only framing and U+2028/U+2029 handling; `test/rpc-prompt-response-semantics.test.ts` checks one-response-per-prompt behavior.

## 3. Anti-patterns or risks

- **CLI/transport coupling to Node is a migration hotspot.**  
  `rpc-client.ts` hardcodes `spawn("node", [cliPath, ...])`; a Rust rewrite would need either a new client or a compatibility shim.

- **RPC UI fallback semantics are lossy.**  
  Several UI calls degrade to no-ops or simplified packets in `rpc-mode.ts`, so a Rust port must decide whether to keep that reduced contract or expand it.

- **JSON mode currently shares print-mode exit/error logic.**  
  This is convenient, but it means protocol changes in print mode can accidentally affect JSON output compatibility.

- **Protocol surface is larger than “just commands”.**  
  The typed RPC layer includes extension UI requests, session state, bash results, compaction results, and slash-command discovery; a Rust port must preserve all of these if it wants drop-in compatibility.

## 4. Evidence index

- `packages/coding-agent/src/main.ts`
  - `resolveExcludedToolsForAppMode()`
  - `resolveAppMode()`
  - `toPrintOutputMode()`
  - `if (appMode === "rpc") ... else if (appMode === "interactive") ... else runPrintMode(...)`

- `packages/coding-agent/src/modes/print-mode.ts`
  - `PrintModeOptions`
  - `mode: "text" | "json"`
  - `writeRawStdout()`, `flushRawStdout()`
  - final-output-only vs event-stream behavior

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - `takeOverStdout()`
  - `attachJsonlLineReader()`, `serializeJsonLine()`
  - `extension_ui_request` translation
  - unsupported UI stubs/no-ops

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
  - `RpcCommand`
  - `RpcResponse`
  - `RpcExtensionUIRequest`
  - `RpcExtensionUIResponse`
  - `RpcSessionState`

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
  - `spawn("node", [cliPath, ...])`
  - `--mode rpc`
  - typed client API for protocol compatibility

- `packages/coding-agent/test/rpc-jsonl.test.ts`
  - strict JSONL framing
  - LF-only parsing
  - U+2028/U+2029 preservation

- `packages/coding-agent/test/rpc-prompt-response-semantics.test.ts`
  - one response per prompt
  - preflight failure/success semantics