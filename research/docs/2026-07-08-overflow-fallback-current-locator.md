I’m unable to write the requested file because this environment only exposes read/search/list tools (no file write/edit tool). Below is the content intended for:

`/Users/tonystark/Documents/projects/atomic-context-overflow-fallback/research/docs/2026-07-08-overflow-fallback-current-locator.md`

```md
# Overflow Fallback Current Locator — 2026-07-08

## Implementation Files

### Coding agent context overflow / compaction fallback
- `packages/coding-agent/src/core/agent-session-auto-compaction.ts`
  - Lines 36-72: detects context overflow, emits `compaction_end` with `unresolvedOverflow: true`, prevents same-model retry loops.
  - Lines 99-115: effective input budget / prompt-limit handling.
- `packages/coding-agent/src/core/agent-session-compaction.ts`
  - Lines 41-70: overflow compaction no-transcript terminal handling and deterministic eviction fallback when planner auth is unavailable.
  - Lines 230-247, 285-302: compaction end event emission paths.
  - Lines 332-335: overflow vs threshold auto-compaction comments.
- `packages/coding-agent/src/core/agent-session-types.ts`
  - Lines 48-54: `compaction_end` event fields including `willRetry`, optional `unresolvedOverflow`, `errorMessage`.
- `packages/coding-agent/src/core/agent-session-events.ts`
  - Lines 85-87, 150-152: resets overflow recovery attempt tracking.
- `packages/coding-agent/src/core/agent-session-retry.ts`
  - Lines 10-14: excludes context overflow from normal retry.
- `packages/coding-agent/src/core/context-window.ts`
  - Lines 8-15, 107-114: effective input budget used for compaction / overflow decisions.
- `packages/coding-agent/src/core/compaction/context-compaction-runner.ts`
  - Lines 111-151: planner overflow detection metadata.
  - Lines 232-270: provider overflow returned from planner stream/state.
  - Lines 300-360: standard pass, critical overflow pass, deterministic fallback control.
- `packages/coding-agent/src/core/compaction/context-compaction-critical.ts`
  - Lines 5-23: critical overflow recent-entry floor.
  - Lines 30-61: critical overflow prompt and protected-entry relaxation.
- `packages/coding-agent/src/core/compaction/context-compaction-eviction.ts`
  - Lines 18-20: deterministic overflow eviction terminal error text.
- `packages/coding-agent/src/core/copilot-model-static-fallbacks.ts`
  - Lines 16-20: comments tying static fallback metadata to auto-compaction / overflow recovery.

### Workflow stage fallback / unresolved overflow routing
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts`
  - Lines 8-10: imports unresolved overflow helpers.
  - Lines 23-31, 46-48: state for unresolved overflow and explicit fallback config.
  - Lines 111-154: prompt path with model fallback.
  - Lines 227-249: `fallbackModels` / `fallbackThinkingLevels` candidate construction and per-candidate session options.
  - Lines 331-332: captures unresolved overflow event.
  - Lines 367-382: throws unresolved overflow around prompt completion/error.
  - Lines 403-428: resumed fallback attempt metadata/error path.
- `packages/workflows/src/runs/foreground/stage-runner-unresolved-overflow.ts`
  - Lines 3-10: reads `compaction_end.unresolvedOverflow` and `errorMessage`.
  - Lines 13-15: converts unresolved overflow to workflow prompt model failure.
- `packages/workflows/src/runs/foreground/stage-runner-types.ts`
  - Lines 57-58: stage session create options include `fallbackModels`, `fallbackThinkingLevels`.
  - Lines 69-72: fallback metadata.
  - Lines 132-139: internal model fallback metadata and controlled pause methods.
- `packages/workflows/src/runs/foreground/stage-runner-context.ts`
  - Lines 83-87: complete adapter fallback option validation.
  - Lines 202-208: exposes model fallback metadata and controlled pause request.
- `packages/workflows/src/runs/foreground/stage-runner-options.ts`
  - Lines 16-18: strips fallback options from session options.
