export const WORKER_PREFLIGHT_CONTRACT = [
  "Before normal implementation delegation, determine whether this checkout appears initialized for its actual language, framework, and build system.",
  "Do not rely on hard-coded assumptions about JavaScript, TypeScript, Python, Rust, Go, Java, mobile, or any other ecosystem. Infer the project type and setup requirements from repository evidence.",
  "Inspect source layout, setup docs, package/build manifests, lockfiles, toolchain files, generated-artifact conventions, CI workflows, workflow configuration, and package scripts or equivalent task definitions.",
  "Look for evidence that dependencies, generated files, local toolchains, submodules, codegen outputs, or other project-specific initialization artifacts are missing for this checkout.",
  "When repository evidence shows missing initialization, run or delegate the appropriate documented setup command before implementation work.",
  "You are responsible for initializing the checkout when setup commands are documented; missing dependencies, generated files, or local toolchains are setup work, not user handoff work.",
  "Once setup succeeds, continue normal implementation orchestration. Do not treat missing dependencies or generated setup artifacts in a fresh worktree as implementation failures.",
  "If setup requirements cannot be determined confidently, delegate a focused discovery task before implementation instead of guessing.",
  "If setup remains blocked after evidence-based discovery and setup attempts, report the blocker with commands tried and the exact evidence needed to continue.",
].join("\n");

export const E2E_VERIFICATION_GUIDANCE = [
  "Verify correctness end-to-end whenever practical for user-visible behavior; do not rely only on code inspection, unit tests, or stage summaries when an executable user scenario can prove the outcome.",
  "For web or frontend flows — including frontend changes whose correctness depends on backend/API behavior — use the playwright-cli skill, or delegate to a subagent with `skill: \"playwright-cli\"`, to drive the application like a user and capture snapshot, screenshot, DOM, or network evidence when that proves the objective.",
  "For TUI or terminal-app flows, use the tmux skill, or delegate to a subagent with `skill: \"tmux\"`, to launch the app in an isolated tmux session, send keys, capture pane output, and simulate the scenario end to end.",
  "Assume credentials, auth, and environment access for playwright-cli/tmux E2E testing exist until a concrete attempt proves otherwise; never skip E2E based only on an assumed missing prerequisite.",
  "Before declaring E2E impractical, do cheap non-destructive checks first (existing sessions, config files, env vars, CLI auth status), then actually attempt to launch the app or flow.",
  "If end-to-end verification is not practical in this checkout, record the exact command(s) attempted, observed failure output, smallest missing prerequisite, and narrower validation run instead; an unattempted assumption is never valid grounds to skip.",
].join("\n");

export function renderE2eQaVideoReviewGuidance(
  knownVideoPath?: string,
): string {
  const target = knownVideoPath === undefined || knownVideoPath.length === 0
    ? "Look for QA E2E video references in the goal ledger, worker receipt, implementation notes, orchestrator report, or other review context artifacts."
    : `Known QA E2E video path for this run: ${knownVideoPath}`;
  return [
    target,
    "When a QA E2E video exists or is claimed as evidence, inspect the actual video before approving; do not treat a path, filename, transcript summary, or stage claim as proof by itself.",
    "Use available video/file tooling such as `fetch_content` on the local video path with a prompt focused on whether the recording proves the required user scenario, or inspect representative frames/metadata when full video analysis is unavailable.",
    "Check that the video reflects the current repository/application state, exercises the objective-relevant user path, shows the expected final behavior, and does not visibly hide errors, stale UI, broken loading states, or skipped steps.",
    "For UI-applicable or full-stack changes, treat a missing, stale, unreadable, or inconclusive QA video as missing E2E evidence unless the receipt or implementation notes justify why no video applies and provide adequate alternate end-to-end proof.",
    "Treat skipped E2E due to assumed-missing credentials, auth, or environment access as missing evidence unless the worker actually checked credential/auth state, attempted the launch/flow, and reported exact commands plus observed failure output.",
  ].join("\n");
}


