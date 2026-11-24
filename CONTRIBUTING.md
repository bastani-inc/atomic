# Contributing to Atomic

## Current status: P0 bugs only

We're accepting P0 fixes only. A P0 bug has no reasonable workaround and crashes Atomic, loses or corrupts data or session history, causes a security problem, or makes Atomic unusable.

Other bug reports are welcome. Follow the [security policy](SECURITY.md) to report vulnerabilities privately.

Don't open feature or enhancement PRs. We're pausing existing PRs other than P0 fixes. You can still propose ideas with the Contribution issue template. See [#3331](https://github.com/bastani-inc/atomic/issues/3331).

## Claiming an issue

If you're an external contributor, open a proposal issue or describe your approach on an existing issue. Wait for a maintainer to explicitly approve the scope before starting work or opening a PR. This includes small fixes, docs changes, and draft PRs. Assignment alone is neither scope approval nor a promise to merge.

Assignments usually last seven days. Post an update if you need more time. Maintainers may release inactive assignments. If someone else is assigned, coordinate with them and a maintainer before opening a competing PR. Maintainers do not need approval or assignment.

## Getting started

Fork and clone the repository, then run `npm ci --ignore-scripts` from the root. See [DEV_SETUP.md](DEV_SETUP.md) for prerequisites, build steps, and how to run Atomic locally.

## Development guidelines

- Use npm for installs, builds, checks, and tests. Bun compiles release binaries and runs `scripts/*.ts`. Do not use Yarn, pnpm, or `bun install`.
- Keep changes focused and follow the existing TypeScript and package conventions. Leave out build output, generated files, and unrelated formatting.
- Add or update tests when behavior changes.

## Testing and checks

Run the checks that cover your change before opening a PR. Start with `npm run check` and `npm run test:unit`. For broader changes, run `npm run test:all` for the root unit and integration suites.

### Per-test timeouts

The root Vitest projects share the 30-second `TEST_TIMEOUT_MS` in [`test/helpers/test-timeout.ts`](test/helpers/test-timeout.ts). Do not duplicate it or set a platform-specific default. Only override it for tests that must do expensive work, such as launching the CLI. Pass a named constant as the third argument. Do not raise a timeout just to silence a CI warning.

### Tests run in parallel

If a test fails under load, fix the test and give the work enough time to finish. Base timing assertions on a named constant. Do not skip the test, serialize the suite, or use sharding to hide the failure.

### Provider credentials and live provider tests

Tests clear inherited [provider credentials and endpoints](test/helpers/provider-credential-env.ts) by default. Set any credentials your test needs in the test itself. If it needs debug output, use `withDebugLog` from [`test/helpers/debug-mode.ts`](test/helpers/debug-mode.ts).

Live provider tests skip without credentials. To run them against a real provider, opt in with your key:

```bash
OPENAI_API_KEY=sk-... ATOMIC_TEST_KEEP_PROVIDER_CREDENTIALS=1 npm run test --workspace=@bastani/atomic-ai
```

## Pull requests

External contributors need [scope approval](#claiming-an-issue) before opening a PR. Maintainers may close PRs without approval.

- Describe the problem and the fix.
- If you're an external contributor, link the approved issue with `Closes #<issue-number>` or `Related: #<issue-number>`.
- Include test results or explain why you did not run tests.
- Call out breaking changes, migration steps, and follow-up work.
- Keep the PR in draft while you work. Mark it ready for review to start the full [Tests workflow](.github/workflows/test.yml), including the `test (all platforms)` check.

## Skills and orchestration patterns

Write reusable procedures as [skills](packages/coding-agent/docs/skills.md). Use [codemode](packages/coding-agent/docs/codemode.md) and [subagents](packages/coding-agent/docs/subagents.md) to coordinate work.

The release procedures are in [`.agents/skills/`](.agents/skills). Use `/skill:publish-release` to publish and `/skill:release-docs` to refresh the hosted docs.

When changing a procedure, update its `SKILL.md`. Put deterministic Git, GitHub, or docs checks in [`scripts/release/`](scripts/release) with tests. Test against existing refs. Do not merge, tag, or publish to verify a change.

## Questions

Ask questions or share feedback in the [Atomic Discord community](https://discord.gg/9CvdXUGXR4).
