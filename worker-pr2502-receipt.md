# PR #2502 CI repair receipt

## Outcome
Repaired the TS1294 build failure on draft PR #2502, pushed only `budgets/config-reducer`, and observed all actionable CI checks pass. PR #2502 remains open, draft, and unmerged.

- Repair commit: `cde15349c019f159ff7503deb2d04fca47546bc8`
- Subject: `fix(workflows): make budget resolution erasable`
- Branch: `budgets/config-reducer`
- Final local and remote branch SHA: `cde15349c019f159ff7503deb2d04fca47546bc8`

## Initial synchronization and PR state
Commands were run in the requested order before editing:

1. `git fetch origin` — passed; fetched `budgets/config-reducer`.
2. `git checkout budgets/config-reducer` — passed; already on the branch.
3. `git pull origin budgets/config-reducer` — passed; already up to date.
4. `gh pr view 2502 --repo bastani-inc/atomic --json baseRefName,headRefName,isDraft,state` — returned `baseRefName: main`, `headRefName: budgets/config-reducer`, `isDraft: true`, `state: OPEN`.

Because the PR base was `main`, no `origin/main` merge was performed.

## Failed checks and diagnosis
The required enumeration command was run exactly:

```text
gh pr checks 2502 --repo bastani-inc/atomic
```

The initial failing checks were all from workflow run `32128527968`:

| Failed check | Job ID | Diagnosis |
|---|---:|---|
| release-archive (blacksmith-4vcpu-ubuntu-2404, linux-x64) | `95684340507` | `Build @bastani/atomic package` failed with TS1294 in `packages/workflows/src/shared/budget.ts` lines 19–22. |
| release-archive (blacksmith-4vcpu-windows-2025, windows-x64) | `95684340559` | Same TS1294 failure in the same four constructor parameter properties. |
| suites (blacksmith-4vcpu-ubuntu-2404, linux-x64) | `95684340445` | `Build @bastani/atomic package` failed with the same TS1294 diagnostics. |
| suites (blacksmith-4vcpu-windows-2025, windows-x64) | `95684340538` | `Build @bastani/atomic package` failed with the same TS1294 diagnostics. |
| test (blacksmith-4vcpu-ubuntu-2404, linux-x64) | `95686351347` | Result gate correctly failed because work-job results were `failure,success,failure,success`; it was a consequence, not an independent defect. |
| test (blacksmith-4vcpu-windows-2025, windows-x64) | `95686351312` | Same result-gate consequence: `failure,success,failure,success`. |

For every failed job, the exact required command was run:

```text
gh run view --repo bastani-inc/atomic --job 95684340507 --log | tail -100
gh run view --repo bastani-inc/atomic --job 95684340559 --log | tail -100
gh run view --repo bastani-inc/atomic --job 95684340445 --log | tail -100
gh run view --repo bastani-inc/atomic --job 95684340538 --log | tail -100
gh run view --repo bastani-inc/atomic --job 95686351347 --log | tail -100
gh run view --repo bastani-inc/atomic --job 95686351312 --log | tail -100
```

The CLI form returned no log text in this environment. The same failed jobs were then inspected through the GitHub Actions log archive (`gh api repos/bastani-inc/atomic/actions/runs/32128527968/logs`, unzip, and per-job log tails). The package-build logs contain these exact diagnostics on both Linux and Windows:

```text
../workflows/src/shared/budget.ts(19,3): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
../workflows/src/shared/budget.ts(20,3): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
../workflows/src/shared/budget.ts(21,3): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
../workflows/src/shared/budget.ts(22,3): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
```

The offending code was the new `ResolvedWorkflowBudget` constructor's four parameter properties. The result-gate logs confirmed the dependency result string rather than another defect.

CodeQL and all Analyze jobs passed in the initial run, and the PR slice contains no sanitizer change or incomplete multi-character sanitizer finding. Therefore the sanitizer fixed-point/unterminated-`<!--` repair was not applicable to this failure set; no unrelated sanitizer code was changed.

## Change made
Changed only `packages/workflows/src/shared/budget.ts`:

- Declared the four existing public readonly fields explicitly.
- Assigned the constructor arguments to those fields in the constructor body.
- Preserved field names, readonly modifiers, constructor visibility, nominal `brand`, `EffectiveBudget` type identity, values, ordering, and all existing behavior.
- Added no enum, namespace, validation, normalization, or sanitizer behavior.

The specialized erasability check passed after the edit:

```text
npx --no-install tsgo -p packages/coding-agent/tsconfig.workflows-types.json
```

`git diff --check` also passed.

## Exact slice Vitest anchor and local gates
The PR adds `test/unit/workflow-budget.test.ts`; this was used as the exact slice anchor:

```text
npm run test:unit -- test/unit/workflow-budget.test.ts
```

It passed before the mandatory gate and was rerun after `npm run check`, passing with 1 file and 9 tests.

Mandatory pre-push commands and outcomes:

