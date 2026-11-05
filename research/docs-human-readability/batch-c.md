# Batch C editorial evidence

Parent attribution: GPT-6-Astra.

**Authoritative amendment applied.** The initial-pass record below is historical. The amendment review, relocation map, and final validation at the end supersede its literal-retention policy and relocation deferrals.

## Scope and method

Independently enumerated every `.md` and `.mdx` below `packages/coding-agent/docs` whose POSIX relative path compares lexically greater than or equal to `subagents.md`. Result: **21 pages, all Markdown; 19 revised and 2 reviewed unchanged**. Nested paths are included. No runtime, changelog, commit, push, PR, or worktree operations were performed.

Fully read `AGENTS.md`, `packages/workflows/skills/unslop/SKILL.md`, `DESIGN.md`, and `PRODUCT.md` through `read`. Setup context came from the fully read terminal, tmux, Termux, Windows, and workflow setup/authoring pages below. Applied plain wording, shorter sentences, and topic-based paragraphs or lists. Existing heading spelling and anchors take precedence over unslop's heading-style advice.

Every page below was read in full through `read`, including examples, tables, warnings, and trailing sections. Large pages were read in consecutive ranges with the tool's surrounding context; no truncated remainder was omitted. Two oversized operations reads were refused and replaced with smaller consecutive ranges.

## Complete page ledger

Paths are relative to `packages/coding-agent/docs`. Line counts refer to the original checkout before this batch's edits. “Full” confirms actual full-page reading, not sampling.

