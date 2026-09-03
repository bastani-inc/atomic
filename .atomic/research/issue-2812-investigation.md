# Issue #2812 investigation — structured-output correction exhaustion skips model fallback

Issue: https://github.com/bastani-inc/atomic/issues/2812
Investigated on `main` @ c20dbb4192 (2026-09-02).

## 1. Confirmed runtime defect (deterministic reproduction)

A faux primary model that returns an empty successful assistant turn for the initial prompt
and all three corrective prompts, plus a configured fallback that calls `structured_output`,
reproduces the issue exactly:

```
CREATED SESSIONS: [ 'anthropic/primary' ]          <- fallback never created
PROMPTS: primary x4 (initial + Corrective attempt 1/3, 2/3, 3/3)
ATTEMPTS: [primary success:true, primary success:true, primary success:true, primary success:true]
ERROR: atomic-workflows: stage configured with schema must finish by calling structured_output.
```

Reproduction shape (vitest, `test/unit`, using `./stage-runner-helpers.js`):

```ts
const agentSession: AgentSessionAdapter = {
  async create(options) {
    createOptions = options;
    const model = typeof options.model === "string" ? options.model : "object-model";
    calls.push(model);
    return makeMockSession({
      async prompt(text) {
        if (model === "anthropic/primary") return;        // empty successful turn
        const tool = createOptions?.customTools?.find((t) => t.name === "structured_output");
        await tool.execute("structured-call-fb", { ok: true }, undefined, undefined, undefined as never);
      },
    }).session;
  },
};
const ctx = createStageContext(makeOpts({
  adapters: { agentSession },
  stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"],
                  schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }) },
})) as InternalStageContext;
await ctx.prompt("partition the work");   // expected { ok: true } from fallback; actually throws
```

## 2. Root cause

Two layers that do not know about each other.

### `packages/workflows/src/runs/foreground/stage-runner-context.ts:99-117`
The schema correction loop sits *above* `controller.promptWithFallback()`. It calls it up to
`1 + STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS` (=4) times, checks only
`structuredOutputCapture.called`, and when the budget is exhausted throws
`STRUCTURED_OUTPUT_MISSING_ERROR` (or the last `structured_output` validation error) directly.
That throw never reaches candidate handling.

### `packages/workflows/src/runs/foreground/stage-runner-controller.ts`
- `promptWithFallback()` (419-519) advances to the next candidate only via
  `handleCandidateFailure()` (1404-1435), which is reached only when
  `promptWithThrownErrorRetry()` throws or the latest assistant message has a terminal
  `stopReason` (`error`/`aborted`) — see `latestTerminalAssistantFailureSince` in
  `stage-runner-messages.ts:110-125`. An empty assistant turn (or *no* assistant message at all)
  is "clean", so line 510 `recordSuccessfulAttempt(candidate)` runs, which also latches
  `resumeCurrentSession = true`.
- Correction prompts 2-4 therefore take `tryResumeCurrentSession()` (1329-1402), stay on the
  same session/model, and each records another `success: true`.
- `handleCandidateFailure` line 1411 (`capturedStructuredOutputForAttempt() &&
  isRetryableModelFailure(err)`) is the #1350/#2201 guard: a *captured* structured result must
  never be re-run on another model. That invariant is orthogonal to this bug (no capture
  exists) and must be preserved.

Net effect: for a schema-backed stage, any *non-throwing* failure mode — empty turn,
prose-only answer, repeatedly invalid `structured_output` arguments — can never reach the
fallback chain, and the attempt metadata misreports every attempt as successful.

## 3. Why did `anthropic/claude-opus-5` return empty turns? (not determinable locally)

The parent session `01a05d8c-…` and stage sessions `01a06103-3ab0…`/`01a06103-ba3d…` are not
present under `~/.atomic/agent/sessions` on this machine, so the raw provider responses cannot
be inspected. Evidence and ranked hypotheses from code:

**Key clue:** both stages completed four "turns" in ~1-2 s total. Four real Opus completions
cannot finish that fast. Either the prompts never reached the provider, or the provider
answered instantly.

Paths in code that produce a "clean" turn with no provider round-trip
(`packages/coding-agent/src/core/agent-session-prompt.ts`):
1. `:64-71` — `_queuedMessagesPaused`: prompt is queued as steer/followUp and `prompt()`
   resolves immediately. No assistant message is produced. The controller treats "no
   assistant message since prompt start" as clean → `success: true`. Only workflow pause
   (`stage-runner-pause.ts`) sets this, which is plausible for the *second* (resumed, Intercom-
   steered) run, less so for the first.
