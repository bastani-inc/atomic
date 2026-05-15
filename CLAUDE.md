# Atomic Monorepo

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
- Source files use `.js` import extensions (TypeScript ESM convention). The repo ships as `.ts` files; Bun resolves `.js` specifiers to the underlying `.ts` source directly — no loader hook required. pi's loader follows the same convention.
- Do not add a build step (`dist/`, `tsconfig.build.json`, etc.) to `packages/workflows`; it distributes raw TypeScript and the host loads it directly. `packages/coding-agent` is copied from upstream pi and keeps its existing build setup.
- When using skills, if you see a frontmatter of `metadata: internal` set to `true` (if missing assume `false`), that means the skill is for internal developers of this package. If this flag is omitted, the skill is meant for consumers/everyday users. 

## Design Context

Refer to `.impeccable.md`

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
2. pi: `can1357/pi`
    1. Extension loading + SDK docs under `docs/`
3. TypeScript: `microsoft/TypeScript`
    1. [Module resolution](https://www.typescriptlang.org/docs/handbook/module-resolution.html)
    2. [`paths`](https://www.typescriptlang.org/tsconfig#paths)
4. Schema tooling:
    1. `@sinclair/typebox` for runtime-validated schemas
    2. `jiti` for on-demand TS loading

### Coding Agent Configuration Location

pi:
 - global:
     - Linux/MacOS: `~/.pi/agent/`
     - Windows: `%HOMEPATH%\.pi\agent\\`
 - extensions: `~/.pi/agent/extensions/<name>/`
 - local: `.pi/` in the project directory

**Agent Skill Locations**
    - local:
        - `.agents/skills` (`.claude/skills` is a symlink to `.agents/skills`)
    - global:
      - `~/.agents/skills` for OpenCode and Copilot CLI
      - `~/.claude/skills` for Claude Code

## Releasing

Atomic mirrors pi's tag-driven release flow: bump versions locally, commit, push a `v<version>` git tag, and CI publishes to npm with OIDC provenance and creates the GitHub Release with cross-compiled binaries attached.

### Agent publishing requests

If a user asks you to publish the package:

- Ask the user with the `ask_user_question`/ask-question tool what version to publish if they have not supplied a version.
- Ask whether they want a release or prerelease if that cannot be inferred from the supplied version, or if the version is in an incorrect format. Valid formats are `MAJOR.MINOR.PATCH` for releases and `MAJOR.MINOR.PATCH-NUMBER` for prereleases.
- Remember that publishing is triggered by the git tag flow: create `git tag v<version>` and push it with `git push origin v<version>` after the version bump commit is on the branch. A branch push or PR merge alone does not publish.

### Bumping Versions

Use the top-level `scripts/bump-version.ts` script to update every `packages/*/package.json` version and package README badge:

```sh
# Explicit version
bun run scripts/bump-version.ts 0.1.0
bun run scripts/bump-version.ts 0.1.0-0
```

Run `bun install` afterward to refresh `bun.lock`.

### Workflow

1. Bump versions with `bun run scripts/bump-version.ts <version>`, then `bun install`.
2. Move the `[Unreleased]` section in `packages/coding-agent/CHANGELOG.md` to a new `## [<version>] - <YYYY-MM-DD>` section. The publish workflow extracts release notes from this section.
3. Run `bun run typecheck`, `cd packages/coding-agent && bun run build`, and the relevant tests.
4. Commit with `chore(release): bump to v<version>`.
5. Tag with `git tag v<version>` and push both branch and tag: `git push && git push origin v<version>`.
6. The `v*` tag push triggers `.github/workflows/publish.yml`, which validates the tag matches `packages/coding-agent/package.json`, runs typecheck/tests, cross-compiles binaries via `scripts/build-binaries.sh`, publishes `@bastani/atomic@<version>` to npm with OIDC provenance, and creates the GitHub Release with binaries attached.

Release automation behavior:

- A `v<version>` tag (e.g. `v0.8.0`) publishes `@bastani/atomic@<version>` to npm with the `latest` tag and creates a non-prerelease GitHub Release marked as latest.
- A prerelease tag like `v0.8.0-0` publishes with the `next` npm tag and creates a prerelease GitHub Release that is **not** marked latest.
- `packages/workflows` and companion pi packages are bundled into `@bastani/atomic` at build time; they are not independently published.
- GitHub Release uses `softprops/action-gh-release@v3` with release notes extracted from `packages/coding-agent/CHANGELOG.md` (pi-style awk extraction). Six binary archives are attached: `atomic-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}.tar.gz` and `atomic-{windows-x64,windows-arm64}.zip`.
- For recovery, `workflow_dispatch` accepts an explicit `tag` input.

## CI

An overview of CI is described here: [CI Docs](docs/ci.md).

Note: Remember that npm publishing with provenance does NOT require a token. That's the whole point. So if you see any steps in the CI related to setting up npm tokens (e.g., NPM_TOKEN|NODE_AUTH_TOKEN) for publishing, those are likely mistakes and should be removed.

## Tips

1. The workflows extension is bundled into `@bastani/atomic`. For local development against upstream pi, symlink `packages/workflows` into `~/.pi/agent/extensions/workflows` if you want host-level discovery outside Atomic.
2. Rely on agent skills to provide information on best practices during implementation. Here is a short list of Agent Skills that are incredibly relevant to this project that you should try to use when applicable:
   - typescript-advanced-types
   - typescript-expert
   - typescript-react-reviewer
   - tdd
   - impeccable
3. Ask for clarity if you are unsure about a change. The developer is your best friend and oftentimes can clarify intent.
4. When modifying this extension, follow pi's extension and SDK conventions.

<EXTREMELY_IMPORTANT>
This repo uses **Bun (≥ 1.3.14)** for development, scripts, and tests. Do NOT use `node`, `npm`, `npx`, `yarn`, or `pnpm` for development commands. Always use `bun`, `bunx`, and `bun run`. The only acceptable exception is `npm publish --provenance` for the release flow (OIDC provenance is npm-CLI-specific).

`@bastani/workflows` ships raw `.ts` files with no build step — do NOT introduce `dist/`, `tsconfig.build.json`, `outDir`, or any bundling. Tests run via Bun's built-in `bun:test` runner.
</EXTREMELY_IMPORTANT>