export const LITERAL_OBJECTIVE_CONTRACT = [
  "Literal objective contract:",
  "- The objective and acceptance criteria are the sole and LITERAL source of truth for required behavior.",
  "- Acceptance criteria are the immutable task contract; the run objective is a delta that must not contradict them.",
  "- If the objective and acceptance criteria conflict, do not implement the contradiction. Surface it as a blocker or reviewer finding instead.",
  "- When external knowledge (language specs, upstream issues, in-repo comments, general best practice, or prior reviewer speculation) conflicts with explicit objective wording, the objective/acceptance criteria win.",
  "- Never silently resolve such a conflict in favor of external knowledge. Surface the conflict clearly.",
  "- Prefer loud errors over silent reinterpretation: when the objective/acceptance criteria enumerate required error conditions, messages, or rejections, give each enumerated error the widest plausible trigger surface. When the contract leaves an input ambiguous or unspecified near an enumerated error case, prefer raising that error over silently reinterpreting the input as different valid behavior, even when external spec knowledge says the input is valid.",
  "- Only narrow an enumerated error's trigger surface when the objective, acceptance criteria, or pre-existing required tests explicitly require the ambiguous input to be accepted. Widening an enumerated error to nearby ambiguous inputs is applying the contract, not adding beyond it.",
  "- Do not add behaviors, restrictions, error conditions, or follow-up requirements beyond what the objective/acceptance criteria require.",
  "- The loud-error preference applies ONLY to error conditions the objective/acceptance criteria enumerate. For anything the contract does not enumerate, the default is the opposite: accept permissively and never invent a new validation error, required field, uniqueness constraint, or rejection the contract does not name.",
  "- When the contract names a concrete type, shape, or format ('returns a dict', 'a list of strings', a JSON object with named keys), produce exactly that — no defensive substitutes such as read-only proxies, frozen collections, tuples-for-lists, or wrapper subclasses unless the contract requires them. Consumers may check type identity literally.",
  "- Where behavior is unspecified, prefer the choice that preserves input verbatim over one that normalizes, deduplicates, reorders, or rewrites it; transform only what the contract says to transform.",
].join("\n");

export const REVIEWER_SPEC_VS_OBJECTIVE_GUARD =
  "Do not use external spec/standard conformance alone to flag a wide trigger surface for an error condition the objective/acceptance criteria enumerate; the contract prefers loud errors over silent reinterpretation of ambiguous inputs, so classify such spec-vs-objective tension as beyond_objective rather than a blocking defect.";

export const REVIEWER_OVERIMPLEMENTATION_GUARD =
  "Hunt over-implementation as seriously as gaps: any validation error, required field, uniqueness/format constraint, immutability wrapper, or normalization the contract does not require is a defect that rejects inputs or produces shapes the contract permits — classify it required_by_objective. Probe at least one contract-permitted input the worker's own tests do not exercise before approving.";

export const ACCEPTANCE_MATRIX_CONTRACT = [
  "Acceptance/contract matrix:",
  "- Before implementing, derive an observable acceptance matrix from the literal objective and acceptance criteria: one row per explicit clause, requirement, named artifact, command, gate, invariant, and deliverable, each mapped to the concrete observable check (command, test, executable scenario, artifact inspection, or state assertion) that would prove it in the current checkout.",
  "- Record the matrix in the receipt/implementation notes on the first turn and keep it current as work proceeds; every later completion claim must map back to matrix rows with current evidence.",
  "- The matrix inherits the literal contract's scope: do not add rows for behavior the objective/acceptance criteria do not require, and do not drop rows because they are inconvenient to prove.",
  "- Add one row per literal example in the objective/acceptance criteria (sample inputs/outputs, rendered text, file contents), checked character-for-character rather than paraphrased.",
  "- Add explicit rows for each interface decision the contract constrains: return/field types by identity, required-vs-optional per field, duplicate handling, ordering, and raw-vs-normalized text. When the contract leaves such a decision open, record the permissive/preserving default chosen.",
  "",
  "Stateful behavior modeling:",
  "- When the work involves stateful behavior (lifecycles, sessions, caches, persisted data, protocols, retries, concurrency, or multi-step flows), model the state space explicitly before implementing: enumerate the states, the legal transitions between them, the invariants that must hold in every state, and how illegal transitions or unexpected inputs are handled.",
  "- Tie matrix rows for stateful clauses to specific states, transitions, and invariants so their checks exercise transitions and invariant preservation, not just happy-path end states.",
].join("\n");

export const CONTRACT_FIDELITY_AUDIT = [
  "Adversarial divergence pass:",
  "- After checks are green and before claiming readiness for review, re-read the literal objective/acceptance criteria and ask for each clause: what plausible independent check of this clause would my implementation fail?",
  "- Probe the recurring divergence categories specifically: (1) type-identity assertions on returned values, (2) inputs with optional fields omitted, (3) duplicated or aliased inputs, (4) ordering assumptions, (5) text expected verbatim where the implementation normalizes it, and (6) any raised error the contract does not enumerate.",
  "- Fix each divergence or record its justification in the receipt/implementation notes; an unexamined divergence category is unfinished verification, not a nice-to-have.",
].join("\n");

