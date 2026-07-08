I’m unable to write the requested file because this session only has read/search/list tools available (no file write/edit tool). Below is the exact content to place at:

`/Users/tonystark/Documents/projects/atomic-context-overflow-fallback/research/docs/2026-07-08-resume-overflow-review-analysis.md`

```markdown
## Analysis: Resumed Overflow Fallback Review

### Overview
The reviewer-b finding still applies at commit `1001ffa921a0c16bab40f938870c58aae70d4276` on branch `fix/context-overflow-fallback`. A resumed workflow stage session that fails with unresolved context overflow is treated as retryable, but `tryResumeCurrentSession()` disposes the resumed session and clears `activeCandidateIndex`, causing `promptWithFallback()` to restart from `candidates[0]` instead of advancing after the resumed model.

### Entry Points
- `packages/workflows/src/runs/foreground/stage-runner-context.ts:35-72` - public `ctx.prompt()` path calls `controller.promptWithFallback()`.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:107-152` - `promptWithFallback()` fallback loop.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:397-437` - `tryResumeCurrentSession()` resumed-session path.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:439-461` - `handleCandidateFailure()` normal candidate failure path.
- `packages/workflows/src/runs/foreground/stage-runner-unresolved-overflow.ts:3-15` - converts unresolved overflow compaction events into workflow model failures.

### Core Implementation

#### 1. Prompt entry and fallback loop
`createStageContext().prompt()` delegates normal AgentSession-backed prompts to `controller.promptWithFallback(text, sdkOptions)` at `packages/workflows/src/runs/foreground/stage-runner-context.ts:69`.

Inside `promptWithFallback()`:
- It loads resolved model candidates at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:117`.
- It first attempts the special resumed-session path at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:123`.
- If resume does not fully handle the prompt, it starts the normal loop from `let index = this.activeCandidateIndex ?? 0` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:124`.
- The loop creates or reuses a session for `candidates[index]` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:126-130`.
- Candidate failures are routed through `handleCandidateFailure()` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:145-149`.

#### 2. Resumed session state
When reattaching from an existing session file, `createInitialSession()` creates a session with `restoreSavedModel: true` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:286-287`.

It then derives the restored model id and candidate index:
- `restoredId` from `workflowModelId(resumed.model)` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:288`.
- `restoredIndex` by searching candidates at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:289`.
- `activeCandidateIndex` is set to the restored index when found at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:290`.
- `resumeCurrentSession` is set to `true` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:292`.

This means the controller knows which candidate the resumed session corresponds to before the next prompt.

#### 3. Unresolved overflow detection
`attachSession()` subscribes to session events at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:329-335`.

For each event, it stores unresolved overflow text via:

- `unresolvedContextOverflowMessage(event)` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:332`.

The event helper recognizes `compaction_end` events with `unresolvedOverflow: true` at `packages/workflows/src/runs/foreground/stage-runner-unresolved-overflow.ts:3-10`.

`promptWithPauseResume()` clears the stored overflow message before each prompt at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:368`, then throws it after prompt completion or prompt failure via `throwUnresolvedContextOverflowIfPresent()` at:
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:379`
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:390`

The thrown error is a `WorkflowPromptModelFailure` with code `context_length_exceeded` and `stopReason: "error"` from `packages/workflows/src/runs/foreground/stage-runner-unresolved-overflow.ts:13-15`.

#### 4. Retryability classification
The fallback classifier treats `context_length_exceeded` as request-incompatible:
- `context_length_exceeded` is listed in `REQUEST_INCOMPATIBLE_CODES` at `packages/workflows/src/runs/shared/model-fallback-failures.ts:201-205`.
- Request-incompatible failures are fallbackable via `FALLBACKABLE_FAILURE_KINDS` at `packages/workflows/src/runs/shared/model-fallback-failures.ts:76-84`.
- `isRetryableModelFailure()` returns true for fallbackable kinds at `packages/workflows/src/runs/shared/model-fallback-failures.ts:496-500`.

So unresolved overflow from a resumed session reaches the retryable branch in `tryResumeCurrentSession()`.

#### 5. Current resumed failure behavior
In `tryResumeCurrentSession()`:
- The resumed session is prompted at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:408`.
- On failure, the attempt is recorded as failed at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:424-425`.
- Retryable failures continue past the non-retryable/abort guard at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:426-431`.
- The warning explicitly says fallback is restarting from `candidates[0]` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:432`.
- The current session is disposed at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:433`.
- `activeCandidateIndex` is reset to `undefined` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:434`.
- The method returns `false` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:435`.

Back in `promptWithFallback()`, `false` from resume causes the normal loop to run. Because `activeCandidateIndex` was reset to `undefined`, the loop starts from `0` at `packages/workflows/src/runs/foreground/stage-runner-controller.ts:124`.

This is the exact restart-from-primary behavior identified by reviewer-b.

