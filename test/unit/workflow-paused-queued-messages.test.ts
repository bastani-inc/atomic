import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe } from "bun:test";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import {
    assert,
    createStageControlRegistry,
    createStore,
    deferred,
    pauseRun,
    resumeRun,
    run,
    test,
    waitForMicrotasks,
    RESUME_CONTINUATION_PROMPT,
    workflow,
} from "./executor-shared.js";

type QueueHold = {
    readonly steering: AgentMessage[];
    readonly followUp: AgentMessage[];
};

type PauseAwareSession = Harness["session"] & {
    readonly queuedMessagesPaused?: boolean;
    readonly _activeInterruptQueueHold?: QueueHold;
};


function assertExactHeldQueue(session: Harness["session"]): void {
    const hold = (session as PauseAwareSession)._activeInterruptQueueHold;
    assert.deepEqual(hold?.steering.map(getMessageText), [
        "first workflow steering",
        "second workflow steering",
    ]);
    assert.equal(hold?.followUp.length, 3);
    const [first, second, custom] = hold?.followUp ?? [];
    assert.notEqual(first, second, "duplicate entries must remain distinct queue items");
    assert.deepEqual([first, second].map(getMessageText), [
        "duplicate workflow follow-up",
        "duplicate workflow follow-up",
    ]);
    assert.equal(custom?.role, "custom");
    if (custom?.role !== "custom") return;
    assert.deepEqual(
        {
            role: custom.role,
            customType: custom.customType,
            content: custom.content,
            display: custom.display,
            details: custom.details,
        },
        {
            role: "custom",
            customType: "workflow-pause-raw-custom",
            content: [{ type: "text", text: "\tworkflow raw custom  \n" }],
            display: true,
            details: { optional: { untouched: true }, sequence: 3 },
        },
    );
}

