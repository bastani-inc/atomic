I’m unable to write the requested markdown file because this subagent has read/search/list tools only and no file write/edit tool. Below are the findings to place in:

`research/docs/2026-07-08-overflow-fallback-regression-test-plan.md`

## Pattern Examples: Overflow Fallback Regression Coverage

### Current stage-level overflow fallback tests

**Found in**: `test/unit/stage-runner-overflow-fallback.test.ts:5-77`  
**Used for**: Workflow stage model fallback after `compaction_end.unresolvedOverflow`.

```ts
describe("createStageContext — overflow fallback", () => {
    test("unresolved overflow compaction advances to the next fallback tier", async () => {
        const calls: string[] = [];
        const disposed: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const model = String(options.model);
                calls.push(model);
                const mock = makeMockSession({
                    async prompt() {
                        if (model === "anthropic/primary") {
                            mock.emit({
                                type: "compaction_end",
                                reason: "overflow",
                                result: undefined,
                                aborted: false,
                                willRetry: false,
                                unresolvedOverflow: true,
                                errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
                            });
                        }
                    },
                    dispose() { disposed.push(model); },
                    getLastAssistantText() { return model === "openai/fallback" ? "fallback answer" : undefined; },
                });
                return mock.session;
            },
        };

        const ctx = createStageContext(makeOpts({
            adapters: { agentSession },
            stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
        })) as InternalStageContext;

        assert.equal(await ctx.prompt("go"), "fallback answer");
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
        assert.deepEqual(disposed, ["anthropic/primary"]);
        assert.deepEqual(ctx.__modelFallbackMeta().modelAttempts?.map((attempt) => attempt.success), [false, true]);
    });
```

**Also covers exhausted tiers**: `test/unit/stage-runner-overflow-fallback.test.ts:45-76`

```ts
test("exhausted overflow fallback tiers stop with a terminal context error", async () => {
    // ...
    await assert.rejects(() => ctx.prompt("go"), /overflow exhausted on openai\/fallback/);
    assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
    assert.deepEqual(ctx.__modelFallbackMeta().modelAttempts?.map((attempt) => attempt.success), [false, false]);
});
```

**Current gaps**:

- Uses mocked `AgentSessionAdapter` / `makeMockSession`, not real `AgentSession`.
- Emits `compaction_end` synchronously inside `prompt`; does not cover deferred auto-compaction retry with timers.
- Does not exercise actual provider overflow classification or real `_checkCompaction`.
- Exhausted-tier assertion exists at stage layer, but not with a real auto-compaction failure source.

---

### Test helper pattern: stage mock session

**Found in**: `test/unit/stage-runner-helpers.ts:64-132`  
**Used for**: Mocking stage session runtime with controllable prompt/abort/events.

```ts
export function makeMockSession(overrides: Partial<StageSessionRuntime> = {}) {
    const state = {
        promptCalls: 0,
        abortCalls: 0,
        resolvers: [] as Array<() => void>,
    };
    const listeners = new Set<(e: { type: string; [k: string]: unknown }) => void>();

    const session: StageSessionRuntime = {
        async prompt() {
            state.promptCalls += 1;
            return new Promise<void>((resolve, reject) => {
                state.resolvers.push(resolve);
                (session as { __reject?: (err: Error) => void }).__reject = reject;
            });
        },
        subscribe(listener) {
            listeners.add(listener as never);
            return () => listeners.delete(listener as never);
        },
        async abort() {
            state.abortCalls += 1;
            const reject = (session as { __reject?: (err: Error) => void }).__reject;
            reject?.(new Error("AbortError"));
        },
        dispose() {},
        getLastAssistantText() {
            return "ok";
        },
        ...overrides,
    };

    const emit = (event: { type: string; [k: string]: unknown }): void => {
        for (const listener of listeners) listener(event);
    };

    return { session, state, emit };
}
```

**Reusable for**:

- Synchronous unresolved overflow fallback.
- Controlled pause while prompt is in-flight.
- Exhausted fallback tiers.

---

### Real AgentSession + fake timers auto-compaction pattern

**Found in**: `packages/coding-agent/test/agent-session-auto-compaction-queue-01.suite.ts:88-121`  
**Used for**: Real `AgentSession` setup with `vi.useFakeTimers()`.

