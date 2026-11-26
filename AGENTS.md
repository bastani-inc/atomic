# Development rules

## Package layout

In the `atomic-monorepo` npm workspace:

- `packages/coding-agent` builds the `@bastani/atomic` CLI and SDK.
- `packages/subagents` handles orchestration, agent definitions, skills, and prompts. `packages/mcp` exposes MCP tools.
  `packages/web-access` handles search and content fetching. `packages/intercom` connects agents and sessions.
  These TypeScript packages have no standalone build or publish step. The CLI build bundles them into `dist/builtin`.
- `packages/ai`, `packages/tui`, `packages/agent`, `packages/codemode`, `packages/schema`, and `packages/telemetry` are Atomic's pi forks.
  They compile with `tsc` and publish as `@bastani/atomic-*`, with `packages/agent` publishing as `@bastani/atomic-agent-core`.
  The CLI pins them to its release version. The loader resolves `@earendil-works/pi-*`, `@mariozechner/pi-*`, and `@bastani/pi-ai` aliases.
- `packages/natives` builds the `@bastani/atomic-natives` N-API module from Rust code in `crates/`.
- `packages/storage-postgres` publishes separately as JSDoc-checked ESM with type declarations.
  It has no compile step. Keep it out of the CLI's dependencies and `dist/builtin`.
  Install with `atomic install npm:@bastani/atomic-storage-postgres`.

## Tech stack

- Install with `npm ci --ignore-scripts`. Add dependencies with `npm install <pkg>`. Never use `yarn install`, `pnpm install`, or `bun install`.
  Keep `package-lock.json` as the only lockfile. Use exact versions for dependencies of published packages and keep `.npmrc` at `save-exact=true`.
  Keep `.npmrc`'s `min-release-age=0` in sync with `.github/dependabot.yml`'s `cooldown.default-days: 0`.
