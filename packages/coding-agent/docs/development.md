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

Set `ATOMIC_TIMING=1` when profiling startup. Normal interactive launches print the initial startup group before `interactiveMode.run()` starts the TUI loop, so marks reached later in the interactive lifecycle are not printed during ordinary sessions. Use `ATOMIC_STARTUP_BENCHMARK=1` for first-frame/deferred-startup probes; it initializes interactive mode, explicitly completes deferred startup work, emits marks such as `time-to-first-frame`, `startup-input-raw-mode-enabled`, `startup-input-first-raw-key`, and `deferred-extension-load` when reached, then exits without submitting a prompt. During normal startup, built-in commands and lightweight bundled extension command metadata are available for autocomplete immediately, while heavy extension implementations load only when an extension command or another extension-aware action is invoked. Targeted tests/probes can also assert later interactive marks such as `interactive-input-handler-ready` and `interactive-first-submit`.

## Testing

```bash
npm run typecheck                 # Type-check the monorepo
npm run test:unit                 # Run unit tests
npm run test:integration          # Run integration tests
npm run test:all                  # Run all tests
npm run test:scripts              # Run the repository script tests under node --test
# Run the package Vitest suite (Node-hosted)
npm run test --workspace=@bastani/atomic -- test/specific.test.ts
# Run its Bun-hosted half. Required: the SQLite selector tests load bun:sqlite,
# which the shipped binary has and Node does not.
```

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
  i-have-adhd/   # Built-in ADHD-friendly response style extension
  intercom/     # Built-in cross-session coordination channel
```
