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
    test.serial("makeExecuteWorkflowTool blocks workflow tool execution from workflow-stage context", async () => {
        const { handler, wasDispatched } =
            makeDispatchTrackingWorkflowHandler();

        const result = await handler(
            { action: "run", workflow: "demo" },
            {
                orchestrationContext: {
                    kind: "workflow-stage",
                    workflowRunId: "run-1",
                    workflowStageId: "stage-1",
                    workflowStageName: "Stage",
                    constraints: {
                        disableWorkflowTool: true,
                        maxSubagentDepth: 2,
                    },
                },
            },
        );

        assertWorkflowToolBlocked(result, wasDispatched);
    });

    test.serial("makeExecuteWorkflowTool blocks workflow tool execution from env workflow-stage guard", async () => {
        const previousGuard = process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
        const { handler, wasDispatched } =
            makeDispatchTrackingWorkflowHandler();

        try {
            process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = "1";
            const result = await handler(
                { action: "run", workflow: "demo" },
                {},
            );

            assertWorkflowToolBlocked(result, wasDispatched);
        } finally {
            restoreWorkflowStageGuard(previousGuard);
        }
    });

    test.serial("registered workflow tool suppresses lifecycle notices while awaiting a headless run", async () => {
        const resource = await makeRegisteredWorkflowToolWithResource(
            "tool-headless-lifecycle.ts",
            `import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "tool-headless-lifecycle",
  description: "Completes under the registered workflow tool",
  inputs: {},
  outputs: {
    ok: Type.Optional(Type.Any()),
    source: Type.Optional(Type.Any()),
  },
  run: async (ctx) => {
    await ctx.stage("terminal-stage").prompt("finish");
    return { ok: true, source: "tool" };
  },
});
`,
        );

        try {
            const result = await resource.tool.execute(
                "tool-headless-lifecycle-call",
                {
                    action: "run",
                    workflow: "tool-headless-lifecycle",
                    inputs: {},
                },
                undefined,
                undefined,
                { hasUI: false } as never,
            );

            assert.equal(result.details.action, "run");
            const run = result.details as Extract<
                WorkflowToolResult,
                { action: "run" }
            >;
            assert.equal(run.status, "completed");
            assert.deepEqual(run.result, { ok: true, source: "tool" });
            assert.equal(
                resource.sent.some(
                    (message) =>
                        message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
                ),
                false,
                "headless tool completion should not emit a lifecycle steer notice before returning",
            );
        } finally {
            await resource.cleanup();
        }
    });

    async function makeRegisteredWorkflowTool(): Promise<
        PiToolOpts<WorkflowToolArgs, WorkflowToolResult>
    > {
        const { pi } = buildMockPi();
        addFactoryStubs(pi);
        let registered:
            | PiToolOpts<WorkflowToolArgs, WorkflowToolResult>
            | undefined;
        pi.registerTool = (opts) => {
            registered = opts as unknown as PiToolOpts<
                WorkflowToolArgs,
                WorkflowToolResult
            >;
        };
        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);
        assert.ok(registered, "expected workflow tool registration");
        return registered;
    }

    async function makeRegisteredWorkflowToolWithResource(
        fileName: string,
        source: string,
    ): Promise<{
        tool: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
        sent: SentMessage[];
        cleanup: () => Promise<void>;
    }> {
        const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-tool-"));
        const filePath = join(dir, fileName);
        await writeFile(filePath, source, "utf8");

        const { pi, sent } = buildMockPi();
        addFactoryStubs(pi);
        pi.disableAsyncDiscovery = false;
        pi.getWorkflowResources = () => [{ path: filePath, enabled: true }];

        const events = new Map<
            string,
            Array<Parameters<NonNullable<ExtensionAPI["on"]>>[1]>
        >();
        pi.on = (event, handler) => {
            const handlers = events.get(event) ?? [];
            handlers.push(handler);
            events.set(event, handlers);
        };

        let registered:
            | PiToolOpts<WorkflowToolArgs, WorkflowToolResult>
            | undefined;
        pi.registerTool = (opts) => {
            registered = opts as unknown as PiToolOpts<
                WorkflowToolArgs,
                WorkflowToolResult
            >;
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        for (const startHandler of events.get("session_start") ?? []) {
            await startHandler(
                {},
                { hasUI: false, ui: { notify: () => undefined } },
            );
        }

        assert.ok(registered, "expected workflow tool registration");
        return {
            tool: registered,
            sent,
            cleanup: () => rm(dir, { recursive: true, force: true }),
        };
    }

    function registerLiveStageHandle(
        runId: string,
        stageId: string,
        options?: {
            status?: StageControlHandle["status"];
            isStreaming?: boolean;
            messages?: StageControlHandle["messages"];
        },
    ): {
        followUps: string[];
        prompts: string[];
        steers: string[];
        dispose: () => void;
    } {
        const followUps: string[] = [];
        const prompts: string[] = [];
        const steers: string[] = [];
        const handle: StageControlHandle = {
            runId,
            stageId,
            stageName: "ask",
            status: options?.status ?? "running",
            sessionId: undefined,
            sessionFile: undefined,
            isStreaming: options?.isStreaming ?? false,
            messages: options?.messages ?? [],
            async ensureAttached(): Promise<void> {},
            async prompt(text: string): Promise<void> {
                prompts.push(text);
            },
            async steer(text: string): Promise<void> {
                steers.push(text);
            },
            async followUp(text: string): Promise<void> {
                followUps.push(text);
            },
            async pause(): Promise<void> {},
            async resume(): Promise<void> {},
            subscribe: () => () => {},
        };
        return {
            followUps,
            prompts,
            steers,
            dispose: stageControlRegistry.register(handle),
        };
    }

    async function waitForToolPrompt(
        runId: string,
        timeoutMs = 1000,
    ): Promise<{ stageId: string; promptId: string }> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const run = store
                .runs()
                .find((candidate) => candidate.id === runId);
            const stage = run?.stages.find(
                (candidate) => candidate.pendingPrompt !== undefined,
            );
            if (stage?.pendingPrompt)
                return { stageId: stage.id, promptId: stage.pendingPrompt.id };
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`pending prompt did not appear for run ${runId}`);
    }

    async function waitForToolRunEnded(
        runId: string,
        timeoutMs = 1000,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const run = store
                .runs()
                .find((candidate) => candidate.id === runId);
            if (run?.endedAt !== undefined) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`run ${runId} did not end`);
    }

});
