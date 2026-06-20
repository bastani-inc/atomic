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
    test("makeExecuteWorkflowTool resume starts linked continuation for failed resumable workflow", async () => {
        const sourceRunId = `resume-tool-source-${Date.now()}`;
        const def = defineWorkflow("tool-resume-wf")
            .output("first", Type.Optional(Type.Any()))
            .output("second", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const first = await ctx.stage("first").prompt("first");
                const second = await ctx
                    .stage("second")
                    .prompt(`second:${first}`);
                return { first, second };
            })
            .compile();

        store.recordRunStart({
            id: sourceRunId,
            name: def.name,
            inputs: {},
            status: "running",
            startedAt: Date.now(),
            stages: [],
        });
        store.recordStageStart(sourceRunId, {
            id: "old-first",
            name: "first",
            status: "completed",
            parentIds: [],
            toolEvents: [],
            result: "first-old",
        });
        store.recordStageEnd(sourceRunId, {
            id: "old-first",
            name: "first",
            status: "completed",
            parentIds: [],
            toolEvents: [],
            result: "first-old",
        });
        store.recordStageStart(sourceRunId, {
            id: "old-second",
            name: "second",
            status: "failed",
            parentIds: ["old-first"],
            toolEvents: [],
            error: "rate limit",
        });
        store.recordStageEnd(sourceRunId, {
            id: "old-second",
            name: "second",
            status: "failed",
            parentIds: ["old-first"],
            toolEvents: [],
            error: "rate limit",
        });
        store.recordRunEnd(sourceRunId, "failed", undefined, "rate limit", {
            resumable: true,
            failedStageId: "old-second",
            failureKind: "rate_limit",
        });

        const calls: string[] = [];
        const runtime = createExtensionRuntime({
            registry: createRegistry([def]),
            store,
            adapters: {
                prompt: {
                    prompt: async (text) => {
                        calls.push(text);
                        return "second-new";
                    },
                },
            },
        });
        const handler = makeExecuteWorkflowTool(
            runtime,
            () => undefined,
            () => undefined,
        );

        const result = await handler(
            { action: "resume", runId: sourceRunId },
            {} as never,
        );

        assert.equal(result.action, "resume");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.status, "running");
        assert.notEqual(r.runId, sourceRunId);
        assert.match(r.message, /Resuming failed workflow/);
        await jobTracker.get(r.runId)?.promise;
        assert.deepEqual(calls, ["second:first-old"]);
        const continued = store.runs().find((run) => run.id === r.runId)!;
        assert.equal(continued.status, "completed");
        assert.equal(continued.resumedFromRunId, sourceRunId);
        assert.equal(continued.stages[0]!.replayed, true);
        assert.equal(
            store.runs().find((run) => run.id === sourceRunId)!.status,
            "failed",
        );
    });

});
