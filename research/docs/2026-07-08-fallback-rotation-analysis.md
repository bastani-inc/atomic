I’m unable to write the requested markdown file because this session only has read/search/list tools available and no file write/edit tool.

Key finding summary for `/research/docs/2026-07-08-fallback-rotation-analysis.md`:

```md
## Analysis: Workflow Model Fallback Rotation

### Overview
Fallback rotation is implemented in editable repo source under `packages/workflows/src/runs/foreground/stage-runner-controller.ts`. `fallbackModels` and `fallbackThinkingLevels` are workflow-only options: they are resolved into an ordered candidate list, stripped before SDK `createAgentSession`, and each candidate is attempted in a fresh Atomic `AgentSession` until success or a non-fallbackable failure.

The editable `packages/coding-agent/src` layer does not implement workflow fallback rotation. It creates individual sessions, performs provider calls through `@earendil-works/pi-ai` dependency functions, and handles context overflow through auto-compaction/retry logic separate from workflow fallback.

### Entry Points
- `packages/workflows/src/shared/authoring-contract-stage.ts:50-55` - Defines `fallbackModels` and deprecated aligned `fallbackThinkingLevels`.
- `packages/workflows/src/shared/types.ts:177-184` - `StageOptions` accepts workflow model fields plus SDK session options.
- `packages/workflows/src/runs/foreground/stage-runner-context.ts:35-72` - `ctx.stage(...).prompt()` delegates to `StageSessionController.promptWithFallback()`.
- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:105-150` - Main fallback loop.
- `packages/workflows/src/runs/shared/model-fallback-candidates.ts:312-358` - Builds ordered fallback candidates.
- `packages/workflows/src/runs/shared/model-fallback-failures.ts:496-500` - Determines whether a failure advances to the next fallback candidate.

### How fallbackModels / fallbackThinkingLevels are passed

#### Authoring fields
`fallbackModels` is an ordered list of model IDs tried after the primary `model`; entries may include reasoning suffixes like `:low` or `:xhigh` (`packages/workflows/src/shared/authoring-contract-stage.ts:50-55`). `fallbackThinkingLevels` is deprecated compatibility data aligned by index with `fallbackModels` and ignored when the fallback model already has a suffix (`packages/workflows/src/shared/authoring-contract-stage.ts:51-54`).

#### Candidate construction
`StageSessionController.modelCandidates()` passes `effectiveStageOptions.model`, `fallbackModels`, and `fallbackThinkingLevels` into `buildModelCandidatesFromCatalog()` (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:222-230`).

`buildModelCandidates()` constructs `rawValues` in this order:
1. Primary `model`, if present.
2. Each `fallbackModels` entry.
3. Current catalog model as implicit final fallback, when catalog is available.

This happens at `packages/workflows/src/runs/shared/model-fallback-candidates.ts:320-340`.

For each fallback entry:
- The string is trimmed (`model-fallback-candidates.ts:327`).
- A reasoning suffix is split via `splitReasoningSuffix()` (`model-fallback-candidates.ts:328`).
- If no suffix exists and `fallbackThinkingLevels[index]` exists, it validates the level and appends `:${level}` to the fallback string (`model-fallback-candidates.ts:329-335`).
- If a suffix already exists, `fallbackThinkingLevels[index]` is ignored (`model-fallback-candidates.ts:328-337`).

Candidates are deduplicated by model id + reasoning level + context window (`model-fallback-candidates.ts:156-158`, `341-354`).

#### Per-candidate session options
When a candidate is attempted, `stageOptionsForCandidate()` rewrites stage options:
- Sets `model: candidate.value`.
- Sets `thinkingLevel` when the candidate has `reasoningLevel`.
- Sets `contextWindow` when the candidate resolved a per-model context token.
- Clears `fallbackModels` and `fallbackThinkingLevels`.

See `packages/workflows/src/runs/foreground/stage-runner-controller.ts:234-247`.

This means fallback metadata is consumed by the workflow layer and is not forwarded into Atomic SDK session creation for a candidate.

#### Stripping before SDK createAgentSession
`stripWorkflowOnlyOptions()` removes `fallbackModels` and `fallbackThinkingLevels` before creating an SDK session (`packages/workflows/src/runs/foreground/stage-runner-options.ts:14-27`). The extension wiring has another strip helper that removes `fallbackModels` before `createAgentSession` (`packages/workflows/src/extension/wiring.ts:167-171`, `306-310`).

The actual SDK call is made through the runtime adapter:
- `StageSessionController.createSession()` calls `opts.adapters.agentSession.create(...)` (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:298-311`).
- `buildRuntimeAdapters()` creates the adapter and calls `createSession(sessionOptions)` (`packages/workflows/src/extension/wiring.ts:282-318`).
- Production `createSession` calls `@bastani/atomic.createAgentSession()` after `prepareAtomicStageSessionOptions()` (`packages/workflows/src/extension/wiring.ts:91-108`).

