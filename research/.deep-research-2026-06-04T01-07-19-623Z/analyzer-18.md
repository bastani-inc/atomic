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