- Set up a new Git worktree with `node scripts/worktree-setup.mjs` from inside it. Don't link its whole `node_modules` to another checkout;
  see [Git worktrees](DEV_SETUP.md#git-worktrees).
- Run `npm run build` after installing in a fresh checkout or pulling changes to the CLI, the pi forks, `packages/natives`, or `crates/`.
  Force a full rebuild with `npm run build -- --force` or `ATOMIC_BUILD_FORCE=1`. For a missing native binding alone, run `npm run build --workspace=@bastani/atomic-natives`.
- Run `npm run check` regularly. It runs Biome, the typechecks, and the interactive event-loop check. Format with `npm run format`.
  Use `tsc` for compilation. Run `npm run typecheck` for the `bun check` passes, including the coding-agent build config and type tests.
- Use Node for Vitest and npm package smoke tests. Use `bun run scripts/<name>.ts` for TypeScript repository scripts,
  `bun build --compile` for release binaries, and Bun for fixtures that need it.
  Keep the Bun runtime and CI pin at `1.4.5`, in sync with `@types/bun` and `bun-types`. Rerun typechecks when changing the types.
- The `npm install` prepare hook installs `default_install_hook_types` from `prek.toml`.
  Reinstall with `npm run hooks:install`. Run all hooks with `npm run hooks:run`. See [Development setup](DEV_SETUP.md) for local CLI commands.

## Code quality

- Use strict TypeScript and specific types instead of `any` or `unknown`. Keep `noUnusedLocals` and `noUnusedParameters` enabled.
  If Bun reports a type error that TypeScript does not, add an explicit annotation instead of loosening the type. Report it upstream.
- Use `.js` extensions in TypeScript ESM imports. Follow [Biome's config](biome.json): tabs, indent width 3, line width 120.
- Keep code modular and reuse library or SDK features. Use TypeBox for schemas and `jiti` for runtime TypeScript loading where needed.
  Follow [the extension and SDK conventions](packages/coding-agent/docs/extensions.md) when editing extensions.
- Resolve coding-agent package assets with helpers in `packages/coding-agent/src/config.ts`, not `__dirname`.
- Consult [DESIGN.md](DESIGN.md) and [PRODUCT.md](PRODUCT.md) for design decisions. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for issue assignment and pull requests.
- Use relevant skills and ask when intent is unclear. Skills with `internal: true` under `metadata` are for Atomic developers. Other skills are for users.

## Testing

- Use `npm run test:unit` for unit tests, `npm run test:integration` for integration tests, and `npm run test:all` for both. Use `npm run test:ci-contracts` for CI and release contracts.
- Run `npm run test --workspace=@bastani/atomic` for the CLI suite. Run `npm run test:scripts` for the Node tests in `scripts/*.test.mjs`.
- Use the `tdd` skill, Vitest, and `node:assert/strict`. Put a GitHub issue number in its regression test name, for example `test("keeps cwd on resume (#123)", ...)`.
- Use `beforeAll` and `afterAll` for suite hooks. Use `beforeEach` and `afterEach` for per-test hooks. Do not use `before` or `after`.
- Set provider credentials or endpoints in the test itself. `test/helpers/provider-credential-env.ts` strips ambient values.
  To [run live provider tests](CONTRIBUTING.md#provider-credentials-and-live-provider-tests) with shell credentials, set `ATOMIC_TEST_KEEP_PROVIDER_CREDENTIALS=1`.

### Replacing Bun globals in tests

Use these replacements from `test/helpers/runtime.ts` in Node tests, not direct `node:fs` or `node:child_process` ports:

- `Bun.sleep`: `sleep`
- `import.meta.dir`: `moduleDir(import.meta.url)`
- `Bun.file(p).text()`, `.json()`, `.exists()`: `readText`, `readJson<T>`, `fileExists`
- `Bun.write`: `writeFileEnsuringDir`
- `Bun.spawnSync`: `spawnSyncCollect`
- `Bun.spawn`: `spawnProcess`
- `process.execPath` when spawning Bun: `bunExecutable()`

Do not change shipped Bun-only code to suit Node tests. Keep `isBunBinary` and `isBundledBuild` guards.
For `packages/web-access/subprocess.ts`, use `installBunGlobal()` in `test/unit/web-access-subprocess.test.ts`.

### SQLite selectors

Use `node:sqlite` in `packages/coding-agent/src/core/tools/sqlite-selector-connection.ts` on both runtimes, not `bun:sqlite` or `better-sqlite3`.
Use `packages/coding-agent/test/helpers/sqlite.ts` for fixtures. Do not skip tests or return early when SQLite is missing.

### Per-test timeout policy

- Set the root Vitest default only in `test/helpers/test-timeout.ts`: `TEST_TIMEOUT_MS` is `30_000` ms for every platform.
  Do not repeat it in scripts, `.github/workflows/test.yml`, or `bunfig.toml`. Keep the separate Windows budget local to `packages/coding-agent/vitest.config.ts`.
- Override only for inherently costly tests. Pass a named constant as the third argument. Do not repeat the default as an override.
- Fix tests that fail under load at the test site. Give real work headroom and derive timing assertions from a named constant.
  Do not skip, serialize, or shard tests to hide failures. Do not set `pool`, `maxWorkers`, `poolOptions`, or `fileParallelism`.
- Keep whole-job timeouts. `scripts/run-test-suite.ts` must run each suite once, propagate failures, and write `.ci-diagnostics/<suite>-durations.md`
  even on success. Treat missing or unusable duration reports as harness failures when tests ran. Resolve budgets from the chosen project and
  overrides keyed by `scope > name`. Leave warnings off for unsupported commands. Keep `WARN_RATIO` at 40% and advisory. Do not raise timeouts to hide warnings.

## Debugging

Track test failures and edge cases in `issues.md`. Use a debugging subagent for support and delete the file once the issues are resolved. Use the `agent-browser` skill when local docs do not answer a question about external tools.

## Docs

- Update [user guides](packages/coding-agent/docs) when a change affects how people use, configure, or troubleshoot Atomic.
  Put internal design, debugging, tests, and verification notes in repository docs or the PR. Put user-visible performance changes in the package changelog.
- Link to [Orchestration](packages/coding-agent/docs/orchestration.md) for multi-step agent work.
  Link to [conversion to skills](packages/coding-agent/docs/orchestration/migrating-workflows.md) for old workflow files, not the retired TypeScript API.
- Edit targeted Markdown fixes directly. For a broad refresh, use the [release-docs skill](.agents/skills/release-docs/SKILL.md) on a clean feature branch.
- The global config is `~/.atomic/agent/` or `%USERPROFILE%\.atomic\agent\` on Windows. Global extensions live in `~/.atomic/agent/extensions/<name>/`. Project config lives in `.atomic/`.

## Changelog

Keep one changelog per package at `packages/*/CHANGELOG.md`. Record only changes to shipped behavior, not version bumps.
Leave out CI, publishing, automation, maintainer scripts, and agent instructions unless they change what users get.

Read the whole `## [Unreleased]` section before appending an entry to the right subsection. Do not duplicate subsections. Use this order:

- `### Breaking Changes`: API changes that require migration.
- `### Added`: New features.
- `### Changed`: Changes to existing behavior.
- `### Fixed`: Bug fixes.
- `### Removed`: Removed features.

Never edit, append to, or delete a released section. A stable release section must stand alone and include all entries from its preceding prereleases under the same standard subsections.

Write one brief summary per release in `packages/coding-agent/CHANGELOG.md` only. Put it between the version heading and the first `###`,
never under `## [Unreleased]`. Cover all packages without repeating changes. Open with one sentence naming the theme.
Group bullets by theme, with one bullet per change. Give each a bold lead, the user benefit, and links to the main PRs or issues at the end.
Add a `**Breaking change:**` line if `### Breaking Changes` is not empty. Do not add a prerelease preamble or send users to earlier notes.
These summaries also make up the docs site's changelog: `packages/coding-agent/docs/changelog.mdx` is generated by `bun run scripts/sync-changelog-docs.ts`, so never edit it by hand.

Attribute issues and external contributions like this:

- `Fixed foo bar ([#123](https://github.com/bastani-inc/atomic/issues/123))`
- `Added feature X ([#456](https://github.com/bastani-inc/atomic/pull/456) by [@username](https://github.com/username))`

## Releasing

Keep `main` and other release bases at `0.0.0`. This covers workspace manifests and lockfile entries, the `@bastani/atomic-natives` pin,
`packages/natives/native/index.js`, `PI_AI_VERSION` in `packages/ai/src/utils/version.ts`, and the Cargo manifests and lockfile.

`scripts/cut-release.ts` tags a detached `Release <version>` commit from the exact remote base. Pushing the tag starts `.github/workflows/publish.yml`.
Only run the version stamper directly to restore a drifted placeholder: `bun run scripts/bump-version.ts 0.0.0 && npm install --package-lock-only --ignore-scripts`.

### Agent publishing requests

Follow the [publish-release skill](.agents/skills/publish-release/SKILL.md) (`/skill:publish-release`) from a clean checkout.
Ask for a missing version. Infer release or prerelease from the version and clarify ambiguity. Default to `main`.
Other bases must be protected by the required CI checks. Use `scripts/release/publish-release.ts` for the exact PR, head, and tag gates, not the PR badge.

Use `--dry-run` on the release gate commands to verify without changes. Do not merge, push, or tag without an explicit publish request.
After the pre-cut gates pass, run `bun run scripts/cut-release.ts <version> --base <base> --push --yes` and verify the exact publish run.
If a release action fails or its result is unclear, stop and inspect Git and GitHub before resuming. Never bypass a gate, repeat a push
with an unclear result, reset, force-push, move a tag, or dispatch a duplicate publication. See [release recovery](docs/ci.md#recovering-a-failed-publication).

## CI

- Keep Windows coverage, per-job timeouts, and the required `test (all platforms)` gate in `.github/workflows/test.yml`.
- Keep pull-request jobs in `test.yml` and `codeql.yml` on Restricted `namespace-profile-atomic-ci-*` profiles.
  [Check `.github/` changes before approving a fork run](docs/ci.md#approving-fork-workflow-runs). See [release runner settings](docs/ci.md#runners).
- Validate workflow changes with YAML parsing, actionlint, review, and hosted runs. Test product and release tooling, not workflow YAML.
- Keep `publish-npm` on GitHub-hosted `ubuntu-latest` for `npm publish --provenance`. Configure npm trusted publishing for `publish.yml`
  and `npm-publish`, not a static npm credential. Limit `id-token: write` to `publish-npm` and `register-published-version`.
  Limit `contents: write` to release staging, undrafting, and draft cleanup. Build from the commit verified by `integrity`.
