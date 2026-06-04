## 1. Behavioral model

This partition is the repo’s **delivery pipeline**: it turns the Bun/TypeScript workspace into a publishable npm package plus cross-platform binaries, and gates changes with hooks and CI.

Core behaviors:

- **Single publish target**
  - Only `packages/coding-agent` is publishable as `@bastani/atomic`.
  - All other workspace packages are private and bundled into `dist/builtin/`.

- **Version synchronization**
  - `scripts/bump-version.ts` updates every `packages/*/package.json` version together.
  - It also updates README version badges.
  - It accepts only strict release-style versions like `0.8.0` or `0.8.0-alpha.1`.

- **Release gating**
  - PR/push CI runs install, typecheck, docs validation, build, unit tests, integration tests, and a native binary smoke test.
  - Tag/release CI additionally performs cross-platform binary builds, validates metadata, publishes to npm with provenance, then creates the GitHub Release.

- **Binary distribution**
  - `scripts/build-binaries.sh` compiles `packages/coding-agent` into native Bun executables for six platforms.
  - It copies runtime deps, bundled builtins, docs, examples, assets, theme files, and WASM into per-platform archives.

- **Hook enforcement**
  - `prek.toml` enforces repository hygiene plus `bun run lint` and `bun run test:unit` on commit/push.

## 2. Key flows and invariants

### Release/version flow
1. Developer bumps versions with `bun run scripts/bump-version.ts <version>`.
2. All package manifests stay aligned.
3. `bun install` refreshes lockfile state.
4. Release tag must exactly match `packages/coding-agent/package.json`.
5. Publish workflow extracts release notes from `packages/coding-agent/CHANGELOG.md`.

**Invariant:** one version number across the whole workspace.

### CI flow
- PR/push:
  - install
  - typecheck
  - docs check
  - build package
  - unit + integration tests
  - native smoke binary
- tag:
  - smoke Linux + Windows archives
  - verify metadata/version sync
  - build all binaries
  - publish npm package
  - create GitHub Release

**Invariant:** `@bastani/atomic` is the only artifact published to npm.

### Binary packaging flow
- `bun run build` produces distributable JS output.
- `bun build --compile` creates platform binaries from `dist/bun/cli.js`.
- Shared assets are copied verbatim.
- Archives are produced as `.tar.gz` for Unix-like targets and `.zip` for Windows.

**Invariant:** release archives must contain enough runtime assets to run standalone.

### Hook flow
- `prek` runs built-in file checks plus:
  - `bun run lint`
  - `bun run test:unit`

**Invariant:** local pre-commit/push state must stay Bun-native and repo-clean.

## 3. Tests / validation

Current validation coverage is strong for the release pipeline:

- `test/unit/package-metadata.test.ts`
  - verifies only `@bastani/atomic` is publishable
  - checks package version sync rules
- `test/unit/bump-version-script.test.ts`
  - checks version parsing/rejection behavior
  - checks README badge update behavior
- `test/unit/runtime-dependency-copy.test.ts`
  - validates runtime dependency closure for packaged binaries
- CI smoke tests
  - verify extracted binaries can run `atomic --version`
  - release smoke jobs also run `--no-session`

What is **not yet evidenced** here:
- whether every `packages/coding-agent/test/` test runs in CI
- whether packaging is fully exercised for all six targets locally outside release workflow

## 4. Risks, unknowns, and verification steps

### Risks for a TypeScript → Rust migration
- **Release pipeline is coupled to Bun build artifacts**
  - `bun build --compile` is central to binary delivery.
  - A Rust port would need a new executable build/package story.

- **Versioning assumptions are workspace-wide**
  - the bump script assumes every package shares one version
  - release automation assumes tag == package version

- **Hook tooling is Bun-specific**
  - `prek.toml` currently runs `bun run lint` and `bun run test:unit`
  - Rust migration needs new hook commands and likely new checks

- **npm provenance is workflow-sensitive**
  - publish runs on GitHub-hosted Ubuntu specifically for provenance
  - any Rust release flow must preserve that constraint if keeping npm publish

### Unknowns
- Whether the Rust target should replace:
  - only the compiled CLI
  - the entire delivery pipeline
  - or just the binary distribution layer while keeping JS packages for plugins/extensions

### Verify next
- Map which repo artifacts must remain npm-compatible vs binary-only.
- Decide whether Rust will:
  1. replace `packages/coding-agent` entirely, or
  2. coexist as a new executable while TS packages remain as compatibility layers.
- Prototype a Rust release path that preserves:
  - one version source
  - one publishable package contract
  - binary archive layout
  - CI smoke tests
  - hook commands