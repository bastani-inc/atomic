# Contributing to Atomic

Thanks for your interest in contributing to Atomic. This guide explains how to prepare a local checkout, make changes, and submit them for review.

## Getting started

1. Fork and clone the repository.
2. Install dependencies with Bun:

   ```bash
   bun install
   ```

3. Read [`DEV_SETUP.md`](DEV_SETUP.md) for the full development setup, local CLI workflow, testing notes, and repository layout.

## Development guidelines

- Use **Bun** for development commands (`bun`, `bun run`, `bunx`). Do not use npm, yarn, pnpm, or npx for normal development tasks.
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
bun run typecheck
bun run lint
bun run test:unit
```

For broader changes, use:

```bash
bun run test:all
```

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
