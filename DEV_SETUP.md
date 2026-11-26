# Atomic development setup

Set up a checkout to build, run, and test Atomic locally.

## Prerequisites

- [Node.js](https://nodejs.org) 24.20.0 or later for npm and most tests. CI runs the newest Node.js release that satisfies `engines.node` in the root `package.json`.
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

## Git worktrees

To work on several branches at once, add a [Git worktree](https://git-scm.com/docs/git-worktree) and set it up from inside it:

```bash
git worktree add -b my-branch ../atomic-worktrees/my-branch origin/main
cd ../atomic-worktrees/my-branch
node scripts/worktree-setup.mjs
```

When the worktree's `package-lock.json` matches the main checkout's, the script links the main checkout's installed packages instead of installing them again. The workspace packages, `.bin` entries, Vitest and the build caches stay in the worktree. When the lockfiles differ, it runs `npm ci --ignore-scripts` in the worktree instead. Either way it finishes with `npm run build`; pass `--no-build` to skip that. Rerun it after the lockfile changes on either side.

Don't link the whole `node_modules` directory to the main checkout. The workspace packages would then resolve to the main checkout's `packages/`, so tests that start child processes would run the main checkout's build. Vitest also fails some imports with `Cannot find module '<worktree>/string_decoder'`. The test suites refuse to start in a worktree set up that way.

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
