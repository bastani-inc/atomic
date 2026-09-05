// Builtin prompts use the same public `keepContext` helper workflow authors do, so the
// protection semantics cannot drift between builtin and user-authored workflows.
import { keepContext } from "../src/authoring/keep-context.js";

export { keepContext };

/**
 * Steering propagation is a whole-repository pattern, not a per-workflow
 * option: every builtin stage prompt carries STEERING_PROPAGATION_CONTRACT
 * through `withSteeringPropagation`, and `test/unit/builtin-workflow-steering-propagation.test.ts`
 * fails when a stage prompt omits it.
 *
 * A run's contract can change mid-flight, but only the user may change it. A
 * steered amendment that stays inside one stage's session is invisible to every
 * later stage, so the implementer builds to the amended contract while reviewers
 * still score the launch contract and mark the added work as unrequested scope.
 * Each stage therefore restates the amendments it received in its own handoff.
 */
export const PENDING_STAGE_DELIVERY_GUIDANCE_LINES = [
	"Send material updates through Intercom to every affected workflow stage, including stages that have not started.",
	"Atomic queues messages for known pending stages addressed as `workflow:<rootRunId>/<segment>[/<segment>...]`; each segment may be a stage name, run id, or glob (`*` matches one segment and `**` any depth), and pattern sends remain sticky for every future matching stage until the root run terminates.",
	"When shared scope or acceptance criteria change, broadcast one authoritative update to `workflow:<rootRunId>/**` (or a narrower path pattern) rather than enumerating stages; use `intercom list` inside the invocation group to see live, pending, and possible future targets, and use `ask` only on live targets.",
	"A valid target outside the known stage set queues with a `notInKnownSet` warning and settles undeliverable at terminal only if it never delivered.",
] as const;

export const PENDING_STAGE_DELIVERY_GUIDANCE = PENDING_STAGE_DELIVERY_GUIDANCE_LINES.join("\n");

export const STEERING_PROPAGATION_CONTRACT = [
  "Steering propagation contract:",
  "- Mid-run user messages (steering, follow-ups, resume text) are authoritative and may amend this run's objective or acceptance criteria. Adopt an amendment as required behavior from the moment you receive it.",
  '- Explicit task-scoped requests to work "inline", "do this directly", or "don\'t use a workflow" override workflow-first defaults even for complex work. Do not create or launch a hidden/nested replacement workflow or pressure the user to reapprove the choice. Quoted examples and questions about inline code are not execution-mode instructions.',
  '- On a switch from an active workflow to inline, notify the controlling session to safely hold/stop the affected workflow, reconcile completed work and in-flight side effects, then continue inline without duplicate execution. Do not claim completed work was undone. Preserve appropriate tests, review, evidence, safety and authorization constraints; the preference applies only to the specified task.',
  "- An amendment that stays in your session is lost. Restate every objective-relevant steering message in your final report or handoff artifact, verbatim when short, under an explicit `Contract amendments received` heading.",
  "- Keep user-authored amendments visibly separate from your own observations, so later stages can tell a required clause from an agent proposal.",
  "- Treat amendments inherited from an upstream stage as contract clauses. Cover them in acceptance and traceability work; never classify inherited user amendments as beyond_objective, unrequested scope, or speculative expansion.",
  "- If an amendment is ambiguous, or conflicts with the launch contract or another amendment, resolve it before implementing: ask through `intercom` when a supervisor or originating stage is reachable, otherwise state the conflict in your report and implement the narrowest reading consistent with the launch contract.",
  ...PENDING_STAGE_DELIVERY_GUIDANCE_LINES.map((line) => `- ${line}`),
  "- Propagate nothing else this way. Guidance about how to work, tool preferences, and your own improvement ideas are not amendments; those follow the scope discipline contract.",
].join("\n");

