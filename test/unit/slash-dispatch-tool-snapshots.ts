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
    test.serial("makeExecuteWorkflowTool returns no truncation marker for tail zero", async () => {
        const runId = `stage-tool-transcript-tail-zero-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-tail-zero-1",
            name: "tail-zero",
            status: "completed",
            parentIds: [],
            toolEvents: [
                {
                    name: "read",
                    output: "file contents",
                    startedAt: 1,
                    endedAt: 2,
                },
            ],
            result: "done",
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "tail-zero",
                tail: 0,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: unknown[];
            truncated: boolean;
        };
        assert.equal(transcript.truncated, false);
        assert.deepEqual(transcript.entries, []);
    });

    test.serial("makeExecuteWorkflowTool returns final snapshot error after timestamped tools", async () => {
        const runId = `stage-tool-transcript-error-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-error-1",
            name: "review",
            status: "failed",
            parentIds: [],
            toolEvents: [
                { name: "grep", output: "matches", startedAt: 10, endedAt: 11 },
            ],
            error: "boom",
            endedAt: 12,
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "review",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: Array<{ role: string; text?: string; timestamp?: number }>;
            truncated: boolean;
        };
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [
            { role: "notice", text: "boom", timestamp: 12 },
        ]);
    });

    test.serial("makeExecuteWorkflowTool keeps terminal snapshot entries after tools for tied timestamps", async () => {
        const runId = `stage-tool-transcript-tie-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-tie-1",
            name: "tie",
            status: "completed",
            parentIds: [],
            toolEvents: [
                {
                    name: "read",
                    output: "file contents",
                    startedAt: 4,
                    endedAt: 5,
                },
            ],
            result: "finished",
            endedAt: 5,
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "tie",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: Array<{ role: string; text?: string; timestamp?: number }>;
            truncated: boolean;
        };
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [
            { role: "assistant", text: "finished", timestamp: 5 },
        ]);
    });

    test.serial("makeExecuteWorkflowTool preserves empty final snapshot result after tools", async () => {
        const runId = `stage-tool-transcript-empty-result-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-empty-result-1",
            name: "empty-result",
            status: "completed",
            parentIds: [],
            toolEvents: [
                {
                    name: "read",
                    output: "file contents",
                    startedAt: 1,
                    endedAt: 2,
                },
            ],
            result: "",
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "empty-result",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: Array<{ role: string; text?: string }>;
            truncated: boolean;
        };
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [{ role: "assistant", text: "" }]);
    });

    test.serial("makeExecuteWorkflowTool preserves empty final snapshot error after tools", async () => {
        const runId = `stage-tool-transcript-empty-error-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-empty-error-1",
            name: "empty-error",
            status: "failed",
            parentIds: [],
            toolEvents: [
                { name: "grep", output: "matches", startedAt: 10, endedAt: 11 },
            ],
            error: "",
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "empty-error",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: Array<{ role: string; text?: string }>;
            truncated: boolean;
        };
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [{ role: "notice", text: "" }]);
    });

});
