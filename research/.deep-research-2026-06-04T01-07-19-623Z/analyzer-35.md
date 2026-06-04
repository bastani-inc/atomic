## 1. Behavioral model

This partition is the subagent “safety net” around parallel execution:

- **Git worktree isolation** creates one disposable worktree per parallel task, so each task edits an isolated checkout.
- **Acceptance gating** evaluates whether the child run produced enough structured evidence to count as done.
- **Completion guard** catches “implementation tasks” that finish successfully but never actually mutate files.

Together, they turn parallel subagent execution into a controlled, auditable workflow rather than plain subprocess fan-out.

## 2. Key flows and invariants

### Worktree isolation
- `createWorktrees()`:
  - requires the target cwd to be a git repo and the tree to be clean
  - captures `HEAD` as `baseCommit`
  - creates one branch/worktree per task using temp paths
  - links `node_modules` into each worktree when possible
  - optionally runs a user hook that can declare extra `syntheticPaths`
- `cleanupWorktrees()`:
  - removes worktrees in reverse order
  - deletes branches
  - prunes repo worktrees best-effort

### Important invariants
- Worktree isolation is **disabled if any task overrides `cwd` away from the shared cwd**.
- Hook output is tightly constrained:
  - JSON object only
  - `syntheticPaths` must be relative
  - cannot escape the worktree root
  - cannot target tracked files
- Diff capture happens **after synthetic paths are removed** so “virtual” paths don’t contaminate the patch.

### Acceptance gating
- `resolveEffectiveAcceptance()` merges:
  - explicit acceptance config
  - inferred policy from agent/task shape
- `formatAcceptancePrompt()` injects a structured report contract into the child task prompt.
- `evaluateAcceptance()`:
  - parses fenced `acceptance-report` JSON or `ACCEPTANCE_REPORT:{...}`
  - validates required criteria and evidence
  - optionally runs verification commands
  - optionally requires independent review for `reviewed`
- `acceptanceFailureMessage()` converts a rejected ledger into a single human-readable failure.

### Completion guard
- `evaluateCompletionMutationGuard()` decides whether the task **should have edited files**.
- It only triggers when:
  - the task looks like an implementation task, and
  - the toolset is not explicitly read-only, and
  - no mutating tool call was observed
- It detects mutations via:
  - `edit`
  - `write`
  - mutating `bash` commands

### Execution coupling
- Foreground, background, and chain runners all thread these same policies through parallel execution.
- If worktree setup fails, the whole parallel group fails early.
- If completion guard triggers, the run is flipped to failure even with exit code 0.
- If acceptance rejects, the run may be converted to failure even after successful execution.

## 3. Tests / validation

Strong coverage exists for acceptance behavior:
- `test/unit/subagents-acceptance.test.ts`
  - inference rules
  - prompt formatting
  - parsing
  - evidence checks
  - verification commands
  - review handling
  - zero-child aggregate behavior

There is also propagation coverage for workflow-stage guard behavior:
- `test/unit/subagents-foreground-guard-propagation.test.ts`

What I did **not** verify directly:
- dedicated unit tests for `worktree.ts` itself
- full integration tests for worktree cleanup/failure rollback
- whether CI runs every subagents-specific test path or only a subset

## 4. Risks, unknowns, and verification steps

### Migration risks for Rust
- **Worktree orchestration is shell/git-heavy**: easiest to port, but cleanup semantics must remain exact.
- **Acceptance parsing is prompt-contract dependent**: Rust must preserve the structured report format or intentionally replace it.
- **Completion guard is heuristic**: false positives/negatives will matter more after a rewrite.
- **The biggest coupling is not these gates themselves, but the runner stack around them**:
  - task spawning
  - stdout event parsing
  - session persistence
  - artifact generation

### Unknowns to verify
- Whether `syntheticPaths` are used only for `node_modules`-like shims or by broader hook ecosystems.
- Whether any downstream consumers depend on the exact error text from acceptance/completion guard failures.
- Whether background and foreground runners diverge in subtle cleanup timing.

### Recommended verification
1. Port worktree creation/cleanup first.
2. Preserve acceptance report schema exactly.
3. Re-run acceptance and guard-focused tests.
4. Add integration tests for:
   - setup-hook failure rollback
   - synthetic path stripping
   - completion-guard failure on no-edit implementations
   - acceptance rejection after a successful run