/**
 * Add the steering propagation contract to a stage prompt. Builtin runners wrap
 * every `ctx.task` / `ctx.parallel` / `ctx.chain` prompt with this so the pattern
 * cannot be forgotten when a stage is added.
 *
 * Stage prompts in this package deliberately end with their `<instruction>`
 * section, which carries the strongest positional weight. The contract is
 * inserted immediately before that closing section rather than after it, so a
 * stage's final words remain its instruction.
 *
 * The contract is `keepContext`-protected because only the user may amend a run's contract,
 * and an amendment reaches later stages solely through this restatement duty. Compacted away,
 * the run silently reverts to the launch contract while the implementer builds to the amended
 * one — the exact split this pattern exists to prevent.
 */
export function withSteeringPropagation(prompt: string): string {
  if (prompt.includes("<steering_propagation>")) return prompt;
  const tagged = `<steering_propagation>\n${keepContext(STEERING_PROPAGATION_CONTRACT)}\n</steering_propagation>`;
  const instructionAt = prompt.lastIndexOf("\n\n<instruction>");
  if (instructionAt === -1) return `${prompt}\n\n${tagged}`;
  return `${prompt.slice(0, instructionAt)}\n\n${tagged}${prompt.slice(instructionAt)}`;
}

export const REVIEWER_CALIBRATION_RULES = [
  "Trust observed output over the agent's narration.",
  'Agent declarations of success ("done", "all tests pass") are ZERO evidence on their own.',
].join("\n");

export const WORKER_PREFLIGHT_CONTRACT = [
  "Before implementation delegation, infer the checkout's language, framework, build system, and setup requirements from repository evidence rather than ecosystem assumptions.",
  "Inspect source layout, setup docs, manifests, lockfiles, toolchain and codegen files, CI/workflow configuration, scripts, and generated-artifact conventions for missing dependencies, generated files, toolchains, submodules, or other initialization artifacts.",
  "When setup is missing, run or delegate the documented setup before implementation; missing initialization is setup work, not a user handoff or implementation failure.",
  "If requirements are unclear, delegate focused discovery rather than guessing. If evidence-based discovery and setup attempts remain blocked, report the commands tried and exact evidence needed to continue.",
].join("\n");

export const E2E_VERIFICATION_GUIDANCE = [
  "Verify correctness end-to-end whenever practical for user-visible behavior; an executable scenario is stronger proof than code inspection, unit tests, or stage summaries alone.",
  "For web or frontend flows, including frontend changes whose correctness depends on backend/API behavior, use the playwright-cli skill or delegate with `skill: \"playwright-cli\"`; capture snapshot, screenshot, DOM, or network evidence suited to the objective.",
  "For TUI/terminal flows, use the tmux skill or delegate with `skill: \"tmux\"`; select tmux on supported hosts, native Windows psmux when available, or herdr's pane API when appropriate. Check installed help: psmux uses tmux-style commands, while herdr has its own CLI, not interchangeable flags. Exercise the actual interactive flow and retain pane/text or terminal recording evidence.",
  "For desktop and accessible simulator/emulator windows, use suitable PyAutoGUI or native platform tooling for a real visible app scenario and screenshots/video. Consult https://github.com/openai/openai-cua-sample-app#first-run and its Python README for setup and interruption guidance; the sample is optional and needs model/API access. Use a dedicated desktop/session, controlled fixtures and required screen-recording/accessibility permissions, inspect screenshots for other windows, and release held keys/buttons on interruption. Do not automate an arbitrary physical iPhone without an accessible simulator/emulator/mirroring or native automation setup, or label browser recordings as terminal/iOS proof.",
  "Choose tools from observed environment capabilities. Prefer installed/cached tools; install missing tools, runtimes or plugins when online access and permissions permit. Known offline/restricted installation is sufficient evidence not to attempt prohibited downloads; otherwise check capabilities or make one bounded setup attempt. Do not loop on blocked downloads, require production credentials, or take unsafe actions.",
  "When execution or installation is unavailable, continue available authoritative repository checks and retain useful local evidence. Report the constraint or attempted command with observed output, what could not run, and the narrower validation performed. For non-UI tasks, use relevant executable checks rather than manufacturing a UI scenario. An unavailable optional mechanism is not itself failed implementation or permission to relax required project checks.",
].join("\n");

