# Issue #2188 — typed child-mode policy move

## Scope and contract

This increment performed MOVE 1 only: child-mode policy moved onto typed admission. It was additive by contract. No source or test file was deleted; the legacy environment constants and environment-selected registration remain in place for the later clean-break deletion move.

## Typed policy and resolution

`packages/subagents/src/runs/inprocess/child-policy.ts` defines the `ChildModePolicy` alias and `resolveChildModePolicy()`.

The policy shape is:

```ts
{
  managementActions: "full" | "restricted";
  fanoutAuthorized: boolean;
}
```

`SubagentControlRuntime.admitChildSession()` resolves it before constructing `AdmittedChild`:

- `managementActions` is always `"restricted"` for an admitted descendant. There is no `ChildSpec` input that can widen it.
- `fanoutAuthorized` is `true` only when the explicitly resolved child tool allowlist (`spec.tools ?? spec.agent.tools`) contains `"subagent"`; omitted or unrelated allowlists cannot widen fanout.
- The fields are part of `AdmittedChild.policy`, alongside cwd, tools, skills, model, intercom group, and depth.

The admitted policy is passed through `CreateAgentSessionOptions.subagentPolicy` into `AgentSession`, `ExtensionRunner`, and `ExtensionContext.subagentPolicy`. The main subagent extension caches a typed child executor per policy and selects it at tool execution time. `createSubagentExecutor()` uses the typed policy as authoritative for mutation checks and rejects all calls when typed fanout is not authorized. The legacy `allowMutatingManagementActions` boolean remains only as the fallback for the old environment-selected path.

`registerFanoutChildSubagentExtension()` now accepts an optional typed policy. With a policy it uses the typed fanout gate and typed mutation policy; without one it retains the existing `SUBAGENT_CHILD_ENV` / `SUBAGENT_FANOUT_CHILD_ENV` reads. Its existing environment caller remains live until the later deletion move.

## Restricted-management regression evidence

The new test `test/unit/subagents-noninteractive-tool-boundary.test.ts` test named **`typed restricted child policy blocks management mutation without environment state`**:

1. Deletes both legacy environment keys.
2. Registers the fanout child tool using `{ managementActions: "restricted", fanoutAuthorized: true }`.
3. Calls `create`, `update`, and `delete`.
4. Asserts each returns `isError: true` and the child-safe refusal message.

Post-commit focused command:

```text
npx vitest --run --project unit test/unit/subagents-noninteractive-tool-boundary.test.ts -t 'typed restricted child policy blocks management mutation without environment state'

Test Files  1 passed (1)
Tests       1 passed | 11 skipped (12)
```

Admission coverage in `test/unit/subagents-inprocess-runner.test.ts` also asserts restricted management for both an explicitly fanout-authorized child and a child with no subagent allowlist, plus `fanoutAuthorized` true/false respectively.

## Required proof greps

From the committed checkout (`6739686a9`):

```text
grep -rn "registerFanoutChildSubagentExtension" packages/subagents/src --include='*.ts'
packages/subagents/src/extension/fanout-child.ts:209:export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI, childPolicy?: ChildModePolicy): void {
packages/subagents/src/extension/index.ts:51:import registerFanoutChildSubagentExtension from "./fanout-child.ts";
packages/subagents/src/extension/index.ts:225:        if (getEnvValue(SUBAGENT_FANOUT_CHILD_ENV) === "1") registerFanoutChildSubagentExtension(pi);

grep -rn "spawn(" packages/subagents/src --include='*.ts'
(no matches)

grep -cE "validateNestedSessionFile|trustedRoots|realpathSync|isSymbolicLink" packages/subagents/src/runs/foreground/subagent-executor-resume.ts
6

git status --porcelain | grep '^ D'
(none)
```

## Files changed

- `packages/subagents/src/runs/inprocess/child-policy.ts` — typed policy alias and admission resolver.
- `packages/subagents/src/runs/inprocess/runner.ts` — policy fields on `ChildPolicy`, admission resolution, session transport.
- `packages/coding-agent/src/core/{sdk-types.ts,sdk.ts,agent-session-types.ts,agent-session.ts,agent-session-methods.ts,agent-session-tool-registry.ts}` — session option/config transport.
- `packages/coding-agent/src/core/extensions/{context-types.ts,index.ts,runner-context.ts,runner.ts}` and `src/index-extensions.ts` — typed policy exposed to extension tools.
- `packages/subagents/src/extension/index.ts` — typed executor selection for in-process child sessions.
- `packages/subagents/src/extension/fanout-child.ts` — typed-policy registration branch with legacy env fallback retained.
- `packages/subagents/src/runs/foreground/{subagent-executor-types.ts,subagent-executor.ts,subagent-executor-resume.ts}` — typed mutation policy authoritative in execution and nested resolution.
- `test/unit/subagents-inprocess-runner.test.ts` and `test/unit/subagents-noninteractive-tool-boundary.test.ts` — admission and restricted-management regression coverage.
- `packages/subagents/CHANGELOG.md` and `packages/coding-agent/CHANGELOG.md` — `[Unreleased]` entries only.

No files were deleted. Diff insertion/deletion count was 188/12 lines, with no deletion-status entries.

## Gates

- `npm run format` — passed; final run had no fixes.
- `npm run check` — passed: Biome, repo-wide `tsc --noEmit`, and shrinkwrap check.
- `cargo fmt --check` — passed.
- `cargo test` — 43 passed, 0 failed; one doctest ignored.
- Focused changed-surface unit run — 2 files, 17 tests passed.
- Full `npm run test:unit` — 625 files; 621 passed; 5,819 passed tests, 16 failed tests, 2 skipped. All 16 failures are the known pre-existing co-scheduling workflow failures in `workflow-durable-tool-failure-notice`, `workflow-reload-rediscovery`, `workflow-tool-durable-replay`, and `workflow-tool-graph`; no changed-surface test failed.

## Commits

- `6739686a9` — `feat(subagents): resolve child mode policy at admission`

## Stopped here

MOVE 1 is complete and committed. MOVE 2 (prompt behavior migration) and MOVE 3 (nested control inbox migration), followed by §10 deletions and cross-package environment cleanup, were intentionally not started. The legacy env constants/reads remain by contract for those later moves. No integration or interactive E2E run was attempted in this bounded increment.
