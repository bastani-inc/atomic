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