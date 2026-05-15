# @bastani/atomic-workflows

## Overview

This repo houses `@bastani/atomic-workflows` — a first-party extension for [pi](https://github.com/earendil-works/pi) that brings multi-stage, DAG-driven workflow execution to pi sessions.

`@bastani/atomic-workflows` ships as **raw TypeScript** (no compile step) and is loaded directly by pi. The layout mirrors pi's extension conventions.

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
- Repo commands: `bun run test:unit`, `bun run test:integration`, `bun run test:all`, `bun run typecheck`, `bun run lint`

**Exception — publishing:** `npm publish --provenance` is still the registry publish tool because npm's OIDC-signed provenance lives in the npm CLI. Everything else is Bun.

## Best Practices

- Avoid ambiguous types like `any` and `unknown`. Use specific types instead.
- Source files use `.js` import extensions (TypeScript ESM convention). The repo ships as `.ts` files; Bun resolves `.js` specifiers to the underlying `.ts` source directly — no loader hook required. pi's loader follows the same convention.
- Do not add a build step (`dist/`, `tsconfig.build.json`, etc.). The package distributes raw TypeScript and pi loads it directly.
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

### Branch Naming Convention

- **Release branches**: `release/v<major>.<minor>.<patch>` (e.g. `release/v0.1.0`)
- **Prerelease branches**: `prerelease/v<major>.<minor>.<patch>-<prerelease>` (e.g. `prerelease/v0.1.0-0`)

The version in the branch name must match `package.json` exactly after removing the leading `v`.

### Bumping Versions

Use the top-level `scripts/bump-version.ts` script to update every tracked version location (`package.json` and the README badge):

```sh
# Explicit version
bun run scripts/bump-version.ts 0.1.0
bun run scripts/bump-version.ts 0.1.0-0

# Auto-detect version from the current branch name
bun run scripts/bump-version.ts --from-branch
```

The `--from-branch` flag extracts the version from the current branch name, so check out the release or prerelease branch first.

### Workflow

1. Create a branch following the naming convention above.
2. Run the bump-version script (prefer `--from-branch`).
3. Run `bun run typecheck` and the relevant tests.
4. Commit with the message `chore(release): bump to v<version>`.
5. Open a PR to `main`.
6. Once the PR is approved and merged, `.github/workflows/publish.yml` publishes the root package to npm with provenance and creates the GitHub Release automatically.

Release automation behavior:

- Merging `release/v<version>` publishes `@bastani/atomic-workflows@<version>` to npm with the `latest` tag and creates a non-prerelease GitHub Release `v<version>` marked as latest.
- Merging `prerelease/v<version>` publishes `@bastani/atomic-workflows@<version>` to npm with the `next` tag and creates a prerelease GitHub Release `v<version>` that is **not** marked latest.
- This package ships only the npm pi package (raw TypeScript/resources). The GitHub Release is version metadata and generated release notes only — no platform binaries or build artifacts are attached.
- GitHub Release creation uses `softprops/action-gh-release@v3`, matching the release-action pattern in `flora131/atomic`, rather than shelling out to `gh` directly.
- The publish workflow also supports manual `workflow_dispatch` with a tag and an existing published GitHub Release/tag path for recovery, but the normal path is merge release/prerelease PR → npm publish → automatic GitHub Release.

## CI

An overview of CI is described here: [CI Docs](docs/ci.md).

Note: Remember that npm publishing with provenance does NOT require a token. That's the whole point. So if you see any steps in the CI related to setting up npm tokens (e.g., NPM_TOKEN|NODE_AUTH_TOKEN) for publishing, those are likely mistakes and should be removed.

## Tips

1. The `@bastani/atomic-workflows` extension is installed under `~/.pi/agent/extensions/workflows` when linked locally or loaded by pi. For local development, symlink this repo's checkout into that path if you want host-level discovery.
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

`@bastani/atomic-workflows` ships raw `.ts` files with no build step — do NOT introduce `dist/`, `tsconfig.build.json`, `outDir`, or any bundling. Tests run via Bun's built-in `bun:test` runner.
</EXTREMELY_IMPORTANT>
