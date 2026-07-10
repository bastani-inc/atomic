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
    test.serial("registered workflow tool content elides empty send targets", async () => {
        const tool = await makeRegisteredWorkflowTool();

        const result = await tool.execute(
            "tool-content-send-empty-target",
            { action: "send", text: "hello" },
            undefined,
            undefined,
            {} as never,
        );

        assert.equal(result.details.action, "send");
        const textBlock = result.content[0];
        assert.equal(textBlock?.type, "text");
        const textContent = textBlock.type === "text" ? textBlock.text : "";
        assert.match(textContent, /^send: noop — /);
        assert.doesNotMatch(textContent, /^send:\s{2,}noop/);
    });

    test.serial("makeExecuteWorkflowTool kill without runId defaults to the active run", async () => {
        const runId = `kill-tool-active-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const handler = makeToolHandler();

        const result = await handler({ action: "kill" }, {} as never);

        assert.equal(result.action, "kill");
        const r = result as { action: string; status: string; runId: string };
        assert.equal(r.status, "killed");
        assert.equal(r.runId, runId);
        assert.equal(
            store.runs().find((run) => run.id === runId)?.status,
            "killed",
        );
    });

    test.serial("makeExecuteWorkflowTool kill supports unique run id prefixes", async () => {
        const runId = `kill-tool-prefix-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const handler = makeToolHandler();

        const result = await handler(
            { action: "kill", runId: runId.slice(0, 12) },
            {} as never,
        );

        assert.equal(result.action, "kill");
        const r = result as { action: string; status: string; runId: string };
        assert.equal(r.status, "killed");
        assert.equal(r.runId, runId);
        assert.equal(
            store.runs().find((run) => run.id === runId)?.status,
            "killed",
        );
    });

    test.serial("makeExecuteWorkflowTool kill supports all:true", async () => {
        const r1 = `kill-tool-all-1-${Date.now()}`;
        const r2 = `kill-tool-all-2-${Date.now()}`;
        const ended = `kill-tool-all-ended-${Date.now()}`;
        store.recordRunStart(makeInflightRun(r1));
        store.recordRunStart(makeInflightRun(r2));
        store.recordRunStart(makeInflightRun(ended));
        store.recordRunEnd(ended, "completed");
        const handler = makeToolHandler();

        const result = await handler(
            { action: "kill", all: true },
            {} as never,
        );

        assert.equal(result.action, "kill");
        const r = result as { action: string; status: string };
        assert.equal(r.status, "killed");
        assert.equal(
            store.runs().find((run) => run.id === r1)?.status,
            "killed",
        );
        assert.equal(
            store.runs().find((run) => run.id === r2)?.status,
            "killed",
        );
        assert.equal(
            store.runs().find((run) => run.id === ended)?.status,
            "completed",
        );
    });

    test.serial("makeExecuteWorkflowTool pause all reports noop when no runs are in flight", async () => {
        const handler = makeToolHandler();

        const result = await handler(
            { action: "pause", all: true },
            {} as never,
        );

        assert.equal(result.action, "pause");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.runId, "--all");
        assert.equal(r.status, "noop");
        assert.match(r.message, /No in-flight runs to pause/);
    });

    test.serial("makeExecuteWorkflowTool rejects all run-control with stageId", async () => {
        const runId = `pause-tool-all-stage-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const handler = makeToolHandler();

        const result = await handler(
            { action: "pause", all: true, stageId: "stage-a" },
            {} as never,
        );

        assert.equal(result.action, "pause");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.runId, "--all");
        assert.equal(r.status, "noop");
        assert.match(r.message, /Cannot pause --all with a stageId/);
        assert.equal(
            store.runs().find((run) => run.id === runId)?.status,
            "running",
        );
    });

    test.serial("makeExecuteWorkflowTool interrupt without runId defaults to the active run", async () => {
        const runId = `interrupt-tool-active-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const handler = makeToolHandler();

        const result = await handler({ action: "interrupt" }, {} as never);

        assert.equal(result.action, "interrupt");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.status, "noop");
        assert.equal(r.runId, runId);
        assert.match(r.message, /No active stages to interrupt/);
        assert.equal(
            store.runs().find((run) => run.id === runId)?.status,
            "running",
        );
    });

    test.serial("makeExecuteWorkflowTool pause reports pause wording for inactive stages", async () => {
        const runId = `pause-tool-inactive-stage-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-paused-1",
            name: "paused-stage",
            status: "paused",
            parentIds: [],
            toolEvents: [],
        });
        const { dispose } = registerLiveStageHandle(runId, "stage-paused-1", {
            status: "paused",
        });
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "pause", runId, stageId: "paused-stage" },
                {} as never,
            );

            assert.equal(result.action, "pause");
            const r = result as {
                action: string;
                status: string;
                message: string;
            };
            assert.equal(r.status, "noop");
            assert.match(r.message, /No active stages to pause/);
            assert.doesNotMatch(r.message, /interrupt/);
        } finally {
            dispose();
        }
    });

    test.serial("makeExecuteWorkflowTool lists and inspects workflow stages", async () => {
        const runId = `stage-tool-list-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-running-1",
            name: "scan",
            status: "running",
            parentIds: [],
            toolEvents: [],
            sessionFile: "/tmp/scan-session.jsonl",
        });
        store.recordStageStart(runId, {
            id: "stage-failed-1",
            name: "review",
            status: "failed",
            parentIds: [],
            toolEvents: [],
            error: "boom",
            sessionFile: "/tmp/review-session.jsonl",
        });
        const handler = makeToolHandler();

        const listResult = await handler(
            { action: "stages", runId, statusFilter: "failed" },
            {} as never,
        );
        assert.equal(listResult.action, "stages");
        const list = listResult as {
            action: string;
            stages: Array<{
                name: string;
                status: string;
                error?: string;
                sessionFile?: string;
                transcriptPath?: string;
            }>;
        };
        assert.deepEqual(
            list.stages.map((stage) => stage.name),
            ["review"],
        );
        assert.equal(list.stages[0]!.status, "failed");
        assert.equal(list.stages[0]!.sessionFile, "/tmp/review-session.jsonl");
        assert.equal(list.stages[0]!.transcriptPath, "/tmp/review-session.jsonl");

        const detailResult = await handler(
            { action: "stage", runId, stageId: "scan" },
            {} as never,
        );
        assert.equal(detailResult.action, "stage");
        const detail = detailResult as {
            action: string;
            stage?: {
                id: string;
                name: string;
                status: string;
                sessionFile?: string;
                transcriptPath?: string;
            };
        };
        assert.equal(detail.stage?.id, "stage-running-1");
        assert.equal(detail.stage?.status, "running");
        assert.equal(detail.stage?.sessionFile, "/tmp/scan-session.jsonl");
        assert.equal(detail.stage?.transcriptPath, "/tmp/scan-session.jsonl");
    });

});
