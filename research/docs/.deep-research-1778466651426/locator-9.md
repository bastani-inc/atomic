# Partition 9: scripts/ — Maintenance Script Locator

## Implementation

- `scripts/lint-offload-await.ts` — Enforces await/catch/void discipline on offloadManager (registerSession, requestResume) and tmuxRun(["switch-client"]) calls; no agent SDK imports, uses Bun.file/Bun.Glob for text parsing
- `scripts/lint-custom-workflows.ts` — Guards against alias-vs-name asymmetric lookup anti-pattern in custom-workflows.ts registry resolve; no agent SDK imports, uses readFileSync for pattern scanning

## Tests

- `scripts/lint-offload-await.test.ts` — Unit tests for checkAwaitOrCatch and checkSwitchClientGate validation functions; 17 test cases covering await, void, .catch, offload-exempt annotation, and violation detection logic

## Notable Findings

### Coupling Analysis

**lint-offload-await.ts**
- Direct tmux references: Rules B checks for `tmuxRun(["switch-client", ...)` patterns as part of workflow-pane offload RFC validation
- Agent SDK coupling: None. Script uses Bun native APIs (Bun.file, Bun.Glob) to scan source code
- Responsibility: Linter enforcing async/await discipline on offloadManager calls (RFC: specs/2026-05-08-workflow-pane-offload-and-resume.md §5.5 / §8.3)
- Scopes: executor.ts (Rule A, A2) and components/**/*.{ts,tsx} (Rule A2, Rule B)

**lint-custom-workflows.ts**
- No tmux or agent SDK coupling
- Responsibility: Linter detecting registry.resolve() calls using .alias keys instead of .name keys (anti-pattern mitigation per RFC §5.7)
- Scopes: packages/atomic/src/commands/custom-workflows.ts

### Entry Points

Both scripts export named functions for testability but execute linting logic when `import.meta.main === true`:
- `checkAwaitOrCatch()` — reusable validator for Rule A / A2
- `checkSwitchClientGate()` — reusable validator for Rule B

### Package.json Integration

- `npm run lint` chains: oxlint → lint-custom-workflows.ts → lint-offload-await.ts
- `npm run lint:offload-await` runs lint-offload-await.ts standalone

### Rewrite Impact

**lint-offload-await.ts**: Heavy tmuxRun pattern dependency. The pi-coding-agent rewrite **removes all tmux**, so Rule B (switch-client gating) becomes obsolete. Rules A/A2 (offloadManager discipline) may persist if offloadManager exists in pi architecture, or be entirely removed if pi uses different async primitives.

**lint-custom-workflows.ts**: Pure business logic linter, zero tmux/agent SDK coupling. Can be ported as-is to pi-coding-agent, possibly renamed for clarity.

