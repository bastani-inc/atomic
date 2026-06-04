## Partition 18: Print mode, JSON output mode, and RPC protocol compatibility

### Locator
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

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the **headless compatibility layer** of the CLI:

- **Print mode** (`--mode text|json`) is single-shot: send prompts, then exit.
- **JSON mode** is a strict **event stream** over stdout: first a session header (if present), then session events as JSON lines.
- **RPC mode** is a long-lived **stdin/stdout JSONL protocol server** for embedding the agent in other apps.

The migration-sensitive behavior is not “agent logic” itself; it’s the **wire contract**:
- predictable stdout framing
- exact response shapes
- prompt acceptance vs execution semantics
- extension UI request/response bridging
- session rebind/reload behavior after new session / fork / switch

## 2. Key flows and invariants

### Print mode
- `runPrintMode(...)` binds extensions, subscribes to session events, and optionally writes the session header in JSON mode.
- In **text mode**, it prints only the final assistant/custom displayable output.
- It tracks **command-originated extension errors** specially:
  - command errors set exit code `1`
  - they suppress stale final output for that prompt
  - non-command extension errors are logged but do not force non-zero exit
- Signal handling (`SIGTERM`, `SIGHUP`) kills detached children, disposes runtime, and exits with conventional codes.

**Invariant:** text output must stay clean; JSON mode must stream all events, one line per event.

### JSON output mode
- The output is raw `JSON.stringify(event) + "\n"`.
- The docs specify the first line is a session header, then `AgentSessionEvent` records.
- This mode is tightly coupled to session lifecycle and event schema; it is effectively a serialization of internal agent state.

**Invariant:** LF-delimited JSONL only; clients must not rely on generic line readers that split on Unicode separators.

### RPC mode
- `takeOverStdout()` is used so incidental console output won’t corrupt stdout protocol traffic.
- It binds the session with:
  - `uiContext` that converts extension UI actions into RPC requests
  - `commandContextActions` for session control
  - a shutdown handler
  - error forwarding as `extension_error` events
- Commands are parsed line-by-line from stdin with strict JSONL framing.
- Some commands are synchronous responses; others are **async acceptance + later events** (notably `prompt`).

Key RPC invariants:
- `prompt` emits its response only after **preflight succeeds**.
- If a prompt is already streaming, caller must provide `streamingBehavior` or it errors.
- `new_session`, `switch_session`, `fork`, and `clone` may rebind the session afterward.
- `get_state` is a snapshot of runtime state, including queue/streaming/compaction flags.
- `get_commands` merges commands from extensions, prompt templates, and skills.
- Unknown commands return an error response.

### Extension UI bridging in RPC
- UI requests like `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` are converted into `extension_ui_request` events.
- Some UI capabilities are intentionally unsupported in RPC mode (custom header/footer/components, terminal input, theme switching, rich widgets/factories).

**Invariant:** RPC mode preserves protocol compatibility by degrading unsupported TUI features rather than failing the whole session.

## 3. Tests / validation

Good coverage exists for this partition:

- **JSONL framing**
  - `rpc-jsonl.test.ts` verifies:
    - strict LF framing
    - preservation of `U+2028` / `U+2029`
    - CRLF tolerance
    - final unterminated line handling
- **Print mode**
  - `print-mode.test.ts` covers:
    - shutdown cleanup
    - text vs JSON behavior
    - final displayable custom message output
    - assistant error exit codes
    - command-originated extension error suppression
- **RPC semantics**
  - `rpc-prompt-response-semantics.test.ts` verifies:
    - prompt failure emits one failure response
    - success emits one success response
    - queued prompts still produce one response
- **RPC client surface**
  - `rpc-client-clone.test.ts` checks at least one command mapping (`clone`)
- **Integration**
  - `rpc.test.ts` exercises real subprocess RPC behavior and session persistence.

## 4. Risks, unknowns, and verification steps

### Risks for a TS → Rust migration
- **Wire compatibility is the hard part**: JSON shape, newline framing, timing of responses, and stdout cleanliness must remain stable.
- **Prompt semantics are subtle**: acceptance vs completion is different; Rust must preserve preflight/queue behavior.
- **Unsupported UI features must fail gracefully**: don’t turn “not supported in RPC” into protocol breakage.
- **`takeOverStdout()` behavior is runtime-specific**: Bun/Node differences may need explicit Rust-side handling if you embed or proxy output.
- **Session rebind lifecycle** after fork/switch/new_session is easy to regress.

### What’s still unknown
- Whether any external clients depend on undocumented ordering of JSON events beyond the documented schema.
- Whether there are hidden stdout/stderr assumptions in real-world RPC consumers.
- Whether all command paths in `rpc-mode.ts` have integration coverage beyond the tests listed above.

### Verify in a Rust port
- Golden-file compare:
  - JSON mode event streams
  - RPC request/response sequences
  - CRLF and Unicode separator framing
- Add compatibility tests for:
  - prompt acceptance timing
  - extension UI round-trips
  - session rebind after fork/switch/new_session
  - stdout cleanliness under noisy logs
- Run existing RPC/print tests against the Rust binary as a drop-in replacement.

### Online Researcher
## 1. Relevant external facts

- **`serde_json::to_string` (serde_json crate)** serializes a value to JSON text, but **does not append a newline**. For JSONL/RPC you must add `\n` yourself.  
- **`std::io::BufRead` (`lines`, `read_line`)** is line-oriented, but your repo’s protocol docs explicitly require **strict LF framing** and CR stripping for input compatibility.  
- **`clap` derive / parser docs** support typed CLI flags/subcommands cleanly, so it’s a reasonable Rust replacement for the TS `parseArgs(...)` path.

## 2. Local implications

- **Print mode (`runPrintMode`)** must stay a two-path renderer:
  - `--mode text`: emit only final assistant/custom text to stdout.
  - `--mode json`: emit the **session header first**, then every session event as JSON lines.
- **JSON output mode** depends on exact stdout hygiene:
  - `takeOverStdout()` in TS exists because machine-readable output must not be polluted by logs.
  - In Rust, keep stdout/stderr separation just as strict.
- **RPC mode** is the highest-risk migration surface:
  - Commands on stdin, responses/events on stdout.
  - Preserve the exact wire types from `rpc-types.ts`.
  - Preserve **LF-only JSONL** framing and accept optional `\r\n` input.
- **Compatibility rule**: migrate behavior, not just features. The Rust port must preserve:
  - event ordering,
  - response shapes,
  - command names,
  - session header emission,
  - and stdout cleanliness.

## 3. Version/API assumptions

- Rust implementation should assume **`serde_json`** for encoding/decoding JSON lines.
- For input framing, prefer explicit byte framing (`\n`) over generic “read line” helpers if you want to mirror the current protocol exactly.
- For CLI, assume **`clap`** (derive or builder API) for `--mode text|json|rpc`, `--session-dir`, `--no-session`, etc.
- I did **not** verify a specific Rust crate/version for the port; these are API-level assumptions only.

## 4. Unverified or unnecessary research

- I did not validate any **external Rust RPC client ecosystem** beyond the standard JSON/CLI building blocks.
- I did not research a Rust equivalent for every TS runtime helper yet (e.g. session runtime, extension hooks, compaction internals); this partition is specifically about **print mode, JSON mode, and RPC compatibility**.
- No extra external standards were needed beyond JSONL framing and Rust std/serde/clap behavior.