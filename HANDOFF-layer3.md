# Layer 3 (pi-0.84.1/adopt-upstream) — handoff

Run 5f77f882 was quit deliberately to free the machine for the test-setup perf
fix. All work is committed; nothing is lost.

## State at handoff
- 7 logical commits on `pi-0.84.1/adopt-upstream` (reset from 24 WIP commits;
  tree diff against the pre-reset HEAD was verified EMPTY — content identical).
- `npm run typecheck`: 0 errors. Tree clean.
- Lock + shrinkwrap: six pi packages at 0.84.1, single instance each,
  zero 0.83.0 references.
- `test:unit`, `test:integration`, `test:ci-contracts`, `test:scripts`: green
  at the time of the last full pass.

## The one open defect
`npm run test:all` exposed a failure in the real-CLI steering integration test:

    npx vitest --run --project integration \
      test/integration/workflow-stage-steering-queue-cli.test.ts

The orchestrator confirmed **it fails in isolation**, so it is a real
regression, not load starvation. Suspected cause: the delta-only
`message_update` rewrite (commit 9c33bc214, "make message updates delta-only
across session surfaces").

Related tests seen during triage:
- `rpc-message-update-deltas.test.ts`
- `2221-interactive-delta-streaming-render.test.ts`
- `2221-interactive-delta-rendering.test.ts`

A debugger subagent had just been dispatched with this reproduction when the
run was quit; its diagnosis was not persisted.

## Next run should
1. Fix the stage-chat delta regression above.
2. Re-run all four suites plus `npm run check`.
3. Leave the 7-commit structure intact; add fix commits on top.