### Tier advancement logic

`promptWithFallback()` is the rotation loop (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:105-150`).

Flow:
1. If the stage has no explicit `model` and no `fallbackModels`, it creates/uses one session and does no rotation (`stage-runner-controller.ts:110-113`).
2. Otherwise it builds candidates (`stage-runner-controller.ts:115`).
3. It optionally tries a resumed current session first (`stage-runner-controller.ts:121`).
4. It starts at `activeCandidateIndex ?? 0` and loops while `index < candidates.length` (`stage-runner-controller.ts:122-123`).
5. For each candidate:
   - Reuses the current session only if it already corresponds to that same index (`stage-runner-controller.ts:125-127`).
   - Otherwise creates a new session for that candidate (`stage-runner-controller.ts:127`).
   - Updates `activeCandidateIndex`, `selectedModel`, and model fallback metadata (`stage-runner-controller.ts:128-130`).
   - Sends the prompt (`stage-runner-controller.ts:132`).
   - Scans for a terminal assistant failure in newly-added messages (`stage-runner-controller.ts:133-140`).
   - Records success and returns when no terminal failure exists (`stage-runner-controller.ts:141-142`).
6. On caught failure, `handleCandidateFailure()` decides whether to stop, throw, or advance (`stage-runner-controller.ts:143-148`).

Advancement itself is simple: `handleCandidateFailure()` returns `"retry"` after recording a warning and disposing the current session; the loop increments `index += 1` (`stage-runner-controller.ts:147`, `430-452`).

### Error classes that trigger advancement

`isRetryableModelFailure()` normalizes the error and returns true only when the normalized kind is in `FALLBACKABLE_FAILURE_KINDS` (`packages/workflows/src/runs/shared/model-fallback-failures.ts:76-84`, `496-500`).

Fallbackable kinds:
- `auth_on_candidate_provider`
- `rate_limit`
- `provider_unavailable`
- `network_timeout`
- `transport_error`
- `model_unavailable`
- `request_incompatible`

Defined at `packages/workflows/src/runs/shared/model-fallback-failures.ts:76-84`.

Important classifiers:
- HTTP 400, 413, 422 => `request_incompatible` (`model-fallback-failures.ts:160-165`).
- HTTP 401, 403 => `auth_on_candidate_provider` (`model-fallback-failures.ts:165-167`).
- HTTP 408 => `network_timeout` (`model-fallback-failures.ts:168-169`).
- HTTP 404 => `model_unavailable` (`model-fallback-failures.ts:170-171`).
- HTTP 429 => `rate_limit` (`model-fallback-failures.ts:172-173`).
- HTTP 5xx => `provider_unavailable` (`model-fallback-failures.ts:174-176`).
- Codes including `context_length_exceeded`, `request_too_large`, `max_context_length`, and `context_window_exceeded` => `request_incompatible` (`model-fallback-failures.ts:201-209`).
- Message patterns for context length/window, max context/tokens, too-large request, invalid request, unsupported tool/parameter/function => `request_incompatible` (`model-fallback-failures.ts:267-278`, `309-315`).

### Error classes that bypass advancement

Fallback does not advance when:
- The workflow abort signal is set (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:442-446`).
- The failure is not retryable (`stage-runner-controller.ts:442-446`).
- The failing candidate is the final candidate (`stage-runner-controller.ts:442-446`).

