## 1. Relevant external facts

- **Bun `build --compile`** creates a standalone executable and supports **cross-compiling** via `--target` (for example `bun-linux-x64`, `bun-windows-x64`). The executable bundles imported code and the Bun runtime, but your repo still copies extra assets/runtime files separately.  
  Source: Bun docs, “Single-file executable”

- **npm provenance (`npm publish --provenance`)** requires a **cloud/GitHub-hosted runner** for trusted publishing.  
  Source: npm docs, “Generating provenance statements” / GitHub Docs, “Publishing Node.js packages”

- **prek** installs Git shims into Git’s effective hooks path and honors `default_install_hook_types`; `prek install --prepare-hooks` prepares hook environments.  
  Source: prek CLI/FAQ/docs

## 2. Local implications

- **CI gate stays strict during migration.** Your workflows currently validate:
  - `bun install --frozen-lockfile`
  - typecheck/tests
  - docs links
  - build/package metadata
  - binary smoke tests
  - release archive contents  
  If you migrate to Rust, these steps need equivalent Cargo-based checks and binary smoke coverage.

- **Release flow is tightly coupled to `packages/coding-agent`.** Today:
  - one publishable package: `@bastani/atomic`
  - tag must equal package version
  - binaries are attached to the GitHub Release
  - npm publish happens before GitHub Release  
  A Rust migration would need a new canonical version source (likely `Cargo.toml`) and a new release artifact source, but the tag/version/release ordering contract should stay.

- **Binary distribution is asset-heavy, not just “compile and ship.”** `scripts/build-binaries.sh` does more than compile:
  - builds 6 platform targets
  - copies `dist/builtin`, docs, examples, theme assets
  - copies runtime `node_modules` dependencies
  - packages `.tar.gz`/`.zip` archives  
  A Rust rewrite must explicitly define how these runtime assets are embedded or shipped alongside the binary.

- **Version bumping is repo-wide and manifest-aware.** `scripts/bump-version.ts` updates every `packages/*/package.json` plus README badges, then `bun install` refreshes the lockfile.  
  For Rust, this means you’ll need a new version-sync mechanism for `Cargo.toml` (and any generated docs/badges), plus a new release-tag validation rule.

- **Hook migration is mostly about install orchestration, not hook semantics.** `prek.toml` currently enforces `bun run lint` and `bun run test:unit`, and `scripts/install-hooks.mjs` skips in CI or when disabled.  
  If you switch to Rust, the hook installer can stay conceptually similar, but the underlying commands should change to Rust equivalents (`cargo fmt`, `cargo clippy`, `cargo test`, etc.).

## 3. Version/API assumptions

- Current release tags are strict SemVer-ish:
  - stable: `MAJOR.MINOR.PATCH`
  - prerelease: `MAJOR.MINOR.PATCH-alpha.REVISION`
- Current binary packaging assumes Bun target names like `bun-linux-x64`.
- Current publish pipeline assumes npm is still the distribution channel for the main package.
- I’m assuming a Rust migration means replacing the TypeScript/Bun runtime for the CLI, not just adding Rust sidecars.

## 4. Unverified or unnecessary research

- I did **not** verify any Rust-specific release tooling (`cargo dist`, `cross`, `cargo release`, etc.). That’s only needed if you want a concrete Rust build/release design.
- I did **not** research npm alternatives, because this repo’s current contract is still npm-first.
- I did **not** inspect every downstream workflow helper; the key release/CI contracts are already clear from the local files above.