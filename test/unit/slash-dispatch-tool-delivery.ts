// @ts-nocheck
import { describe, test } from "bun:test";
import {
    assert,
    parseWorkflowArgs,
    tokenizeWorkflowArgs,
    makeExecuteWorkflowTool,
    workflowPolicyFromContext,
    WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
    renderResult,
    createRegistry,
    defineWorkflow,
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

describe("tool run-control actions", () => {
    function makeToolHandler() {
        const registry = createRegistry([]);
        const runtime = createExtensionRuntime({ registry });
        return makeExecuteWorkflowTool(
            runtime,
            () => undefined,
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
    test.serial("makeExecuteWorkflowTool sends explicit prompt delivery to live handles", async () => {
        const runId = `stage-tool-send-prompt-live-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-live",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { followUps, prompts, steers, dispose } = registerLiveStageHandle(
            runId,
            "stage-prompt-live",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                {
                    action: "send",
                    runId,
                    stageId: "ask",
                    delivery: "prompt",
                    text: "start next",
                },
                {} as never,
            );

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
            };
            assert.equal(send.delivery, "prompt");
            assert.equal(send.status, "ok");
            assert.deepEqual(prompts, ["start next"]);
            assert.deepEqual(steers, []);
            assert.deepEqual(followUps, []);
        } finally {
            dispose();
        }
    });

    test.serial("makeExecuteWorkflowTool sends explicit steer delivery to live handles", async () => {
        const runId = `stage-tool-send-steer-live-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-steer-live",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { followUps, prompts, steers, dispose } = registerLiveStageHandle(
            runId,
            "stage-steer-live",
            { isStreaming: true },
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                {
                    action: "send",
                    runId,
                    stageId: "ask",
                    delivery: "steer",
                    text: "adjust course",
                },
                {} as never,
            );

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
            };
            assert.equal(send.delivery, "steer");
            assert.equal(send.status, "ok");
            assert.deepEqual(steers, ["adjust course"]);
            assert.deepEqual(prompts, []);
            assert.deepEqual(followUps, []);
        } finally {
            dispose();
        }
    });

    test.serial("makeExecuteWorkflowTool promptId mismatch does not fall through to live followUp", async () => {
        const runId = `stage-tool-send-prompt-mismatch-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-mismatch",
            name: "ask",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-mismatch", {
            id: "prompt-real",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const { followUps, dispose } = registerLiveStageHandle(
            runId,
            "stage-prompt-mismatch",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                {
                    action: "send",
                    runId,
                    stageId: "ask",
                    promptId: "prompt-missing",
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
            assert.match(
                send.message,
                /No matching pending prompt prompt-missing/,
            );
            assert.deepEqual(followUps, []);
            const stage = store
                .runs()
                .find((run) => run.id === runId)
                ?.stages.find((s) => s.id === "stage-prompt-mismatch");
            assert.equal(stage?.pendingPrompt?.id, "prompt-real");
        } finally {
            dispose();
        }
    });

    test.serial("makeExecuteWorkflowTool treats explicit empty text prompt payload as an answer", async () => {
        const runId = `stage-tool-send-empty-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-empty",
            name: "ask-empty",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-empty", {
            id: "prompt-empty",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            { action: "send", runId, stageId: "ask-empty", text: "" },
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
            ?.stages.find((s) => s.id === "stage-prompt-empty");
        assert.equal(stage?.pendingPrompt, undefined);
    });

    test.serial("makeExecuteWorkflowTool treats explicit empty response prompt payload as an answer", async () => {
        const runId = `stage-tool-send-empty-response-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-empty-response",
            name: "ask-empty-response",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-empty-response", {
            id: "prompt-empty-response",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "send",
                runId,
                stageId: "ask-empty-response",
                response: "",
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
        assert.equal(send.status, "ok");
        assert.match(send.message, /Answered prompt/);
        const stage = store
            .runs()
            .find((run) => run.id === runId)
            ?.stages.find((s) => s.id === "stage-prompt-empty-response");
        assert.equal(stage?.pendingPrompt, undefined);
    });

    test.serial("makeExecuteWorkflowTool ignores explicit undefined prompt payloads", async () => {
        const runId = `stage-tool-send-undefined-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-undefined",
            name: "ask-undefined",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-undefined", {
            id: "prompt-undefined",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "send",
                runId,
                stageId: "ask-undefined",
                text: undefined,
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
        assert.match(send.message, /requires text, response, or message/);
        const stage = store
            .runs()
            .find((run) => run.id === runId)
            ?.stages.find((s) => s.id === "stage-prompt-undefined");
        assert.equal(stage?.pendingPrompt?.id, "prompt-undefined");
    });

});
