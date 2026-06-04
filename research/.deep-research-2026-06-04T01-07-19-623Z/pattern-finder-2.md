## 1. Established patterns

- **Single root workspace, Bun-first**
  - Root `package.json` is the workspace controller: `workspaces: ["packages/*"]`, `packageManager: "bun@1.3.14"`, and scripts are all `bun`-based (`test:unit`, `test:integration`, `typecheck`, `lint`).
  - `bunfig.toml` locks the repo to Bun’s hoisted linker and frozen-ish install behavior.

- **One publishable package, many private companions**
  - `packages/coding-agent/package.json` is the only publishable package (`name: @bastani/atomic`, `bin: atomic`, `main: ./dist/index.js`).
  - `packages/workflows`, `packages/subagents`, `packages/mcp`, `packages/web-access`, and `packages/intercom` are all `private: true` and act as bundled/internal workspace packages.

- **Version sync is repo-wide**
  - `scripts/bump-version.ts` updates every `packages/*/package.json` version together.
  - CI/docs explicitly assume one shared version across all workspace packages.

- **Build/release is asset-assembly, not just compilation**
  - `packages/coding-agent` builds to `dist/`, then copies assets, docs, examples, and bundled packages.
  - `scripts/build-binaries.sh` wraps that into per-platform release archives.

- **Current layout suggests Rust would likely mirror package boundaries**
  - The existing repo already splits concerns into stable subsystems: CLI/runtime (`packages/coding-agent`), workflows, subagents, MCP, web-access, intercom.
  - That makes a Rust migration more like a **workspace split into crates** than a single monolith rewrite.

## 2. Variations / exceptions

- **Root vs package-level scripts differ**
  - Root scripts only cover repo-wide checks.
  - `packages/coding-agent` has its own build/docs/binary scripts and is the only package with publish logic.

- **Some packages are pure source bundles, not build artifacts**
  - `packages/workflows` ships raw TS entrypoints (`main: ./src/index.ts`) and export surfaces designed for direct source loading.
  - This is a major exception to a “compile everything to Rust” assumption.

- **Docs describe stronger packaging rules than the raw workspace layout**
  - `docs/ci.md` says only `@bastani/atomic` publishes; companion packages are copied into `dist/builtin/`.
  - That is more of a release convention than a hard workspace constraint.

- **`packages/coding-agent` is both package and runtime host**
  - It owns the CLI binary, dist layout, runtime dependencies, and bundled-builtins copy step.
  - In Rust, this likely becomes the top-level binary crate plus shared library crates.

## 3. Anti-patterns or risks

- **No Rust scaffold exists yet**
  - There is no `Cargo.toml` or `*.rs` in the repo, so the workspace shape has to be invented from scratch.

- **The current system assumes JS/TS runtime loading**
  - `jiti`, raw `.ts` exports, and TS-based extension loading are baked into the package layout.
  - A Rust migration has to decide whether to preserve that via embedding/scripting or replace it with a new plugin ABI.

- **Packaging is tightly coupled to Bun/Node artifact conventions**
  - `dist/`, `node_modules` copying, `.ts` export surfaces, and npm provenance are all part of the current delivery model.
  - Direct Rust output will break these assumptions unless the release pipeline is redesigned.

- **Workspace packages are not independent products**
  - Their versioning, bundling, and publish rules are intertwined.
  - That’s good for source organization, but risky if you want a clean Rust crate ecosystem without hidden coupling.

## 4. Evidence index

- Root workspace and scripts: `package.json`
- Bun runtime/install config: `bunfig.toml`
- TS path/package aliasing: `tsconfig.json`
- Publishable package: `packages/coding-agent/package.json`
- Private companion packages:
  - `packages/workflows/package.json`
  - `packages/subagents/package.json`
  - `packages/mcp/package.json`
  - `packages/web-access/package.json`
  - `packages/intercom/package.json`
- Build/release conventions: `docs/ci.md`
- Binary assembly script: `scripts/build-binaries.sh`
- Repo-wide version bumping: `scripts/bump-version.ts`
- Builtin package bundling into `dist/builtin`: `packages/coding-agent/scripts/copy-builtin-packages.ts`