# Atomic development setup

Set up a checkout to build, run, and test Atomic locally.

## Prerequisites

- [Node.js](https://nodejs.org) 22.19.0 or later for npm and most tests. Use Node 22 to match CI.
- [Bun](https://bun.sh) 1.4.5 or later to run the CLI from source, typecheck, and run TypeScript scripts.
- Stable [Rust](https://rustup.rs) with `cargo` on your `PATH` to build the native bindings.

## Install

Clone the repository, or clone your fork if you're contributing from one. Run the rest of this guide from the workspace root.

```bash
git clone git@github.com:bastani-inc/atomic.git
cd atomic
npm ci --ignore-scripts
```

Use `npm install` to add dependencies. Keep `package-lock.json` as the only lockfile. Do not use Yarn, pnpm, or `bun install`.

`npm ci --ignore-scripts` skips Git hook setup. Run `npm run hooks:install` to install the hooks from [`prek.toml`](prek.toml).

## Build

```bash
npm run build
```

This builds the CLI, its compiled dependencies, and the native bindings. It fetches model catalogs as needed. Run it before starting the CLI or running tests, and again after pulling package or Rust changes.

If a workspace package or native binding is missing, rerun `npm run build` rather than reinstalling dependencies. Use `npm run build -- --force` to rebuild every step.

## Run from source

Start Atomic with Bun:

```bash
bun packages/coding-agent/src/cli.ts
```

Add `--help` to see the options or `-p "List files in this repo"` for a single prompt. To try the compiled CLI after a build, run `node packages/coding-agent/dist/cli.js`.

## Test

Pick the suite that covers your change:

- `npm run test:unit` runs the root unit tests.
- `npm run test:integration` runs the root integration tests.
- `npm run test:all` runs both of those suites.
- `npm run test:ci-contracts` runs the CI and release contract tests.
- `npm run test --workspace=@bastani/atomic` runs the coding agent suite under Node.
- `npm run test:scripts` runs the tests for repository scripts.

To run one root test file, pass its path after `--`:

```bash
npm run test:unit -- test/unit/config-package-identity.test.ts
```

Finish builds and typechecks before starting tests so they don't rewrite files the tests are loading. See [Testing in AGENTS.md](AGENTS.md#testing) for test conventions.

## Lint and format

Run `npm run check` before submitting a change. It runs Biome, the type checks, and the interactive event loop check.

Use `npm run typecheck` to run just the type checks and `npm run format` to apply Biome formatting.

## Where to read next

- [CONTRIBUTING.md](CONTRIBUTING.md) for issue approval and pull requests.
- [AGENTS.md](AGENTS.md) for repository commands and development rules.
- [Atomic CLI docs](packages/coding-agent/docs/) and [SDK examples](packages/coding-agent/examples/sdk/README.md) for CLI and SDK usage.
- [CI guide](docs/ci.md) for the [Tests workflow](.github/workflows/test.yml) and its required `test (all platforms)` check.
- [Release skill](.agents/skills/publish-release/SKILL.md) for cutting a release tag and following the [Publish workflow](.github/workflows/publish.yml). Keep package versions at `0.0.0` on `main` and other release bases.
