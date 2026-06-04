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