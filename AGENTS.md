# Development Rules

## Overview

This repo is the private `atomic-monorepo` npm workspace. It currently houses:

- `@bastani/atomic` in `packages/coding-agent` — the Atomic-branded fork of pi's coding-agent CLI and the only independently published package.
- `@bastani/workflows` in `packages/workflows` — a first-party extension for Atomic/pi that brings multi-stage, DAG-driven workflow execution to agent sessions.
- `@bastani/subagents` in `packages/subagents` — builtin subagent orchestration, reusable agent definitions, skills, prompts, chains, and foreground/background execution.
- `@bastani/mcp` in `packages/mcp` — builtin MCP adapter extension that exposes MCP servers as agent tools.
- `@bastani/web-access` in `packages/web-access` — builtin web search, URL fetching, GitHub repository, PDF, and video extraction tools.
- `@bastani/intercom` in `packages/intercom` — builtin coordination channel for parent/child and cross-session agent communication.

Companion packages under `packages/*` ship as **raw TypeScript** (no compile step) and are bundled into `@bastani/atomic` at build time rather than published independently. The coding-agent package follows upstream pi's compiled-package layout.

## Tech Stack

This repo runs a **hybrid toolchain, matching upstream `earendil-works/pi` task for task**.
Each tool is used where it is actually better, rather than one runtime being mandated
everywhere. Where the split differs from pi, the reason is written down.

| Task | Tool | Why |
| --- | --- | --- |
| Dependency install | `npm ci --ignore-scripts` | `package-lock.json` is the single verified lockfile. `npm ci` refuses to install when it and `package.json` disagree; nothing enforced that while two lockfiles coexisted |
| Supply-chain gate | committed `.npmrc` | Byte-identical to pi's: `save-exact=true` and `min-release-age=2`. Binds every contributor's install, not just CI. `.github/dependabot.yml` carries the matching `cooldown` |
| Build | `npm run build` | tsgo, not Bun; no behaviour change |
| Lint / format | `biome check` (`npm run check`, `npm run format`) | pi's rule set exactly: recommended preset plus the same six overrides. Tab indent width 3, line width 120 |
| Typecheck / check | `npm run check` (biome + `tsc --noEmit` + shrinkwrap check) | pi runs biome + tsgo here |
| Root test suites | `vitest --run --project {unit,integration,ci}` | pi uses vitest for its workspace tests, with a shared `vitest.base.ts` setting only `resolve.alias` |
| `packages/coding-agent` suite | `vitest --run` | already parity; it now runs under Node rather than `bun --bun`, SQLite selectors included |
| Script tests | `node --test scripts/*.test.mjs` | pi parity. Scripts Node can run are tested with Node's own runner |
| Repository scripts | `bun run scripts/*.ts` | Bun executes `.ts` directly and resolves `.js` specifiers to `.ts` source with no loader hook. Bare `node` cannot; scripts meant for `node --test` are `.mjs` |
| Binary compilation | `bun build --compile` | Cross-compiles the single-file executables; upstream pi uses Bun for exactly this step too. Bun pinned to 1.3.14 |
| npm-package smoke tests | Node (`node-version: 22` in CI, matching pi) | `test/integration/installed-package-node-extensions.test.ts` verifies the shipped `atomic` bin under `#!/usr/bin/env node`, which is how npm installs run it |
| Registry publish | `npm publish --provenance` | npm's OIDC-signed provenance lives in the npm CLI, and npm trusted publishing requires a GitHub-hosted runner |

**Where this repository deliberately declines pi's shape:** pi's CI is one `ubuntu-latest`
job with no matrix and no `timeout-minutes`. Do not copy it. This workflow produces nine
check contexts including full Windows coverage, runs on Blacksmith runners, and carries
per-job timeout budgets that `test/ci/test-workflow-topology.test.ts` asserts. Adopting pi's
topology would delete Windows coverage and orphan the two required check contexts. Parity is
a *toolchain* goal, not a CI-topology goal.

- TypeScript ≥ 5.x (strict, `noUnusedLocals`, `noUnusedParameters`)
- `@sinclair/typebox` for schema definitions
- `jiti` for runtime TS loading where needed

## Quick Reference

### Commands

