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
].join("\n");

export const REVIEWER_SPEC_VS_OBJECTIVE_GUARD =
  "Do not use external spec/standard conformance alone to flag a wide trigger surface for an error condition the objective/acceptance criteria enumerate; the contract prefers loud errors over silent reinterpretation of ambiguous inputs, so classify such spec-vs-objective tension as beyond_objective rather than a blocking defect.";

export const ACCEPTANCE_MATRIX_CONTRACT = [
  "Acceptance/contract matrix:",
  "- Before implementing, derive an observable acceptance matrix from the literal objective and acceptance criteria: one row per explicit clause, requirement, named artifact, command, gate, invariant, and deliverable, each mapped to the concrete observable check (command, test, executable scenario, artifact inspection, or state assertion) that would prove it in the current checkout.",
  "- Record the matrix in the receipt/implementation notes on the first turn and keep it current as work proceeds; every later completion claim must map back to matrix rows with current evidence.",
  "- The matrix inherits the literal contract's scope: do not add rows for behavior the objective/acceptance criteria do not require, and do not drop rows because they are inconvenient to prove.",
  "",
  "Stateful behavior modeling:",
  "- When the work involves stateful behavior (lifecycles, sessions, caches, persisted data, protocols, retries, concurrency, or multi-step flows), model the state space explicitly before implementing: enumerate the states, the legal transitions between them, the invariants that must hold in every state, and how illegal transitions or unexpected inputs are handled.",
  "- Tie matrix rows for stateful clauses to specific states, transitions, and invariants so their checks exercise transitions and invariant preservation, not just happy-path end states.",
].join("\n");

export const REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT = [
  "Independent verification derivation:",
  "- Before relying on the worker receipt, worker-authored tests, or any prior reviewer output, derive your own adversarial check list from the literal objective and acceptance criteria alone: per-clause observable checks plus boundary, edge, negative, and invalid-input probes, and state/transition/invariant probes for stateful behavior.",
  "- Execute or delegate the highest-value derived checks against the current repository state before mapping worker evidence to requirements.",
  "- Worker-authored tests, snapshots, and receipts corroborate your derived checks; they never substitute for them. Passing worker-authored tests is circular evidence for the clauses those tests were written from.",
  "- Keep derived checks inside the literal contract's scope; do not manufacture requirements beyond the objective/acceptance criteria.",
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
  "Evidence closure:",
  "- Approval is evidence closure, not reviewer agreement alone: the loop completes only when the review gate approves and no objective-relevant blocking finding from any reviewer remains unresolved.",
  "- Severity/priority labels alone never dismiss an objective-relevant finding: a finding classified required_by_objective stays blocking at any priority (P3 included) until evidence shows it is fixed or it is reclassified against the literal contract.",
  "- The loop is bounded: when the turn budget ends before closure, the run stops with the unresolved findings and remaining work recorded for a human instead of relabeling them away.",
].join("\n");
