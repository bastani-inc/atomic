# Development

See [AGENTS.md](https://github.com/bastani-inc/atomic/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/bastani-inc/atomic
cd atomic
npm ci --ignore-scripts
npm run typecheck
```

This monorepo runs a hybrid toolchain matching upstream pi: npm installs, builds, checks, and runs the vitest suites, while Bun compiles the release binaries and runs `scripts/*.ts`. Avoid yarn and pnpm. Run package scripts from the monorepo root or a package directory, for example:

```bash
npm run test:unit
npm run build --workspace=@bastani/atomic
```

Atomic keeps the caller's current working directory when launched from development wrappers.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "atomicConfig": {
    "name": "atomic",
    "configDir": ".atomic"
  }
}
```

Change `name`, `configDir`, and the `bin` field for your fork. The app-specific `<appName>Config` key is preferred; legacy `piConfig` remains a backwards-compatible shim. Atomic sets these to `atomic`, `.atomic`, and the `atomic` executable. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: package-manager install, standalone binary, and source checkout.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.atomic/agent/atomic-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Startup timing probes

Use `scripts/perf/windows-startup/benchmark.ts` for Windows startup claims. It launches the ordinary bare `atomic` command through a real 120x40 ConPTY, feeds ordered output into `@xterm/headless`, and timestamps each receive with `process.hrtime.bigint()`. Complete first paint requires the final `Atomic v<version>` identity, the focused `❯ ` editor, and two identical settled frames at least one 80 ms animation interval apart. `dispatchMs` runs from the Enter write to the first byte observed by a raw TCP loopback provider. The headline `spawnToDispatchMs` is exactly `startupCompleteMs + dispatchMs`; `launchToProviderFirstByteMs` separately retains the contiguous launch-to-provider interval that also contains nonce typing and editor-echo wait. The provider request must contain the nonce and the normal tool schemas, and every accepted sample must pass `/workflow list` after the timed response. See [the benchmark README](https://github.com/bastani-inc/atomic/blob/main/scripts/perf/windows-startup/README.md) for artifact preparation, cache profiles, raw records, and summary commands.

Do not use `time-to-first-frame` as settled-paint evidence, and do not substitute `launchToProviderFirstByteMs` for the contract sum. The first-frame mark records the host's first requested identity frame after the header is mounted; it does not prove terminal receipt, animation settlement, engine resource readiness, or provider readiness. `ATOMIC_STARTUP_BENCHMARK=1`, `--no-extensions`, and `--no-tools` are attribution controls only. They do not run the accepted full CLI path with bundled workflows, normal extensions, tools, and provider dispatch.

The process-local lifecycle timing seams use monotonic nanoseconds and remain disabled until an internal diagnostic adapter installs a synchronous sink. With no sink, they do not read the clock, write output, or schedule work. External ConPTY and TCP marks remain authoritative. Startup now has several deliberate partial orders rather than one cross-process sequence:

```text
interactive host: process-entry → interactive-engine-spawn → engine-ready
                  → tui-start → header-mounted → initialize engine-bound state
                  → chat-output-release → interactive-input-handler-ready

isolated child:   process-entry → engine-ready → engine-bound
                  → engine-resources-ready

external screen:  first-terminal-write → startup-coherent → startup-complete

first turn:       interactive-first-submit → before-provider-request
```

The header and editor are mounted before the host waits for `engine-bound`; the child can therefore report binding while the host is applying its theme or requesting that frame. `engine-bound` means RPC control plus the mandatory minimal session are available. `engine-resources-ready` is a separate, generation-scoped child message sent only after a staged optional snapshot containing bundled extensions, tools, providers, skills, prompts, and themes commits. User prompts, extension commands, model/resource commands, session replacement, and tool-dispatching RPC calls wait for that gate. After a readiness failure, `/reload` bypasses the rejected gate to start a fresh transactional attempt; successful retry replaces the gate before later work proceeds. Escape cancels a first submission that is still waiting, so that continuation cannot dispatch later. `session_start` messages are queued against the candidate snapshot and released only after publication. Mandatory Intercom remains in the minimal runtime. A failed transactional candidate leaves host-managed settings, providers, tools, resources, event subscriptions, and system-prompt state unchanged, restores an unadmitted prompt draft exactly, and reports the generation failure once. Extension-owned objects stored with `sessionScopedExtensionState` are deliberately shared across reloads and are not cloned or rolled back.

`engine-resources-ready` is recorded in the isolated engine process; host marks are recorded in the interactive process. The two process clocks are monotonic but must not be subtracted without an external synchronization protocol. `startup-coherent` and `startup-complete` describe internal render composition, not terminal receipt. The external VT predicates decide the reported first-paint marks.

For package-manager installs under Node 22, Atomic enables Node's persistent module compile cache in both the host and isolated child and flushes the host cache before spawning the child. Explicit `NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE` settings pass through unchanged. This preserves Node's coverage opt-out and avoids forcing a new cache directory or a first-run-only precompile step. SEA, V8 snapshots, and package-install precompilation were not adopted because Atomic's dynamic ESM, native modules, workers, and first-run requirements do not provide a safe portable boundary.

Compiled releases syntax-minify the shared CJS `app.js` sidecar without identifier minification and compile launchers with bytecode on all eight supported targets, including Windows x64 and ARM64. `bun run scripts/probe-windows-bytecode.ts` pins Bun 1.4.0, cross-compiles `bun-windows-x64-baseline` and `bun-windows-arm64` launchers, and verifies their PE machine types. Atomic observed a Bun 1.3.14 Windows startup crash in `llint_entry`, but Bun 1.4.0 already contains the embedded-bytecode alignment fix ([#26299](https://github.com/oven-sh/bun/pull/26299)) and integrity fallback ([#31961](https://github.com/oven-sh/bun/pull/31961)); the separate Bun 1.4.0 Windows report ([#40302](https://github.com/oven-sh/bun/issues/40302)) concerns a general standalone/JIT segfault and has not been shown to be bytecode-specific. Cross-compilation is not runtime validation: release candidates still require full-archive target-machine coverage of the TUI, workflows, tools, extensions, workers, and native add-ons, with Windows ARM64 validated on ARM64 hardware.

Set `ATOMIC_TIMING=1` only for the older human-readable phase diagnostics. Normal interactive launches print that initial timing group before `interactiveMode.run()` starts the TUI loop, so later marks are not printed during ordinary sessions.

## Testing

```bash
npm run typecheck                 # Type-check the monorepo
npm run test:unit                 # Run unit tests
npm run test:integration          # Run integration tests
npm run test:all                  # Run all tests
npm run test:scripts              # Run the repository script tests under node --test
# Run the package Vitest suite (Node-hosted)
npm run test --workspace=@bastani/atomic -- test/specific.test.ts
```

Root Vitest projects install a fresh in-memory durable backend before every test.
Durability initialization imports the backend and its process owner rather than
preloading the DBOS factory or the Atomic host. A test that needs host prototype
installers must import those real modules explicitly rather than depend on a
side effect of shared setup. Test-local backend overrides still use the factory's
injection seam, and the next test receives a fresh backend without resetting
unrelated initialization or warning state. Keep the global artifact/native setups,
default isolation, worker sizing and timeout budgets unchanged when measuring
test cost. See the [CI measurements](https://github.com/bastani-inc/atomic/blob/main/docs/ci.md#current-critical-path-measured-september-5-2026)
for local gains and the remaining hosted Linux/Windows validation.

CI runs the complete root unit and integration suites in independent Linux and
Windows jobs. Each builds its own native and package prerequisites; both required
result gates wait for every work job and reject failures, cancellations and skips.
This trades duplicated setup for earlier integration feedback without changing
test isolation, coverage or retries.

## Deterministic installs

`@bastani/atomic` ships `packages/coding-agent/npm-shrinkwrap.json` so package-manager installs resolve the same dependency tree every time. Contributors working from a source checkout can validate that the checked-in shrinkwrap is up to date with:

```bash
bun run scripts/generate-coding-agent-shrinkwrap.mjs --check
```

## Release security boundary

Atomic's release bases remain at the `0.0.0` placeholder. `scripts/cut-release.ts` stamps the real version only on a detached tagged release commit. Tag creation runs an inert signal workflow; a separate `workflow_run` publisher loaded from protected `main` validates the exact upstream repository, source workflow/event/run, tag/SHA, immutable release-base trailers, and deterministic release tree. The privileged trigger checks out only protected workflow code: it treats the tag tree as data, exports it only after deterministic verification, and makes every read-only build verify the protected job's source checksum instead of checking out tag-selected code. Same-run artifact transport failures receive at most one retry after partial-download cleanup and still fail explicitly on the second error; verified source archives are streamed to tar over stdin for portable Windows drive-letter handling. Preparation restores the digest-verified source after documentation validation before producing artifacts. Release-source jobs configure no dependency cache, npm publication has OIDC without repository write, and GitHub Release creation has repository write without OIDC. Never move or recreate a failed release tag or dispatch the privileged publisher. See the repository's [CI/CD pipeline](https://github.com/bastani-inc/atomic/blob/main/docs/ci.md#release-pipeline) for trusted-publisher configuration.

## Project Structure

```
packages/
  coding-agent/ # Atomic CLI, agent loop, providers, TUI, and core runtime
  workflows/    # First-party workflow extension bundled into Atomic
  subagents/    # Built-in subagent orchestration and reusable agents
  mcp/          # Built-in MCP adapter extension
  web-access/   # Built-in web search and content extraction tools
  intercom/     # Built-in cross-session coordination channel
```