export const REVIEWER_INTERCOM_COORDINATION_PROTOCOL = [
  "Concurrent reviewer coordination protocol:",
  "- At review start, use Intercom to initialize/check coordination and discover sibling reviewers participating in the same workflow run.",
  "- Tell those sibling reviewers your validation plan and intended check ownership before running checks. Claim ownership before starting any expensive, lock-prone, or potentially conflicting command that uses a shared checkout or shared environment.",
  "- Coordinate and serialize conflicting shared-checkout or shared-environment commands, including full test suites, build or test commands, package-manager operations, browser or E2E sessions, migrations, and generated-artifact steps. Announce each coordinated check when it starts and finishes. Release every claimed resource when finished, then send siblings an explicit resource-release update. Share reusable command outcomes and evidence so siblings can avoid redundant execution where appropriate.",
  "- Operational coordination does not make the review collective: independently inspect the patch, perform your own analysis, and produce your own verdict. Never copy or defer to a sibling reviewer's conclusions.",
].join("\n");

export const REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT = [
  "Independent verification derivation:",
  "- Before relying on the worker receipt, worker-authored tests, or any prior reviewer output, derive your own adversarial check list from the literal objective and acceptance criteria alone: per-clause observable checks plus boundary, edge, negative, and invalid-input probes; contract-permitted-input probes; exact type/shape/text-identity probes; and state/transition/invariant probes.",
  "- Apply this conditional contract-probe playbook when supported by the contract and repository:",
  "  - Exact public API/type contracts: create a minimal external-consumer compile or typecheck probe using the names, parameter types, return types, field types, pointer/value identity, and method shapes stated by the objective.",
  "  - Build tags/features/configuration variants: exercise every named positive and negative build-tag, feature, or configuration variant; prove required symbols compile and forbidden symbols are unavailable.",
  "  - Schemas and generated artifacts: regenerate or inspect the authoritative schema, probe omitted and zero-value fields, and verify required-versus-optional behavior and downstream representation match the literal contract.",
  "  - Stateful behavior: enumerate relevant states and mutation paths and exercise the transition matrix, not only happy-path end states; for boolean membership or predicate behavior this includes false→false, false→true, true→false, and true→true when applicable.",
  "  - Configurable paths and precedence: use temporary or injected paths, changed working directories, and relevant environment or configuration overrides; verify initialization and defaults do not overwrite caller-controlled state.",
  "  - Low-level APIs versus feature flags: exercise direct loaders, parsers, or validators with the surrounding feature both enabled and disabled unless the literal low-level API contract explicitly makes that flag authoritative.",
  "  - Permissive inputs and over-implementation: probe at least one contract-permitted omitted, empty, zero, duplicate, aliased, or unusual value that an implementation may have made unnecessarily invalid.",
  "- Select only the risk classes supported by the literal objective and repository context. These are generic risk classes, not hidden test cases; do not manufacture requirements outside the literal contract.",
  "- Execute or delegate every applicable material probe against the current repository state before mapping worker evidence to requirements. Name each command or scenario and its observed result in the existing narrative and requirements_traceability fields.",
  "- Worker-authored tests, snapshots, and receipts corroborate your derived checks; they never substitute for them. Passing worker-authored tests is circular evidence for the clauses those tests were written from. Repository-local or worker-authored tests are not sufficient evidence for an exact API, build, or schema clause without the applicable independent compile, type, build-variant, or schema probe.",
  "- A compile, type, build, or schema requirement without its applicable independent probe remains unverified: keep its requirements_traceability status missing, explain the gap, add an objective-aligned finding when the patch is materially deficient, and set stop_review_loop=false.",
  "- When an applicable material probe is missing, blocked, or failed, record the command or scenario and its observed result or limitation in overall_explanation and requirements_traceability, use the workflow's existing remaining-verification or finding fields, and set stop_review_loop=false. When tools or dependencies prevent necessary verification after reasonable recovery, populate the existing reviewer_error field instead of approving around the limitation.",
  "",
  "Pre-verdict self-audit:",
  "- Before returning stop_review_loop=true, confirm overall_correctness is patch is correct; every objective-relevant implementation and validation requirements_traceability entry is proven; no blocking objective-aligned finding remains; every applicable exact API, build, schema, state, configuration, and feature-flag risk has direct evidence or a clear explanation of why it does not apply; and reviewer_error is null or omitted.",
  "- If any item in this self-audit is false or unverified, set stop_review_loop=false and report the gap through the existing fields; never make the structured verdict internally inconsistent.",
].join("\n");