| Page | Full read | Disposition and concrete reason | Preservation decisions |
| --- | --- | --- | --- |
| `subagents.md` | Full, 290 lines | Revised delegation introduction, catalog navigation, observation modes, and parallel limits into shorter prose and lists. | Kept local-versus-delegated work caveats, background/foreground distinctions, permission and child-lifetime boundaries, model policies, examples, and all default limits. |
| `subagents/authoring.md` | Full, 39 lines | Revised the dense agent-body checklist into actionable bullets. | Kept frontmatter example, discovery paths, auto-model and constraints guidance. |
| `subagents/reference.md` | Full, 118 lines | Revisited routing deadline/result paragraph, effort explanation, and host-binding sequence. | Kept routing failure/privacy caveats, compatibility fields, fallback behavior, exact binding APIs, and the warning that binding does not create an owner. |
| `terminal-setup.md` | Full, 180 lines | Revised iTerm2 scrolling explanation and Ghostty's nested Claude Code/tmux exception. | All terminal configuration fences unchanged; retained global-workaround warning, version requirements, macOS-only fallback, SSH limitation, and modified-key behavior. |
| `termux.md` | Full, 138 lines | Split libc/install warning from native-addon limitation. | Preserved npm installation and nested AGENTS example verbatim, Android target warning, clipboard/storage limits, and separately installed Bun caveat. |
| `themes.md` | Full, 220 lines | Shortened hot-reload instruction and removed redundant bold label. | Theme JSON, token redirects, compatibility paths, automatic selection, and all example destinations unchanged. |
| `themes/reference.md` | Full, 176 lines | Split `workingIndicator` rules into a main bullet and numeric/hot-reload sub-bullets. | Retained six-tone derivation, explicit indices, ANSI approximation caveat, token tables, counts, and fences. |
| `tmux.md` | Full, 70 lines | Reviewed unchanged: short setup steps, explicit version requirements, and side-by-side key sequences already scan well. | Kept restart commands verbatim, CSI-u recommendation, xterm fallback, and Herdr tool-selection link. |
| `tools.md` | Full, 579 lines; ranges 1–300 and 304–579, with returned context covering 301–303 | Revised persisted-output introduction and age/cleanup policy into separate location, scheduling, and safety paragraphs. | Kept all line-anchored patch syntax/errors/warnings and examples verbatim, byte caps, permissions, cleanup exclusions, retention timing, and exact path/config literals. |
| `tui.md` | Full, 804 lines; ranges 1–400 and 404–804, with returned context covering 401–403 | Reorganized the very long Working-indicator and compaction paragraphs by lifecycle, animation, overrides, and failure behavior. | Kept every component example verbatim, 453 verbs, ten frames, 88ms, width bounds, color/reduced-motion settings, custom-frame fidelity, and compaction event ownership. |
| `tui/reference.md` | Full, 343 lines | Clarified asynchronous input fallthrough, shortened invalidation instruction, and separated host-native picker mechanics from availability. | Kept interfaces/examples, focus behavior, IME/width requirements, host isolation distinction, semantic events, and headless refusal. |
| `usage.md` | Full, 217 lines | Split startup replay into ordered behavior bullets and separated cooperative cancellation, stuck-engine recovery, and draft restoration. | Kept synchronous-startup exceptions, command ordering, exact draft/queue retention, shell differences, sharing warnings, and CLI examples. |
| `web-access.md` | Full, 52 lines | Split batch-error interpretation from retry instructions. | Kept plural-field migration, scalar normalization caveat, video-only options, frame requirements, and missing-content limitation. |
| `windows.md` | Full, 70 lines | Split installer locations/options and turn PATH/launcher/pin constraints into a checklist. | All PowerShell/JSON fences unchanged; retained checksum, Unicode, PATH, PATHEXT, unexpected-entry, release-pin, and package-manager constraints. |
| `workflows.md` | Full, 67 lines | Shortened authoring progression and removed “battle-tested” marketing wording. | Retained generated/handwritten runtime equivalence, router ownership, authorization, budgets, and composition links. |
| `workflows/api-reference.md` | Full, 1524 lines; consecutive reads 1–300, 304–650, 654–1000, 1004–1300, 1304–1524, including returned context between ranges | Revisited route fields, retry/fallback policy, transcript retention, and `reads` contract. Lists distinguish conditions previously embedded in long paragraphs. | Every signature/example unchanged; preserved nested result locations, shared deadlines, immediate-versus-retry failures, transcript privacy and retention exemptions, deletion-first ordering, and missing-read failures. |
| `workflows/authoring.md` | Full, 696 lines; reads 1–350 and 354–696 with returned context | Revised dual-host guidance, source layout, and precise-schema rationale. | Preserved Node/Bun APIs, all runnable examples, dynamic DAG restrictions, exit/replay contracts, and child-output validation. |
| `workflows/builtins.md` | Full, 250 lines | Removed promotional introduction and made re-verification eligibility a checklist. | Kept all builtin contracts/model chains, threshold values, missing-confidence exclusion, retry count, and convergence authority. |
| `workflows/operations.md` | Full, 1097 lines; consecutive reads 1–230, 234–350, 354–470, 474–570, 574–750, 754–950, 954–1097, including returned context | Revisited routing/decision density and split embedded-Postgres setup into requirements, targets, discovery, versions, and lifetime. | Kept all command fences, reservation/ownership restrictions, non-retried failures, no forced launch, database versions/paths, and shared-server lifetime. Deferred technical contradictions and internal histories below. |
| `workflows/reliable-design.md` | Full, 2092 lines; consecutive reads 1–350, 354–700, 704–1100, 1104–1500, 1504–1850, 1854–2092, including returned context | Shortened contract/compaction explanation, removed repeated best-practices preamble, and replaced generic closing prose with an acceptance decision. | Kept every graph, code/template fence, requirement, score/threshold, scope boundary, and user-authorization rule. |
| `workflows/verification.md` | Full, 146 lines | Reviewed unchanged: scenario/check/evidence sections already give direct steps, concrete limitations, and short lists. | Retained environment distinctions, permission/secret checks, no simulated-coverage claims, GitHub media requirements, and verbatim commands. |

## Validation