describe("workflow paused queued messages", () => {
    test("the real stage handle pause holds raw queue order until its existing resume continuation", async () => {
        const harness = await createHarness();
        try {
            const providerStarted = deferred();
            harness.setResponses([
                async (_context, options) => {
                    providerStarted.resolve();
                    await new Promise<void>((resolve) => {
                        if (options?.signal?.aborted) resolve();
                        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
                    });
                    return fauxAssistantMessage("interrupted");
                },
                fauxAssistantMessage("resume continuation acknowledged"),
                fauxAssistantMessage("first steering handled"),
                fauxAssistantMessage("second steering handled"),
                fauxAssistantMessage("first duplicate handled"),
                fauxAssistantMessage("second duplicate handled"),
            ]);
            const registry = createStageControlRegistry();
            const store = createStore();
            const sawStage = deferred<{ runId: string; stageId: string }>();
            const definition = workflow({
                name: "paused-queued-message-regression",
                description: "",
                inputs: {},
                outputs: {},
                run: async (ctx) => {
                    await ctx.stage("paused-stage").prompt("start workflow stage");
                    return {};
                },
            });
            const runPromise = run(definition, {}, {
                adapters: {
                    agentSession: {
                        async create() {
                            return harness.session;
                        },
                    },
                },
                store,
                stageControlRegistry: registry,
                onStageStart: (runId, stage) => {
                    if (stage.name === "paused-stage") sawStage.resolve({ runId, stageId: stage.id });
                },
            });
            let runSettled = false;
            void runPromise.finally(() => {
                runSettled = true;
            });

            const [{ runId, stageId }] = await Promise.all([sawStage.promise, providerStarted.promise]);
            const handle = registry.get(runId, stageId);
            assert.ok(handle, "live stage handle should exist");
            await handle.steer("first workflow steering");
            await handle.steer("second workflow steering");
            await handle.followUp("duplicate workflow follow-up");
            await handle.followUp("duplicate workflow follow-up");
            await harness.session.sendCustomMessage(
                {
                    customType: "workflow-pause-raw-custom",
                    content: [{ type: "text", text: "\tworkflow raw custom  \n" }],
                    display: true,
                    details: { optional: { untouched: true }, sequence: 3 },
                },
                { deliverAs: "followUp" },
            );
            assert.deepEqual(harness.session.getSteeringMessages(), [
                "first workflow steering",
                "second workflow steering",
            ]);
            assert.deepEqual(harness.session.getFollowUpMessages(), [
                "duplicate workflow follow-up",
                "duplicate workflow follow-up",
            ]);
            assert.equal(harness.session.agent.hasQueuedMessages(), true);

            const pauseResult = await pauseRun(runId, { store, stageControlRegistry: registry });
            assert.equal(pauseResult.ok, true, "aggregate workflow pause routing should reach the live stage");

            assert.equal(handle.status, "paused");
            assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
            assert.equal(harness.getPendingResponseCount(), 5, "no queued model turn may start while paused");
            assert.equal((harness.session as PauseAwareSession).queuedMessagesPaused, true);
            assert.equal(harness.session.isStreaming, false);
            assert.equal(harness.session.agent.hasQueuedMessages(), false);
            assert.deepEqual(harness.session.getSteeringMessages(), [
                "first workflow steering",
                "second workflow steering",
            ]);
            assert.deepEqual(harness.session.getFollowUpMessages(), [
                "duplicate workflow follow-up",
                "duplicate workflow follow-up",
            ]);
            assertExactHeldQueue(harness.session);
            assert.equal(runSettled, false, "the active stage flow must remain suspended");

            const resumeResult = await resumeRun(runId, { store, stageControlRegistry: registry });
            assert.equal(resumeResult.ok, true, "aggregate workflow resume routing should release the live stage");
            const result = await runPromise;
            await waitForMicrotasks();

            assert.equal(result.status, "completed");
            assert.equal((harness.session as PauseAwareSession).queuedMessagesPaused, false);
            assert.equal(harness.getPendingResponseCount(), 0);
            assert.deepEqual(harness.session.getSteeringMessages(), []);
            assert.deepEqual(harness.session.getFollowUpMessages(), []);
            const deliveredQueue = harness.session.messages
                .filter((message) =>
                    (message.role === "user" && [
                        "first workflow steering",
                        "second workflow steering",
                        "duplicate workflow follow-up",
                    ].includes(getMessageText(message))) ||
                    (message.role === "custom" && message.customType === "workflow-pause-raw-custom"),
                )
                .map((message) => message.role === "custom" ? `custom:${message.customType}` : `user:${getMessageText(message)}`);
            assert.deepEqual(deliveredQueue, [
                "user:first workflow steering",
                "user:second workflow steering",
                "user:duplicate workflow follow-up",
                "user:duplicate workflow follow-up",
                "custom:workflow-pause-raw-custom",
            ]);
            assert.equal(
                harness.session.messages.filter(
                    (message) => message.role === "user" && getMessageText(message) === RESUME_CONTINUATION_PROMPT,
                ).length,
                1,
                "the existing resume continuation must run exactly once",
            );
            const deliveredCustom = harness.session.messages.filter(
                (message): message is Extract<AgentMessage, { role: "custom" }> =>
                    message.role === "custom" && message.customType === "workflow-pause-raw-custom",
            );
            assert.equal(deliveredCustom.length, 1, "resume callbacks must not double-deliver held work");
            assert.deepEqual(deliveredCustom[0]?.details, { optional: { untouched: true }, sequence: 3 });
        } finally {
            harness.cleanup();
        }
    });

    test("idle readiness-stage chat releases held raw work through one objective continuation", async () => {
        const harness = await createHarness();
        try {
            type SessionEvent = Parameters<Parameters<Harness["session"]["subscribe"]>[0]>[0];
            const emittingSession = harness.session as Harness["session"] & {
                _emit(event: SessionEvent): void;
            };
            const productionPrompt = harness.session.prompt.bind(harness.session);
            harness.session.prompt = async (text, options) => {
                await productionPrompt(text, options);
                if (text !== "enter readiness-stage chat") return;
                emittingSession._emit({
                    type: "tool_execution_start",
                    toolCallId: "readiness-pause-question",
                    toolName: "ask_user_question",
                    args: {},
                } as SessionEvent);
                emittingSession._emit({
                    type: "tool_execution_end",
                    toolCallId: "readiness-pause-question",
                    toolName: "ask_user_question",
                    result: { content: [], details: {} },
                    isError: false,
                } as SessionEvent);
            };
            harness.setResponses([
                fauxAssistantMessage("ready to wait for stage chat"),
                fauxAssistantMessage("paused objective continuation"),
                fauxAssistantMessage("held readiness work consumed"),
                fauxAssistantMessage("unexpected duplicate continuation"),
            ]);
            const registry = createStageControlRegistry();
            const store = createStore();
            const sawStage = deferred<{ runId: string; stageId: string }>();
            const enteredReadiness = deferred();
            const definition = workflow({
                name: "paused-idle-readiness-stage-chat",
                description: "",
                inputs: {},
                outputs: {},
                run: async (ctx) => {
                    await ctx.stage("readiness-chat").prompt("enter readiness-stage chat");
                    return {};
                },
            });
            const runPromise = run(definition, {}, {
                adapters: { agentSession: { async create() { return harness.session; } } },
                store,
                stageControlRegistry: registry,
                confirmStageReadiness: async () => {
                    enteredReadiness.resolve();
                    return false;
                },
                onStageStart: (runId, stage) => sawStage.resolve({ runId, stageId: stage.id }),
            });
            const [{ runId, stageId }] = await Promise.all([sawStage.promise, enteredReadiness.promise]);
            const handle = registry.get(runId, stageId);
            assert.ok(handle);
            await waitForMicrotasks();

            await handle.pause();
            await harness.session.steer("raw work held during readiness-stage chat");
            assert.equal(handle.status, "paused");
            assert.equal(harness.session.queuedMessagesPaused, true);
            assert.equal(harness.session.agent.hasQueuedMessages(), false);

            await handle.resume();
            const resumedWithoutExternalTurn = await Promise.race([
                runPromise.then(() => true),
                Bun.sleep(25).then(() => false),
            ]);
            if (!resumedWithoutExternalTurn) {
                await handle.prompt("cleanup stranded readiness-stage chat");
            }
            const result = await runPromise;

            assert.equal(resumedWithoutExternalTurn, true, "resume must wake the idle readiness-stage continuation");
            assert.equal(result.status, "completed");
            assert.equal(harness.session.queuedMessagesPaused, false);
            assert.equal(harness.session.messages.filter(
                (message) => message.role === "user" && getMessageText(message) === RESUME_CONTINUATION_PROMPT,
            ).length, 1);
            assert.equal(harness.session.messages.filter(
                (message) => message.role === "user" && getMessageText(message) === "raw work held during readiness-stage chat",
            ).length, 1);
            assert.equal(harness.getPendingResponseCount(), 2, "no duplicate objective continuation may consume a sentinel");
        } finally {
            harness.cleanup();
        }
    });

    for (const readinessGateEnabled of [false, true]) {
        test(`late direct AgentSession arrival schedules one continuation with readiness gate ${readinessGateEnabled ? "enabled" : "disabled"}`, async () => {
            const harness = await createHarness();
            try {
                const providerStarted = deferred();
                harness.setResponses([
                    async (_context, options) => {
                        providerStarted.resolve();
                        await new Promise<void>((resolve) => {
                            if (options?.signal?.aborted) resolve();
                            else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
                        });
                        return fauxAssistantMessage("late-arrival interrupted");
                    },
                    fauxAssistantMessage("late continuation one"),
                    fauxAssistantMessage("late direct steer consumed"),
                    fauxAssistantMessage("unexpected duplicate continuation"),
                ]);
                const registry = createStageControlRegistry();
                const store = createStore();
                const sawStage = deferred<{ runId: string; stageId: string }>();
                const definition = workflow({
                    name: `late-paused-arrival-${readinessGateEnabled ? "gate" : "no-gate"}`,
                    description: "",
                    inputs: {},
                    outputs: {},
                    run: async (ctx) => {
                        await ctx.stage("late-paused-stage").prompt("start late-arrival stage");
                        return {};
                    },
                });
                const runPromise = run(definition, {}, {
                    adapters: { agentSession: { async create() { return harness.session; } } },
                    store,
                    stageControlRegistry: registry,
                    ...(readinessGateEnabled ? { confirmStageReadiness: async () => true } : {}),
                    onStageStart: (runId, stage) => sawStage.resolve({ runId, stageId: stage.id }),
                });
                const [{ runId, stageId }] = await Promise.all([sawStage.promise, providerStarted.promise]);
                const handle = registry.get(runId, stageId);
                assert.ok(handle);
                await handle.pause();

                await harness.session.steer("late direct paused steer");
                assert.equal(harness.session.queuedMessagesPaused, true);
                assert.equal(harness.session.agent.hasQueuedMessages(), false);
                await handle.resume();
                const result = await runPromise;

                assert.equal(result.status, "completed");
                assert.equal(harness.session.messages.filter(
                    (message) => message.role === "user" && getMessageText(message) === "late direct paused steer",
                ).length, 1);
                assert.equal(harness.session.messages.filter(
                    (message) => message.role === "user" && getMessageText(message) === RESUME_CONTINUATION_PROMPT,
                ).length, 1);
            } finally {
                harness.cleanup();
            }
        });
    }
    for (const readinessGateEnabled of [false, true]) {
        test(`public stage delivery owns the post-pause turn with readiness gate ${readinessGateEnabled ? "enabled" : "disabled"}`, async () => {
            const harness = await createHarness();
            try {
                const providerStarted = deferred();
                harness.setResponses([
                    async (_context, options) => {
                        providerStarted.resolve();
                        await new Promise<void>((resolve) => {
                            if (options?.signal?.aborted) resolve();
                            else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
                        });
                        return fauxAssistantMessage("runner-owned turn interrupted");
                    },
                    fauxAssistantMessage("paused public delivery handled"),
                ]);
                const registry = createStageControlRegistry();
                const store = createStore();
                const sawStage = deferred<{ runId: string; stageId: string }>();
                const definition = workflow({
                    name: `paused-public-delivery-${readinessGateEnabled ? "gate" : "no-gate"}`,
                    description: "",
                    inputs: {},
                    outputs: {},
                    run: async (ctx) => {
                        await ctx.stage("public-delivery-stage").prompt("start public delivery race");
                        return {};
                    },
                });
                const runPromise = run(definition, {}, {
                    adapters: { agentSession: { async create() { return harness.session; } } },
                    store,
                    stageControlRegistry: registry,
                    ...(readinessGateEnabled ? { confirmStageReadiness: async () => true } : {}),
                    onStageStart: (runId, stage) => sawStage.resolve({ runId, stageId: stage.id }),
                });
                const [{ runId, stageId }] = await Promise.all([sawStage.promise, providerStarted.promise]);
                const handle = registry.get(runId, stageId);
                assert.ok(handle?.sendUserMessage);
                await handle.pause();

                let deliverySettled = false;
                const delivery = handle.sendUserMessage("public message accepted while paused")
                    .finally(() => { deliverySettled = true; });
                await waitForMicrotasks();

                assert.equal(deliverySettled, false);
                assert.equal(harness.getPendingResponseCount(), 1, "no provider turn starts before resume");
                await handle.resume();
                const [action, result] = await Promise.all([delivery, runPromise]);

                assert.equal(action, "prompt");
                assert.equal(result.status, "completed");
                assert.equal(harness.getPendingResponseCount(), 0);
                assert.equal(harness.session.messages.filter(
                    (message) => message.role === "user" && getMessageText(message) === "public message accepted while paused",
                ).length, 1);
                assert.equal(harness.session.messages.filter(
                    (message) => message.role === "user" && getMessageText(message) === RESUME_CONTINUATION_PROMPT,
                ).length, 0, "the accepted public turn replaces a separate objective continuation");
            } finally {
                harness.cleanup();
            }
        });
    }
});
