# Development

See [AGENTS.md](https://github.com/bastani-inc/atomic/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/bastani-inc/atomic
cd atomic
npm ci --ignore-scripts
npm run build
```

Use npm for installs, builds, checks, and Vitest suites. Bun compiles standalone binaries and runs repository TypeScript scripts. Do not use yarn, pnpm, or `bun install`.

Atomic keeps the caller's current working directory when launched from development wrappers.

Run package scripts from the monorepo root or a package directory, for example:

```bash
npm run test:unit
npm run build --workspace=@bastani/atomic
```

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

Change `name`, `configDir`, and the `bin` field for your fork. These control the CLI banner, config paths, and environment variable names. Legacy `piConfig` remains a compatibility fallback.

The app-specific `<appName>Config` key is preferred. Atomic sets these to `atomic`, `.atomic`, and the `atomic` executable.

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

For startup measurements, see the [Windows startup benchmark](https://github.com/bastani-inc/atomic/blob/main/scripts/perf/windows-startup/README.md). Internal timing marks do not prove terminal first paint.

## PDF and engine diagnostics

PDF conversion and engine diagnostics appear as status messages in interactive sessions
and console output otherwise. Conversion failures also include diagnostic details in
their error result. Long or noisy diagnostics may be truncated. Interactive sessions keep
only recent diagnostics; older diagnostics are discarded without removing normal chat.

Diagnostics are displayed as text, not terminal commands. RPC clients receive diagnostics
separately from JSON responses. No `atomic-engine-stderr.log` file is written; include the
displayed diagnostic and conversion error when reporting a PDF problem.

## Startup timing probes

Use the [current startup benchmark instructions](https://github.com/bastani-inc/atomic/blob/main/scripts/perf/windows-startup/README.md).

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

Set `ATOMIC_TIMING=1` only for the older human-readable phase diagnostics. Normal interactive launches print that initial timing group before `interactiveMode.run()` starts the TUI loop, so later marks are not printed during ordinary sessions.

For the current Bun version, Windows-hosted bytecode requirement, and archive-validation caveats, see [Windows interactive startup](/windows#interactive-startup).

## Testing

```bash
npm run check                    # Typechecks and published-shrinkwrap validation
npm run test:unit                # Root unit tests
npm run test:integration         # Root integration tests
npm run test:all                 # All root test projects
npm run test:scripts             # Repository script tests under Node
npm run test --workspace=@bastani/atomic -- test/specific.test.ts
```

CI runs root unit and integration suites on Linux and Windows. See [CI documentation](https://github.com/bastani-inc/atomic/blob/main/docs/ci.md) for job details and release procedures.

To run only the typechecks:

```bash
npm run typecheck                 # Type-check the monorepo
```

### Installed package smoke test

After building, run:

```bash
ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE=1 npx vitest --run --project integration test/integration/installed-package-node-extensions.test.ts
```

This checks Node startup and builtin extension loading outside the checkout.

Atomic ships an npm shrinkwrap. After dependency changes, regenerate it with `npm run shrinkwrap:coding-agent` and validate with `npm run check`.

## Deterministic installs

See [Testing](#testing) for the current shrinkwrap commands.

`@bastani/atomic` ships `packages/coding-agent/npm-shrinkwrap.json` so package-manager installs resolve the same dependency tree every time. Contributors working from a source checkout can validate that the checked-in shrinkwrap is up to date with:

```bash
bun run scripts/generate-coding-agent-shrinkwrap.mjs --check
```

## Release security boundary

Follow the [current release pipeline](https://github.com/bastani-inc/atomic/blob/main/docs/ci.md#release-pipeline).

Atomic's release bases remain at the `0.0.0` placeholder. `scripts/cut-release.ts` stamps the real version only on a detached tagged release commit.

## Project Structure

```text
packages/
  ai/           # Atomic's LLM provider fork
  coding-agent/ # CLI, interactive mode, and core runtime
  workflows/    # Workflow execution
  subagents/    # Subagent orchestration
  mcp/          # MCP adapter
  web-access/   # Web search and content extraction
  intercom/     # Cross-session coordination
  feedback/     # Conversational feedback drafting
```

The bundled companion-package roles are:

```
packages/
  coding-agent/ # Atomic CLI, agent loop, providers, TUI, and core runtime
  workflows/    # First-party workflow extension bundled into Atomic
  subagents/    # Built-in subagent orchestration and reusable agents
  mcp/          # Built-in MCP adapter extension
  web-access/   # Built-in web search and content extraction tools
  intercom/     # Built-in cross-session coordination channel
  feedback/     # Built-in feedback command and conversational drafting skill
```