### Data Flow for the Finding
1. Reattached session restores saved model and sets `activeCandidateIndex` to the restored model index (`stage-runner-controller.ts:286-292`).
2. Next prompt enters `promptWithFallback()` (`stage-runner-controller.ts:107-123`).
3. `tryResumeCurrentSession()` prompts the resumed session (`stage-runner-controller.ts:397-408`).
4. Session emits unresolved overflow; subscriber stores message (`stage-runner-controller.ts:329-335`, `stage-runner-unresolved-overflow.ts:3-10`).
5. `promptWithPauseResume()` throws `WorkflowPromptModelFailure` with `context_length_exceeded` (`stage-runner-controller.ts:379,498`, `stage-runner-unresolved-overflow.ts:13-15`).
6. `tryResumeCurrentSession()` classifies it as retryable and records failed attempt (`stage-runner-controller.ts:424-431`).
7. It logs restart from `candidates[0]`, disposes, and clears `activeCandidateIndex` (`stage-runner-controller.ts:432-434`).
8. `promptWithFallback()` starts loop from `this.activeCandidateIndex ?? 0`, now `0` (`stage-runner-controller.ts:124`).

### Test Coverage
Existing tests cover unresolved overflow in fresh fallback chains:
- `test/unit/stage-runner-overflow-fallback.test.ts:6-43` - primary unresolved overflow advances to next fallback.
- `test/unit/stage-runner-overflow-fallback.test.ts:46-80` - deferred unresolved overflow advances to next fallback.
- `test/unit/stage-runner-overflow-fallback.test.ts:82-113` - exhausted fresh overflow fallback tiers reject with terminal context error.
- `test/unit/stage-runner-overflow-fallback.test.ts:115-146` - deferred exhausted fresh overflow fallback tiers reject.

Existing resume tests document and assert restart-from-primary behavior for generic retryable resumed failures:
- `test/unit/stage-runner-fallback-resume.test.ts:162-198` expects a resumed model failure to create `[undefined, "anthropic/model-a", "anthropic/model-b"]`.
- The file comment says retryable resumed failure restarts the full chain from the primary at `test/unit/stage-runner-fallback-resume.test.ts:12-14`.

No current test covers a resumed session that fails with unresolved overflow. The overflow tests only start from fresh candidate `candidates[0]`, and the resume tests use generic retryable errors such as rate limit.

### Finding Status
The finding still applies.

The decisive lines are:
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:124` - normal loop starts from `activeCandidateIndex ?? 0`.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:290` - resumed session can have a known `activeCandidateIndex`.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:432` - warning says restart from `candidates[0]`.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:434` - resumed failure clears `activeCandidateIndex`, forcing line 124 to use `0`.

### Implementation Changes to Resolve

#### Option A: Make resumed request/context incompatibility advance after resumed model
Change `tryResumeCurrentSession()` so that retryable request/context-incompatible failures, including unresolved overflow, continue from the candidate after the resumed candidate instead of clearing the index.

Implementation shape:
- Capture the resumed candidate index before disposing, using existing `this.activeCandidateIndex` and/or a lookup by `resumedLabel`.
- Classify the caught error with `normalizeModelFailureSignal(err)`.
- If the signal kind is `request_incompatible`, set `this.activeCandidateIndex = resumedIndex + 1` before returning `false`.
- Update the warning to say it is continuing with the next candidate, not restarting from `candidates[0]`.
- Preserve existing restart-from-primary behavior for transient retryable failures such as rate limits, matching `test/unit/stage-runner-fallback-resume.test.ts:162-198`.

Affected area:
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:397-437`.

#### Option B: Special-case unresolved overflow only
Because unresolved overflow is created locally by `unresolvedContextOverflowFailure()` with code `context_length_exceeded`, the narrower change is to detect that specific failure and advance after the resumed model only for that case.

Affected area:
- `packages/workflows/src/runs/foreground/stage-runner-unresolved-overflow.ts:13-15`
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:424-435`

This keeps all other retryable resume failures on the currently documented restart-from-primary path.

### Test Changes to Resolve

Add resumed-overflow regression coverage. Suggested cases:

1. Reattached saved middle candidate overflows and advances to the next candidate:
   - Stage options: primary `anthropic/model-a`, fallback models `["anthropic/model-b", "anthropic/model-c"]`.
   - Reattach returns saved model-b for the no-model override create.
   - Saved model-b emits unresolved overflow.
   - Expected create order: `[undefined, "anthropic/model-c"]`.
   - Expected no `"anthropic/model-a"` retry.
   - Expected attempts: model-b failed, model-c succeeded.

2. Reattached saved last candidate overflows and rejects terminally:
   - Stage options: primary `anthropic/model-a`, fallback models `["anthropic/model-b"]`.
   - Reattach returns saved model-b.
   - Saved model-b emits unresolved overflow.
   - Expected create order: `[undefined]`.
   - Expected rejection with the model-b overflow message.
   - Expected no replay of model-a.

3. Optional live retained-session case:
   - First prompt settles on fallback model-b.
   - Second prompt resumes model-b and emits unresolved overflow.
   - With candidate model-c present, expected next create is only model-c, not model-a.

Best target files:
- Add resumed-overflow tests to `test/unit/stage-runner-overflow-fallback.test.ts`.
- Or extend `test/unit/stage-runner-fallback-resume.test.ts` near the existing resumed failure tests at `test/unit/stage-runner-fallback-resume.test.ts:162-198`.

### Notes on Existing Behavior to Preserve
The existing resume behavior for transient retryable failures is explicitly tested:
- `test/unit/stage-runner-fallback-resume.test.ts:162-198`.

If the implementation changes only overflow/request-incompatible resumed failures, that test can remain unchanged. If all retryable resumed failures are changed to advance after the resumed model, that test and its file-level comments at `test/unit/stage-runner-fallback-resume.test.ts:12-14` must be updated.
```