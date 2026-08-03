# Contributing to Atomic

Thanks for your interest in contributing to Atomic. This guide explains how to prepare a local checkout, make changes, and submit them for review.

## Getting started

1. Fork and clone the repository.
2. Install dependencies with npm:

   ```bash
   npm ci --ignore-scripts
   ```

   The committed `.npmrc` applies a three-day minimum release age to anything you
   add with `npm install`, and pins exact versions.

3. Read [`DEV_SETUP.md`](DEV_SETUP.md) for the full development setup, local CLI workflow, testing notes, and repository layout.

## Development guidelines

- Use **npm** for installs, builds, checks, and tests. **Bun** compiles the release binaries and runs `scripts/*.ts`. Do not use yarn or pnpm, and do not run `bun install` — see the Tech Stack table in [`AGENTS.md`](AGENTS.md) for the full split.
- Keep changes focused and small enough to review.
- Follow the existing TypeScript style and package conventions.
- Add or update tests when changing behavior.
- Do not add build output, generated artifacts, or unrelated formatting changes.

## Claiming an issue

For external contributors, before starting substantial work on an existing issue, comment with your intended approach and wait for a maintainer to assign the issue or explicitly approve the work. A maintainer will respond within 24 hours. An expression of interest alone does not reserve an issue.

Assignments are normally held for seven days. Post a progress update if you need more time. Maintainers may release an assignment when there has been no activity.

Avoid competing pull requests for assigned issues. Coordinate with the assignee and a maintainer first; uncoordinated duplicate pull requests may be closed.

Assignment reserves the opportunity to work on an issue but does not guarantee merge. Maintainers may work on issues and open pull requests without being assigned.

## Testing and checks

Before opening a pull request, run the most relevant checks for your change:

```bash
npm run check
npm run test:unit
```

For broader changes, use:

```bash
npm run test:all
```

### Per-test timeouts

Every suite runs with a shared **30000 ms** per-test budget, declared once as `TEST_TIMEOUT_MS` in the root `vitest.config.ts` and applied to all three projects. That single value is the whole policy:

- Do not restate the budget in a package script, in `bunfig.toml` (Bun ignores `[test] timeout`), or only in the CI workflow (CI and local runs would drift apart), and do not make it platform-specific.
- Pass an explicit third-argument timeout only when a test is structurally heavy — it reloads the full builtin package graph, spawns a real CLI child, runs `tsc`, or installs a built package. Otherwise rely on the shared default; never restate it.
- CI scores every test against its effective timeout on every attempt, including a failed one that a bounded retry later rescued, and fails the step at 70 % of budget. The full duration table is uploaded as a `.ci-diagnostics/` artifact. If your test trips that gate, make it faster rather than raising the shared default.
- That scoring reads vitest's JSON reporter, which the CI wrapper requests alongside the human one so the step log stays readable. A run that executes tests without producing durations fails the step instead of reporting no slow tests.

### Tests run in parallel

vitest runs test files concurrently and this repository sets no pool or worker limits, matching upstream pi. A test that only passes on an idle machine is a bug in that test: give the real work headroom and derive the assertion from a named constant. Do not skip it, serialize the suite, or shard.

## Pull requests

When opening a PR:

- Describe the problem and the solution clearly.
- When applicable, link an issue with `Closes #<issue-number>` or `Related: #<issue-number>`.
- Include test output or explain why tests were not run.
- Call out breaking changes, migration steps, or follow-up work.

## Workflows contributions

Looking to contribute workflows? Check out the atomic-workflows repo [here](https://github.com/lavaman131/atomic-workflows).

## Questions

For questions, help, feedback, or feature ideas, join the [Atomic Discord community](https://discord.gg/9CvdXUGXR4).