- `npm ci --ignore-scripts` — install dependencies from `package-lock.json`
- `npm install <pkg>` — add a dependency; `.npmrc` applies the 3-day release-age gate and `save-exact`
- `npm run check` — `tsc --noEmit` plus the published-shrinkwrap check. `npm run typecheck` is the typecheck alone
- `npm run test:unit`, `npm run test:integration`, `npm run test:ci-contracts`, `npm run test:all`
- `npm run test --workspace=@bastani/atomic` — the coding-agent vitest suite, under Node
- `npm run test:scripts` — `node --test scripts/*.test.mjs`
- `npm run hooks:install`, `npm run hooks:run`
- `bun run scripts/<name>.ts` — repository scripts stay on Bun; see the Tech Stack table
- Git hooks are configured in `prek.toml`; `npm install` runs the root `prepare` script to install hooks with `prek install --prepare-hooks` using `default_install_hook_types`.

**Do not run `yarn install` or `pnpm install`,** and do not reintroduce `bun install`: each
writes a competing lockfile that `npm ci` neither reads nor verifies, and bypasses the
`.npmrc` release-age gate. `bun.lock` and `packageManager: bun@…` were removed for this
reason. Bun remains a declared engine and is still the right tool for the rows above that
name it.

## Best Practices

- Avoid ambiguous types like `any` and `unknown`. Use specific types instead.
- Source files use `.js` import extensions (TypeScript ESM convention). The repo ships as `.ts` files; Bun resolves `.js` specifiers to the underlying `.ts` source directly — no loader hook required. atomic's loader follows the same convention as pi.
- Do not add a build step (`dist/`, `tsconfig.build.json`, etc.) to `packages/workflows`; it distributes raw TypeScript and the host loads it directly. `packages/coding-agent` is copied from upstream pi and keeps its existing build setup.
- When using skills, if you see a frontmatter of `metadata: internal` set to `true` (if missing assume `false`), that means the skill is for internal developers of this package. If this flag is omitted, the skill is meant for consumers/everyday users.

## Design Context

Refer to `DESIGN.md` and `PRODUCT.md`.

## Issues and pull requests

Follow [`CONTRIBUTING.md`](CONTRIBUTING.md) for external-contributor coordination, issue assignment, and pull request guidance.

## Testing

Use `npm run test:unit` (or `test:integration`, `test:all`) and make use of your tdd skill to write high quality tests. The suites run under **vitest**; the assertion style stays `node:assert/strict`:

```ts#test/unit/index.test.ts
import { test } from "vitest";
import assert from "node:assert/strict";

test("hello world", () => {
  assert.equal(1, 1);
});
```

### Replacing Bun globals in tests

Root suites run under Node, so `Bun.*` and `import.meta.dir` are unavailable. Use
`test/helpers/runtime.ts` rather than reaching for `node:fs`/`node:child_process` directly —
several of the replacements differ in ways that fail silently:

| Bun | Helper | Trap it closes |
| --- | --- | --- |
| `Bun.sleep` | `sleep` | — |
| `import.meta.dir` | `moduleDir(import.meta.url)` | — |
| `Bun.file(p).text()/.json()/.exists()` | `readText` / `readJson` / `fileExists` | `readJson<T>()` returns `unknown` by default; `Bun.file().json()` returned `any` |
| `Bun.write` | `writeFileEnsuringDir` | `Bun.write` creates parent directories; `fs.writeFile` throws ENOENT |
| `Bun.spawnSync` | `spawnSyncCollect` | Node returns `status`, not `exitCode`; a raw port makes every `assert.equal(r.exitCode, 0)` compare against `undefined` |
| `Bun.spawn` | `spawnProcess` | Node has no `.exited` promise and no web-stream stdio, and reports a missing binary asynchronously rather than throwing |
| `process.execPath` **when spawning Bun** | `bunExecutable()` | Under vitest `process.execPath` is Node, so a `.ts` child, `bun run`, or a Bun-specific `-e` script silently runs under the wrong runtime |

Shipped `packages/` code that uses `Bun.*` behind `isBunBinary`/`isBundledBuild` is **out of
scope** and must not be edited to suit the test runner. One shipped module —
`packages/web-access/subprocess.ts` — calls `Bun.spawn`/`Bun.sleep` *unguarded*, because it
only ever runs inside the Bun-compiled binary. `test/unit/web-access-subprocess.test.ts`
therefore calls `installBunGlobal()`, which substitutes the helpers above for those two
globals. All five test names and their assertions survive, and what they cover — bounded
draining, the byte cap, the timeout, the kill path — is unchanged. **What they no longer
cover is Bun's own spawn implementation, which is what the shipped binary runs on.** The
alternative, re-execing the file under Bun, would collapse five names into one wrapper
assertion; that is a worse trade, but the gap is real and is stated here rather than only in
the helper.

### SQLite selectors run on either runtime