```ts
beforeEach(() => {
    compactionMocks.contextCompact.mockClear();
    tempDir = join(tmpdir(), `pi-auto-compaction-queue-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    vi.useFakeTimers();

    const model = getModel("anthropic", "claude-sonnet-4-5")!;
    const agent = new Agent({
        initialState: {
            model,
            systemPrompt: "Test",
            tools: [],
        },
    });

    sessionManager = SessionManager.inMemory();
    const settingsManager = SettingsManager.create(tempDir, tempDir);
    const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", "test-key");
    const modelRegistry = ModelRegistry.create(authStorage, tempDir);

    session = new AgentSession({
        agent,
        sessionManager,
        settingsManager,
        cwd: tempDir,
        modelRegistry,
        resourceLoader: createTestResourceLoader(),
    });
});

afterEach(() => {
    session.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true });
    }
});
```

**Timer probe coverage**: `packages/coding-agent/test/agent-session-auto-compaction-queue-01.suite.ts:189-230`

```ts
it("should resume when compaction_end listener asynchronously queues work before the deferred probe", async () => {
    session.subscribe((event) => {
        if (event.type !== "compaction_end" || event.reason !== "threshold") return;
        setTimeout(() => {
            session.agent.followUp({
                role: "custom",
                customType: "test",
                content: [{ type: "text", text: "Queued after compaction_end" }],
                display: false,
                timestamp: Date.now(),
            });
        }, 0);
    });

    const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
    const drainSpy = vi.spyOn(
        session as unknown as { _continueQueuedAgentMessages: () => Promise<void> },
        "_continueQueuedAgentMessages",
    ).mockResolvedValue();

    await runAutoCompaction("threshold", false);

    await vi.advanceTimersByTimeAsync(0);
    expect(session.agent.hasQueuedMessages()).toBe(true);

    await vi.advanceTimersByTimeAsync(100);

    expect(continueSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledTimes(1);
});
```

**Current gaps**:

- Existing deferred probe tests are for threshold compaction, not overflow fallback.
- Tests mock `contextCompact`; they do not combine real provider overflow → auto-compaction retry → unresolved overflow → workflow fallback.
- No test currently wires this timer path into `createStageContext` model fallback behavior.

---

### Real AgentSession + faux provider deterministic overflow eviction pattern

**Found in**: `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:22-116`  
**Used for**: Real `AgentSession`, `registerFauxProvider`, missing auth, deterministic overflow eviction tier.

```ts
describe("AgentSession auth-missing overflow deterministic eviction", () => {
    let session: AgentSession;
    let sessionManager: SessionManager;
    let tempDir: string;
    let unregister: (() => void) | undefined;
    let events: AgentSessionEvent[];

    beforeEach(() => {
        tempDir = join(tmpdir(), `atomic-overflow-eviction-${Date.now()}`);
        mkdirSync(tempDir, { recursive: true });
        events = [];
        const faux = registerFauxProvider();
        unregister = () => faux.unregister();
        const model = { ...faux.getModel(), contextWindow: 200, maxInputTokens: 200 };
        const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });
        sessionManager = SessionManager.inMemory();
        const settingsManager = SettingsManager.create(tempDir, tempDir);
        settingsManager.applyOverrides({ compaction: { reserveTokens: 20 } });
        const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
        const modelRegistry = ModelRegistry.create(authStorage, tempDir);
        session = new AgentSession({
            agent,
            sessionManager,
            settingsManager,
            cwd: tempDir,
            modelRegistry,
            resourceLoader: createTestResourceLoader(),
        });
        session.subscribe((event) => events.push(event));
    });
```

**Terminal no-preparable overflow**: `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:73-83`

```ts
it("surfaces a terminal overflow error when no compactable transcript can be prepared", async () => {
    seedUnpreparableBranch();
    await (session as unknown as AutoCompactionSurface)._runAutoCompaction("overflow", false);

    const end = events.find((event) => event.type === "compaction_end" && event.reason === "overflow");
    expect(end).toMatchObject({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false });
    if (end?.type !== "compaction_end") throw new Error("missing compaction_end");
    expect(end.errorMessage).toContain("Context overflow recovery failed");
    expect(end.errorMessage).toContain("nothing more was safely deletable");
    expect(sessionManager.getEntries().filter((entry) => entry.type === "context_compaction")).toHaveLength(0);
});
```

**Deterministic tier-4 success**: `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:95-105`

```ts
it("commits deterministic tier-4 eviction for overflow auto-compaction when auth is missing", async () => {
    seedCompactableBranch();
    await (session as unknown as AutoCompactionSurface)._runAutoCompaction("overflow", false);

    const end = events.find((event) => event.type === "compaction_end" && event.reason === "overflow");
    expect(end).toMatchObject({ type: "compaction_end", reason: "overflow", aborted: false });
    expect(end && "errorMessage" in end ? end.errorMessage : undefined).toBeUndefined();
    if (end?.type !== "compaction_end") throw new Error("missing compaction_end");
    expect(end.result).toBeDefined();
    expect(sessionManager.getEntries().filter((entry) => entry.type === "context_compaction")).toHaveLength(1);
});
```

**Current gaps**:

- Covers deterministic tier-4 success and no-preparable terminal failure.
- Does not cover exhausted fallback tiers at workflow stage with real `AgentSession`.
- Does not cover deferred retry timers.
- Does not cover planner provider overflow degradation path.

---

### Auto-compaction unresolved overflow implementation points

**Found in**: `packages/coding-agent/src/core/agent-session-auto-compaction.ts:43-72`  
**Used for**: Detect context overflow, one compact-and-retry attempt, then unresolved overflow event.

```ts
if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
    const willRetry = assistantMessage.stopReason !== "stop";
    if (!willRetry) {
        await this._runAutoCompaction("overflow", false);
        return;
    }

    if (this._overflowRecoveryAttempted) {
        this._emit({
            type: "compaction_end",
            reason: "overflow",
            result: undefined,
            aborted: false,
            willRetry: false,
            unresolvedOverflow: true,
            errorMessage:
                "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
        });
        return;
    }

    this._overflowRecoveryAttempted = true;
    const messages = this.agent.state.messages;
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        this.agent.state.messages = messages.slice(0, -1);
    }
    await this._runAutoCompaction("overflow", willRetry);
    return;
}
```

**Deferred continuation timer**: `packages/coding-agent/src/core/agent-session-auto-compaction.ts:140-159`

```ts
export function _schedulePostAutoCompactionContinuationProbe(
    this: AgentSession,
    _reason: "overflow" | "threshold",
    willRetry: boolean,
): void {
    setTimeout(() => {
        if (this.isCompacting || this.isStreaming) {
            return;
        }

        if (willRetry) {
            this._resumeAfterAutoCompaction();
            return;
        }

        if (!this.agent.hasQueuedMessages()) {
            return;
        }

        this._resumeAfterAutoCompaction();
    }, 100);
}
```

**Unresolved overflow event on failed/no-result overflow compaction**: `packages/coding-agent/src/core/agent-session-auto-compaction.ts:181-229`

```ts
function overflowUnresolved(reason: "overflow" | "threshold", aborted = false): boolean | undefined {
    return reason === "overflow" && !aborted ? true : undefined;
}

