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
    test("makeExecuteWorkflowTool resume starts linked continuation for active blocked recoverable workflow", async () => {
        const sourceRunId = `resume-tool-blocked-${Date.now()}`;
        const def = defineWorkflow("tool-resume-blocked-wf")
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
            id: "blocked-first",
            name: "first",
            status: "completed",
            parentIds: [],
            toolEvents: [],
            result: "first-old",
        });
        store.recordStageEnd(sourceRunId, {
            id: "blocked-first",
            name: "first",
            status: "completed",
            parentIds: [],
            toolEvents: [],
            result: "first-old",
        });
        store.recordStageStart(sourceRunId, {
            id: "blocked-second",
            name: "second",
            status: "failed",
            parentIds: ["blocked-first"],
            toolEvents: [],
            error: "rate limit",
            failureKind: "rate_limit",
            failureCode: "rate_limited",
            failureRecoverability: "recoverable",
            failureDisposition: "active_blocked",
        });
        store.recordStageEnd(sourceRunId, {
            id: "blocked-second",
            name: "second",
            status: "failed",
            parentIds: ["blocked-first"],
            toolEvents: [],
            error: "rate limit",
            failureKind: "rate_limit",
            failureCode: "rate_limited",
            failureRecoverability: "recoverable",
            failureDisposition: "active_blocked",
            failureMessage: "HTTP 429",
        });
        store.recordRunBlocked(sourceRunId, "rate limit", {
            resumable: true,
            failedStageId: "blocked-second",
            failureKind: "rate_limit",
            failureCode: "rate_limited",
            failureRecoverability: "recoverable",
            failureDisposition: "active_blocked",
            failureMessage: "HTTP 429",
        });

        const calls: string[] = [];
        const persistenceCalls: Array<{
            readonly type: string;
            readonly payload: Record<string, unknown>;
        }> = [];
        const persistence: WorkflowPersistencePort = {
            appendEntry(type, payload) {
                persistenceCalls.push({ type, payload });
                return `entry-${persistenceCalls.length}`;
            },
        };
        const runtime = createExtensionRuntime({
            registry: createRegistry([def]),
            store,
            persistence,
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
        assert.match(r.message, /Resuming blocked workflow/);
        await jobTracker.get(r.runId)?.promise;
        assert.deepEqual(calls, ["second:first-old"]);
        const continued = store.runs().find((run) => run.id === r.runId)!;
        assert.equal(continued.status, "completed");
        assert.equal(continued.resumedFromRunId, sourceRunId);
        assert.equal(continued.stages[0]!.replayed, true);
        const source = store.runs().find((run) => run.id === sourceRunId)!;
        assert.equal(source.status, "killed");
        assert.equal(source.endedAt !== undefined, true);
        assert.equal(source.blockedAt, undefined);
        assert.equal(source.resumable, false);
        assert.equal(source.failureKind, "rate_limit");
        assert.equal(source.failureCode, "rate_limited");
        assert.equal(source.failureRecoverability, "non_recoverable");
        assert.equal(source.failureDisposition, "terminal_killed");
        assert.equal(source.failureMessage, "HTTP 429");
        assert.equal(source.failedStageId, "blocked-second");

        const sourceRunEnd = persistenceCalls.find(
            (call) =>
                call.type === "workflow.run.end" &&
                call.payload["runId"] === sourceRunId,
        );
        assert.ok(sourceRunEnd);
        assert.equal(sourceRunEnd.payload["status"], "killed");
        assert.equal(sourceRunEnd.payload["resumable"], false);
        assert.equal(sourceRunEnd.payload["failureRecoverability"], "non_recoverable");
        assert.equal(sourceRunEnd.payload["failureDisposition"], "terminal_killed");
    });

    test("makeExecuteWorkflowTool resume finalizes restored blocked source run", async () => {
        const sourceRunId = `resume-tool-restored-blocked-${Date.now()}`;
        const def = defineWorkflow("tool-resume-restored-blocked-wf")
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
        const entries: SessionEntry[] = [
            {
                id: "e1",
                type: "workflow.run.start",
                payload: { runId: sourceRunId, name: def.name, inputs: {}, ts: 1 },
            },
            {
                id: "e2",
                type: "workflow.stage.start",
                payload: { runId: sourceRunId, stageId: "restored-first", name: "first", parentIds: [], ts: 2 },
            },
            {
                id: "e3",
                type: "workflow.stage.end",
                payload: {
                    runId: sourceRunId,
                    stageId: "restored-first",
                    status: "completed",
                    summary: "first-old",
                },
            },
            {
                id: "e4",
                type: "workflow.stage.start",
                payload: {
                    runId: sourceRunId,
                    stageId: "restored-second",
                    name: "second",
                    parentIds: ["restored-first"],
                    ts: 3,
                },
            },
            {
                id: "e5",
                type: "workflow.stage.end",
                payload: {
                    runId: sourceRunId,
                    stageId: "restored-second",
                    status: "failed",
                    error: "rate limit",
                    failureKind: "rate_limit",
                    failureCode: "rate_limited",
                    failureRecoverability: "recoverable",
                    failureDisposition: "active_blocked",
                    failureMessage: "HTTP 429",
                },
            },
            {
                id: "e6",
                type: "workflow.run.blocked",
                payload: {
                    runId: sourceRunId,
                    failedStageId: "restored-second",
                    error: "rate limit",
                    failureKind: "rate_limit",
                    failureCode: "rate_limited",
                    failureMessage: "HTTP 429",
                    failureRecoverability: "recoverable",
                    failureDisposition: "active_blocked",
                    resumable: true,
                    ts: 4,
                },
            },
        ];
        restoreOnSessionStart(
            { getEntries: () => entries },
            { resumeInFlight: "never", persistRuns: true },
            store,
        );

        const calls: string[] = [];
        let markPromptStarted = (): void => {};
        const promptStarted = new Promise<void>((resolve) => {
            markPromptStarted = resolve;
        });
        let releasePrompt = (_value: string): void => {};
        const promptRelease = new Promise<string>((resolve) => {
            releasePrompt = resolve;
        });
        const runtime = createExtensionRuntime({
            registry: createRegistry([def]),
            store,
            adapters: {
                prompt: {
                    prompt: async (text) => {
                        calls.push(text);
                        markPromptStarted();
                        return promptRelease;
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
        const r = result as { action: string; status: string; runId: string };
        assert.equal(r.action, "resume");
        assert.equal(r.status, "running");
        assert.notEqual(r.runId, sourceRunId);

        await promptStarted;
        assert.deepEqual(calls, ["second:first-old"]);
        const source = store.runs().find((run) => run.id === sourceRunId)!;
        assert.equal(source.status, "killed");
        assert.equal(source.failureDisposition, "terminal_killed");
        assert.equal(source.failureRecoverability, "non_recoverable");
        assert.equal(source.resumable, false);
        assert.equal(source.blockedAt, undefined);
        const inFlight = store.runs().filter((run) => run.endedAt === undefined);
        assert.deepEqual(inFlight.map((run) => run.id), [r.runId]);

        releasePrompt("second-new");
        await jobTracker.get(r.runId)?.promise;
        const continued = store.runs().find((run) => run.id === r.runId)!;
        assert.equal(continued.status, "completed");
        assert.equal(continued.resumedFromRunId, sourceRunId);
        assert.equal(continued.resumeFromStageId, "restored-second");
    });

});
