I’m unable to write `/Users/tonystark/Documents/projects/atomic-context-overflow-fallback/research/docs/2026-07-08-current-overflow-fallback-locator-v2.md` because this subagent only has read/search/list tools available and no file write/edit tool.

## File Locations for Current Overflow Fallback Work

### Awaitable Overflow Post-Compaction Continuation
- `packages/coding-agent/src/core/agent-session.ts:84-88` - Stores overflow recovery attempted flag and pending post-compaction continuation promise/token fields.
- `packages/coding-agent/src/core/agent-session-auto-compaction.ts:136-190` - Schedules and awaits post-auto-compaction continuation probe for overflow `willRetry`.
- `packages/coding-agent/src/core/agent-session-auto-compaction.ts:214-287` - Emits `compaction_end`, schedules continuation probe after successful auto-compaction.
- `packages/coding-agent/src/core/agent-session-prompt.ts:184-190` - `_runAgentPrompt()` awaits `_awaitPendingOverflowPostCompactionContinuation()` after queued continuations.

### `unresolvedOverflow` Event Emission / Consumption
- `packages/coding-agent/src/core/agent-session-types.ts:47-55` - `compaction_end` event type includes `unresolvedOverflow?: boolean`.
- `packages/coding-agent/src/core/agent-session-auto-compaction.ts:43-72` - Emits terminal overflow `compaction_end` with `unresolvedOverflow: true` after exhausted compact-and-retry.
- `packages/coding-agent/src/core/agent-session-auto-compaction.ts:220-258` - Emits `unresolvedOverflow` for no model / no result cases.
- `packages/coding-agent/src/core/agent-session-auto-compaction.ts:271-282` - Emits `unresolvedOverflow` on overflow auto-compaction errors.
- `packages/workflows/src/runs/foreground/stage-runner-unresolved-overflow.ts:3-15` - Converts unresolved overflow event into workflow prompt model failure.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:329-335` - Subscribes to session events and records unresolved overflow message.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:367-390` - Clears/checks unresolved overflow around prompt execution and pause handling.

### Pause / Resume Ordering
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:178-193` - Controlled pause request, abort, resume resolution, pause-state check.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:353-394` - Prompt loop orders pending pauses before/after prompt and checks unresolved overflow after resume.
- `packages/workflows/src/runs/foreground/executor-stage-control.ts:85-122` - Stage control pause/resume ordering, cascade pause/resume, run status updates, inner context resume.
- `packages/workflows/src/runs/foreground/executor-scheduler.ts:128-142` - Cascade pause logic.
- `packages/workflows/src/runs/foreground/executor-stage-call.ts:68-82,148-170` - Resume continuation drain and injection.

### Fallback Candidate Advancement
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:107-152` - Main fallback loop over candidates.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:439-460` - Candidate failure handling; records attempts, decides retry/throw, advances to next candidate.
- `packages/workflows/src/runs/shared/model-fallback-candidates.ts` - Candidate construction cluster.
- `packages/workflows/src/runs/shared/model-fallback-failures.ts` - Failure classification cluster.
- `packages/workflows/src/runs/shared/model-fallback.ts` - Shared fallback types/helpers cluster.

### `tryResumeCurrentSession` Resume Fallback Behavior
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:397-436` - Resume existing session first; on retryable resume failure disposes current session, clears active index, restarts fallback chain from primary.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:467-470` - Successful attempt marks `resumeCurrentSession = true`.
- `packages/workflows/src/runs/foreground/stage-runner-options.ts:31-35` - Reattach opens persisted session manager for resume.

### Tests: Stage Runner Overflow Fallback
- `test/unit/stage-runner-overflow-fallback.test.ts:5-43` - Unresolved overflow advances to next fallback tier.
- `test/unit/stage-runner-overflow-fallback.test.ts:46-80` - Deferred unresolved overflow advances instead of success.
- `test/unit/stage-runner-overflow-fallback.test.ts:82-113` - Exhausted overflow fallback tiers stop with terminal context error.
- `test/unit/stage-runner-overflow-fallback.test.ts:115-146` - Exhausted deferred unresolved overflow.
- `test/unit/stage-runner-overflow-fallback.test.ts:148-183` - Controlled pause honored before unresolved overflow; resume message not sent.

### Tests: Fallback Resume
- `test/unit/stage-runner-fallback-resume.test.ts:1-17` - Regression intent/docs for reattached follow-up resume behavior.
- `test/unit/stage-runner-fallback-resume.test.ts:131-160` - Reattached follow-up resumes on saved working model.
- `test/unit/stage-runner-fallback-resume.test.ts:162-198` - Failed resumed model restarts full chain from primary.
- `test/unit/stage-runner-fallback-resume.test.ts:201-245` - Live `ctx.followUp()` reuses settled fallback session.
- `test/unit/stage-runner-fallback-resume.test.ts:247-277` - Second `ctx.prompt()` resumes settled model without chain replay.
- `test/unit/stage-runner-fallback-resume.test.ts:279-375` - Request/context incompatibility advances through fallback to current selected model.

### Related Coding-Agent Tests
- `packages/coding-agent/test/agent-session-auto-compaction-overflow-await.suite.ts` - Awaitable overflow continuation suite.
- `packages/coding-agent/test/agent-session-auto-compaction-queue-01.suite.ts` - Auto-compaction queued continuation behavior.
- `packages/coding-agent/test/agent-session-auto-compaction-queue-02.suite.ts` - Additional queue/continuation coverage.
- `packages/coding-agent/test/agent-session-auto-compaction-queue-03.suite.ts` - Compaction queue/overflow retry coverage.

### Docs / Changelog / PR Evidence
- `packages/coding-agent/CHANGELOG.md:6-8` - Current alpha notes for unresolved overflow signal and awaiting post-compaction continuation.
- `packages/coding-agent/CHANGELOG.md:101-104` - Request/context fallback and post-compaction continuation evidence, includes issue refs.
- `packages/coding-agent/CHANGELOG.md:150-155` - Workflow/subagent fallback and watchdog fixes, includes PR/issue refs.
- `packages/coding-agent/CHANGELOG.md:202-203` - Post-compaction queued work resumes through continuation lifecycle, issue `#1570`.
- `packages/coding-agent/docs/compaction.md:109-112` - Documents prompt waiting for overflow post-compaction continuation and unresolved overflow signal.
- `packages/coding-agent/docs/compaction.md:554-563` - Overflow auto-compaction terminal/fallback behavior.
- `packages/coding-agent/docs/json.md:16-29` - JSON event contract for `compaction_end.unresolvedOverflow`.
- `packages/coding-agent/docs/rpc.md:1079-1085` - RPC docs for `willRetry` and unresolved overflow fallback signal.
- `packages/coding-agent/docs/workflows.md:1846-1849` - Workflow model fallback on request/context incompatibility and resume settled model behavior.
- `packages/coding-agent/docs/subagents.md:177-180` - Subagent fallback behavior for request/context incompatibility.