- Scoped `git diff --check` passed for all 21 owned pages.
- Compared HEAD and edited versions for every owned page with a fence-aware Python check. All fenced blocks remained byte-identical, including nested fences.
- Compared ordered headings, Markdown link destinations, and explicit HTML anchor tags outside fences. All matched.
- Compared unique inline-code literals outside fences. No original literal was lost on any page. Repetition counts can change when prose is consolidated; spelling was not changed.
- Inspected the complete owned Git diff in three batches: subagents/setup/themes/web; tools/TUI/usage/Windows; workflows. No unrelated changes appeared in these hunks.
- Runtime tests and browser rendering were not run: this batch changes prose only and preserves examples and navigation syntax. Checks do not establish the technical correctness of pre-existing examples.

## Deferred issues and limits

These are observations for a separate technical/content-ownership pass, not changes made by this editorial batch:

- `workflows/operations.md` says DBOS/Postgres is the sole persistent backend and later describes process-local fallback. Distinguishing initial provisioning failure from failure after readiness matters; do not collapse these into one simplified guarantee without runtime verification.
- `workflows/api-reference.md` describes ordinary Intercom as mandatory in group policy while tool-selection guidance allows exclusions. Preserve both until the exact runtime contract is verified.
- `workflows/reliable-design.md` says protected text counts against the keep target, while a later paragraph says protecting all reference material raises that target. This needs a compaction-contract check, not an editorial guess.
- The initial pass deferred maintainer relocation. That deferral is **resolved by the amendment pass below**, including Windows incident history, lifecycle mechanics, test commands, and historical release restrictions. No historical release action was taken or authorized.
- `progress.md` was outside the explicit owned-file list. Sent the supervisor a progress update and asked the integrator to record it there rather than editing another owner's file.

## Authoritative audience amendment

> Note for the docs change: repository directive that this user-facing documentation stay concise and avoid internal implementation and debugging details. Move those mechanics to maintainer documentation and retain observable behavior and operator actions here

Re-read `AGENTS.md`, the unslop skill, this ledger, and all 21 current owned pages in full. Used bounded `cat`/`sed` reads; reread the omitted leading ranges when combined outputs exceeded the tool limit. Reviewed every section for audience, not just the paragraphs edited in the first pass. Kept public SDK/extension APIs and workflow-authoring recipes, including user-project verification instructions. Those are product usage, not Atomic's internal test infrastructure.

This amendment changed 12 pages beyond the initial edits and retained 9 after audience review. Added 8 topic-specific maintainer documents outside the published guide tree. Public text fell from 712,249 to 635,426 bytes at the first completed preservation check, about 77 KB removed through relocation and condensation; subsequent small cleanups further shortened it. No root progress, other-batch, runtime, or changelog edits were made.

### Final disposition of every page

Paths below are relative to `packages/coding-agent/docs`; all were fully reread for this amendment.

