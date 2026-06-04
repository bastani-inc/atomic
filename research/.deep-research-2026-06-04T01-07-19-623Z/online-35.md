## 1. Relevant external facts

- No external research was necessary for this partition. The key behavior is defined by local TS code in:
  - `packages/subagents/src/runs/shared/worktree.ts`
  - `packages/subagents/src/runs/shared/acceptance.ts`
  - `packages/subagents/src/runs/shared/completion-guard.ts`

## 2. Local implications

For a TypeScript → Rust migration, these are the contracts you must preserve:

- **Git worktree isolation**
  - `createWorktrees`, `cleanupWorktrees`, and `resolveExpectedWorktreeAgentCwd` define how parallel agents get isolated filesystems.
  - Rust must keep:
    - branch/worktree naming semantics
    - synthetic path handling
    - `node_modules` linking behavior
    - cleanup on success/failure

- **Acceptance gating**
  - `resolveEffectiveAcceptance`, `validateAcceptanceInput`, `parseAcceptanceReport`, `evaluateAcceptance`, and `acceptanceFailureMessage` define “done vs rejected.”
  - Rust must preserve:
    - input validation rules
    - report parsing format
    - failure messaging
    - policy inheritance/override behavior

- **Completion guard**
  - `expectsImplementationMutation`, `hasMutationToolCall`, and `evaluateCompletionMutationGuard` enforce “did the agent actually edit anything?”
  - Rust should keep this as a first-class safeguard, not a UI-only check.

- **Execution wiring**
  - The foreground/background runners thread `worktree`, `acceptance`, and completion guard through execution.
  - Migration risk is highest at orchestration boundaries, not just the pure helpers.

- **Public API surface**
  - `packages/subagents/src/extension/schemas.ts` and `packages/subagents/src/extension/index.ts` mean these behaviors are externally visible.
  - A Rust rewrite must remain schema-compatible unless you plan a breaking change.

## 3. Version/API assumptions

- Assumes the current TS APIs are the source of truth.
- No Rust API exists yet for these features, so migration likely means:
  - reimplementing the same behavior in Rust, or
  - introducing a compatibility layer that preserves the current extension contract.
- The local repo currently treats `@bastani/subagents` as a bundled TS extension, not a Rust-backed boundary.

## 4. Unverified or unnecessary research

- I did not verify Git CLI/worktree upstream docs because the local implementation already defines the behavior that matters for migration.
- I did not inspect the exact Rust runtime architecture, so I can’t say whether these pieces should become:
  - in-process Rust modules,
  - a subprocess service,
  - or a plugin boundary.
- I also did not verify test coverage depth for worktree behavior beyond the files listed in the locator.