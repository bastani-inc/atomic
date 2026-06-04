## Partition 13: Bash/process execution, command sandboxing, and cross-platform process behavior

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/core/tools/bash.ts`  
  Main bash tool implementation. Shows shell resolution, `spawn(...)`, `detached`, `windowsHide`, timeout/abort handling, and how command output is streamed/truncated.

- `packages/coding-agent/src/core/bash-executor.ts`  
  Shared execution wrapper around `BashOperations`; important if Rust replaces the command runner but keeps tool semantics.

- `packages/coding-agent/src/utils/shell.ts`  
  Cross-platform shell lookup and process-tree killing (`getShellConfig`, `killProcessTree`, `trackDetachedChildPid`).

- `packages/coding-agent/src/utils/child-process.ts`  
  Cross-platform spawn wrappers and `waitForChildProcess()`; critical for avoiding hangs on Windows stdio inheritance.

- `packages/subagents/src/runs/shared/pi-spawn.ts`  
  How subagent child processes are launched/resolved; relevant if Rust changes the “spawn a nested atomic/pi process” model.

- `packages/subagents/src/runs/shared/worktree.ts`  
  Git worktree setup uses `spawnSync("git", ...)` and `spawnSync` for hook execution; this is a major cross-platform process boundary.

- `packages/coding-agent/test/bash-close-hang-windows.test.ts`  
  Direct characterization of Windows close/hang behavior. This is the best proof of the current process model’s edge cases.

## 2. Supporting paths

- `packages/coding-agent/test/tools.test.ts`  
  Covers bash execution, timeouts, aborts, shell resolution, and full-output persistence.

- `packages/coding-agent/test/suite/agent-session-bash-persistence.test.ts`  
  Shows how bash results are persisted into session state.

- `packages/coding-agent/test/rpc.test.ts`  
  Verifies RPC-visible bash behavior, useful if Rust keeps RPC as a stable automation surface.

- `packages/coding-agent/src/core/tools/index.ts`  
  Registers `bash` alongside other tools; shows where process execution sits in the tool ABI.

- `packages/coding-agent/src/core/tools/file-mutation-queue.ts`  
  Not process execution itself, but relevant to command side effects and serialized mutations.

- `packages/coding-agent/test/package-manager.test.ts`  
  Includes Windows command-spawning expectations and shell-avoidance cases.

- `packages/coding-agent/test/clipboard*.test.ts`  
  Several tests here verify platform-specific spawn behavior and are good examples of cross-platform process handling.

## 3. Entry points / symbols

- `createLocalBashOperations()`  
  Local shell backend for bash tool execution.

- `createBashToolDefinition()` / `createBashTool()`  
  User-facing bash tool API and error formatting.

- `executeBashWithOperations()`  
  Shared execution path for remote/local delegation.

- `getShellConfig(customShellPath?)`  
  Cross-platform shell selection policy.

- `killProcessTree(pid)`  
  Current process-tree cancellation mechanism; Rust needs an equivalent.

- `waitForChildProcess(child)`  
  Important for avoiding hangs when descendants keep stdio handles open.

- `spawnProcess(...)` / `spawnProcessSync(...)`  
  Centralized platform-aware process spawning wrapper.

- `resolvePiCliScript()` / `getPiSpawnCommand()`  
  Determines how nested Atomic/Pi processes are launched.

- `createWorktrees(...)` / `runWorktreeSetupHook(...)`  
  Git and hook subprocess orchestration.

## 4. Gaps or uncertainty

- I verified heavy process usage in bash, worktrees, and subagent spawning, but **did not fully map every subprocess caller** across the repo.
- I found strong evidence for Windows-specific handling, but **did not verify all platform branches** (macOS/Linux edge cases may exist elsewhere).
- Rust migration impact on process execution depends on whether you plan to:
  - keep shelling out to system tools,
  - embed a scripting runtime, or
  - replace subprocess-heavy features with native Rust equivalents.
- I did **not verify** whether CI currently runs the Windows-specific bash hang test on a Windows runner.

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the repo’s **process boundary layer**: it turns user/tool intents into OS processes, then normalizes cross-platform behavior so higher-level features can treat execution as reliable.

Main behaviors:
- **Bash tool execution**: user-facing `bash` runs through a shared bash executor, using shell resolution, spawn options, streaming output, truncation, timeout/abort, and result persistence.
- **Child-process abstraction**: `spawnProcess` / `waitForChildProcess` centralize platform-aware process handling and are used to avoid hangs from inherited stdio or detached descendants.
- **Cancellation + cleanup**: process-tree killing is part of the contract, not an afterthought; cancellation must terminate descendants, not just the top PID.
- **Nested Atomic/Pi spawning**: subagents can launch child CLI processes, so process execution is also part of the orchestration model, not only the tool model.
- **Worktree setup hooks**: git worktree creation and setup scripts depend on synchronous subprocess execution.

For a Rust migration, this is the area where you decide whether Rust becomes:
1. a thin OS-process orchestrator,
2. a full replacement for shell/tool execution semantics, or
3. a hybrid that still shells out for many commands.

## 2. Key flows and invariants

### Bash execution flow
- Tool entrypoint registers `bash`.
- Execution resolves shell configuration (`getShellConfig`).
- A child process is spawned with platform-specific flags (`detached`, `windowsHide`, stdio handling).
- Output is streamed and bounded/truncated.
- Timeout/abort can terminate the process tree.
- Results are persisted into session state.

### Process invariants
- **Cross-platform consistency matters**: Windows-specific hangs are explicitly tested.
- **Child cleanup is required**: killing only the parent is insufficient.
- **Stdio inheritance is dangerous**: child handles can keep processes alive on Windows.
- **Shell selection is policyful**: custom shell paths and default shell resolution are part of the contract.
- **Synchronous subprocesses exist for setup paths**: worktree/hook flows don’t all use async spawning.

### Coupling to other partitions
- **Tool ABI**: bash is exposed as a built-in tool, so process behavior affects LLM-visible tool results.
- **Session persistence**: bash output becomes part of session history.
- **Subagents**: nested process spawning affects async/background execution.
- **Worktrees**: git/hook execution depends on the same OS-process assumptions.
- **Rust migration**: any CLI rewrite must preserve these semantics or intentionally redefine them.

## 3. Tests / validation

Strong evidence exists for this partition:
- `packages/coding-agent/test/bash-close-hang-windows.test.ts` — characterizes Windows close/hang behavior.
- `packages/coding-agent/test/tools.test.ts` — covers bash execution, timeout, abort, shell resolution, and output persistence.
- `packages/coding-agent/test/suite/agent-session-bash-persistence.test.ts` — confirms bash results are stored in session state.
- `packages/coding-agent/test/rpc.test.ts` — verifies bash behavior is visible through RPC.
- `packages/coding-agent/test/package-manager.test.ts` — includes Windows-spawn expectations.
- `packages/coding-agent/test/clipboard*.test.ts` — additional cross-platform spawn/process examples.

What remains unverified:
- Whether the Windows-specific hang test runs in CI on Windows.
- Whether every subprocess caller is covered by tests, especially outside the bash/worktree paths.

## 4. Risks, unknowns, and verification steps

### Risks
- **Windows behavior is fragile**: inherited stdio and detached descendants can hang shutdown.
- **Rust rewrite can easily break shell semantics** if it replaces Node/Bun spawn behavior too literally.
- **Subagent spawning may need a compatibility shim** if child CLI processes are still expected.
- **Worktree/setup hooks depend on git subprocesses**; native Rust wrappers must preserve exit-code and stdio behavior.

### Unknowns
- Full inventory of subprocess callers outside the known bash/worktree/subagent paths.
- Exact CI platform matrix for Windows process tests.
- Whether any behavior relies on Node/Bun-specific process semantics that Rust won’t mimic by default.

### Verify next
- Search all `spawn*`, `exec*`, and `child_process` use sites.
- Run the Windows hang test path under a Windows CI or VM.
- Define the Rust migration contract for:
  - shell execution,
  - process-tree cancellation,
  - stdio streaming,
  - synchronous setup commands,
  - nested CLI spawning.

### Online Researcher
## 1. Relevant external facts

- `std::process::Command` is the Rust standard API for spawning processes; `spawn()` returns a `Child`, `output()` waits for completion, and stdio defaults differ by method. Source: Rust std docs for `std::process::Command` / `Child`.
- `Child` has no `Drop`-based auto-kill; if you don’t wait/kill it explicitly, the process can keep running. Source: `std::process::Child`.
- On Windows, Rust process pipes can behave differently than Unix; the standard library has Windows-specific `CommandExt`, and there are known hang/pipe caveats in Rust issue tracker discussions around piped stdout and async/sync handle behavior. Sources: Rust docs + issues #45572 and #95759.
- Rust `Command` does not provide a built-in process-tree kill abstraction; tree-kill behavior usually needs platform-specific logic (`taskkill /T /F` on Windows, process groups / signals on Unix). This matches the kind of logic you already have in TS.

## 2. Local implications

- Your bash subsystem is a direct migration target: `packages/coding-agent/src/core/tools/bash.ts` depends on:
  - shell resolution,
  - `spawn(...)`,
  - stdout/stderr streaming,
  - timeout + abort handling,
  - detached process tracking,
  - process-tree termination.
- `packages/coding-agent/src/utils/process/child-process.ts` and `.../shell.ts` show that cross-platform process behavior is already a first-class concern. In Rust, this should likely become a dedicated process module, not scattered `Command` calls.
- The Windows hang workaround in `waitForChildProcess()` is especially important: Rust will need an equivalent “exit vs close vs pipe-drain” strategy, or you risk reintroducing the same deadlock class.
- `packages/subagents/src/runs/shared/worktree.ts` implies this isn’t just “run a shell command”; Git, hooks, and nested agent launches are also process boundaries. Plan for a shared Rust runtime layer that all these features reuse.
- Practical migration shape: keep shell-based behavior first, port the process wrapper second, then move callers (`bash`, worktrees, nested agent spawns) onto the wrapper.

## 3. Version/API assumptions

- Assumes **stable Rust** `std::process` APIs (`Command`, `Child`, `Stdio`) rather than async runtime-specific abstractions.
- Assumes platform-specific kill behavior will be implemented manually or via a crate, not via stdlib.
- Assumes you want to preserve current semantics: shell commands, streamed output, timeout/abort, and cross-platform behavior, not redesign them.

## 4. Unverified or unnecessary research

- I did **not** fully map every subprocess caller in the repo; the locator file already identifies the main high-risk ones.
- I did **not** verify whether your CI runs the Windows hang test on a Windows runner.
- I did **not** research which Rust crates you should use for process trees/PTYs because that depends on whether you want a minimal stdlib port or a richer async/runtime-based rewrite.