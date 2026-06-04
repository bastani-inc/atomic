## 1. Established patterns

- **Shell execution is centralized, but only partially unified.**  
  The main bash tool uses `createLocalBashOperations()` in `packages/coding-agent/src/core/tools/bash.ts`, while reusable lower-level execution lives in `packages/coding-agent/src/core/bash-executor.ts`.

- **Cross-platform shell resolution is explicit and defensive.**  
  `packages/coding-agent/src/utils/shell.ts` prefers:
  1. user-specified `shellPath`
  2. Windows Git Bash / PATH lookup
  3. Unix `/bin/bash`
  4. fallback to `sh`  
  This is the main portability contract.

- **Process trees are treated as first-class cancellation targets.**  
  `killProcessTree()` and detached PID tracking in `packages/coding-agent/src/utils/shell.ts` are used by bash execution to clean up descendants on abort/timeout.

- **Output handling is standardized for agent-facing tools.**  
  Bash output is streamed, sanitized, truncated, and optionally persisted to temp files in:
  - `packages/coding-agent/src/core/bash-executor.ts`
  - `packages/coding-agent/src/core/tools/bash.ts`

- **Execution is cancellable and timeout-aware.**  
  The bash tool accepts `AbortSignal` + optional timeout, and maps them to user-facing errors like `Command aborted` / `Command timed out...` in `packages/coding-agent/src/core/tools/bash.ts`.

- **Tool execution favors pluggable backends.**  
  `BashOperations` in `packages/coding-agent/src/core/tools/bash.ts` lets extensions replace local shell execution without rewriting the tool UI/ABI.

## 2. Variations / exceptions

- **`execCommand()` is a narrower subprocess helper.**  
  `packages/coding-agent/src/core/exec.ts` uses `spawn(..., shell: false)` and returns raw stdout/stderr/code; it’s used by extensions/loader code rather than the interactive bash tool.

- **Not all subprocesses use the same lifecycle model.**  
  `packages/coding-agent/src/core/tools/find.ts` spawns `fd` directly with manual kill handling, separate from the bash tool’s process-tree tracking.

- **Windows behavior is not identical to Unix.**  
  `killProcessTree()` uses `taskkill /F /T /PID` on Windows, but negative-PID process-group killing on Unix/macOS in `packages/coding-agent/src/utils/shell.ts`.

- **Shell execution is not sandboxed.**  
  The repo’s model is “trusted local command execution,” not capability-based restriction. Sandbox-like behavior is only implied by truncation/cancellation, not policy enforcement.

## 3. Anti-patterns or risks

- **Multiple subprocess pathways increase migration surface.**  
  Bash, `execCommand()`, `find.ts`, and shell helpers are similar but not identical; a Rust port would need a single coherent process abstraction or risk drift.

- **Process cleanup relies on platform-specific heuristics.**  
  Detached-child tracking, `taskkill`, and `process.kill(-pid)` are operationally fragile compared to a dedicated process supervision layer.

- **Output truncation is UI-driven, not execution-driven.**  
  The system optimizes for display and temp-file recovery, but the underlying process still runs unrestricted until cancellation/exit.

- **Extension loader can invoke commands indirectly.**  
  `packages/coding-agent/src/core/extensions/loader.ts` exposes `exec(...)` into extension context, so process behavior is part of the extension ABI.

## 4. Evidence index

- `packages/coding-agent/src/core/tools/bash.ts` — `BashOperations`, `createLocalBashOperations()`, timeout/abort handling, output formatting
- `packages/coding-agent/src/core/bash-executor.ts` — streaming execution, temp-file persistence, truncation
- `packages/coding-agent/src/utils/shell.ts` — shell resolution, env PATH injection, `killProcessTree()`, detached PID tracking
- `packages/coding-agent/src/core/exec.ts` — generic `execCommand()` wrapper
- `packages/coding-agent/src/core/tools/find.ts` — direct `spawn(fdPath, ...)` subprocess path
- `packages/coding-agent/src/core/extensions/loader.ts` — extension-side `exec(...)` access to process execution