- `packages/workflows/src/runs/shared/model-fallback-candidates.ts`
  - Lines 313-334: `fallbackModels` and deprecated `fallbackThinkingLevels` compatibility mapping.
  - Lines 369-390: resolved candidate construction with catalog.
  - Lines 406-440: workflow model validation for model/fallback requests.
- `packages/workflows/src/runs/shared/model-fallback-failures.ts`
  - Lines 47-84: fallback failure kinds and fallbackable set.
  - Lines 160-164: HTTP 400/413/422 classified as `request_incompatible`.
  - Lines 201-209: request/context incompatible error codes.
  - Lines 267-270: context length/window message patterns.
- `packages/workflows/src/runs/shared/model-fallback.ts`
  - Lines 1-2: re-export surface for candidates/failures.

### Subagent fallback parity
- `packages/subagents/src/runs/shared/model-fallback.ts`
  - Lines 40-50: `fallbackModels` + `fallbackThinkingLevels` candidate construction.
  - Lines 114-148: fallback failure kinds and fallbackable set.
  - Lines 225-252: request incompatible HTTP/code handling.
- `packages/subagents/src/runs/background/async-execution-chain.ts`
  - Lines 153-156: background chain fallback candidate construction with `fallbackThinkingLevels`.
- `packages/subagents/src/runs/background/async-execution-single.ts`
  - Lines 88-91: single background fallback candidate construction.
- `packages/subagents/src/runs/foreground/execution-run-sync.ts`
  - Lines 70-76: foreground fallback candidate construction with `fallbackThinkingLevels`.

### Controlled pause / resume
- `packages/workflows/src/runs/foreground/stage-control-registry.ts`
  - Lines 45-76: controlled pause/resume interface docs.
  - Lines 165-232: controlled stage lookup, pause/resume handling.