// ...

if (!result) {
    this._emit({
        type: "compaction_end",
        reason,
        result: undefined,
        aborted: false,
        willRetry: false,
        unresolvedOverflow: overflowUnresolved(reason),
    });
    return;
}
```

**Failure path**: `packages/coding-agent/src/core/agent-session-auto-compaction.ts:239-254`

```ts
this._emit({
    type: "compaction_end",
    reason,
    result: undefined,
    aborted,
    willRetry: false,
    unresolvedOverflow: overflowUnresolved(reason, aborted),
    errorMessage: aborted
        ? undefined
        : reason === "overflow"
            ? `Context overflow recovery failed: ${errorMessage}`
            : `Auto-compaction failed: ${errorMessage}`,
});
```

---

### Compaction planner overflow deterministic degradation

**Found in**: `packages/coding-agent/src/core/compaction/context-compaction-runner.ts:154-272`  
**Used for**: Planner run records provider overflow instead of throwing immediately.

```ts
try {
    await agent.prompt(promptMessage);
} catch (error) {
    if (signal?.aborted) throw new Error("Context compaction failed: Request was aborted");
    const errorMessage = formatErrorMessage(error);
    const formattedErrorMessage = formatCopilotProviderError(model.provider, errorMessage);
    if (isContextCompactionOverflowError(model, errorMessage)) {
        return {
            validatedResult: deletionTool.getValidatedResult(),
            lastToolError: deletionTool.getLastError(),
            providerError: formattedErrorMessage,
            providerOverflow: true,
        };
    }
    throw new Error(`Context compaction failed: ${formattedErrorMessage}`);
}
```

**Assistant state-message overflow path**: `packages/coding-agent/src/core/compaction/context-compaction-runner.ts:248-260`

```ts
if (agent.state.errorMessage) {
    const formattedErrorMessage = formatCopilotProviderError(model.provider, agent.state.errorMessage);
    if (isContextCompactionOverflowError(model, agent.state.errorMessage)) {
        return {
            validatedResult: deletionTool.getValidatedResult(),
            lastToolError: deletionTool.getLastError(),
            providerError: formattedErrorMessage === agent.state.errorMessage ? undefined : formattedErrorMessage,
            providerOverflow: true,
        };
    }
    throw new Error(`Context compaction failed: ${formattedErrorMessage}`);
}
```

**Degradation ladder**: `packages/coding-agent/src/core/compaction/context-compaction-runner.ts:312-377`

```ts
const standardRun = await runContextDeletionAssistant(...);
if (targetMetAcceptedForLadder(standardRun, parameters, ladder)) return standardRun.validatedResult;
if (feasibleAccepted(standardRun.validatedResult, ladder?.acceptanceTokenBudget)) return standardRun.validatedResult;
skipCriticalPlanner = standardRun.providerOverflow;
attempts.push({ ...standardRun });

