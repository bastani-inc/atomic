# @bastani/atomic-natives

Native Rust bindings for [Atomic](https://github.com/bastani-inc/atomic) exposed through N-API.

This package is a required dependency of `@bastani/atomic`, while its eight per-platform binary subpackages (`@bastani/atomic-natives-<platform>`) are installed as `optionalDependencies` of `@bastani/atomic-natives`. Most users do not need to install it directly. The Rust source lives in `crates/atomic-natives`, while this package publishes the generated NAPI-RS loader (`native/index.js`), TypeScript declarations (`native/index.d.ts`), and per-platform binary packages.

See Atomic's docs for [package manager troubleshooting](https://docs.bastani.ai/getting-started/installation#package-manager-troubleshooting), [Termux setup](https://docs.bastani.ai/termux), [environment variables](https://docs.bastani.ai/environment-variables), and the [SDK](https://docs.bastani.ai/sdk).

## Install

`@bastani/atomic` installs `@bastani/atomic-natives` automatically. Do not pass `--omit=optional` when installing in a project, because npm skips the platform binary subpackages and Atomic exits or throws `NativeModuleUnavailableError`.

To install directly for diagnostics or standalone tooling:

```bash
npm install @bastani/atomic-natives
```

## Quick start

```typescript
import { grep, nativeVersion } from "@bastani/atomic-natives";

console.log("Native addon version:", nativeVersion());

const result = await grep({
	pattern: "TODO",
	path: ".",
	glob: "*.ts",
	maxCount: 20,
});

for (const match of result.matches) {
	console.log(`${match.path}:${match.lineNumber}: ${match.line}`);
}
```

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

Android and Termux do not have prebuilt binaries. Atomic requires `@bastani/atomic-natives` to start any session and exits or throws `NativeModuleUnavailableError` without a compatible binary, so Android and Termux users must build the addon locally and set `NAPI_RS_NATIVE_LIBRARY_PATH` ([Termux setup](https://docs.bastani.ai/termux)).

## Overriding the native binary

At startup, Atomic compares `nativeVersion()` against the installed Atomic release version and refuses a mismatched binary. To load a locally built `.node` file (which bypasses the release version check), set `NAPI_RS_NATIVE_LIBRARY_PATH` ([Environment variables](https://docs.bastani.ai/environment-variables#diagnostics-and-performance)):

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
