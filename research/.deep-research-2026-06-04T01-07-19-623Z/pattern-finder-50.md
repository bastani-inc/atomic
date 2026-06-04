## 1. Established patterns

- **Single publishable core, bundled companions.** The repo consistently treats `packages/coding-agent` as the only published npm package, while `packages/workflows`, `subagents`, `mcp`, `web-access`, and `intercom` are private workspace packages bundled into `dist/builtin/`.
- **Raw TypeScript as the extension/package format.** Companion packages ship directly from `.ts` source, with no Rust/build split in the repo.
- **Dynamic extension loading is a first-class contract.** `packages/coding-agent/src/core/extensions/loader.ts` loads TS/JS via `jiti`, and exposes multiple alias names (`@bastani/atomic`, `@earendil-works/pi-*`, `@mariozechner/pi-*`).
- **Compatibility shims are deliberate.** The loader keeps upstream/pi-era package names alive, and `packages/coding-agent/package.json` carries both `atomicConfig` and `piConfig`.
- **Docs/CI mirror the runtime shape.** `docs/ci.md` codifies the “one publishable package + bundled builtins” model and validates it in CI.

## 2. Variations / exceptions

- **Historical specs are not current behavior.** The rewrite spec describes a clean-slate, no-backward-compat world, but the repo today still preserves rebrand/compat layers and existing bundled-package behavior.
- **Spec language about “all TS removed” is not reality.** Current repo still depends on TS source loading, TS toolchain, and TS runtime packages.
- **Workflows are already first-party source, not an external Rust boundary.** `packages/workflows` is a local workspace package, not something that has been replaced by a non-TS implementation.
- **Binary build is JS-centric.** `packages/coding-agent/package.json` still builds via `tsgo` + Bun compile, not Cargo.

## 3. Anti-patterns or risks

- **Don’t treat the rewrite spec as ground truth.** It is a design target, not the current repository state.
- **Rust migration is blocked by the extension ABI.** The repo’s most load-bearing contract is dynamic TS extension/workflow loading (`jiti`, alias resolution, bundled virtual modules).
- **The repo has no Rust baseline.** No `Cargo.toml`, no `.rs` files, no workspace shape to extend incrementally.
- **A file-by-file TS→Rust translation would miss the real seam.** The real migration decision is which behaviors remain compatible: CLI, sessions, extensions, workflows, bundled resources, and package discovery.

## 4. Evidence index

- `docs/ci.md` — one publishable package; bundled private workspace packages.
- `packages/coding-agent/package.json` — `piConfig`, `atomicConfig`, `bin`, `build`, `copy-builtin-packages`, TS toolchain.
- `packages/coding-agent/src/core/extensions/loader.ts` — `jiti` loader, virtual modules, legacy package-name aliases.
- `package.json` — Bun workspace + TS scripts only.
- `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` — historical clean-slate rewrite spec; useful as intent, not current behavior.
- Scout artifact `research/.deep-research-2026-06-04T01-07-19-623Z/00-codebase-scout.md` — confirms no Rust baseline and identifies the central migration boundary.