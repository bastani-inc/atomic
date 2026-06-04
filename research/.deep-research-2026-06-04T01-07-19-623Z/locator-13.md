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