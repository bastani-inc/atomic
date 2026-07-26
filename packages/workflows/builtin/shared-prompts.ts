export const WORKER_PREFLIGHT_CONTRACT = [
  "Before implementation delegation, infer the checkout's language, framework, build system, and setup requirements from repository evidence rather than ecosystem assumptions.",
  "Inspect source layout, setup docs, manifests, lockfiles, toolchain and codegen files, CI/workflow configuration, scripts, and generated-artifact conventions for missing dependencies, generated files, toolchains, submodules, or other initialization artifacts.",
  "When setup is missing, run or delegate the documented setup before implementation; missing initialization is setup work, not a user handoff or implementation failure.",
  "If requirements are unclear, delegate focused discovery rather than guessing. If evidence-based discovery and setup attempts remain blocked, report the commands tried and exact evidence needed to continue.",
].join("\n");

export const E2E_VERIFICATION_GUIDANCE = [
  "Verify correctness end-to-end whenever practical for user-visible behavior; an executable scenario is stronger proof than code inspection, unit tests, or stage summaries alone.",
  "For web or frontend flows, including frontend changes whose correctness depends on backend/API behavior, use the playwright-cli skill or delegate with `skill: \"playwright-cli\"`; capture snapshot, screenshot, DOM, or network evidence suited to the objective.",
  "For TUI/terminal flows, use the tmux skill or delegate with `skill: \"tmux\"` to exercise the scenario and capture pane output.",
  "Assume credentials, auth, and environment access for playwright-cli/tmux E2E exist until a concrete attempt proves otherwise. Before calling E2E impractical, check existing sessions, config, env vars, and CLI auth, then attempt the launch or flow.",
  "If E2E remains impractical, record the commands attempted, observed failure output, smallest missing prerequisite, and narrower validation run; an unattempted assumption is never valid grounds to skip.",
].join("\n");

export function renderE2eQaVideoReviewGuidance(
  knownVideoPath?: string,
): string {
  const target = knownVideoPath === undefined || knownVideoPath.length === 0
    ? "Look for QA E2E video references in the goal ledger, implementation receipt, implementation notes, orchestrator report, or other review context artifacts."
    : `Known QA E2E video path for this run: ${knownVideoPath}`;
  return [
    target,
    "Inspect the actual video before approving any claimed QA E2E evidence; a path, filename, transcript summary, or stage claim is not proof.",
    "Use available video/file tooling such as `fetch_content` on the local video path with an objective-focused prompt, or inspect representative frames and metadata when full analysis is unavailable.",
    "Confirm the video reflects the current repository/application state, exercises the objective-relevant user path through its expected result, and does not hide errors, stale UI, broken loading states, or skipped steps.",
    "For UI-applicable or full-stack changes, missing, stale, unreadable, or inconclusive video is missing E2E evidence unless the receipt or notes explain why video does not apply and provide adequate alternate end-to-end proof.",
    "Treat E2E skipped for assumed-missing credentials, auth, or environment access as missing evidence unless the implementation agent checked that state, attempted the launch or flow, and reported exact commands plus observed failure output.",
  ].join("\n");
}

export const LITERAL_OBJECTIVE_CONTRACT = [
  "Literal objective contract:",
  "- The objective and acceptance criteria are the sole literal source of required behavior; acceptance criteria are immutable and the run objective must not contradict them.",
  "- Surface objective/criteria conflicts as blockers or findings. When explicit wording conflicts with specs, upstream issues, comments, best practice, or reviewer speculation, the objective/criteria control; do not silently favor external knowledge.",
  "- For an enumerated error, message, or rejection, prefer the widest plausible trigger over silently reinterpreting ambiguous nearby input. Narrow it only when the contract or pre-existing required tests explicitly require acceptance.",
  "- That loud-error preference applies only to enumerated errors. Otherwise accept permissively: do not invent behavior, restrictions, validation errors, required fields, uniqueness/format constraints, or follow-up requirements.",
  "- Produce named types, shapes, and formats exactly; do not substitute proxies, frozen collections, tuples-for-lists, or wrappers unless required because consumers may check identity.",
  "- Where behavior is unspecified, preserve input verbatim rather than normalizing, deduplicating, reordering, or rewriting it.",
].join("\n");

export const REVIEWER_SPEC_VS_OBJECTIVE_GUARD =
  "External spec/standard conformance alone does not make a wide trigger for an enumerated error defective; classify that spec-vs-objective tension as beyond_objective, not blocking.";

export const REVIEWER_OVERIMPLEMENTATION_GUARD =
  "Treat unrequired validation errors, required fields, uniqueness/format constraints, immutability wrappers, and normalization as required_by_objective defects when they reject permitted inputs or change permitted shapes. Probe at least one contract-permitted input absent from implementation-authored tests.";

export const ACCEPTANCE_MATRIX_CONTRACT = [
  "Acceptance matrix:",
  "- Derive one row per explicit objective/criteria clause, requirement, named artifact, command, gate, invariant, deliverable, and literal example; map each to a current-checkout command, test, scenario, artifact inspection, or state assertion. Check literal examples character-for-character.",
  "- Record it in the first receipt/implementation notes, keep it current, map completion claims to current evidence, and neither add out-of-contract rows nor omit inconvenient ones.",
  "- Include constrained interface decisions: exact return/field identity, required versus optional fields, duplicate handling, ordering, and raw versus normalized text; when open, record the permissive/preserving choice.",
  "- For stateful work, enumerate states, legal transitions, cross-state invariants, and handling of illegal transitions/unexpected inputs; tie relevant rows to transition and invariant checks, not only happy-path end states.",
].join("\n");