- `packages/workflows/src/runs/foreground/executor-stage-control.ts`
  - Lines 98-100: calls `__requestPause()` for pending/running/streaming stages.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts`
  - Lines 12-14, 28: pause request state.
  - Lines 178-193: request pause, resume, isPaused.
  - Lines 214-218: abort cleanup rejects pending pause.
  - Lines 359-385: prompt loop waits on controlled pause before/after prompt or thrown error.
- `packages/workflows/src/runs/foreground/stage-runner-types.ts`
  - Lines 134-139: controlled pause/resume internal interface.
- `packages/workflows/src/extension/workflow-run-control-command.ts`
  - Lines 270-388: `/workflow pause` command routing.
  - Lines 391-420: resume branching for paused vs resumable continuation.
- `packages/workflows/src/extension/workflow-tool-control.ts`
  - Lines 35-64: workflow tool pause action.
  - Lines 180-201: workflow tool resume action.

## Test Files

### Overflow fallback / unresolved overflow
- `test/unit/stage-runner-overflow-fallback.test.ts`
  - Lines 16-24: mocked `compaction_end` with `unresolvedOverflow: true`.
  - Lines 35-39: stage configured with `fallbackModels`.
  - Lines 53-61: unresolved overflow per model.
  - Lines 69-73: exhausts fallback and reports fallback overflow error.

### Workflow model fallback
- `test/unit/stage-runner-model-fallback-1.test.ts`
  - Lines 73-75: model suffix + fallback context-window candidate.
  - Lines 245-247, 307-310, 373-375, 439-441: `fallbackModels` stage tests.
- `test/unit/stage-runner-model-fallback-2.test.ts`
  - Lines 45-47, 107-109, 284-288, 339-340, 394-395: additional fallback chain tests.
- `test/unit/model-fallback-01.test.ts`
- `test/unit/model-fallback-02.test.ts`
- `test/unit/model-fallback.test.ts`
- `test/unit/model-fallback-transport.test.ts`
- `test/unit/model-fallback-request-incompatible.test.ts`
- `test/unit/model-fallback-classifier-conformance.test.ts`
- `test/unit/stage-runner-fallback-resume.test.ts`
- `test/unit/stage-runner-fallback-shared-registry.test.ts`
- `test/unit/subagents-model-fallback.test.ts`
- `test/unit/subagents-foreground-fallback-updates.test.ts`

### Coding-agent overflow compaction / eviction
- `packages/coding-agent/test/agent-session-overflow-eviction.test.ts`
- `test/unit/check-file-length-fallback.test.ts`

### Controlled pause / resume
- `test/integration/overlay-entrypoints-commands.test.ts`
  - Lines 257-289: `/workflow pause` command tests.
  - Lines 289-420: resume branching tests.
- `test/integration/runtime-tunables-01.test.ts`
  - Lines 413-423: pause/resume of queued stage.
- `test/integration/runtime-tunables-02.test.ts`
  - Lines 23-26: imports pause/resume control helpers.
- `test/integration/mock-extension-api-tool-registration.test.ts`
  - Lines 264-268: pause result/status assertions.

## Documentation Files

- `packages/coding-agent/docs/compaction.md`
  - Lines 10-12: source file map for runner, critical overflow, eviction.
  - Lines 26-32: compaction modes and auto overflow ladder note.
  - Lines 104-109: reserve tokens / effective budget / manual compact behavior.
  - Lines 174-182: flow table including target/fallback decision.
  - Lines 552-562: overflow terminal cases, planner overflow, unresolved overflow event, workflow `fallbackModels`.
- `packages/coding-agent/docs/json.md`
  - Lines 16-23: JSON event union includes `compaction_start` / `compaction_end`; docs currently omit `unresolvedOverflow`.
- `packages/coding-agent/docs/rpc.md`
  - Lines 1054-1080: compaction reason and overflow retry behavior.
- `packages/coding-agent/docs/extensions.md`
  - Lines 464-465: compaction hook reason includes overflow.
  - Lines 1994-1996: tool output truncation / context overflow warning.
- `packages/coding-agent/docs/providers.md`
  - Lines 43-45: Copilot long-context and overflow/compaction behavior.
- `packages/workflows/README.md`
  - Relevant to workflow fallback docs; search hits for fallback-related docs.
- `specs/2026-05-14-workflow-sdk-fallback-models.md`
  - Workflow SDK fallback model design/spec.

## Changelog Files

- `packages/workflows/CHANGELOG.md`
  - Lines 10-11: current fix for unrecoverable context-window overflow advancing `fallbackModels`.
  - Lines 72-75: request/context incompatibility model fallback and related fallback ordering/classification.
- `packages/coding-agent/CHANGELOG.md`
  - Lines 7-8: unresolved overflow signal and planner overflow fallback.
  - Lines 43-49: overflow auto-compaction ladder and terminal handling.
  - Lines 100-103: workflow/subagent request/context incompatibility fallback.
  - Lines 149-152: request/context incompatibility fallback, fallback to selected model, watchdogs.
  - Lines 477-478: successful overflow-sized assistant response compaction.
  - Lines 483-493: context-window support / Copilot context-window behavior.
  - Lines 610-612: verbatim compaction and critical overflow prompt.

## Research / Existing Analysis Docs

- `research/docs/2026-07-08-context-overflow-fallback-locator.md`
- `research/docs/2026-07-08-fallback-rotation-analysis.md`
- `research/docs/2026-07-08-overflow-compaction-analysis.md`
- `research/docs/2026-07-08-overflow-fallback-patterns.md`
- `research/web/2026-07-08-context-overflow-upstream-practices.md`

## Related Directories / Clusters

- `packages/coding-agent/src/core/compaction/`
  - Contains context compaction runner, critical overflow mode, deterministic eviction, deletion validation, metrics, prompts, and transcript utilities.
- `packages/workflows/src/runs/foreground/`
  - Contains stage runner, unresolved overflow bridge, controlled pause, fallback session lifecycle, and stage control wiring.
- `packages/workflows/src/runs/shared/`
  - Contains workflow fallback candidate and failure classification code.
- `packages/subagents/src/runs/shared/`
  - Contains subagent fallback candidate and failure classification code.
- `test/unit/`
  - Contains workflow, subagent, classifier, request-incompatible, transport, resume, and overflow fallback tests.
```