/**
 * Code-quality verification is the lint/format/metrics/smells counterpart to
 * E2E_VERIFICATION_GUIDANCE, and is included at the same call sites so goal and
 * ralph stages — implementation, orchestrator, and reviewer alike — receive it.
 */
export const CODE_QUALITY_VERIFICATION_GUIDANCE = [
  "For code-quality verification — linting, auto-formatting, complexity and duplication metrics, and code smells — use the qlty skill or delegate with `skill: \"qlty\"`; it drives one CLI across the repository's languages instead of ad-hoc per-tool linter invocations.",
  "Use judgment guided by user priorities and repository evidence to select reliable, low-noise checks and useful metrics, not every plugin or metric. If .qlty/qlty.toml is absent during authorized coding, initialize it with qlty init or hand-author it from bundled skill references when init cannot run; inspect generated configuration. Missing config alone is not a blocker. Preserve existing config and authoritative repo tools, including Biome where used; avoid wholesale format churn. Read-only tasks stay read-only or use isolated scratch configuration.",
  "Prefer installed/cached qlty tools and plugins; install when online permissions permit. Offline, restricted-install or missing-binary environments may still prepare repo-appropriate TOML from bundled references when configuration changes are in scope. Do not invent plugin versions or flags; validate TOML and schema with available tools and distinguish configuration prepared from lint/security/metrics actually executed. Installed built-in metrics/smells may work offline; uncached plugins may need downloads. Record command/output and a relevant baseline, continue available repository checks, and do not make optional qlty installation a universal completion blocker.",
  "Repository-defined checks in AGENTS.md/CLAUDE.md, package scripts, and CI stay authoritative; qlty supplements them rather than replacing them, and its findings count as evidence only with the command and observed output recorded.",
].join("\n");

export const MEDIA_PUBLICATION_GUIDANCE = [
  "Detect the repository provider and authorized PR/MR/issue/comment target before publishing media. Inspect and redact screenshots/video for secrets, personal information and unrelated windows; tie evidence to the verified commit and scenario. Local evidence collection does not authorize uploads.",
  "On GitHub, check gh --version and the chosen command's --help. GitHub CLI >=2.99.0 supports repeatable --attach on gh issue create/edit/comment and gh pr create/edit/comment. Use native attachments when supported, for example gh pr comment <number> --repo <owner/repo> --body-file <body.md> --attach <proof.mp4>. Attach each file once. Body-local path references are rewritten to hosted URLs; otherwise attachments append in flag order. Image path#alt text is supported; video alt text is not. A standalone ![](<local-video-path>) paragraph becomes an embedded player.",
  "Check current GitHub limits: PNG/JPEG/GIF/WebP/SVG images and MP4/MOV/WebM videos; images/GIFs up to 10 MB, video 10 MB on Free or 100 MB paid. Native attachment upload requires repository write access and supported OAuth/classic PAT auth; GitHub Enterprise Server is unsupported in this release. See https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli.",
  "Read back the returned PR/issue/comment and confirm usable GitHub-hosted links before claiming attachment success. Unsupported CLI versions, hosts, providers, auth or sizes require a truthful fallback: retain the local artifact and explain authorized manual attachment or supported provider options. Never claim file:// links are uploaded evidence, expose secrets, or upload automatically to unrelated third-party hosts.",
].join("\n");

/**
 * Repositories carry behavioral norms written docs never state — commit
 * signing, message style, changelog discipline, review etiquette — and they
 * are inferable from history. Included at the same goal/ralph call sites as
 * the E2E and code-quality guidance so implementers match inferred
 * conventions and reviewers check delivered work against them.
 */