Non-fallbackable classifications include:
- `cancelled`
- `task_failure`
- `unknown`

The `cancelled` and `task_failure` kinds are not in `FALLBACKABLE_FAILURE_KINDS` (`packages/workflows/src/runs/shared/model-fallback-failures.ts:47-57`, `76-84`).

Cancellation patterns include cancel/abort/interrupted (`model-fallback-failures.ts:41-45`). Non-retryable task-failure message patterns include command failed, tests failed, shell, missing file, no such file, cancel, abort, interrupted (`model-fallback-failures.ts:30-39`). Provider refusal/content-filter/safety/policy/tool-refusal patterns also classify as `task_failure` (`model-fallback-failures.ts:279-289`, `302-306`, `372-387`).

### Context overflow behavior

There are two separate context-overflow paths:

#### Workflow fallback classifier
The workflow fallback classifier treats `context_length_exceeded` as fallbackable because it maps to `request_incompatible`:
- `context_length_exceeded` is in `REQUEST_INCOMPATIBLE_CODES` (`packages/workflows/src/runs/shared/model-fallback-failures.ts:201-205`).
- That code becomes `request_incompatible` (`model-fallback-failures.ts:206-209`).
- `request_incompatible` is fallbackable (`model-fallback-failures.ts:76-84`).

Message patterns like `context length exceeded` and `context window exceeded` also become `request_incompatible` (`model-fallback-failures.ts:267-278`, `309-315`).

So if a context overflow escapes to the workflow layer as a thrown error or terminal assistant failure, it can advance the fallback tier.

#### Coding-agent auto-compaction path
Inside editable `packages/coding-agent/src`, context overflow is handled separately before normal retry:
- `_checkCompaction()` imports `isContextOverflow` from `@earendil-works/pi-ai/compat` (`packages/coding-agent/src/core/agent-session-auto-compaction.ts:1-2`).
- If the terminal assistant message is same-model and `isContextOverflow(...)` is true, it runs overflow auto-compaction and optionally retries (`agent-session-auto-compaction.ts:36-71`).
- `_isRetryableError()` explicitly returns false for `isContextOverflow(...)`, with the comment “Context overflow is handled by compaction, not retry” (`packages/coding-agent/src/core/agent-session-retry.ts:8-14`).

This means coding-agent retry logic does not treat context overflow as a provider retry. It is handled by compaction. Workflow fallback only participates if the overflow manifests to the workflow controller as a retryable model failure after/without coding-agent compaction handling.

### Editable repo source vs dependency-only logic

Editable repo source:
- Workflow candidate construction and rotation:
  - `packages/workflows/src/runs/shared/model-fallback-candidates.ts`
  - `packages/workflows/src/runs/shared/model-fallback-failures.ts`
  - `packages/workflows/src/runs/foreground/stage-runner-controller.ts`
- Workflow option stripping and adapter wiring:
  - `packages/workflows/src/runs/foreground/stage-runner-options.ts`
  - `packages/workflows/src/extension/wiring.ts`
- Atomic SDK session creation wrapper:
  - `packages/coding-agent/src/core/sdk.ts`
- Atomic context overflow compaction/retry decisions:
  - `packages/coding-agent/src/core/agent-session-auto-compaction.ts`
  - `packages/coding-agent/src/core/agent-session-retry.ts`

Dependency-only logic:
- `Agent` and provider streaming implementation come from `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core`, declared in `packages/coding-agent/package.json:79-84`.
- `isContextOverflow`, `streamSimple`, and model compatibility helpers are imported from `@earendil-works/pi-ai/compat` in editable files, but their implementation is dependency code, not repo source (`packages/coding-agent/src/core/agent-session-auto-compaction.ts:1-2`, `packages/coding-agent/src/core/sdk.ts:329-374`).
```
