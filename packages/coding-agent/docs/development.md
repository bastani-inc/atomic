# Development

See [AGENTS.md](https://github.com/bastani-inc/atomic/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/bastani-inc/atomic
cd atomic
bun install
bun run typecheck
bun run check:file-length
```

This monorepo uses Bun for development commands; avoid npm/yarn/pnpm except for npm registry publishing. Run package scripts from the monorepo root or package directory with Bun, for example:

```bash
bun run test:unit
bun run --cwd packages/coding-agent build
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
bun run typecheck                 # Type-check the monorepo
bun run check:file-length         # Enforce the tracked TS/JS/Rust 500-line limit
bun run test:unit                 # Run unit tests
bun run test:integration          # Run integration tests
bun run test:all                  # Run all tests
# Run package Vitest tests
bun run --cwd packages/coding-agent test -- test/specific.test.ts
```

The file-length gate scans tracked `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, and `.rs` files via `git ls-files`, falls back to a recursive walk outside Git, and counts physical lines with a no-final-newline correction. Only generated/vendored path globs (`node_modules`, `dist`, `target`, `binaries`, `.git`, `vendor`, minified bundles, and the bundled third-party `packages/workflows/skills/impeccable/**` skill) plus first-five-line generated markers are excluded.

## Deterministic installs

`@bastani/atomic` ships `packages/coding-agent/npm-shrinkwrap.json` so package-manager installs resolve the same dependency tree every time. Contributors working from a source checkout can validate that the checked-in shrinkwrap is up to date with:

```bash
bun run scripts/generate-coding-agent-shrinkwrap.mjs --check
```

## Release security boundary

Atomic's release bases remain at the `0.0.0` placeholder. `scripts/cut-release.ts` stamps the real version only on a detached tagged release commit. Tag creation runs an inert signal workflow; a separate `workflow_run` publisher loaded from protected `main` validates the exact upstream repository, source workflow/event/run, tag/SHA, immutable release-base trailers, and deterministic release tree. Build and verification jobs are read-only, npm publication has OIDC without repository write, and GitHub Release creation has repository write without OIDC. Never move or recreate a failed release tag or dispatch the privileged publisher. See the repository's [CI/CD pipeline](https://github.com/bastani-inc/atomic/blob/main/docs/ci.md#release-pipeline) for trusted-publisher configuration and recovery.

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
