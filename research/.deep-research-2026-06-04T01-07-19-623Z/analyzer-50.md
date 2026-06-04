# 1. Behavioral model

The current repo is **not a Rust codebase**; it is a Bun/TypeScript monorepo with one publishable CLI package (`@bastani/atomic`) and bundled private TS packages (`workflows`, `subagents`, `mcp`, `web-access`, `intercom`).

The historical specs describe a **clean-slate rewrite** that:
- keeps only docs/specs/history,
- removes tmux and external agent CLIs,
- rebrands `pi`/`@bastani/atomic`,
- moves workflows into a first-party extension model,
- and treats TS extension loading as a compatibility boundary.

So the migration question is really: **what behavior must Rust preserve vs replace?**

Main current behaviors to preserve/rethink:
- CLI entrypoint and subcommands
- config/root path semantics (`.atomic`, `ATOMIC_*`)
- session persistence and branching
- tool execution (`read`, `bash`, `edit`, `write`, etc.)
- extension loading and bundled resources
- workflow/subagent/MCP/intercom integration surfaces
- CI/release packaging

# 2. Key flows and invariants

## Current repository invariants
- Root scripts assume **Bun** (`bun run typecheck`, `bun test`, `bun install`).
- `packages/coding-agent` is the only publishable package.
- Builtin companion packages are copied into `dist/builtin/` at build time.
- The CLI binary is still TS-built (`dist/cli.js`).
- Current system depends heavily on external JS libs (`jiti`, `pi-*`, MCP SDKs, web parsers).

## Spec vs repo reconciliation
The specs assume:
- a **wipe-and-rebuild** strategy,
- **no backward compatibility** with old on-disk layouts,
- workflows loaded by direct module import,
- no tmux/process-pane orchestration,
- and Atomic as a thin rebrand of a single-process agent runtime.

But the repo currently still has:
- a multi-package TS workspace,
- build/copy scripts,
- docs describing bundle-and-publish behavior,
- and a publishable npm package, not a Rust crate.

## Rust migration boundary
The hardest boundary is **dynamic TS extension/workflow loading**:
- current design uses `jiti` and TS module import,
- specs explicitly want direct module import for workflows,
- Rust cannot “just” preserve that without embedding JS or defining a new plugin ABI.

So the main architectural choice is:
1. **Rust host + JS plugin layer** (highest compatibility, most complexity), or
2. **full Rust rewrite with new plugin ABI** (cleanest, most breakage), or
3. **hybrid**: Rust core + JS compatibility shim for existing extensions.

# 3. Tests / validation

Current validation is TS/Bun-based:
- root `bun run typecheck`
- root `bun run test:unit`
- root `bun run test:integration`
- package-level `vitest` in `packages/coding-agent`
- CI builds the package and smoke-tests the binary

What’s missing for Rust:
- no `Cargo.toml`
- no Rust test harness
- no cross-language contract tests
- no migration tests for session/config/workflow file formats

Useful verification targets for a Rust port:
- CLI parity tests
- session JSONL compatibility tests
- tool ABI tests
- extension/workflow loading tests
- release/package layout tests

# 4. Risks, unknowns, and verification steps

## Biggest risks
- **Dynamic TS loading** is the main incompatibility.
- **External `pi-*` dependencies** are load-bearing and not in-repo.
- **Current docs/specs conflict**: specs describe an intended rewrite, not the live tree.
- **Backwards compatibility** is explicitly absent in the specs.
- **Packaged resources and CI** assume npm/Bun workflows, not Cargo.

## Unknowns
- Whether Rust should replace only the CLI/runtime or also the extension ecosystem.
- Whether existing workflows/skills/prompts/themes must stay file-compatible.
- Whether session files must remain readable.
- Whether the Rust port should preserve the current npm package name and release flow.

## How to verify
- Map each TS subsystem to one of: **rewrite, bridge, or preserve**.
- Add contract tests around:
  - CLI flags/commands
  - session format
  - tool execution
  - workflow loading
  - bundled resource discovery
- Decide early on the extension ABI, because that determines whether the migration is incremental or a hard cutover.