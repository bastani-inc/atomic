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