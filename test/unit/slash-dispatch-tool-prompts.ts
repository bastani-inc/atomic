// @ts-nocheck
import { describe, test } from "bun:test";
import {
    installSlashDispatchTestHooks,
    assert,
    parseWorkflowArgs,
    tokenizeWorkflowArgs,
    makeExecuteWorkflowTool,
    workflowPolicyFromContext,
    WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
    renderResult,
    createRegistry,
    workflow,
    Type,
    createExtensionRuntime,
    store,
    restoreOnSessionStart,
    WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
    WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
    LIFECYCLE_NOTICE_CUSTOM_TYPE,
    stageControlRegistry,
    stageUiBroker,
    buildStagePromptAdapter,
    jobTracker,
    mkdtemp,
    rm,
    writeFile,
    tmpdir,
    join,
    makeInflightRun,
    registerWorkflowCommand,
    recordTerminalRun,
    registerTestStageHandle,
    makeRegisteredWorkflowTool,
    makeRegisteredWorkflowToolWithResource,
    registerLiveStageHandle,
    waitForToolPrompt,
    waitForToolRunEnded,
    buildMockPi,
    buildCtx,
    addFactoryStubs,
    fakeAgentSession,
    runFactory,
    writeWorkflowFixture,
} from "./slash-dispatch-utils.js";
import type {
    ExtensionAPI,
    PiArgumentCompletion,
    PiCommandContext,
    PiCommandOptions,
    PiToolOpts,
    WorkflowToolArgs,
    WorkflowDefinition,
    WorkflowPersistencePort,
    ExtensionRuntime,
    ChatSurfacePayload,
    SessionEntry,
    PiCustomComponent,
    PiCustomOverlayFactoryTui,
    PiCustomOverlayFunction,
    PiCustomOverlayOptions,
    PiOverlayHandle,
    StageSessionRuntime,
    StageControlHandle,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("tool run-control actions", () => {
    function makeToolHandler() {
        const registry = createRegistry([]);
        const runtime = createExtensionRuntime({ registry });
        return makeExecuteWorkflowTool(
            runtime,
            () => undefined,
        );
    }

    function makeDispatchTrackingWorkflowHandler(): {
        handler: ReturnType<typeof makeExecuteWorkflowTool>;
        wasDispatched: () => boolean;
    } {
        let dispatched = false;
        const runtime = {
            dispatch: async () => {
                dispatched = true;
                return {
                    action: "run",
                    runId: "unexpected",
                    status: "running",
                    stages: [],
                };
            },
        } as unknown as ExtensionRuntime;

        return {
            handler: makeExecuteWorkflowTool(
                runtime,
                () => undefined,
            ),
            wasDispatched: () => dispatched,
        };
    }

    function restoreWorkflowStageGuard(
        previousGuard: string | undefined,
    ): void {
        if (previousGuard === undefined) {
            delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
            return;
        }
        process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousGuard;
    }

    function assertWorkflowToolBlocked(
        result: WorkflowToolResult,
        wasDispatched: () => boolean,
    ): void {
        assert.equal(wasDispatched(), false);
        assert.match(
            (result as { error?: string }).error ?? "",
            /workflows cannot invoke workflows/,
        );
    }
    test.serial("makeExecuteWorkflowTool answers stage pending prompts", async () => {
        const runId = `stage-tool-send-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-1",
            name: "ask",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-1", {
            id: "prompt-1",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            { action: "send", runId, stageId: "ask", text: "42" },
            {} as never,
        );

        assert.equal(result.action, "send");
        const send = result as {
            action: string;
            delivery: string;
            status: string;
            message: string;
        };
        assert.equal(send.delivery, "answer");
        assert.equal(send.status, "ok");
        assert.match(send.message, /Answered prompt/);
        const stage = store
            .runs()
            .find((run) => run.id === runId)
            ?.stages.find((s) => s.id === "stage-prompt-1");
        assert.equal(stage?.pendingPrompt, undefined);
        assert.equal(
            store.getStagePromptAnswer(runId, "stage-prompt-1")?.answerSource,
            "workflow_tool",
        );
    });

    test.serial("makeExecuteWorkflowTool refuses workflow send answers for custom prompt nodes", async () => {
        const runId = `stage-tool-send-custom-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-custom-prompt",
            name: "custom",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
            awaitingInputSince: Date.now(),
            promptFootprint: {
                id: "custom-prompt-1",
                kind: "custom",
                message: "Custom widget",
                customIdentityHash: "hash",
                customIdentitySource: "caller",
                createdAt: Date.now(),
            },
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "send",
                runId,
                stageId: "custom",
                promptId: "custom-prompt-1",
                delivery: "answer",
                response: { value: "not-supported" },
            },
            {} as never,
        );

        assert.equal(result.action, "send");
        const send = result as {
            action: string;
            delivery: string;
            status: string;
            message: string;
        };
        assert.equal(send.delivery, "answer");
        assert.equal(send.status, "noop");
        assert.match(send.message, /requires the interactive workflow graph/);
        assert.equal(store.getStagePromptAnswer(runId, "stage-custom-prompt"), undefined);
    });

    test.serial("makeExecuteWorkflowTool tags brokered prompt answers as workflow-tool sourced", async () => {
        const runId = `stage-tool-send-broker-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-broker-prompt",
            name: "ask",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        const adapter = buildStagePromptAdapter(
            "ask-1",
            "ask_user_question",
            {
                questions: [
                    {
                        question: "What color?",
                        options: [{ label: "Red" }, { label: "Blue" }],
                    },
                ],
            },
            1,
        )!;
        stageUiBroker.provideStagePrompt(runId, "stage-broker-prompt", adapter);
        const events: Array<{ answerSource?: string }> = [];
        const unsubscribe = stageUiBroker.onStagePromptResolved((event) => {
            if (
                event.runId === runId &&
                event.stageId === "stage-broker-prompt"
            ) {
                events.push({ answerSource: event.answerSource });
            }
        });
        const pending = stageUiBroker.requestCustomUi(
            runId,
            "stage-broker-prompt",
            () => ({
                render: () => [],
                invalidate: () => {},
            }),
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "send", runId, stageId: "ask", text: "Blue" },
                {} as never,
            );
            await pending;

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
                message: string;
            };
            assert.equal(send.delivery, "answer");
            assert.equal(send.status, "ok");
            assert.match(send.message, /Answered input request/);
            assert.equal(events[0]?.answerSource, "workflow_tool");
        } finally {
            unsubscribe();
        }
    });

    test.serial("makeExecuteWorkflowTool leaves pending prompts untouched when payload is omitted", async () => {
        const runId = `stage-tool-send-omitted-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-omitted",
            name: "ask-omitted",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-omitted", {
            id: "prompt-omitted",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            { action: "send", runId, stageId: "ask-omitted" },
            {} as never,
        );

        assert.equal(result.action, "send");
        const send = result as {
            action: string;
            delivery: string;
            status: string;
            message: string;
        };
        assert.equal(send.delivery, "answer");
        assert.equal(send.status, "noop");
        assert.match(send.message, /requires text, response, or message/);
        const stage = store
            .runs()
            .find((run) => run.id === runId)
            ?.stages.find((s) => s.id === "stage-prompt-omitted");
        assert.equal(stage?.pendingPrompt?.id, "prompt-omitted");
    });

    test.serial("makeExecuteWorkflowTool delivery answer without a pending prompt does not fall through to live followUp", async () => {
        const runId = `stage-tool-send-answer-no-prompt-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-no-prompt",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { followUps, dispose } = registerLiveStageHandle(
            runId,
            "stage-no-prompt",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                {
                    action: "send",
                    runId,
                    stageId: "ask",
                    delivery: "answer",
                    text: "42",
                },
                {} as never,
            );

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
                message: string;
            };
            assert.equal(send.delivery, "answer");
            assert.equal(send.status, "noop");
            assert.match(send.message, /No pending prompt/);
            assert.deepEqual(followUps, []);
        } finally {
            dispose();
        }
    });

    test.serial("makeExecuteWorkflowTool auto delivery without a targeted prompt starts an idle live prompt", async () => {
        const runId = `stage-tool-send-auto-live-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-auto-live",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { followUps, prompts, dispose } = registerLiveStageHandle(
            runId,
            "stage-auto-live",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "send", runId, stageId: "ask", text: "next" },
                {} as never,
            );

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
                message: string;
            };
            assert.equal(send.delivery, "prompt");
            assert.equal(send.status, "ok");
            assert.equal(send.message, "Prompt started for stage.");
            assert.deepEqual(prompts, ["next"]);
            assert.deepEqual(followUps, []);
        } finally {
            dispose();
        }
    });

});
