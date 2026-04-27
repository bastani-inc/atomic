# Atomic CLI

## Overview

This project is a TUI application built on OpenTUI and powered in the backend by coding agent SDKs: OpenCode SDK, Claude Agent SDK, and Copilot SDK.

It works out of the box by reading and configuring `.claude`, `.opencode`, `.github` configurations for the Claude Code, OpenCode, and Copilot CLI coding agents and allowing users to build powerful agent workflows defined by TypeScript files.

## Tech Stack

- bun.js for the runtime
- TypeScript
- @clack/prompts for CLI prompts
- figlet for ASCII art
- OpenTUI for tui components
- OpenCode SDK
- Claude Agent SDK
- Copilot SDK

## Quick Reference

### Commands by Workspace

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun test:coverage` instead of `jest --coverage` or `vitest --coverage`
- Use `bun lint` to run the linters
- Use `bun typecheck` to run TypeScript type checks
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads `.env`, so don't use `dotenv`.

## Best Practices

- Avoid ambiguous types like `any` and `unknown`. Use specific types instead.

## Design Context

Refer to `.impeccable.md`

## Testing

Use `bun test` to run tests and make use of your tdd skill to write high quality tests. Here's an example of a simple test file:

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

### AI Agent Integration

When using Bun’s test runner with AI coding assistants, you can enable quieter output to improve readability and reduce context noise. This feature minimizes test output verbosity while preserving essential failure information.
​
**Environment Variables**

Set any of the following environment variables to enable AI-friendly output:
`CLAUDECODE=1` - For Claude Code
`REPL_ID=1` - For Replit
`AGENT=1` - Generic AI agent flag

### Code Quality

- Frequently run linters and type checks using `bun lint` and `bun typecheck`.
- Avoid Any and Unknown types.
- Modularize code and avoid re-inventing the wheel. Use functionality of libraries and SDKs whenever possible.

## Debugging

You are bound to run into errors when testing. As you test and run into issues/edges cases, address issues in a file you create called `issues.md` to track progress and support future iterations. Delegate to the debugging sub-agent for support. Delete the file when all issues are resolved to keep the repository clean.

## Docs

Relevant resources (use your `playwright-cli` skill if the information is not available in the local docs):

1. Bun (runtime) repo: `oven-sh/bun`
2. OpenCode:
   1. SDK repo: `anomalyco/opencode`
        1. [Docs](docs/opencode/sdk.md)
        2. [Server](docs/opencode/server.md)
   2. CLI repo: `anomalyco/opencode`
3. Copilot:
    1. SDK repo: `github/copilot-sdk`
        1. [Docs](docs/copilot-cli/sdk.md)
    2. CLI repo: `github/copilot-cli`
        1. [Usage](docs/copilot-cli/usage.md)
        2. [Hooks](docs/copilot-cli/hooks.md)
        3. [Skills](docs/copilot-cli/skills.md)
        4. [Subagents](docs/copilot-cli/subagents.md)
4. Claude Code:
   1. SDK repo: `anthropics/claude-agent-sdk-typescript`
      1. [Docs](docs/claude-code/agent-sdk)
   2. CLI repo: `anthropics/claude-code`
      1. [Hooks](docs/claude-code/cli/hooks.md)
      2. [Permissions](docs/claude-code/cli/permissions.md)
      3. [Skills](docs/claude-code/cli/skills.md)
      4. [Subagents](docs/claude-code/cli/subagents.md)
      5. [Tools](docs/claude-code/cli/tools.md)
5. OpenTUI repo: `anomalyco/opentui`
   1. [Docs](https://opentui.com/docs/getting-started/)
   2. Agent Skill: `opentui` skill for usage patterns and avoiding anti-patterns

### Coding Agent Configuration Locations

Note: There are three main coding agents used in this repository: OpenCode, Claude Code, and GitHub Copilot CLI. Each has specific configuration file locations. Their configurations may also differ in syntax and structure, so be sure to refer to the respective documentation for each agent when making changes:

1. OpenCode:
    - global:
        - Linux/MacOS: `$XDG_CONFIG_HOME/.opencode` AND `~/.opencode`
        - Windows: `%HOMEPATH%\\.opencode`

2. Claude Code:
    - global:
        - Linux/MacOS: `~/.claude`
        - Windows: `%HOMEPATH%\\.claude`
    - local: `.claude` in the project directory

3. Copilot CLI:
    - global:
        - Linux/MacOS: `$XDG_CONFIG_HOME/.copilot` AND `~/.copilot`
        - Windows: `%HOMEPATH%\\.copilot`
    - local: `.github` in the project directory

**Agent Skill Locations**
    - local:
        - `.agents/skills` (`.claude/skills` is a symlink to `.agents/skills`)
    - global:
      - `~/.agents/skills` for OpenCode and Copilot CLI
      - `~/.claude/skills` for Claude Code

## Releasing

### Branch Naming Convention

- **Release branches**: `release/v<major>.<minor>.<patch>` (e.g. `release/v0.4.47`)
- **Prerelease branches**: `prerelease/v<major>.<minor>.<patch>-<prerelease>` (e.g. `prerelease/v0.4.47-0`)

### Bumping Versions

Use the `bump-version.ts` script to update the version across all tracked files (`package.json`):

```sh
# Explicit version
bun run src/scripts/bump-version.ts 0.4.47
bun run src/scripts/bump-version.ts 0.4.47-0

# Auto-detect version from current branch name
bun run src/scripts/bump-version.ts --from-branch
```

The `--from-branch` flag extracts the version from the current branch name, so check out the release or prerelease branch first.

### Workflow

1. Create a branch following the naming convention above.
2. Run the bump-version script (prefer `--from-branch`).
3. Commit with the message `chore(release): bump version to v<version>`.
4. Open a PR to `main`.
5. Once the PR is approved and merged, a GitHub Release will automatically be created based on the branch name, and the version will be published to npm.

## CI

An overview of CI is described here: [CI Docs](docs/ci.md).

Note: Remember that npm publishing with provenance does NOT require a token. That's the whole point. So if you see any steps in the CI related to setting up npm tokens (e.g., NPM_TOKEN|NODE_AUTH_TOKEN) for publishing, those are likely mistakes and should be removed.

## Tips

1. Note: for the `.github` config for GitHub Copilot CLI, ignore the `.github/workflows` and `.github/dependabot.yml` files as they are NOT for Copilot CLI.
2. Rely on agent skills to provide information on best practices during implementation. Here is a short list of Agent Skills that are incredibly relevant to this project that you should try to use when applicable:
   - bun
   - typescript-advanced-types
   - typescript-expert
   - typescript-react-reviewer
   - opentui
   - impeccable
   - tdd
3. Ask for clarity if you unsure about a change. The developer is your best friend and oftentimes can clarify intent.

<EXTREMELY_IMPORTANT>
This is a `bun` project. Do NOT use `node`, `npm`, `npx`, `yarn`, or `pnpm` commands. Always use `bun` commands.
</EXTREMELY_IMPORTANT>