I’m unable to write `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-current-research-synthesis.md` directly because this session exposes only read/search/list/todo tools and no file write/edit tool.

Below is the complete content intended for that file:

```md
# Transitive Cost Current Research Synthesis

Date: 2026-07-10  
Scope: `/workspaces/atomic`  
Mode: read-only synthesis  
Breaking changes allowed: false

## Analysis of: `research/2026-07-10-read-the-file-at-specs-2026-07-10-transitive-cost-status-bar-md-and-implement-it.md`

### Document Context
- **Date**: 2026-07-10
- **Purpose**: Executive summary of the original transitive-cost research and implementation guidance.
- **Status**: Still relevant. It matches the current implementation shape and should remain the primary checklist for resolving review comments.

### Key Decisions
1. **Aggregator home**: `TransitiveUsageAggregator` belongs directly on `AgentSession`.
   - Rationale: `AgentSession` is already the object available to the footer, slash commands, SDK callers, extension contexts, and resume/import flows.
   - Impact: Current implementation correctly exposes `getTransitiveUsage()`, `attributeDescendantUsage()`, and `walkDescendantUsage()` on the `AgentSession` method surface.

2. **Single accounting chokepoint**: `attributeDescendantUsage(report)` must be the only descendant accounting write path.
   - Rationale: Keyed upsert by `childRunId` makes double-counting structurally hard.
   - Impact: Any review issue about subagents/workflows should be resolved by routing reports into this method, not by adding parallel aggregation logic.

3. **Status bar behavior**: Only the dollar amount goes transitive.
   - Rationale: Context percentage and token/cache badges are current-session concepts.
   - Impact: Current footer behavior should keep `↑`, `↓`, `R`, `W`, and context `%` self-only while replacing only `$` with `getTransitiveUsage().total.cost.total`.

4. **Reconciliation path**: `/cost` should trigger `walkDescendantUsage()`.
   - Rationale: Live push events can be missed; durable session files are the repair/source-of-truth path.
   - Impact: Validation should specifically exercise `/cost` or `walkDescendantUsage()` after subagent/workflow runs.

### Critical Constraints
- **No breaking changes**: New APIs/fields must be additive. Existing `Usage` shape, session JSONL entries, extension event semantics, and `getSessionStats()` self-only behavior should not be changed.
- **Completeness must be visible**: If descendant accounting is partial, render `~$...` and report `complete: false`; never show an exact-looking undercount.
- **Internal workflow stage sessions count**: `includeInternal: true` is required when walking session history, because workflow-stage sessions are intentionally hidden from normal resume/session lists.

### Technical Specifications
- Event channel: `usage:descendant-rollup`.
- Core report shape:
  - `rootSessionId`
  - `childRunId`
  - `kind: "subagent" | "workflow-stage" | "workflow-run"`
  - `usage`
  - `settled`
  - optional label/session file metadata is implementation-specific but useful for `/cost`.
- Footer:
  - `cost = getTransitiveUsage().total.cost.total`
  - prefix `~` when `complete === false`
  - token badges/context remain self-only.
- `/context`:
  - current-session context-window stats
  - transitive cost summary line.
- `/cost`:
  - reconcile first
  - show self/descendants/total/completeness/breakdown.

### Actionable Insights
- Do not “fix” review comments by making footer tokens transitive; that conflicts with the resolved RFC.
- If a review asks for accuracy after restart/resume, point to `walkDescendantUsage()` and ensure it runs on load/resume/import and `/cost`.
- If a review asks for double-count safety, preserve keyed upsert semantics and avoid additive accumulation by event count.

### Still Open/Unclear
- The research allowed implementation-specific metadata (`label`, `sessionFile`, `sessionFiles`) but did not fully specify alias behavior when a partial durable walk overlaps a multi-session live rollup. Current code has such alias logic; see review-risk section below.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Still applicable and largely implemented. Use it as the source of truth over older exploratory artifacts.

---

## Analysis of: `specs/2026-07-10-transitive-cost-status-bar.md`

### Document Context
- **Date**: 2026-07-10
- **Purpose**: Formal RFC/spec for issue #1636.
- **Status**: Current source of truth. The implementation should comply without breaking public consumers.

### Key Decisions
1. **Selected architecture**: Push rollup + keyed chokepoint + on-demand walk reconcile.
   - Rationale: Live updates without hot-path file I/O; durable reconciliation for missed/crashed reports.
   - Impact: Footer must not walk files during render.

2. **Cost-only transitive display**.
   - Rationale: Transitive context is meaningless; token/cache badges have current-session semantics.
   - Impact: Current footer tests should assert no descendant tokens in badges.

3. **New user surface**: `/cost` plus `/context` summary.
   - Rationale: Footer stays compact; detailed breakdown is available on demand.
   - Impact: Docs must list both commands.

4. **Lower-bound marker**: dim `~` prefix for incomplete totals.
   - Rationale: Users must not mistake incomplete totals for exact totals.
   - Impact: Tests should include incomplete nonzero and incomplete zero-cost totals.

5. **Workflow stage accounting split**:
   - `recordStageUsage()` stores usage on snapshot.
   - `emitStageRollup()` emits rollup.
   - Rationale: Each door has a single responsibility.
   - Impact: Current `WorkflowUsageRollupPort.recordStageUsage()` is a no-op; this may attract review scrutiny because the name promises persistence but the port implementation does nothing. The actual store mutation happens elsewhere, so consider either removing the no-op port method or documenting that store-level `recordStageUsage()` is the real persistence door.

6. **Async subagents report transitive usage**.
   - Rationale: Direct `SingleResult.usage` misses nested/sub-subagent spend.
   - Impact: Async result files need top-level `transitiveUsage`; result watcher can forward it by spreading parsed data.

### Critical Constraints
- **Behavior change is intentional but not breaking**: Status-bar `$` becoming larger is the fix; it should be documented in changelog.
- **Existing self-only stats remain**: `getSessionStats()` should not silently become transitive unless explicitly designed.
- **No external ledger/backend**: All totals derive from local session files and existing usage data.

### Technical Specifications
- `TransitiveUsage` includes:
  - `self`
  - `descendants`
  - `total`
  - `complete`
- Current implementation additionally includes `breakdown`, which is additive and useful for `/cost`.
- `StageSnapshot.usage?`, durable checkpoints, and stage-end persistence fields must be optional/additive.
- Async result files should carry optional `transitiveUsage`.

### Actionable Insights
- Reviewers should accept optional fields as compatibility-safe.
- Any changelog wording should explicitly say:
  - footer `$` now reflects full transitive session spend
  - token badges/context remain self-only
  - `~` marks lower bounds
  - `/cost` reconciles descendant files.

### Still Open/Unclear
- The spec says the event-bus subscriber should be a single funnel. Current implementation subscribes once per `AgentSession` to the shared bus and filters by `rootSessionId` inside `attributeDescendantUsage()`. That satisfies the funnel principle, but malformed event payloads are currently cast rather than validated.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- This is the strongest source of truth for review resolution.

---

## Analysis of: `research/docs/2026-07-10-transitive-cost-coding-agent-analysis.md`

### Document Context
- **Date**: 2026-07-10
- **Purpose**: Codebase-specific map for where to attach transitive cost in `packages/coding-agent`.
- **Status**: Mostly implemented; still useful for validation and review triage.

### Key Decisions
1. **Use `AgentSession` facade/method-module pattern**.
   - Current code matches this:
     - `agent-session-transitive-usage.ts`
     - method-surface additions in `agent-session-methods.ts`
     - exports in `agent-session.ts` / `index.ts`.

2. **UI invalidation via session event**.
   - Current implementation added `descendant_usage_changed`.
   - Interactive handler invalidates footer/usage meter and requests render, matching the research guidance.

3. **Walk must include internal sessions**.
   - Current implementation calls `SessionManager.list(..., { includeInternal: true })` and `SessionManager.listAll(..., { includeInternal: true })`, matching the workflow-stage requirement.

### Critical Constraints
- The footer’s existing cumulative token semantics come from `sessionManager.getEntries()`, while `getSessionStats()` uses active state messages. Keep this distinction; do not accidentally make `/session` transitive unless the product decision changes.
- `walkDescendantUsage()` should not run on every footer render. Current footer reads only `getTransitiveUsage()`, which is correct.

### Technical Specifications
- Current implementation source:
  - `packages/coding-agent/src/core/transitive-usage.ts`
  - `packages/coding-agent/src/core/agent-session-transitive-usage.ts`
  - `packages/coding-agent/src/modes/interactive/components/footer.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts`
- Existing tests cover:
  - keyed upsert
  - wrong-root rejection
  - self/descendant separation
  - incomplete lower-bound rendering
  - self-only context percent
  - basic subagent/session-tree discovery.

### Actionable Insights
- For validation, run at minimum:
  - `bun test test/unit/transitive-usage.test.ts`
  - `bun run typecheck`
  - `bun --cwd packages/coding-agent run docs:check`
  - `bun run check:file-length`
- If review requests focused validation beyond unit tests, add/verify a scenario with:
  - parent self usage
  - foreground subagent usage
  - nested subagent usage
  - workflow stage usage
  - `/cost` reconciliation after a durable session-file walk.

### Still Open/Unclear
- Current event-bus subscriber casts payloads to `DescendantUsageReport` without shape validation. Wrong-root reports are rejected, but malformed same-root reports could still reach aggregation. This was not explicitly required by the RFC, but a reviewer may flag it as hardening.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Still applicable and directly maps to current implementation.

---

## Analysis of: `research/docs/2026-07-10-transitive-cost-subagents-analysis.md`

### Document Context
- **Date**: 2026-07-10
- **Purpose**: Identify foreground/async subagent usage propagation points.
- **Status**: Implemented in broad strokes; still important for nested and async edge cases.

### Key Decisions
1. **Foreground integration point**: parent `tool_result` listener for `toolName === "subagent"`.
   - Current code now calls `reportSubagentUsage(pi, ctx, event.details as Details)`.
   - This is the right location because final foreground `Details.results[].usage` is available there.

2. **Async integration point**: async result file + `SUBAGENT_ASYNC_COMPLETE_EVENT`.
   - Current code writes top-level `transitiveUsage` in `subagent-runner-finalize.ts`.
   - Result watcher spreads parsed result file data, so the field flows through completion events.

3. **Do not sum both final `SingleResult.usage` and `modelAttempts[].usage`**.
   - Rationale: fallback attempts are already aggregated into final foreground `SingleResult.usage`.
   - Current helper `usageFromResults()` uses `SingleResult.usage` or session-tree data, which avoids this double-count trap for foreground.

### Critical Constraints
- Async status token totals are not cost totals. Do not use `AsyncStatus.totalTokens` for cost.
- Intercom and nested summaries historically omit cost-bearing usage; they are not reliable as the sole transitive-cost propagation path.

### Technical Specifications
- Current implementation source:
  - `packages/subagents/src/shared/usage-rollup.ts`
  - `packages/subagents/src/shared/types-results.ts`
  - `packages/subagents/src/shared/utils.ts`
  - `packages/subagents/src/extension/index.ts`
  - `packages/subagents/src/runs/background/subagent-runner-finalize.ts`
- `usage-rollup.ts` converts subagent scalar usage to Atomic/Pi `Usage` shape:
  - `input`, `output`, `cacheRead`, `cacheWrite`
  - `totalTokens`
  - `cost.total`
  - component cost fields default to zero.
- `usageFromSessionTree()` prefers session-file-derived usage over scalar fallback, which is important for nested subagents.

### Actionable Insights
- Reviewers may focus on async paused/interrupted runs:
  - Current `reportSubagentUsageForRoot()` always emits `settled: true` when `transitiveUsage` exists.
  - For a paused async result (`state: "paused"`), that may overstate completeness. A safer rule is `settled: payload.state !== "paused"` or equivalent, while failed/complete terminal results can remain settled.
- If a review asks whether nested subagent spend is counted, point to `usageFromSessionTree()` scanning the session-file-derived nested directory. If nested async results can live outside that tree, durable reconciliation may still be needed.
- For foreground parallel rollups, keep `sessionFiles` metadata because it helps reconcile live run-id reports with durable per-session reports.

### Still Open/Unclear
- The research did not define exact behavior when an incomplete durable walk partially overlaps a multi-session live rollup. Current alias logic can replace a multi-file live rollup when any session-file alias overlaps. That avoids double-counting but may drop known live spend for other children until a later complete reconcile. If reviewers complain about undercounting during partial reconciliation, this is the likely root.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Still applicable; use it to resolve subagent-specific review findings.

---

## Analysis of: `research/docs/2026-07-10-transitive-cost-workflows-analysis.md`

### Document Context
- **Date**: 2026-07-10
- **Purpose**: Identify workflow-stage usage storage, persistence, checkpointing, and event-rollup seams.
- **Status**: Mostly implemented.

### Key Decisions
1. **Stage usage lives on `StageSnapshot.usage?`**.
   - Current code added optional `usage?: Usage` to `StageSnapshot`.
   - This is additive and compatible.

2. **Usage must be copied through store end, persistence, and durable checkpointing**.
   - Current code copies usage in:
     - `store-stage-methods.ts`
     - `persistence-session-entries.ts`
     - `durable/types.ts`
     - `durable/stage-primitive.ts`.

3. **Usage extraction should happen before `onStageEnd`**.
   - Rationale: durable checkpoint wrapper runs from `onStageEnd`, so snapshot usage must be present first.
   - Current stage finalizer calls `recordStageUsage()` before `recordStageEnd()` and before `opts.onStageEnd`, which is correct.

4. **Workflow event bus should use a port pattern**.
   - Current `makeUsageRollupPort()` mirrors `makeMcpPort()` and emits `usage:descendant-rollup`.

### Critical Constraints
- Prompt nodes, replay contexts, and non-real/test adapters may not have a real `AgentSession`; usage should be optional/absent, not fabricated.
- Workflow stage sessions are internal and hidden from normal resume lists but must still count toward transitive cost.
- Replayed durable stages should only reuse previously stored usage; they must not create new usage.

### Technical Specifications
- Current implementation source:
  - `packages/workflows/src/runs/foreground/executor-stage-factory.ts`
  - `packages/workflows/src/shared/store-types.ts`
  - `packages/workflows/src/shared/store-stage-methods.ts`
  - `packages/workflows/src/shared/persistence-session-entries.ts`
  - `packages/workflows/src/durable/types.ts`
  - `packages/workflows/src/durable/stage-primitive.ts`
  - `packages/workflows/src/extension/workflow-ports.ts`
- Current extraction uses `innerCtx.__agentSession()?.getTransitiveUsage?.().total`, which is better than self-only `getSessionStats()` because it includes subagents launched inside a workflow stage.

### Actionable Insights
- `WorkflowUsageRollupPort.recordStageUsage()` is currently a no-op in `makeUsageRollupPort()`.
  - Store-level `recordStageUsage()` does real work, so correctness is not necessarily broken.
  - But the no-op port method conflicts with the RFC’s “honest door” language. If this is a review issue, prefer removing the no-op from the port or renaming/separating responsibilities so only the store method is called `recordStageUsage`.
- Verify that `emitStageRollup()` happens after `sessionId`/`sessionFile` capture; current finalizer captures metadata before finalization and passes metadata to the port.

### Still Open/Unclear
- Cached durable stage replay records usage into store, but it does not necessarily emit a live rollup. This may be acceptable because cached replay does not create new provider spend; `/cost` reconciliation can still see persisted usage if needed.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Still applicable and especially useful for workflow review findings.

---

## Analysis of: `research/docs/2026-07-10-transitive-cost-patterns-tests-docs.md`

### Document Context
- **Date**: 2026-07-10
- **Purpose**: Test, docs, changelog, slash-command, and event-pattern guidance.
- **Status**: Still relevant for closing validation/docs/changelog review comments.

### Key Decisions
1. **Tests should use existing Bun + strict assert style**.
   - Current `test/unit/transitive-usage.test.ts` follows this pattern.

2. **Slash commands belong in metadata and interactive dispatch**.
   - Current code includes `/context` and `/cost` in command metadata and dispatch.

3. **Docs/changelog conventions**:
   - Package changelogs use `[Unreleased]`.
   - Docs site changelog uses MDX `<Update>` blocks.
   - Docs pages should document source-visible behavior, not hidden implementation details.

### Critical Constraints
- Changelog should not call the footer increase a regression or breaking change.
- Documentation should preserve self-only `/session` wording unless `/session` behavior changes.
- Docs should not imply token badges/context percentage are transitive.

### Technical Specifications
Current docs/changelog state:
- `packages/coding-agent/docs/usage.md` documents:
  - transitive footer dollar amount
  - self-only token/cache badges and context percentage
  - `/context`
  - `/cost`
- `packages/coding-agent/docs/subagents.md` documents subagent transitive usage rollups.
- `packages/coding-agent/docs/workflows.md` documents workflow-stage usage and internal stage session counting.
- `packages/coding-agent/CHANGELOG.md` has an `[Unreleased]` entry for #1636.
- `packages/subagents/CHANGELOG.md` has an `[Unreleased]` entry for subagent rollups.
- `packages/workflows/CHANGELOG.md` has an `[Unreleased]` entry for workflow-stage rollups.

### Actionable Insights
- Likely missing docs/changelog item: `packages/coding-agent/docs/changelog.mdx` does not yet mention the July 10 transitive-cost change. If reviewer asked for “docs changelog,” add a new top `<Update label="July 10, 2026">` block that mirrors the package changelog in user-facing language.
- Keep docs wording precise:
  - “footer dollar amount is transitive”
  - “token/cache badges and context-window percentage remain current-session only”
  - “`~` means lower bound/incomplete”
  - “`/cost` reconciles descendant session files”
  - “`/session` remains self cost.”

### Still Open/Unclear
- No evidence from read-only inspection that validation commands were run in this session. Final handoff should explicitly list commands run or state “not run.”

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Still applicable; use it to close validation and docs/changelog requirements.

---

## Analysis of: `research/web/2026-07-10-transitive-cost-online-research.md`

### Document Context
- **Date**: 2026-07-10
- **Purpose**: Public docs/upstream compatibility research.
- **Status**: Relevant for compatibility and documentation review.

### Key Decisions
1. **Preserve Pi/Atomic compatibility**.
   - No removal or renaming of session JSONL fields, extension events, tool names, footer APIs, or package/extension patterns.
   - Additive event/fields are acceptable.

2. **Use assistant-message usage as source of truth**.
   - Public docs and source compute cost from assistant-message `usage` buckets.
   - Current implementation’s session-file walk aligns with this.

3. **Subagents/workflows are first-party Atomic extensions but must remain package/extension-shaped**.
   - Rationale: Upstream Pi does not include core subagents/workflows.
   - Impact: Usage rollups through extension event bus/ports are better than hard-coding package-specific dependencies into core hot paths.

### Critical Constraints
- Do not change JSONL field meanings.
- Do not break public extension event subscription semantics.
- Use additive docs/API changes only.

### Technical Specifications
- Public docs already describe:
  - footer/session usage
  - session format
  - extension events
  - TUI footer/status APIs
  - subagents
  - workflows.
- Docs update should be Atomic-specific and not imply upstream Pi core now owns subagents/workflows.

### Actionable Insights
- Any review request framed as “breaking_changes_allowed=false” should be answered with:
  - optional fields only
  - additive `AgentSession` methods/types
  - existing self-only stats retained
  - no JSONL schema migration
  - only intended behavior change is honest footer `$`.

### Still Open/Unclear
- No external docs source supersedes the local RFC/spec; use local 2026-07-10 spec as source of truth for implementation details.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Still applicable for docs/changelog/compatibility review.

---

# Current Implementation Findings That Matter for Review

## Implemented and aligned with the RFC

- `AgentSession` has transitive-cost methods and exports:
  - `getTransitiveUsage()`
  - `attributeDescendantUsage(report)`
  - `walkDescendantUsage(root?)`
- `TransitiveUsageAggregator` uses keyed `Map<childRunId, report>` upsert and rejects wrong-root reports.
- Footer cost reads `session.getTransitiveUsage().total.cost.total`.
- Footer renders `~` when `complete === false`.
- Footer tokens and context percentage remain self-only.
- `/context` shows context usage plus transitive cost summary.
- `/cost` calls `walkDescendantUsage()` and renders self/descendant/total/completeness/breakdown.
- Subagents now:
  - attach `transitiveUsage` to foreground details
  - write async result-file `transitiveUsage`
  - report foreground and async rollups over `usage:descendant-rollup`.
- Workflows now:
  - store `StageSnapshot.usage?`
  - copy usage through store end
  - persist usage in stage-end entries
  - include usage in durable checkpoints/hydration
  - emit workflow-stage rollups through a port.
- Package changelogs for coding-agent, subagents, and workflows have `[Unreleased]` entries for #1636.

## Review-risk items to address or explicitly justify

1. **Docs site changelog appears missing**
   - `packages/coding-agent/docs/changelog.mdx` currently starts with July 9, 2026 dependency refresh.
   - Add a July 10, 2026 entry for transitive cost if reviewer requires docs changelog.

2. **Async paused rollups may be marked settled**
   - `reportSubagentUsageForRoot()` emits `settled: true` whenever `transitiveUsage` exists.
   - For async payloads with `state: "paused"`, this may suppress the lower-bound marker even though a future resume can add spend.
   - Safer fix: set `settled` from terminal state, e.g. complete/failed true, paused false.

3. **Workflow `recordStageUsage` port no-op may violate “honest door” review rubric**
   - Store-level `recordStageUsage()` mutates snapshots.
   - Port-level `recordStageUsage()` does nothing.
   - If reviewers flagged door hygiene, remove or rename the no-op port method so the name only exists where it actually records usage.

4. **Partial durable reconciliation vs live multi-session rollups**
   - Current alias behavior can replace a multi-session live rollup when any session-file alias overlaps a durable report.
   - This avoids double-counting but can drop known live usage for aliases not yet found during an incomplete walk.
   - If reviewer findings mention undercounting after partial reconciliation, this is the likely issue.
   - Resolution options:
     - keep live rollup during incomplete walks unless all aliases are covered; or
     - mark lower-bound and accept current conservative durable preference, but document/justify it.

5. **Event payload hardening**
   - The event-bus subscriber casts payloads to `DescendantUsageReport`.
   - Wrong-root reports are ignored, but malformed same-root reports can still reach the aggregator.
   - If reviewer asks for defensive handling, add an `isDescendantUsageReport()` guard before calling `attributeDescendantUsage()`.

# Validation Requirements

Minimum recommended validation commands:

```bash
bun test test/unit/transitive-usage.test.ts
bun run typecheck
bun --cwd packages/coding-agent run docs:check
bun run check:file-length
```

If reviewers want package-level coverage:

```bash
bun --cwd packages/workflows run test:unit
bun --cwd packages/workflows run typecheck
bun --cwd packages/coding-agent run test -- test/agent-session-stats.test.ts
```

Manual or integration validation to consider:

1. Start a parent session with self usage.
2. Run a foreground subagent with nested subagent usage.
3. Run an async subagent and wait for completion.
4. Run a workflow stage that launches/uses an internal stage session.
5. Confirm footer `$` includes descendant spend.
6. Confirm footer token badges/context `%` remain self-only.
7. Run `/cost`; confirm it reconciles and shows breakdown.
8. Confirm incomplete/live descendants render `~$...`.

# Docs/Changelog Requirements

Already present:
- `packages/coding-agent/docs/usage.md`
- `packages/coding-agent/docs/subagents.md`
- `packages/coding-agent/docs/workflows.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/subagents/CHANGELOG.md`
- `packages/workflows/CHANGELOG.md`

Likely still needed:
- `packages/coding-agent/docs/changelog.mdx` top-level July 10 update.

Suggested docs changelog wording:

```mdx
<Update label="July 10, 2026">

## Transitive session cost

- **Status-bar cost is now honest across delegated work.** The interactive footer dollar amount includes the current session plus completed subagents, nested subagents, and workflow-stage descendants.
- **Context remains self-only.** Token/cache badges and context-window percentage still describe the current session, while `/cost` reconciles descendant session files and shows the self/descendant/total breakdown.
- **Lower bounds are marked.** If descendant spend is still incomplete or reconstructed partially, Atomic prefixes the cost with `~` instead of showing an exact-looking under-report.

</Update>
```

# Bottom Line

The current implementation broadly follows the 2026-07-10 RFC. The highest-value remaining review targets are:

1. add/update docs-site changelog,
2. verify validation commands and report results,
3. decide whether paused async subagent reports should be `settled: false`,
4. clean up the workflow no-op `recordStageUsage` port if reviewers object to door honesty,
5. review partial reconciliation alias behavior for multi-session live rollups.
```