// ...

if (!skipCriticalPlanner) {
    const criticalRun = await runContextDeletionAssistant(...);
    if (targetMetAcceptedForLadder(criticalRun, parameters, ladder)) return criticalRun.validatedResult;
    if (feasibleAccepted(criticalRun.validatedResult, ladder.criticalEvictionTokenBudget)) return criticalRun.validatedResult;
    attempts.push({ ...criticalRun });
}

try {
    return runDeterministicContextEviction(transcript, ladder.criticalEvictionTokenBudget);
} catch (error) {
    const message = error instanceof Error ? error.message : formatErrorMessage(error);
    throw new Error(`${formatContextCompactionTargetFailureMessage(attempts, parameters)}; ${message}`);
}
```

**Current gaps**:

- No located test directly asserts planner provider overflow sets `providerOverflow`, skips critical planner, and reaches deterministic eviction.
- No located test covers both variants:
  - overflow thrown by provider stream before `agent.prompt` completes,
  - overflow surfaced via `agent.state.errorMessage`.
- Existing deterministic eviction test covers missing-auth path, not planner-overflow degradation.

---

### Controlled pause patterns

**Found in**: `test/unit/stage-runner-controlled-pause.test.ts:11-14` and related stage runner tests.  
**Used for**: `__requestPause` aborting active SDK call without finalizing stage.

Search hits:

- `test/unit/stage-runner-controlled-pause.test.ts:11`
- `test/unit/stage-runner-errors.test.ts:94`
- `test/unit/stage-runner-model-fallback-2.test.ts:55`
- `test/unit/executor-concurrency-limiter.test.ts:310`

**Relevant existing fallback pause test**: `test/unit/stage-runner-model-fallback-2.test.ts:55`

```ts
test("controlled pause/resume ignores stale aborted assistant messages when fallback is enabled", async () => {
    // existing pattern for pause/resume + fallback interaction
});
```

**Current gaps**:

- Existing controlled pause tests do not specifically cover unresolved overflow event during pause.
- No located regression test asserts that a controlled pause during unresolved overflow does not advance fallback tiers or does not mark terminal failure incorrectly.
- Mock session helper supports abort tracking (`test/unit/stage-runner-helpers.ts:117-122`) and can be reused.

---

## Regression Coverage Gaps Summary

1. **Synchronous unresolved overflow fallback**
   - Covered at stage layer by `test/unit/stage-runner-overflow-fallback.test.ts:6-43`.
   - Gap: only mock session; no real `AgentSession`.

2. **Deferred auto-compaction retry overflow fallback with timers / real AgentSession / faux provider**
   - Timer patterns exist in `packages/coding-agent/test/agent-session-auto-compaction-queue-01.suite.ts:189-230`.
   - Real faux provider pattern exists in `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:29-50`.
   - Gap: no test combines real `AgentSession`, timer-driven post-compaction retry, second overflow unresolved event, and workflow fallback.

3. **Exhausted fallback tiers**
   - Covered at stage mock layer in `test/unit/stage-runner-overflow-fallback.test.ts:45-76`.
   - Gap: not covered with real auto-compaction source or real session events.

4. **Compaction-planner overflow deterministic degradation**
   - Implementation is in `context-compaction-runner.ts:229-260` and `context-compaction-runner.ts:312-377`.
   - Gap: no located direct test for thrown planner overflow or assistant state-message overflow degrading deterministically.

5. **Controlled pause during unresolved overflow**
   - Controlled pause patterns exist in stage tests.
   - Gap: no located test specifically combines `__requestPause`, unresolved overflow `compaction_end`, and model fallback behavior.