export const REGRESSION_EVIDENCE_CONTRACT = [
  "Durable regression evidence:",
  "- When a defect or reviewer finding has been reproduced (observed through a command, test, or executable scenario), its fix is complete only with durable regression evidence: a focused test or repeatable check persisted in the repository's test suite where project norms allow, otherwise an exact re-runnable command with its observed output recorded in the receipt/notes.",
  "- Treat a reproduced finding whose fix lacks durable regression evidence as unresolved; a one-off manual re-check is not durable evidence.",
  "- Match the regression check to the reproduction: it must demonstrably cover the failing scenario (fail before the fix or provably exercise it) and pass after the fix.",
].join("\n");

export const FINDINGS_CONSOLIDATION_CONTRACT = [
  "Consolidated findings batch:",
  "- Treat the latest review round as one consolidated batch of findings, not a queue to repair one item per turn.",
  "- Read every blocking finding first, group findings that share a root cause, plan the batch, then repair the full batch in this turn together with the validation and durable regression evidence each fix needs.",
  "- Only defer a finding out of the batch when it is genuinely blocked or it contradicts the literal contract; record the reason in the receipt.",
].join("\n");

export const EVIDENCE_CLOSURE_POLICY = [
  "Convergence flag (stop_review_loop):",
  "- The reviewer's stop_review_loop boolean is the single authoritative convergence signal. The harness gates approval on that flag deterministically and does not recompute approval from findings arrays, priorities, or requirements_traceability statuses — derive the flag carefully because it is trusted as-is.",
  "- Derive stop_review_loop=false while any objective-relevant blocking work remains: any P0/P1/P2 finding, any required_by_objective finding at any priority (P3 included — severity labels alone never dismiss objective-relevant findings), or any unproven implementation/validation requirement.",
  "- Derive stop_review_loop=true when independent verification proves the implementation and validation requirements and everything left is non-blocking: consistent_with_objective P3 nice-to-haves, beyond_objective/contradicts_objective observations, an explicitly authorized post-approval final action such as PR/MR/review creation, or the multi-reviewer quorum process itself. Never hold the flag at false for those items — quorum is counted by the harness across reviewers and is not an implementation gap any single reviewer can prove.",
  "- The loop is bounded: when the turn budget ends before convergence, the run stops with the unresolved findings and remaining work recorded for a human instead of relabeling them away.",
].join("\n");

export const WORKTREE_DISCIPLINE_CONTRACT = [
  "Worktree discipline:",
  "- Do all work in the working directory this stage was invoked in (the workflow-designated checkout/worktree).",
  "- Never create additional git worktrees, clones, or repository copies unless the user's task explicitly requests them; a merge conflict, a locked file, a dirty tree, or a failed command is not such a request.",
  "- If you discover required work stranded in another worktree, clone, or copy, bring it into the invoking checkout (apply, cherry-pick, or replay the changes) before continuing; work left outside the invoking checkout does not exist for review or delivery.",
].join("\n");

export const REVIEW_CODE_DELTA_CONTRACT = [
  "Code delta presence and integrity:",
  "- Review the actual code delta, and first prove that delta exists where the workflow delivers it: in the invoking working directory, or in the explicitly configured git worktree when the run was set up with one.",
  "- Use the repository's version-control tooling to inspect state (for git: `git worktree list`, `git status --short`, and a diff against the baseline branch; use the equivalent commands for other systems). If receipts, implementation notes, or stage summaries claim implemented work but the review checkout shows no corresponding delta, that is a blocking [P0] required_by_objective finding: the work may be stranded in another worktree, clone, or unapplied state. Do not approve; require the work to be brought into the review checkout first.",
  "- Never set stop_review_loop=true for an implementation objective when the review checkout's delta is empty or unrelated to that objective; an empty delta cannot satisfy an implementation objective regardless of what receipts claim.",
  "- Unless the objective explicitly forbids committing, treat uncommitted work at claimed readiness as remaining work: require the worker to commit (or intentionally discard) outstanding changes so the delivered state is durable.",
  "- Treat any modification, rename, or deletion of pre-existing test files or test functions in the delta as a finding requiring explicit justification against the literal contract; validating against existing tests means running them, not editing them.",
].join("\n");
