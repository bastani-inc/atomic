# Test Value and Audits

One value bar applies to every test: it must protect observable behavior, a credible regression, or an independently meaningful contract. Use this file in two modes:

- **Authoring gate**: before adding or changing a test in a RED step.
- **Audit**: when asked to review, clean up, or prune an existing test surface.

## Authoring gate

Answer all four questions before adding a test. If one has no answer, do not add the test yet.

1. **What does it protect?** Name the observable behavior, invariant, or independent contract.
2. **What regression makes it fail?** Describe a credible code change that would break it.
3. **Why doesn't existing coverage catch that?** Each contract should have one primary test at the strongest boundary. A second layer needs its own risk, such as a transport or lifecycle failure the primary test cannot reach. Prefer adding a row to a table-driven test or reusing a shared fixture over writing a near-duplicate.
4. **Does it need a production seam nothing else uses?** An export, flag, wrapper, or injection hook that exists only for the test is a sign the test sits at the wrong boundary. Move the test to the real boundary instead.

Then check it against the [junk patterns](#junk-patterns). A match fails the gate unless the [retention bar](#retention-bar) names the contract the test independently guards.

A test that breaks under a behavior-preserving refactor asserts implementation, not behavior. Rewrite it at the owning boundary before landing it.

### Regression tests

A bug regression test must fail on the pre-fix code for the intended reason, then pass after the fix. Run it against the unfixed code and read the failure message: a test that never failed proves the mock, not the fix. One regression test at the boundary that owns the bug covers it; do not replay the same scenario at every layer it passes through.

## Junk patterns

The authoring gate rejects new tests that match these; audits hunt for existing ones.

- Assertion-free coverage probes (the code runs, nothing is checked).
- Self-comparisons and identity copies (`expect(x).toEqual(x)`, or a value compared with a copy of itself).
- Copied fixtures, inventories, manifests, or export lists that restate the source.
- Exact source, import, or string greps standing in for behavior.
- Private predicate or call-shape tests that duplicate what a real-boundary test already proves.
- Several invocations of the same contract that differ only in incidental input.
- Local replays of a shared helper's tests in each caller.
- Tests whose only job is keeping a test-only export, global, or wrapper alive.
- Dead production code whose only callers are tests.
- Expected values computed by the helper or renderer under test.
- Mocks that implement the behavior being asserted, or one identical mock standing in for different APIs.
- Fixtures that supply the ordering, callback, or acknowledgement the code under test should produce, or persistence asserted against a store the code never writes.
- Capability tests that restate a declared flag instead of exercising what the flag promises.
- Negative tests that pass for an unrelated reason, such as a rejection from a different guard or an error the production path never reaches.
- Names or fixtures that promise more than the input exercises.

## Retention bar

Keep a test when it independently enforces a public API, protocol, config, migration, storage, security, platform, default-value, prompt text, package, release, or architecture contract. Also keep:

- Call-order assertions when order is observable behavior.
- Regressions with a credible failure mode.
- Source inspection when it is the cheapest independent guard: it fails when the contract changes (a user-facing key, byte, or path) and survives an identifier-only rename.
- A test that fails on the current baseline. Treat that as a possible product bug: reproduce it and fix the code rather than deleting the test.

Static or slow is not a reason to delete. A test that resembles implementation may still be the only guard on a contract; prove otherwise before removing it.

## Audit workflow

### 1. Read before judging

Read the root and nearest `AGENTS.md` (or equivalent) first. For each candidate, read the whole test and the production code it covers: its entry point, callers, callees, sibling implementations, overlapping tests, how CI runs it, and the history of why it exists (`git log -S`, `git blame`, linked issues). When a test claims dependency-backed behavior, check the dependency's source or types directly.

### 2. Discover read-only

Keep discovery read-only and report evidence before editing anything. For a broad scope, split discovery into parallel lanes (for example core packages, extensions or plugins, apps and scripts, and one cross-cutting sweep for the junk patterns). Prefer a few high-confidence candidates over a large speculative list.

### 3. Record evidence per candidate

A candidate is ready for removal only when every field is filled in:

- Exact test name and file.
- What failure it can actually detect.
- Non-test callers of the production code or seam it covers.
- The stronger test that still proves the contract, or why no proof is needed.
- Relevant history and why the test or seam exists.
- Production or test-support code the removal unlocks.
- Risk, and the focused command that validates the change.

### 4. Edit one coherent batch

Choose one batch that belongs to a single owner. Delete obsolete test-only exports, globals, wrappers, and dead production paths rather than keeping aliases. Move retained regressions to the boundary that owns them. Merge repeated assertions into one table-driven contract.

Aim for less production code, not a higher deletion count. Do not write replacement tests that restate the same implementation, and do not turn uncertain candidates into cleanup to inflate the numbers.

### 5. Validate

- Do not edit source or tests while the test runner is running in the same checkout.
- Run the smallest affected test files and their siblings first, then the project's required suites and checks.
- When a removed test was a source grep or plan assertion, run the script or dry-run that owns the real contract.
- Run the formatter on changed files and `git diff --check`.
- Inspect `git diff --numstat` and report production and tooling changes separately from test changes.

### 6. Land and continue

Commit, push, or open a PR only when authorized. Land one coherent batch at a time. After it lands, refresh from the main branch and rerun read-only discovery for the next batch.

## Audit handoff

Report:

- Removed low-value categories and why they were low value.
- Production code simplified or deleted.
- Tests that looked removable but were kept, and the contract each one guards.
- Focused and full checks actually run, with results.
- Production versus test line counts.
- PR state and named follow-ups.