export const CONTRACT_FIDELITY_AUDIT = [
  "Contract-fidelity risk classes:",
  "- Select only classes supported by the literal contract and repository: exact public API/type identity; positive and negative build tags/features/configuration variants; schemas/generated artifacts and omitted/zero-value fields; states/transitions/invariants; configurable paths, working directories, precedence, and caller-controlled state; low-level APIs across feature flags; permitted omitted, empty, zero, duplicate, aliased, ordered, unusual, or verbatim-text inputs; and unenumerated errors.",
  "- Before claiming readiness, probe each applicable class against the current checkout. Fix divergence or record its evidence-based justification in the receipt/notes; do not manufacture requirements outside the literal contract.",
].join("\n");

export const REVIEWER_INTERCOM_COORDINATION_PROTOCOL = [
  "Concurrent reviewer coordination:",
  "- At review start, use Intercom to discover sibling reviewers and share validation plans and check ownership.",
  "- Claim, serialize, announce, and release expensive or conflicting shared-checkout/environment work such as suites, builds, package operations, browser/E2E sessions, migrations, and generated-artifact steps; share reusable command evidence.",
  "- Coordination is operational only: inspect independently and return your own verdict rather than copying or deferring to sibling conclusions.",
].join("\n");

export const REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT = [
  "Independent verification:",
  "- Before reading receipts, implementation-authored tests, or prior reviews, derive per-clause observable checks from the literal objective/criteria, including supported boundary, edge, negative, invalid, permitted-input, exact type/shape/text, and state-transition probes.",
  CONTRACT_FIDELITY_AUDIT,
  "- Execute or delegate every applicable material probe before mapping implementation evidence. Report each command or scenario and observed result in the narrative and requirements_traceability fields.",
  "- Implementation-authored tests, snapshots, and receipts corroborate but never replace independently derived checks; exact API, build, or schema clauses require the applicable independent compile, type, build-variant, or schema probe.",
  "- A missing applicable compile/type/build/schema probe remains missing in requirements_traceability; explain it, add an objective-aligned finding when materially deficient, and set stop_review_loop=false.",
  "- For any missing, blocked, or failed material probe, record its command/scenario and observed result or limitation in overall_explanation and requirements_traceability, use the remaining-verification or finding fields, and set stop_review_loop=false. If tools or dependencies still prevent necessary verification after reasonable recovery, populate reviewer_error.",
  "- Before stop_review_loop=true, require overall_correctness to be patch is correct, every objective-relevant implementation and validation requirements_traceability entry proven, no blocking objective-aligned finding, direct evidence or a clear not-applicable justification for each applicable risk, and reviewer_error null or omitted. Otherwise set stop_review_loop=false and report the gap consistently.",
].join("\n");

export const REGRESSION_EVIDENCE_CONTRACT = [
  "Durable regression evidence:",
  "- A reproduced defect is fixed only when a focused test or repeatable check covers the failing scenario and passes after the fix (and fails before it or demonstrably exercises it). Persist it in the test suite where norms allow; otherwise record an exact rerunnable command and observed output in the receipt/notes.",
  "- Keep a reproduced finding unresolved when its fix has only a one-off manual check.",
].join("\n");

export const FINDINGS_CONSOLIDATION_CONTRACT = [
  "Treat the latest review round as one consolidated batch: read all blocking findings, group shared root causes, and repair the full batch with validation and durable regression evidence in this turn.",
  "Defer only a genuinely blocked or contract-contradicting finding, recording the reason in the receipt.",
].join("\n");

export const EVIDENCE_CLOSURE_POLICY = [
  "Convergence flag (stop_review_loop):",
  "- stop_review_loop is the single authoritative convergence signal; the harness trusts it without recomputing approval from findings, priorities, or requirements_traceability.",
  "- Derive stop_review_loop=false while any objective-relevant blocking work remains: a P0/P1/P2 finding, a required_by_objective finding at any priority including P3, or an unproven implementation/validation requirement.",
  "- Derive stop_review_loop=true when independent verification proves implementation and validation and only non-blocking items remain: consistent_with_objective P3 items, beyond_objective/contradicts_objective observations, an authorized post-approval PR/MR/review action, or reviewer quorum. Never hold it false for those items.",
  "- If the bounded loop ends first, preserve unresolved findings and remaining work for a human rather than relabeling them.",
].join("\n");

export const WORKTREE_DISCIPLINE_CONTRACT = [
  "Work in the workflow-designated checkout. Do not create another worktree, clone, or repository copy unless the task requests it; conflicts, locks, dirty state, and failed commands do not authorize one.",
  "Bring required work found elsewhere into this checkout by applying, cherry-picking, or replaying it before continuing.",
].join("\n");

export const REVIEW_CODE_DELTA_CONTRACT = [
  "Code delta integrity:",
  "- Inspect the delivered checkout with version-control tooling (for git: `git worktree list`, `git status --short`, baseline diff, staged diff, and untracked files) and prove an objective-related delta exists before trusting receipts.",
  "- If summaries claim implementation but the checkout lacks it, return a blocking [P0] required_by_objective finding and require the work to be brought here. Never set stop_review_loop=true for an empty or unrelated implementation delta.",
  "- Unless the objective forbids committing, uncommitted claimed-ready work remains work: require a commit or intentional discard so delivery is durable.",
  "- Treat modification, rename, or deletion of pre-existing tests or test functions as a finding requiring literal-contract justification; validating existing tests means running, not editing, them.",
].join("\n");