| Page | Audience disposition | What remains public / relocation |
| --- | --- | --- |
| `subagents.md` | Revised throughout lifecycle/control sections. | Retains delegation, catalog, model/group choices, burst constraints, task inspection, cancellation and handoff actions. Moves capability issuance, admission enforcement, receipt identities, cancellation recovery mechanics to `subagent-lifecycle.md`. |
| `subagents/authoring.md` | Retained after review. | Discovery paths, complete frontmatter/body example, scope and auto-model guidance are instructions for custom-agent authors. No internal history or test infrastructure to relocate. |
| `subagents/reference.md` | Revised classification/projection explanation. | Keeps effort/fallback constraints and host-binding APIs; moves native snapshot/journal recovery and classifier internals to `subagent-lifecycle.md`. |
| `terminal-setup.md` | Retained after review. | Terminal escape sequences, versions, local-macOS/SSH limits, wheel workaround and modifier mappings directly explain configuration and troubleshooting. |
| `termux.md` | Retained after review. | bionic versus musl explains why installers differ; Android native limitations, clipboard/storage remedies and nested AGENTS example remain actionable. |
| `themes.md` | Retained after review. | Theme selection, transparency, custom JSON, token redirects and hot reload are observable behavior and authoring instructions. |
| `themes/reference.md` | Retained after review. | Six tones, ANSI approximations, indices, fallbacks and tokens define the public theme format; removing them would hide how a custom theme renders. |
| `tmux.md` | Retained after review. | Version gates and CSI-u/xterm byte examples diagnose key forwarding; no Atomic implementation mechanics. |
| `tools.md` | Revised editing, writes, search, URL protection and output storage. | Keeps canonical syntax, active diagnostics, all examples, conflicts, adapter obligations, caps and retention actions. Moves parser constants/inactive messages, native backend choices, ACL cache/cleanup locks and trusted-test escape hatch to `tool-storage-and-editing.md`. |
| `tui.md` | Revised isolated input, indicator lifecycle and footer explanation. | Keeps every component/example, input-return requirements, frame customization, reduced motion, widget and footer ownership. Moves bridge/cache and animation/compaction mechanics to `tui-lifecycle.md`. |
| `tui/reference.md` | Revised logging and host integration prose. | Keeps component/focus signatures, width/invalidation examples, actionable ANSI capture and host picker/form APIs. Moves transport, dependency naming and builtin implementation rationale to `tui-lifecycle.md`. |
| `usage.md` | Revised startup/Working description. | Keeps immediate input, settings, commands, queues and interruption behavior; moves startup-label collision algorithm and animation timing/cleanup to `tui-lifecycle.md`. |
| `web-access.md` | Retained after review. | Argument migration, video flags, partial-error interpretation, retry and stored-content retrieval are operator guidance. |
| `windows.md` | Revised install cleanup, startup, watchers and self-update. | Keeps installer constraints, drafts/reload, shell behavior and public factories; moves transaction mechanics, launcher/build incident, watcher crash rationale and quarantine procedure to `windows-runtime.md`. |
| `workflows.md` | Retained after review. | Navigation, selection/authoring boundaries, router authorization and budgets explain use of workflows. No Atomic-only tests or internals to relocate. |
| `workflows/api-reference.md` | Revised heartbeat, fallback, child restriction, schema/artifact and store sections. | Keeps all 95 signature/example fences, observable delivery/replay limits and SDK contracts. Moves scheduler cleanup, capture history and graph projection mechanics to `workflow-lifecycle.md`. |
| `workflows/authoring.md` | Revised topology, repository example, adapter queue, exit and composition sections. | Keeps all public authoring examples and runtime obligations; moves topology implementation to `workflow-durability.md`, exit/admission arbitration to `workflow-lifecycle.md`, repository/fixture examples to `workflow-verification-and-design.md`. |
| `workflows/builtins.md` | Revised panel summary, prompt rationale, Goal ledger and live-design protocol. | Keeps builtin inputs, models, thresholds, approval authority, outputs and user review controls. Moves ledger split and helper events/adapters to `workflow-verification-and-design.md`. |
| `workflows/operations.md` | Revised across UI, pause/quit, notices, durability, recovery, DB packaging, reload and budget tails. | Keeps commands, uncertainty warnings, same-ID recovery, privacy and no-duplicate-effect boundaries. Moves lifecycle to `workflow-lifecycle.md`, checkpoint/database internals to `workflow-durability.md`, build/tests and live-release incident to `workflow-recovery.md`, UI timing to `tui-lifecycle.md`. |
| `workflows/reliable-design.md` | Revised compaction, schema gates, score caching/trends and research rationale. | Keeps every graph, complete custom-workflow example, scope/approval contract and supported rubric API. Moves cache scheduling, reducer math and uncited research measurements to `workflow-verification-and-design.md`; TUI reconstruction to `tui-lifecycle.md`. |
| `workflows/verification.md` | Retained after review. | This teaches users to author verification stages for their own projects, collect evidence safely, and upload only when authorized. It contains no Atomic-specific regression suite or incident history. Keeping its public examples is intentional. |

### Relocation map and example custody

Destinations are under `docs/maintainer/readability-c/`. Each destination states its source pages and sections. Mechanics were rewritten into cohesive maintenance notes; this is not an archive of whole user pages.