export const REPO_INTENT_MINING_GUIDANCE = [
  "Infer maintainer and requesting-user intent from repository behavior, not only written docs: mine git history (`git log`, `git log --show-signature`), merged PRs, issues and their comments, review comments, commit subjects and trailers, and CI/branch-protection config for unwritten conventions.",
  "Read for commit-signing habits, commit-message style and issue linking, changelog discipline, PR size and stacking norms, review etiquette, formatting and lint norms, and branch naming. Prefer the dominant, recent, intentional pattern over accidental drift; when signals conflict, the requesting user's own commits, PRs, and comments weigh highest — different users of one repository keep different preferences.",
  "Match inferred conventions in delivered work (for example, sign commits when the surrounding history is signed rather than skipping signing because no doc required it); in review, report deviations as convention findings backed by the mined evidence.",
  "Behavioral evidence fills gaps where the contract is silent; it never overrides the literal objective, acceptance criteria, or explicit AGENTS.md/CLAUDE.md guidance, and it does not license new contract requirements.",
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
    "Known offline/restricted or unsafe environments justify a recorded limitation without prohibited setup attempts. Otherwise require a reasonable capability check or bounded launch attempt and observed output. Assess adequate alternate proof against the objective; do not demand production credentials or reject implementation solely because an optional recording tool is unavailable.",
  ].join("\n");
}

/**
 * `keepContext`-protected: this is the run's immutable contract and its central prohibition
 * ("You may never widen the contract yourself"). A prohibition deleted from context reads as
 * permission, so losing it turns scope creep into apparently sanctioned work.
 */
export const LITERAL_OBJECTIVE_CONTRACT = keepContext([
  "Literal objective contract:",
  "- The objective and acceptance criteria are the sole literal source of required behavior; the run objective must not contradict them.",
  "- Only the user may change the contract. A mid-run user message — steering, a follow-up, or resume text — is authoritative: adopt it as required behavior from that point on, and carry it forward under the steering propagation contract. You may never widen the contract yourself; an improvement you thought of is deferred work, not a new criterion.",
  "- Surface objective/criteria conflicts as blockers or findings. When explicit wording conflicts with specs, upstream issues, comments, best practice, or reviewer speculation, the objective/criteria control; do not silently favor external knowledge.",
  "- For an enumerated error, message, or rejection, prefer the widest plausible trigger over silently reinterpreting ambiguous nearby input. Narrow it only when the contract or pre-existing required tests explicitly require acceptance.",
  "- That loud-error preference applies only to enumerated errors. Otherwise accept permissively: do not invent behavior, restrictions, validation errors, required fields, uniqueness/format constraints, or follow-up requirements.",
  "- Produce named types, shapes, and formats exactly; do not substitute proxies, frozen collections, tuples-for-lists, or wrappers unless required because consumers may check identity.",
  "- Where behavior is unspecified, preserve input verbatim rather than normalizing, deduplicating, reordering, or rewriting it.",
].join("\n"));

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
  "Concurrent reviewer coordination (constructive quorum):",
  "- At review start, use Intercom to discover sibling reviewers and share validation plans and check ownership.",
  "- Claim, serialize, announce, and release expensive or conflicting shared-checkout/environment work such as suites, builds, package operations, browser/E2E sessions, migrations, and generated-artifact steps; share reusable command evidence.",
  "- First, inspect independently and form a preliminary assessment before reading or relying on sibling findings or verdicts. After the exchange, inspect independently and return your own verdict rather than copying or deferring to sibling conclusions.",
  "- Then run exactly one bounded evidence-exchange round over Intercom: share your preliminary verdict, concise findings, and evidence; challenge blocking findings, surface defects a sibling missed, and correct objective/acceptance-criteria misreadings. Do not start a second round or continue substantive discussion.",
  "- Verdicts change only through concrete evidence, never through deference to a sibling's approval or rejection; inspect shared evidence yourself before deciding.",
  "- In `overall_explanation`, record whether deliberation changed your preliminary verdict and, if it did, which concrete evidence caused the change. If it did not, say so; return your own structured decision even when dissent remains.",
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