`src/core/tools/resource-selectors.ts` loads `node:sqlite` first and falls back to
`bun:sqlite`. `node:sqlite` is unflagged from Node v22.13.0 and is what upstream pi uses;
Bun 1.3.14 does not ship it (oven-sh/bun#32498 is merged but unreleased), and the shipped
binary is Bun-compiled, so the fallback is what keeps that binary working. When Bun releases
`node:sqlite`, both runtimes take the first branch and the fallback can be deleted.

`better-sqlite3` was evaluated and rejected: it segfaults Bun 1.3.14 on construction, which is
worse than a catchable missing-module error.

Test fixtures go through `packages/coding-agent/test/helpers/sqlite.ts`, which mirrors that
preference order behind the `bun:sqlite`-shaped API the suites were written against. Never
reintroduce a soft guard (`if (!sqlite) return`, or a `? it : it.skip`) — that is how one test
skipped and eleven kept passing with every assertion dead. `test/ci/ci-workflow-contracts.test.ts`
enforces the loader order and rejects those guards.


### Per-test timeout policy

- The suite-wide per-test budget is **30000 ms**, declared once as `TEST_TIMEOUT_MS` in `test/helpers/test-timeout.ts` and applied by the root `vitest.config.ts` to all three projects. `test/ci/ci-workflow-contracts.test.ts` enforces that the three `test:*` scripts each select a project and that all three resolve to that one value.
- Do **not** restate the budget in a package script, in `.github/workflows/test.yml`, or in `bunfig.toml`. The contract test rejects a `--timeout` flag in any script, and Bun ignores `[test] timeout` in bunfig anyway — it looks correct and does nothing.
- One platform-neutral value, never a Windows-only branch. A Windows-only bump would leave Linux as the only place the budget is enforced and hide Windows regressions until they were far worse. (`packages/coding-agent/vitest.config.ts` keeps its own pre-existing 90 s Windows branch, local to that project.)
- Add an explicit third-argument timeout only for a test whose cost is *structural* (a full builtin-package loader reload, a real CLI child process, a real `vitest` child, a `tsc` invocation, a built-package install). **Name the constant and keep it at the call site** — `REAL_VITEST_SUITE_TIMEOUT_MS` in `test/unit/flaky-test-suite-runner.test.ts` is the pattern; a bare `120_000` says nothing about why the cost is structural rather than a slow test nobody fixed. Never restate the default value — an explicit timeout that merely repeats it silently lowers that test's budget when the default rises.
- `scripts/run-flaky-test-suite.ts` scores every duration against that test's effective timeout: warn at 40 % of budget, fail the step at 70 %. Every attempt is scored, so a fast bounded retry cannot hide a first attempt that burned a test's headroom. It always writes the per-test duration table to `.ci-diagnostics/<suite>-durations.md`, on green runs too. If it fails your test, make the test faster or justify a structural explicit timeout — do not raise the shared default.
- The gate reads **vitest's JSON reporter**, which the wrapper requests alongside the default one so the step log stays readable. The reporter emits a record per test, so the gate now scores the whole suite rather than the 97 % that printed a duration under Bun's stdout, and `blind` — tests ran, no durations — finally means the harness broke. A report that is missing *or unreadable* counts as blind too: an unparsable report measures exactly as much as one that was never written.
- The gate reads a budget only from a *vitest* invocation, following one `npm run <script>` indirection into `package.json` and then into the config that script selects. A leading `bun`/`bunx` is the runtime rather than the command and is stepped over. Any other wrapped command leaves the gate disabled rather than scoring output against a budget nothing enforced. Explicit per-test budgets are matched by the fully qualified `scope > name`, so a declaration inside `describe` never lends its budget to a same-named test in another scope.
- **Do not raise `WARN_RATIO`.** The move to vitest made the heaviest tests materially slower (vite transform cost: `coding-agent builtin resources > loads builtin pi package resources` went 622 ms → ~10 s), and the slowest unit test now sits just under the 40 % warn line. A loaded or Windows runner may start warning. That is the gate working as designed — make the test faster or justify a structural explicit timeout.

### Load sensitivity

vitest runs test *files* in parallel by default, and this repository deliberately sets no
`pool`, `maxWorkers`, `poolOptions`, or `fileParallelism` — pi sets none either. A test that
only passes on an idle machine is a bug in that test. Fix it where it lives: give the real
work headroom and derive the assertion from a named constant (see `STALLED_ATTEMPT_CAP_MS` in
`test/unit/subagents-attempt-watchdog-helpers.ts`). Do not skip it, do not serialize the
suite, and do not shard — `test/ci/test-workflow-topology.test.ts` forbids
`--parallel|--shard|--concurrent|--max-concurrency` for exactly this reason.

### Hook name compatibility

Use `beforeAll`/`afterAll` for once-per-suite setup/teardown and `beforeEach`/`afterEach` for
per-test hooks. `before`/`after` are not exported.

### Code Quality

- Frequently run `npm run check` (typecheck plus the shrinkwrap check). `npm run typecheck` is the typecheck alone.
- Avoid `any` and `unknown` types.
- Modularize code and avoid re-inventing the wheel. Use functionality of libraries and SDKs whenever possible.

## Debugging

You are bound to run into errors when testing. As you test and run into issues/edge cases, address issues in a file you create called `issues.md` to track progress and support future iterations. Delegate to the debugging sub-agent for support. Delete the file when all issues are resolved to keep the repository clean.

## Docs

Relevant resources (use your `playwright-cli` skill if the information is not available in the local docs):

1. Bun (runtime + test runner): `oven-sh/bun`
    1. [`bun:test`](https://bun.sh/docs/cli/test)
    2. [Bun + TypeScript](https://bun.sh/docs/runtime/typescript)
    3. [`bunfig.toml`](https://bun.sh/docs/runtime/bunfig)
2. Pi: `earendil-works/pi`
    1. [`docs/`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)
3. TypeScript: `microsoft/TypeScript`
    1. [Module resolution](https://www.typescriptlang.org/docs/handbook/module-resolution.html)
    2. [`paths`](https://www.typescriptlang.org/tsconfig#paths)
4. Schema tooling:
    1. `@sinclair/typebox` for runtime-validated schemas
    2. `jiti` for on-demand TS loading

### Coding Agent Configuration Location

atomic:

- global:
    - Linux/MacOS: `~/.atomic/agent/`
    - Windows: `%HOMEPATH%\.atomic\agent\\`
- extensions: `~/.atomic/agent/extensions/<name>/`
- local: `.atomic/` in the project directory

## Releasing

Atomic uses a **versionless release-base** flow: supported bases keep `packages/*/package.json` at `0.0.0`; `scripts/cut-release.ts` materializes the real version only on a tagged detached `Release <version>` commit with harmless immutable `Release-base-ref`/`Release-base-sha` trailers. Pushing the version tag directly starts `publish.yml`. Its lightweight integrity job checks that the source resolves to the tag commit, `packages/coding-agent/package.json` equals the tag, and the subject is `Release <version>`. Build jobs produce and smoke-test native modules and archives; a draft GitHub Release is staged before OIDC-only npm publication and undrafted only after npm succeeds. `publish-npm` alone receives `id-token: write` under `npm-publish`; release staging, undrafting, and failed-draft cleanup alone receive `contents: write`. Configure npm trusted publishers with filename `publish.yml` and environment `npm-publish`.

Cut and publish a release with:

```sh
bun run scripts/cut-release.ts 0.8.31 --base main --push
```

The selected base is never advanced by the version stamp. The script resolves its exact `refs/heads/...` ref on `origin`, creates the release commit in a detached git worktree, records the base trailers, tags it, and abandons the worktree. The tag push is the publication signal. The publisher deliberately does not validate or allowlist those trailers; its integrity boundary is the tag/package-version/commit-subject match.

### Agent publishing requests

If a user asks to publish a release or prerelease, route the request through the repository-local `publish-release` Atomic workflow:

1. Ask for the version only when it was not supplied. Stable releases use `MAJOR.MINOR.PATCH`; prereleases use `MAJOR.MINOR.PATCH-alpha.REVISION` with revision starting at 1.
2. Infer release versus prerelease from a valid supplied version; ask only when it is ambiguous or invalid. Use the requested `base_ref`, defaulting to the short branch name `main` when omitted.
3. For non-main bases, require the branch to be protected with the repository's required CI checks before using it as the selected release base.
4. Launch one `publish-release` workflow run with `target_version`, `release_kind`, and `base_ref`. Do not duplicate its Git, PR, tag, or publishing actions inline.
5. The workflow creates `[release|prerelease]/<version>` from the selected base, updates relevant changelogs without bumping package versions, validates and commits the changes, pushes the branch, and opens the PR.
6. It watches required CI until every required check reaches a terminal state, treating an admin merge of the PR as approval to proceed; check failures or an expired watch window stop the run with evidence.
7. After checks pass, it merges the exact verified PR head, switches to the selected base, and fast-forwards from `origin/<base_ref>`.
8. It runs `bun run scripts/cut-release.ts <version> --base <base_ref> --push --yes`, which stamps only the detached release commit and pushes the tag. That tag push automatically starts `publish.yml`; the workflow does not manually dispatch normal publication.
9. It watches the matching `Publish <version>` action until it completes. Failure or an expired watch window stops the run with evidence; success returns a concise release summary.

## Docs

- ALWAYS keep the user-facing docs in `packages/coding-agent/docs` up-to-date with the latest changes after you make changes. Prefer to keep other docs up-to-date as well, but the coding-agent docs are the most important since they are user-facing and often consulted by users and other agents.
- To update docs, prefer using your `release-docs` workflow to thoroughly update all relevant docs with the latest changes. If you need to make a quick fix or update, you can also edit the markdown files directly, but make sure to keep them comprehensive and up-to-date.

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- Package changelogs are user-facing release notes. Add entries only for changes to shipped package behavior, APIs, features, or user-visible fixes.
- CI configuration, release/publish pipelines, repository automation, maintainer scripts, and agent-instruction changes are infrastructure-level changes. Do **not** add them to `packages/*/CHANGELOG.md` unless they also change the behavior of a shipped package for users.
- In particular, changing how a release is tagged, dispatched, built, verified, or published does not itself warrant a package changelog entry.
- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist
- New entries ALWAYS go under `## [Unreleased]` section
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released
- When updating the changelog entry you should:
    1. Carefully note key features that were added for a particular `prerelease` revision and for each `release` version changelog you should note every key feature that was introduced in the cumulative `prerelease`(s) that led up to the `release`.
    2. Do NOT be lazy and avoid saying something like: "Bumped package version for the Atomic prerelease." That is not helpful to users and does not provide any information on what was actually changed.
    3. The changelog should be a comprehensive and detailed summary of all the key features, bug fixes, breaking changes, and other relevant information about the `release`/`prerelease` that would be helpful for users.

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Versionless release bases & bumping

`main` and supported workstream bases are versionless: every `packages/*/package.json` (plus `package-lock.json` workspace entries, the `@bastani/atomic-natives` dependency pin, `packages/natives/native/index.js` checks, and the Cargo manifests/lock) stays at the `0.0.0` placeholder. **Do not bump the version on a release base.**

`scripts/bump-version.ts` is the low-level stamper that rewrites every versioned manifest. It is invoked by `scripts/cut-release.ts` inside a throwaway worktree at the exact remote base SHA to materialize the real version on the tagged release commit. You normally never run it directly against a release base; the only direct use is resetting the placeholder if it ever drifts:

```sh
# stamp a real version onto the off-base tag commit (preferred; explicit base shown)
bun run scripts/cut-release.ts 0.1.0 --base main
bun run scripts/cut-release.ts 0.1.0-alpha.1 --base main

# low-level: reset main back to the versionless placeholder
bun run scripts/bump-version.ts 0.0.0 && npm install --package-lock-only --ignore-scripts
```

## CI

An overview of CI is described here: [CI Docs](docs/ci.md).

Note: npm provenance publishing uses GitHub OIDC trusted publishing and must not configure a static npm credential.

## Tips

1. The workflows extension is bundled into `@bastani/atomic`. For local development against upstream pi, symlink `packages/workflows` into `~/.pi/agent/extensions/workflows` if you want host-level discovery outside Atomic.
2. Rely on agent skills to provide information on best practices during implementation. Here is a short list of Agent Skills that are incredibly relevant to this project that you should try to use when applicable:
    - bun
    - gh-commit
    - gh-create-pr
    - prek
    - typescript-advanced-types
    - typescript-expert
3. Ask for clarity if you are unsure about a change. The developer is your best friend and oftentimes can clarify intent.
4. When modifying this extension, follow pi's extension and SDK conventions.

<EXTREMELY_IMPORTANT>
`@bastani/workflows` ships raw `.ts` files with no build step — do NOT introduce `dist/`, `tsconfig.build.json`, `outDir`, or any bundling.

Install with `npm ci --ignore-scripts`, and add dependencies with `npm install`. Never run
`yarn install` or `pnpm install`, and do not bring back `bun install`: each writes a competing
lockfile that `npm ci` neither reads nor verifies, and bypasses the `min-release-age` gate in
the committed `.npmrc`. `package-lock.json` is the only lockfile, and it is also the input to
the shrinkwrap published inside `@bastani/atomic`.

Bun is still required, and still correct, for three things: compiling release binaries with
`bun build --compile`, running `scripts/*.ts`, and running the Bun-hosted test fixtures. See
the Tech Stack table for the full split.
</EXTREMELY_IMPORTANT>