| Destination | Source sections / knowledge retained |
| --- | --- |
| `subagent-lifecycle.md` | Subagent observation, single-child handoff, foreground cancellation, group authority, delegation boundaries; reference fallback classifier and owner projection. |
| `tool-storage-and-editing.md` | Tools: block resolver, limits/constants, inactive parser messages, write queue/exclusive create, native matching, URL test escape hatch, temp path/ACL/cache/cleanup mechanics. |
| `tui-lifecycle.md` | TUI component isolation, terminal setters, native picker/form transport, footer caching; usage startup collision rules; stage UI routing and indicator lifecycle. |
| `windows-runtime.md` | Windows install retries, startup resource transactions, Bun Windows-host build constraints and 0.9.18-alpha.1 incident, watcher path assertions, addon quarantine. |
| `workflow-lifecycle.md` | API heartbeat anchors/watchdog/stale cards, output capture and graph invalidation; authoring exit/race/child cleanup and adapter admission; operations notice history/recovery, retained chat ownership and reload adoption. |
| `workflow-durability.md` | Operations bundled runtime lookup/root privilege cache/packaging validation, checkpoint scopes/topology, liveness, quit/failure arbitration, late callbacks, rendering/history and task-tail persistence; authoring cycle-check requirements. |
| `workflow-recovery.md` | Operations “Recovering an uncaught tool abort”: patched-checkout build/launch fence and integration-test fence **moved byte-for-byte**, plus fixture limitations and historical run/PR/version restrictions. No release actions performed. |
| `workflow-verification-and-design.md` | Builtin prompt/ledger organization and live helper protocol; reliable-design shared-prefix/warm scheduling, trend formula and research figures; authoring repository layout and complex-leaf fixture rationale. |

### Final preservation review

- Scoped `git diff --check` passed across all 21 pages, destinations and this ledger before the ledger update; rerun after the final update is recorded by the execution result.
- A fence-aware comparison against both the pre-amendment snapshot and `HEAD` passed: **318 public fenced blocks byte-identical; exactly 2 maintainer command fences relocated verbatim** to `workflow-recovery.md`. Nested fences handled by delimiter length. No new or modified public code fences.
- Ordered Markdown headings and explicit HTML anchors match `HEAD` for every page. Source section links therefore retain their targets; no redirect stub replaced an entire public page.
- Every newly linked repository maintainer destination exists. Relocation links use full repository URLs because these files are not shipped under the user-guide tree. Network availability was not tested.
- Reviewed edit results and compared changed source sections against the saved pre-amendment text. Preservation review caught and corrected temporary line-target mistakes in two signatures, a table row, headings and nearby guidance. The final fence/heading checks pass; no unresolved validation issue remains.
- Existing public examples remain unchanged even where they may need a separate correctness pass. Runtime tests, example execution, documentation rendering and external-link fetching were not run for this prose-only amendment.

### Deferred technical questions, not relocation work

- DBOS initial provisioning fallback versus post-readiness failures still deserves a runtime-backed clarification. Both existing limits remain; no new durability guarantee was invented.
- Group policy says workflow Intercom is mandatory while tool-selection policy allows exclusion. This conflict remains for contract verification.
- `keepContext` guidance describes both counting against and raising a keep target. The retention-contract contradiction remains unaltered rather than guessed.
- Research measurements moved to maintenance notes lack an identifiable source citation in the original text. Recover the citation before publishing performance claims.
- Windows ARM64 runtime coverage remains unverified; relocation preserves the explicit gap and does not claim hardware validation.
- No maintainer relocation is deferred. Long public API/authoring examples and operational restrictions remain deliberately public, not because literal retention overrode the amendment.

## Review-round correction

The earlier preservation review missed operator guidance in `workflows/operations.md:432`. The audience edit replaced post-mortem Escape and subsequent submission behavior with a duplicate host-invalidation paragraph. All three consolidated P2 findings identify this one defect. Restored conversation-only interruption, editor restoration, continued queue hold, and ordinary-submission release without resuming terminal workflow execution. These are user actions, not maintainer mechanics. See [the correction record](review-round-correction.md) for the red/green regression, runtime test, rendered checks and scope reconciliation. The original per-page ledger remains historical; its scope and disposition counts are unchanged.
