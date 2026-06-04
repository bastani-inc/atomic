## 1. Relevant external facts

- **Cargo workspaces**: a workspace shares one `Cargo.lock` and `target/` at the root, and can select `members`, `exclude`, and `default-members` in the root `Cargo.toml` ([Cargo Book: Workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html)).
- **Cargo target types**: a package can expose both a library and one or more binaries from the same manifest (`src/lib.rs`, `src/main.rs`, or explicit `[[bin]]`) ([Cargo Book: Cargo Targets](https://doc.rust-lang.org/cargo/reference/cargo-targets.html)).
- **`cargo package`**: crates are published from a package manifest; workspace packages can be packaged individually ([Cargo Book: cargo package](https://doc.rust-lang.org/stable/cargo/commands/cargo-package.html)).
- **Bun workspaces**: the current repo uses root `package.json` `workspaces: ["packages/*"]`, and Bun expects each workspace package to be self-contained ([Bun Workspaces](https://bun.com/docs/pm/workspaces)).
- **Bun lock/install behavior**: this repo uses `bun.lock` plus `bunfig.toml` settings like `linker = "hoisted"` and `saveTextLockfile = true`, which matter only for the current TS/Bun toolchain ([Bun Lockfile](https://bun.com/docs/pm/lockfile), [Bun isolated installs](https://bun.com/docs/pm/isolated-installs)).
- **Bun standalone binaries**: current binary packaging relies on `bun build --compile --target=bun-...` to produce platform-specific executables ([Bun executables](https://bun.com/docs/bundler/executables)).

## 2. Local implications

- The repo is currently a **Bun-first TS monorepo** with one publishable package: `packages/coding-agent` (`@bastani/atomic`), plus bundled private companion packages.
- The root `package.json`, `tsconfig.json`, and `docs/ci.md` together define a **workspace + shared version + single publish target** model. A Rust migration should preserve or intentionally replace those rules.
- The current TS layout uses path aliases and runtime TS loading (`jiti`), so a Rust port needs a replacement for:
  - package boundaries,
  - plugin/loading semantics,
  - bundled companion extensions,
  - and the single release artifact flow.
- A sensible **proposed Rust workspace** is:
  - `Cargo.toml` (workspace root)
  - `crates/atomic-cli` — binary entrypoint
  - `crates/atomic-core` — session/runtime/model/tool orchestration
  - `crates/atomic-extensions` — extension ABI/types
  - `crates/atomic-workflows` — workflow authoring/runtime
  - `crates/atomic-intercom` — IPC/broker
  - `crates/atomic-mcp` / `crates/atomic-web-access` / `crates/atomic-subagents` — optional feature crates if you want to preserve current package boundaries
- If you want a **minimal migration**, start with a single workspace member:
  - `crates/atomic-cli` containing both `lib.rs` and `main.rs`,
  - then split out crates only after the CLI/runtime boundary stabilizes.
- The current Bun binary pipeline (`scripts/build-binaries.sh`) maps well to Rust cross-compilation, but the script will likely become a `cargo build --release` + per-target packaging pipeline.

## 3. Version/API assumptions

- Assumes **stable Cargo workspace behavior** as documented in the Rust Book/Cargo Book.
- Assumes you want to keep the repo’s current **single-version release model** unless you deliberately move to per-crate versions.
- Assumes the Rust migration will preserve the current CLI name `atomic` and the current platform release matrix.
- Assumes companion functionality currently shipped under `dist/builtin/` becomes either:
  - embedded Rust modules/features, or
  - separate workspace crates packaged into the main binary.

## 4. Unverified or unnecessary research

- I did **not** verify a concrete Rust crate graph in this repo because there is no `Cargo.toml`/`*.rs` yet.
- I did **not** research Rust equivalents for every TS dependency here; that should be done per subsystem (TUI, MCP, web fetch, intercom, workflow engine).
- I did **not** inspect external Rust crates for replacements yet; that’s only needed once you choose the first crate boundary to migrate.