```text
npm run check
```

Passed:
- Biome checked 2537 files with no fixes.
- Root TypeScript check passed.
- `@bastani/atomic` `tsgo -p tsconfig.build.json --noEmit` passed.
- Published shrinkwrap was up to date.

```text
npm run test:unit -- test/unit/workflow-budget.test.ts
```

Passed: 1 test file, 9 tests.

A local full package build was attempted for diagnosis with `npm run build --workspace=@bastani/atomic`; its `tsgo` phase passed, but the checkout has no `bun` executable and the later copy-assets step stopped at `sh: 1: bun: not found`. CI's Bun-hosted package build was the authoritative reproduction and passed after the repair.

## Commit and push
After both local gates passed:

```text
git add packages/workflows/src/shared/budget.ts
git commit -m "fix(workflows): make budget resolution erasable" --trailer "Assistant-model: OpenAI GPT-5"
```

Created commit `cde15349c019f159ff7503deb2d04fca47546bc8`.

```text
git push origin HEAD:budgets/config-reducer
```

Push passed:

```text
4a556db0..cde15349  HEAD -> budgets/config-reducer
```

No other branch or PR was modified. No PR was created, marked ready, or merged.

## Final acceptance matrix A1–A14

| Row | Requirement | Evidence and outcome |
|---|---|---|
| A1 | Sync requested branch and conditionally merge main | Required fetch/checkout/pull/query order passed. PR base is `main`; no merge was performed. |
| A2 | Enumerate every failed check and inspect every failed job log | Exact `gh pr checks` and six exact `gh run view ... --job ... --log \| tail -100` commands were run. Empty CLI output was supplemented by the Actions log archive; all six jobs were diagnosed. |
| A3 | Repair TS1294 erasability defects in workflows | Replaced the four parameter properties in `packages/workflows/src/shared/budget.ts`; specialized `tsgo` erasability check and CI package builds pass. No enum or namespace defect was reported. |
| A4 | Repair relevant sanitizer defects to fixed point, including trailing unterminated `<!--`, with a durable test | Not applicable: CodeQL passed before and after, and the original budget slice has no sanitizer code/finding. No unrelated sanitizer change was made. |
| A5 | Fix all in-scope failures and nothing else | One-file repair addresses the common package-build failure; result-gate failures consequently cleared. Final actionable checks pass. |
| A6 | Add no dependency or build step | `git diff --name-only origin/main...HEAD -- package.json package-lock.json .npmrc .github/workflows 'packages/*/package.json' 'packages/*/tsconfig*.json'` returned `none`. |
| A7 | Keep PR #2502 open/draft/unmerged | Final PR query: `number: 2502`, `state: OPEN`, `isDraft: true`, `mergeCommit: null`, `mergedAt: null`, head `budgets/config-reducer`. |
| A8 | Run `npm run check` and exact Vitest anchor before push | Both passed before push; anchor was rerun after `check` as well. |
| A9 | Make small commit(s) and push only target branch | One small commit `cde15349`; `git push origin HEAD:budgets/config-reducer` passed. |
| A10 | Comment instead of changing code for proven unrelated infrastructure flake | N/A. Failures were reproducible TS1294 code defects, not infrastructure flakes; no comment was posted. |
| A11 | Repeat until CI is green | Final `gh pr checks 2502 --repo bastani-inc/atomic` shows all actionable checks pass: Analyze (actions), Analyze (javascript-typescript) x2, Analyze (python), Analyze (rust), CodeQL, agent-suite Linux/Windows, release-archive Linux/Windows, static-checks, suites Linux/Windows, and test Linux/Windows. Only informational Mintlify Deployment and [code]smith are `skipping`. |
| A12 | Remove `issues.md` after debugging | `test ! -e issues.md` passed; file is absent. |
| A13 | Preserve unspecified API/input behavior | Diff only changes parameter-property lowering to explicit fields and assignments; names, field identity, optionality, raw values, duplicates/order, nominal brand, and public type identity remain unchanged. |
| A14 | Clean checkout and report commit | `git status --porcelain=v1` was empty. `git rev-parse HEAD` and `git ls-remote origin refs/heads/budgets/config-reducer` both returned `cde15349c019f159ff7503deb2d04fca47546bc8`. |

## Final PR and CI state
Final PR query:

```json
{"baseRefName":"main","headRefName":"budgets/config-reducer","headRefOid":"cde15349c019f159ff7503deb2d04fca47546bc8","isDraft":true,"mergeCommit":null,"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","mergedAt":null,"number":2502,"state":"OPEN"}
```

Final check run was `32157185232`; all actionable checks passed. No unrelated-flake comment URL exists (N/A).

## Blockers and residual risks
None for the frozen objective. The local full package build could not execute its Bun copy-assets phase because Bun is not installed in this checkout, but the required Node/npm gates passed and the pushed CI package builds passed on Linux and Windows with Bun 1.3.14. No `issues.md` remains.
