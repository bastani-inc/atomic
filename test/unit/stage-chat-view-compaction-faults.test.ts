import { describe, test } from "bun:test";
import type { AgentSession, AgentSessionEvent } from "@bastani/atomic";
import {
    assert,
    createStore,
    deriveGraphTheme,
    fakeFooterAgentSession,
    flush,
    makeHandle,
    setupRun,
    StageChatView,
    stripAnsi,
    submitStageChatText,
} from "./stage-chat-view-helpers.js";

function createView(agentSession: AgentSession) {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "running");
    const runtime = makeHandle(undefined, [], "running", agentSession);
    const view = new StageChatView({
        store,
        graphTheme: deriveGraphTheme({}),
        runId: "run-1",
        stageId: "stage-a",
        workflowName: "test-wf",
        handle: runtime.handle,
        onDetach: () => {},
        onClose: () => {},
    });
    return { view, ...runtime };
}

function rendered(view: StageChatView): string {
    return stripAnsi(view.render(96).join("\n"));
}

describe("StageChatView compaction fault containment", () => {
    test("cancelled /compact remains usable and can be retried", async () => {
        let compactCalls = 0;
        let abortCompactionCalls = 0;
        let finishCancelledAttempt: (() => void) | undefined;
        let emitEvent: (event: AgentSessionEvent) => void = () => {};
        const agentSession = Object.assign(fakeFooterAgentSession(false), {
            compact: async () => {
                compactCalls += 1;
                emitEvent({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
                if (compactCalls === 1) {
                    await new Promise<void>((_resolve, reject) => {
                        finishCancelledAttempt = () => {
                            emitEvent({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false } as AgentSessionEvent);
                            reject(new Error("Compaction cancelled"));
                        };
                    });
                } else {
                    emitEvent({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false } as AgentSessionEvent);
                }
                return {} as never;
            },
            abortCompaction: () => {
                abortCompactionCalls += 1;
                finishCancelledAttempt?.();
                finishCancelledAttempt = undefined;
            },
        }) as AgentSession;
        const { view, state, emit } = createView(agentSession);
        emitEvent = emit;

        submitStageChatText(view, "/compact");
        await flush();
        assert.equal(compactCalls, 1);
        assert.equal(view._hasAnimationTick, true);
        assert.match(rendered(view), /Compacting context\.\.\./);
        assert.doesNotMatch(rendered(view), /Working\.\.\./);

        assert.equal(view.handleInput("\x1b"), true);
        await flush();
        await flush();
        assert.equal(abortCompactionCalls, 1);
        assert.equal(view._hasAnimationTick, false);
        assert.equal(view._statusMessage, "Compaction cancelled");
        assert.equal(view._inputBuffer, "");

        submitStageChatText(view, "/compact");
        await flush();
        await flush();
        assert.equal(compactCalls, 2);
        assert.equal(view._hasAnimationTick, false);
        assert.equal(view._statusMessage, "");
        assert.deepEqual(state.promptCalls, []);
        assert.deepEqual(state.steerCalls, []);
        assert.deepEqual(state.followUpCalls, []);
        view.dispose();
    });

    test("malformed planner failure is event-owned and does not escape or duplicate", async () => {
        const failure = "Compaction failed: Compaction range planning returned malformed output (diagnostic: /tmp/planner.json)";
        let compactCalls = 0;
        let emitEvent: (event: AgentSessionEvent) => void = () => {};
        const agentSession = Object.assign(fakeFooterAgentSession(false), {
            compact: async () => {
                compactCalls += 1;
                emitEvent({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
                emitEvent({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: failure } as AgentSessionEvent);
                throw new Error("Compaction range planning returned malformed output");
            },
        }) as AgentSession;
        const { view, state, emit } = createView(agentSession);
        emitEvent = emit;

        submitStageChatText(view, "/compact");
        await flush();
        await flush();
        const output = rendered(view);
        assert.equal(compactCalls, 1);
        assert.equal(view._hasAnimationTick, false);
        assert.equal(view._statusMessage, failure);
        assert.equal(output.match(/Compaction failed:/g)?.length, 1);
        assert.doesNotMatch(output, /RangePlanError|Error:|Compacting context\.\.\./);
        assert.deepEqual(state.promptCalls, []);
        assert.deepEqual(state.steerCalls, []);
        assert.deepEqual(state.followUpCalls, []);
        view.dispose();
    });
});
