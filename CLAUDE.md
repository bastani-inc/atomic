# Development Rules

## Overview

This repo is the private `atomic-monorepo` Bun workspace. It currently houses:

- `@bastani/atomic` in `packages/coding-agent` — the Atomic-branded fork of pi's coding-agent CLI and the only independently published package.
- `@bastani/workflows` in `packages/workflows` — a first-party extension for Atomic/pi that brings multi-stage, DAG-driven workflow execution to agent sessions.
- `@bastani/subagents` in `packages/subagents` — builtin subagent orchestration, reusable agent definitions, skills, prompts, chains, and TUI clarification support.
- `@bastani/mcp` in `packages/mcp` — builtin MCP adapter extension that exposes MCP servers as agent tools.
- `@bastani/web-access` in `packages/web-access` — builtin web search, URL fetching, GitHub repository, PDF, and video extraction tools.
- `@bastani/intercom` in `packages/intercom` — builtin coordination channel for parent/child and cross-session agent communication.

Companion packages under `packages/*` ship as **raw TypeScript** (no compile step) and are bundled into `@bastani/atomic` at build time rather than published independently. The coding-agent package follows upstream pi's compiled-package layout.

## Tech Stack

- **[Bun](https://bun.sh) ≥ 1.3.14** for the runtime, package manager, and test runner
- TypeScript ≥ 5.x (strict, `noUnusedLocals`, `noUnusedParameters`)
- `bun:test` + `node:assert/strict` for tests
- `@sinclair/typebox` for schema definitions
- `jiti` for runtime TS loading where needed

## Quick Reference

### Commands

Default to using **Bun**, not Node/npm/yarn/pnpm.

- Use `bun <file.ts>` instead of `node --experimental-strip-types <file.ts>` or `ts-node <file>`
- Use `bun test <path>` instead of `node --test` or Jest/Vitest CLIs
- Use `bun run typecheck` to run TypeScript type checks (`tsc --noEmit`)
- Use `bun install` instead of `npm install`, `yarn install`, or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Repo commands: `bun run test:unit`, `bun run test:integration`, `bun run test:all`, `bun run typecheck`, `bun run lint`, `bun run hooks:install`, `bun run hooks:run`
- Git hooks are configured in `prek.toml`; `bun install` runs the root `prepare` script to install hooks with `prek install --prepare-hooks` using `default_install_hook_types`.

**Exception — publishing:** `npm publish --provenance` is still the registry publish tool because npm's OIDC-signed provenance lives in the npm CLI. Everything else is Bun.

## Best Practices

- Avoid ambiguous types like `any` and `unknown`. Use specific types instead.
- Source files use `.js` import extensions (TypeScript ESM convention). The repo ships as `.ts` files; Bun resolves `.js` specifiers to the underlying `.ts` source directly — no loader hook required. atomic's loader follows the same convention as pi.
- Do not add a build step (`dist/`, `tsconfig.build.json`, etc.) to `packages/workflows`; it distributes raw TypeScript and the host loads it directly. `packages/coding-agent` is copied from upstream pi and keeps its existing build setup.
- When using skills, if you see a frontmatter of `metadata: internal` set to `true` (if missing assume `false`), that means the skill is for internal developers of this package. If this flag is omitted, the skill is meant for consumers/everyday users.

## Design Context

Refer to `DESIGN.md` and `PRODUCT.md`.

## Testing

Use `bun run test:unit` (or `test:integration`, `test:all`) and make use of your tdd skill to write high quality tests. Tests use `bun:test` + `node:assert/strict`:

```ts#test/unit/index.test.ts
import { test } from "bun:test";
import assert from "node:assert/strict";

test("hello world", () => {
  assert.equal(1, 1);
});
```

### Hook name compatibility

Bun's `bun:test` exports `beforeAll`/`afterAll` (not `before`/`after`). Use `beforeAll`/`afterAll` for once-per-suite setup/teardown and `beforeEach`/`afterEach` for per-test hooks.

### AI Agent Integration

When using Bun’s test runner with AI coding assistants, you can enable quieter output to improve readability and reduce context noise. This feature minimizes test output verbosity while preserving essential failure information.
​
**Environment Variables**

Set any of the following environment variables to enable AI-friendly output:
`CLAUDECODE=1` - For Claude Code
`REPL_ID=1` - For Replit
`AGENT=1` - Generic AI agent flag

### Code Quality

- Frequently run linters and type checks using `bun run lint` and `bun run typecheck` (both are `tsc --noEmit`).
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

Atomic uses a **versionless `main`** release flow (modeled on openai/codex): every `packages/*/package.json` on `main` stays at the `0.0.0` placeholder, and the real version is materialized **only** on a throwaway, off-`main` `Release <version>` commit that is tagged but never merged back. Pushing the `<version>` tag (no leading `v`, for example `0.8.24` or `0.8.24-alpha.1`) triggers CI, which publishes to npm with OIDC provenance (stable `<x.y.z>` → `@latest`, prerelease `<x.y.z>-alpha.N` → `@next`) and creates the GitHub Release with cross-compiled binaries attached. Because `main` carries no version, you can cut a stable release and an ahead-of-stable prerelease line from the same trunk without branch gymnastics.

Cut a release with `scripts/cut-release.ts`, which stamps the version onto the off-`main` tag commit and (with `--push`) pushes only the tag:

```sh
bun run scripts/cut-release.ts 0.8.31            # stable -> @latest
bun run scripts/cut-release.ts 0.9.0-alpha.1     # prerelease -> @next
bun run scripts/cut-release.ts 0.8.31 --base main --push
```

`main` is never advanced; the script creates the release commit in a detached git worktree, tags it, and abandons the worktree (the tag keeps the commit alive).

### Agent publishing requests

If a user asks you to publish the package or create a release/prerelease, run the `publish-release` workflow using your workflow tool. That workflow opens a CHANGELOG-only release-notes PR to `main`, then stamps and tags the release off-`main` via `cut-release.ts` — it never bumps the version on `main`. It also accepts an optional `base_ref` input (default `main`) to release from a maintenance/integration branch instead of `main`, and an optional `from_ref` input to cut an **ephemeral** release from any commit/tag/branch: the workflow auto-creates `release/<version>` (or `prerelease/<version>`) from that ref, gates on that branch's CI, cuts and publishes the tag, then deletes the branch (the changelog lives on the tag only; `main` is untouched).

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

## Versionless main & bumping

`main` is versionless: every `packages/*/package.json` (plus `bun.lock` workspace entries, the `@bastani/atomic-natives` dependency pin, `packages/natives/native/index.js` checks, and the Cargo manifests/lock) stays at the `0.0.0` placeholder. **Do not bump the version on `main`.**

`scripts/bump-version.ts` is the low-level stamper that rewrites every versioned manifest. It is invoked by `scripts/cut-release.ts` inside a throwaway worktree to materialize the real version on the tagged release commit. You normally never run it directly against `main`; the only direct use is resetting the placeholder if it ever drifts:

```sh
# stamp a real version onto the off-main tag commit (preferred)
bun run scripts/cut-release.ts 0.1.0
bun run scripts/cut-release.ts 0.1.0-alpha.1

# low-level: reset main back to the versionless placeholder
bun run scripts/bump-version.ts 0.0.0 && bun install
```

## CI

An overview of CI is described here: [CI Docs](docs/ci.md).

Note: Remember that npm publishing with provenance does NOT require a token. That's the whole point. So if you see any steps in the CI related to setting up npm tokens (e.g., NPM_TOKEN|NODE_AUTH_TOKEN) for publishing, those are likely mistakes and should be removed.

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
This repo uses **Bun (≥ 1.3.14)** for development, scripts, and tests. Do NOT use `node`, `npm`, `npx`, `yarn`, or `pnpm` for development commands. Always use `bun`, `bunx`, and `bun run`. The only acceptable exception is `npm publish --provenance` for the release flow (OIDC provenance is npm-CLI-specific).

`@bastani/workflows` ships raw `.ts` files with no build step — do NOT introduce `dist/`, `tsconfig.build.json`, `outDir`, or any bundling. Tests run via Bun's built-in `bun:test` runner.
</EXTREMELY_IMPORTANT>
