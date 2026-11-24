# @bastani/atomic-natives

Native Rust bindings for [Atomic](https://github.com/bastani-inc/atomic) exposed through N-API.

This package is installed automatically as an optional platform dependency of `@bastani/atomic`; most users do not need to install it directly. The Rust source lives in `crates/atomic-natives`, while this package publishes the generated NAPI-RS loader (`native/index.js`), TypeScript declarations (`native/index.d.ts`), and per-platform binary packages.

## What it provides

- **PTY execution:** `PtySession` backs interactive pseudo-terminal execution for `bash` tool calls with `pty: true`.
- **Fast filesystem search:** `glob()`, `grep()`, `search()`, `hasMatch()`, and `invalidateFsScanCache()` power Atomic's built-in `find` and `search` tools.
- **Task supervision:** `TaskSupervisor` supervises owned command and agent tasks, wait budgets, cancellation, cleanup, process-group containment, and output spooling.
- **Subagent control:** `SubagentControl` enforces root-scoped subagent admission, depth and concurrency limits, and child status watches.
- **Process spawning and containment:** `HostProcess`, `startHostProcess()`, `containProcessTree()`, `containProcessTreeAllowingBreakaway()`, `holdProcessDescendants()`, `holdWindowsProcessExit()`, `processCreationTime()`, `terminateProcessCreatedAt()`, and `killSupervisedProcessTrees()` manage helper subprocesses and ensure process trees shut down cleanly across Unix and Windows.
- **Advisory file locks and atomic renames:** `AdvisoryLock`, `tryAdvisoryLock()`, `tryAdvisoryLockAsync()`, `trySharedAdvisoryLock()`, `trySharedAdvisoryLockAsync()`, `renameNoReplace()`, and `renameNoReplaceAsync()` coordinate cross-process file access.
- **Runtime and OS helpers:** `nativeVersion()`, `pendingStdinInput()`, `signalIgnored()`, `watchSessionEnd()`, and Windows directory security, file-pinning, and monotonic clock helpers.

## Supported platforms

Prebuilt binaries are published for eight targets:

- **macOS:** `x86_64-apple-darwin` (Intel), `aarch64-apple-darwin` (Apple Silicon)
- **Linux (glibc):** `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`
- **Linux (musl):** `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`
- **Windows:** `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`

Android and Termux do not have prebuilt binaries and require a local build or running without native acceleration.

## Overriding the native binary

At startup, Atomic compares `nativeVersion()` against the installed Atomic release version and refuses a mismatched binary. To load a locally built `.node` file (which bypasses the release version check), set `NAPI_RS_NATIVE_LIBRARY_PATH`:

```bash
export NAPI_RS_NATIVE_LIBRARY_PATH=/path/to/atomic_natives.node
atomic
```

## Building from source

Building requires a Rust toolchain (`rustup` / `cargo`) and Bun (`1.4.5+`). From the repository root:

```bash
npm run build --workspace=@bastani/atomic-natives
```

Or from inside `packages/natives/`:

```bash
bun run build        # Release build
bun run build:debug  # Debug build
```

## License

MIT. See [LICENSE](LICENSE).
