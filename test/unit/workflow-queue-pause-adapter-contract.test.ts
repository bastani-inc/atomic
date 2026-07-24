import { describe, test } from "bun:test";
import type { AgentSession } from "@bastani/atomic";
import type { StageSessionRuntime as PublicStageSessionRuntime } from "../../packages/workflows/src/authoring.ts";
import type { AgentSessionAdapter, InternalStageContext, StageSessionRuntime } from "./stage-runner-helpers.js";
import { assert, createStageContext, flushMicrotasks, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

type LegacyPublicRuntime = Omit<
    PublicStageSessionRuntime,
    "queuedMessagesPaused" | "pauseQueuedMessages" | "resumeQueuedMessages"
>;
type LegacyRuntimeRemainsCompatible = LegacyPublicRuntime extends PublicStageSessionRuntime ? true : false;
type PublicAgentSessionQueuePauseContract = AgentSession extends {
    readonly queuedMessagesPaused: boolean;
    pauseQueuedMessages(): void;
    resumeQueuedMessages(): Promise<boolean>;
} ? true : false;

const LEGACY_RUNTIME_REMAINS_COMPATIBLE: LegacyRuntimeRemainsCompatible = true;
const PUBLIC_AGENT_SESSION_QUEUE_PAUSE_CONTRACT_IS_EXPORTED: PublicAgentSessionQueuePauseContract = true;

function omitNativeQueuePause(session: StageSessionRuntime): StageSessionRuntime {
    const {
        queuedMessagesPaused: _queuedMessagesPaused,
        pauseQueuedMessages: _pauseQueuedMessages,
        resumeQueuedMessages: _resumeQueuedMessages,
        ...legacySession
    } = session;
    void [_queuedMessagesPaused, _pauseQueuedMessages, _resumeQueuedMessages];
    return legacySession;
}

describe("public workflow queue-pause adapter compatibility", () => {
    test("legacy custom adapters may omit the native queue-pause capability", async () => {
        assert.equal(LEGACY_RUNTIME_REMAINS_COMPATIBLE, true);
        assert.equal(PUBLIC_AGENT_SESSION_QUEUE_PAUSE_CONTRACT_IS_EXPORTED, true);
        const mock = makeMockSession();
        const legacySession = omitNativeQueuePause(mock.session);
        const adapter: AgentSessionAdapter = { async create() { return legacySession; } };
        const ctx = createStageContext(makeOpts({ adapters: { agentSession: adapter } })) as InternalStageContext;
        const prompt = ctx.prompt("legacy adapter prompt");
        await flushMicrotasks();

        await ctx.__requestPause();
        assert.equal(ctx.__isPaused(), true);
        assert.equal(mock.state.abortCalls, 1);
        await ctx.__resume();
        assert.equal(await prompt, "ok");
        assert.equal(ctx.__isPaused(), false);
    });

    test("fallback admission preserves verbatim ordered duplicate deliveries until resume", async () => {
        let rejectInitial: ((error: Error) => void) | undefined;
        const promptTexts: string[] = [];
        const mock = makeMockSession({
            async prompt(text) {
                mock.state.promptCalls += 1;
                promptTexts.push(text);
                if (mock.state.promptCalls === 1) {
                    return new Promise<void>((_resolve, reject) => { rejectInitial = reject; });
                }
            },
            async abort() {
                mock.state.abortCalls += 1;
                rejectInitial?.(new Error("AbortError"));
            },
        });
        const legacySession = omitNativeQueuePause(mock.session);
        const adapter: AgentSessionAdapter = { async create() { return legacySession; } };
        const ctx = createStageContext(makeOpts({ adapters: { agentSession: adapter } })) as InternalStageContext;
        const initial = ctx.prompt("initial custom-adapter prompt");
        await flushMicrotasks();
        await ctx.__requestPause();

        let firstSettled = false;
        const first = ctx.__sendUserMessage("\tduplicate payload  \n")
            .finally(() => { firstSettled = true; });
        const second = ctx.__sendUserMessage("\tduplicate payload  \n");
        await flushMicrotasks();

        assert.equal(mock.state.promptCalls, 1, "fallback prompts must not start while paused");
        assert.equal(firstSettled, false);
        await ctx.__resume();
        const [firstAction, secondAction] = await Promise.all([first, second, initial]);

        assert.equal(firstAction, "prompt");
        assert.equal(secondAction, "prompt");
        assert.deepEqual(promptTexts, [
            "initial custom-adapter prompt",
            "\tduplicate payload  \n",
            "\tduplicate payload  \n",
        ]);
        assert.equal(mock.state.promptCalls, 3);
    });
});