/**
 * `keepContext`-protected: every clause here is a prohibition, and prohibitions are the class
 * compaction erodes first — they are terse, stated once, and low-density next to the objective
 * they bound. Losing this reads as license to keep going.
 */
export const SCOPE_DISCIPLINE_CONTRACT = keepContext([
  "Scope discipline:",
  "- Before writing code, state the goal in one sentence and list the acceptance criteria. That list is the contract. Freeze it.",
  "- Done means the contract, not \"good.\" When all criteria pass, stop. Polish, refactors, and \"while I'm here\" fixes are new work, not this work.",
  "- Every addition must trace to a criterion. If you cannot point at the criterion a change serves, do not make it. Log it instead.",
  "- Keep a deferred list, not a growing diff. When you notice a bug, smell, or missing feature outside the contract, write one line in a deferred note and move on. Surface it at the end.",
  "- Distinguish blockers from improvements. Change scope only if a criterion is impossible or wrong as written — and say so explicitly before proceeding; never silently absorb the work.",
  "- Watch for the tells. \"It would be cleaner if...\", \"we should also...\", \"this really ought to...\" mean you are about to move the goalpost. Stop and check the contract.",
  "- Prefer the smallest diff that satisfies the contract: fewer files touched, fewer abstractions introduced, no speculative generality for futures nobody asked for.",
  "- Report three things at the end: what the contract was, evidence each criterion passes, and the deferred list. Scope changes belong in the report, never in the diff.",
].join("\n"));

export const EVIDENCE_CLOSURE_POLICY = [
  "Convergence flag (stop_review_loop):",
  "- stop_review_loop is the single authoritative convergence signal; the harness trusts it without recomputing approval from findings, priorities, or requirements_traceability.",
  "- Derive stop_review_loop=false while any objective-relevant blocking work remains: a P0/P1/P2 finding, a required_by_objective finding at any priority including P3, or an unproven implementation/validation requirement.",
  "- Derive stop_review_loop=true when independent verification proves implementation and validation and only non-blocking items remain: consistent_with_objective P3 items, beyond_objective/contradicts_objective observations, an authorized post-approval PR/MR/review action, or reviewer quorum. Never hold it false for those items.",
  "- If the bounded loop ends first, preserve unresolved findings and remaining work for a human rather than relabeling them.",
].join("\n");

/**
 * `keepContext`-protected: this binds the stage to a specific checkout, and a checkout is
 * exactly the kind of identifier a stage must not lose. Compacted away during a long run, an
 * agent hitting a lock or dirty state invents a second worktree and the delivered delta lands
 * somewhere the reviewers never look. It is two lines, so protection costs almost nothing.
 */
export const WORKTREE_DISCIPLINE_CONTRACT = keepContext([
  "Work in the workflow-designated checkout. Do not create another worktree, clone, or repository copy unless the task requests it; conflicts, locks, dirty state, and failed commands do not authorize one.",
  "Bring required work found elsewhere into this checkout by applying, cherry-picking, or replaying it before continuing.",
].join("\n"));

export const REVIEW_CODE_DELTA_CONTRACT = [
  "Code delta integrity:",
  "- Inspect the delivered checkout with version-control tooling (for git: `git worktree list`, `git status --short`, baseline diff, staged diff, and untracked files) and prove an objective-related delta exists before trusting receipts.",
  "- If summaries claim implementation but the checkout lacks it, return a blocking [P0] required_by_objective finding and require the work to be brought here. Never set stop_review_loop=true for an empty or unrelated implementation delta.",
  "- Unless the objective forbids committing, uncommitted claimed-ready work remains work: require a commit or intentional discard so delivery is durable.",
  "- Treat modification, rename, or deletion of pre-existing tests or test functions as a finding requiring literal-contract justification; validating existing tests means running, not editing, them.",
].join("\n");
