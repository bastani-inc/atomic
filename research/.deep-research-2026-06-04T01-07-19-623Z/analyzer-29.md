# 1. Behavioral model

This partition is the repo’s **workflow orchestration layer**: reusable, declarative workflows built with `defineWorkflow(...).input(...).run(...).compile()` and executed as multi-step task graphs.

Core semantics from `define-workflow.ts`:
- Builder is **immutable/chained**; every call returns a new builder.
- `compile()` freezes the definition and brands it as a workflow.
- `worktreeFromInputs(...)` lets a workflow bind git worktree settings from inputs.
- Input/output schemas use TypeBox and are part of the runtime contract.

The built-in workflows show three recurring orchestration patterns:

- **`deep-research-codebase`**: scout → history lookup → partitioning → parallel specialist waves → synthesis/manifest/report.
- **`goal`**: bounded worker turns → parallel reviewer quorum → deterministic reducer → final status/ledger.
- **`ralph`**: plan → orchestrate → simplify → parallel review loop → PR handoff.
- **`open-claude-design`**: onboarding/import → generate preview → user feedback loop → critique/audit → forced fix → export/handoff.

# 2. Key flows and invariants

## Deep research
- Computes a partition cap from repo size, then fans out work by partition.
- Writes per-run artifacts under `research/.deep-research-<runId>/`.
- Uses `ctx.parallel()` for specialist waves and `ctx.chain()` for dependent synthesis steps.
- Invariant: partitions are normalized and capped; if parsing fails, it falls back to `["core codebase architecture"]`.
- Invariant: final report is written to a public research doc path plus a hidden manifest/artifact tree.

## Goal
- Creates a persistent goal ledger and treats it as authoritative state.
- Each turn:
  1. worker produces a receipt,
  2. three reviewers run in parallel,
  3. structured JSON verdicts are parsed,
  4. reducer decides `complete | blocked | needs_human | active`.
- Invariant: reviewer quorum is required; worker “ready for review” is never enough by itself.
- Error handling is explicit: reviewer failure or invalid JSON becomes a non-approval path, not a silent success.

## Ralph
- Bounded iterative loop with planner/orchestrator/simplifier/review split.
- Supports git worktree integration through `worktreeFromInputs`.
- Has PR-prep behavior at the end, so orchestration is coupled to git/gh state.
- Invariant: review loop gates handoff; approval depends on structured reviewer outputs.

## Open Claude Design
- Generates a real HTML preview on disk, then iterates with user feedback and formal critique/audit.
- Uses browser-use opportunistically, but degrades to manual file paths if unavailable.
- Invariant: preview is the artifact; later steps must rewrite it in place, not patch it partially.
- Export step requires embedding/linking the approved preview into a rich HTML spec.

# 3. Tests / validation

From the evidence here, validation is mostly **workflow-level and contract-level**, not low-level unit coverage:
- `define-workflow.ts` encodes compile-time/runtime invariants via builder typing and freezing.
- Builtins hard-code output schemas and structured-output contracts, so malformed model output is treated as failure.
- Workflows validate by:
  - parsing structured JSON,
  - checking approval predicates,
  - persisting artifacts/ledgers,
  - using parallel reviewer consensus.

What remains unknown:
- Exact test files for these workflows weren’t inspected here.
- It’s unclear whether CI exercises all builtin workflows end-to-end or only some subset.

# 4. Risks, unknowns, and verification steps

## Migration risks for Rust
- **This layer is the hardest TS→Rust boundary** because the semantics are not just “business logic”; they include:
  - dynamic task composition,
  - TypeBox-driven schema contracts,
  - file-based artifact conventions,
  - parallelism and reducer behavior,
  - git worktree and PR handoff integration,
  - browser-use/manual fallback behavior.
- A Rust rewrite must decide whether to:
  1. reimplement these workflows natively,
  2. keep workflow authoring in TS and call into Rust,
  3. define a new DSL/runtime with compatibility shims.

## Unknowns
- The exact public workflow API surface beyond `defineWorkflow` and the builtins wasn’t fully traced.
- The depth of dependency on `ctx.task / ctx.parallel / ctx.chain` implementation details is still not fully known.
- Which parts are meant as reusable patterns vs. product-specific examples is partly inferred from comments.

## Verify next
1. Inspect `packages/workflows/src/runs/*` to confirm execution semantics.
2. Inspect `packages/workflows/src/shared/types.ts` for the full orchestration ABI.
3. Inspect tests for:
   - reducer correctness,
   - review quorum behavior,
   - artifact persistence,
   - worktree binding,
   - browser fallback handling.
4. For Rust migration, decide whether workflows remain authorable in TS or become a Rust-native DSL first.