2. `:76-87` — an extension `input` handler returning `handled`.
3. `:51-55` — slash-command dispatch (prompt text would need to start with `/`; unlikely).

Paths that produce an *empty assistant message* with an error:
4. OAuth `invalid_grant` at request time: `sdk.ts:302-306` streamFn → `modelRuntime.getRequestAuth`
   throws → pi-agent-core `Agent.handleRunFailure` (agent.js:349-364) appends an assistant
   message with `content: [{ type: "text", text: "" }]`, `stopReason: "error"`, `errorMessage`.
   This is literally an empty assistant message. `latestTerminalAssistantFailureSince` *should*
   classify it as terminal and route to fallback (covered by
   `stage-runner-model-fallback-1.test.ts` "non-throwing assistant stopReason error tries
   fallback"), so if this is what happened, either the stopReason/errorMessage was not
   preserved on the message the controller saw, or the reporter's inspection did not surface
   those fields. Worth a targeted check but not provable here.
5. A genuine Anthropic 200 with `end_turn` and no content blocks. Known to happen rarely with
   Claude; inconsistent with the ~250 ms/turn timing.

Conclusion: the external cause is unresolved; most consistent with the timing is (1)/(2) —
`prompt()` returning without a provider turn — or (4) if error fields were dropped. Regardless
of cause, the runtime must (a) fall back and (b) record enough to diagnose next time.

## 4. Fix shape (what the user asked for)

"Same model fallback chain for structured output as regular rate limits."

- Treat exhaustion of the per-candidate structured-output correction budget as a candidate
  failure that goes through the same chain as rate limits: record the candidate's attempts as
  `success: false` with the structured-output error, emit the `[fallback] … failed: … Retrying
  with …` warning, dispose the session, and re-run the **initial** prompt (not a corrective
  prompt) on the next candidate with a fresh correction budget.
- Correction budget is per candidate (`STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS` = 3 corrective
  prompts after the initial one, per model).
- A successful correction on the current candidate continues without fallback.
- No fallback configured / every candidate exhausted: keep the current clear error
  (`STRUCTURED_OUTPUT_MISSING_ERROR` or the last validation error); attempt metadata must show
  `success: false`.
- Preserve: single-use `structured_output` guarantee; `executionCapture.snapshot` pairing across
  session recreation (issue #2198 test at `stage-runner-structured-output.test.ts:478`); the
  #1350/#2201 "captured result is never retried on another model" guard
  (`stage-runner-model-fallback-1.test.ts:354`).
- Diagnosability: the failed attempt's `error` should say *what* the turn looked like —
  e.g. no assistant message produced vs. empty assistant text vs. structured_output validation
  error — so the next occurrence of the external cause is attributable.
- Durable resume/replay must not reuse an abandoned candidate's capture or report its empty
  turns as successful.

## 5. Regression matrix (from the issue, plus diagnosability)

1. Primary returns empty successful turns through the full budget; fallback calls
   `structured_output`; stage completes from the fallback; metadata: primary attempts
   `success: false`, fallback `success: true`; warning recorded.
2. Primary makes invalid `structured_output` calls through the budget; fallback succeeds.
3. Primary succeeds on a corrective attempt; fallback not created.
4. No fallback configured: stage fails with the current error; attempts `success: false`.
5. Captured valid result is never retried on another model (#1350) — existing test stays green.
6. Durable resume/replay does not reuse an abandoned candidate's capture.
7. Existing `stops after three corrective prompts when structured_output is still missing`
   (`stage-runner-structured-output.test.ts:610`) stays at 4 prompts and gains a
   `success: false` assertion.

## 6. Relevant files

- packages/workflows/src/runs/foreground/stage-runner-context.ts
- packages/workflows/src/runs/foreground/stage-runner-controller.ts
- packages/workflows/src/runs/foreground/stage-runner-structured-output.ts
- packages/workflows/src/runs/foreground/stage-runner-messages.ts
- packages/coding-agent/src/core/model-fallback-failures.ts (failure classification;
  `isRetryableModelFailure`)
- test/unit/stage-runner-structured-output.test.ts
- test/unit/stage-runner-model-fallback-1.test.ts
- test/unit/stage-runner-fallback-resume.test.ts
- test/unit/stage-runner-helpers.ts
- packages/workflows/CHANGELOG.md (### Fixed under [Unreleased])
- packages/coding-agent/docs/workflows.md (model fallback / schema section, if it documents
  correction or fallback behavior)
