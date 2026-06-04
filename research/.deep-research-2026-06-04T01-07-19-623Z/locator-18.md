## 1. Must-read paths

- `packages/coding-agent/src/modes/print-mode.ts`  
  `runPrintMode(...)` is the non-interactive output path; it decides whether users get plain text vs JSON event streaming.

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`  
  `runRpcMode(...)` is the headless stdin/stdout protocol server. This is the main RPC compatibility surface to preserve in Rust.

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`  
  Defines the full wire contract: `RpcCommand`, `RpcResponse`, `RpcSessionState`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`.

- `packages/coding-agent/src/modes/rpc/jsonl.ts`  
  Strict LF-only framing (`serializeJsonLine`, `attachJsonlLineReader`) is critical for protocol compatibility.

- `packages/coding-agent/src/core/output-guard.ts`  
  `takeOverStdout()` / `writeRawStdout()` / `flushRawStdout()` are what keep JSON/RPC output clean.

- `packages/coding-agent/docs/json.md`  
  Canonical docs for `--mode json` event stream shape and header/event ordering.

- `packages/coding-agent/docs/rpc.md`  
  Canonical docs for command/response protocol, framing rules, and client expectations.

## 2. Supporting paths

- `packages/coding-agent/src/cli/args.ts`  
  Defines `Mode = "text" | "json" | "rpc"` and parses `--mode`.

- `packages/coding-agent/src/main.ts`  
  Routes execution: interactive vs print vs RPC; also blocks `@file` in RPC mode.

- `packages/coding-agent/src/core/agent-session.ts`  
  Shows how RPC/print modes bind session behavior, including `preflightResult` and extension hooks.

- `packages/coding-agent/docs/usage.md`  
  User-facing mode summary: `-p`, `--mode json`, `--mode rpc`.

- `packages/coding-agent/docs/session-format.md`  
  Relevant because JSON mode emits session header/event records that mirror session persistence concepts.

- `packages/coding-agent/test/rpc-client-clone.test.ts`  
  Minimal compatibility test for one RPC command (`clone`).

## 3. Entry points / symbols

- `runPrintMode(runtimeHost, options)` — `src/modes/print-mode.ts`
- `runRpcMode(runtimeHost): Promise<never>` — `src/modes/rpc/rpc-mode.ts`
- `RpcCommand` / `RpcResponse` / `RpcSessionState` — `src/modes/rpc/rpc-types.ts`
- `serializeJsonLine(value)` / `attachJsonlLineReader(stream, onLine)` — `src/modes/rpc/jsonl.ts`
- `takeOverStdout()` / `writeRawStdout()` / `flushRawStdout()` — `src/core/output-guard.ts`
- `parseArgs(args)` / `Mode` — `src/cli/args.ts`
- `main(args)` — `src/main.ts`

## 4. Gaps or uncertainty

- I verified the **current** TS implementation and docs, but not every RPC command path end-to-end.
- `rpc.md` is the best protocol reference, but some details may lag behind code changes.
- I did not confirm whether any external clients depend on undocumented stdout quirks beyond the JSONL framing.
- The Rust migration risk here is mostly **wire compatibility**, not business logic: print mode, JSON event stream, and RPC command set must stay byte-for-byte predictable.