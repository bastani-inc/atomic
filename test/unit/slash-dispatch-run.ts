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

describe("slash /workflow <name> dispatch", () => {
    test.serial("/workflow <known-name> dispatches run, not unknown subcommand", async () => {
        const wf = defineWorkflow("test-wf")
            .input("prompt", Type.Optional(Type.String()))
            .output("done", Type.Optional(Type.Any()))
            .run(async (_ctx) => ({ done: true }))
            .compile() as WorkflowDefinition;

        const registry = createRegistry([wf]);
        const runtime = createExtensionRuntime({ registry });

        const { ctx, messages } = buildCtx();

        let dispatchCalled = false;
        let dispatchedArgs: {
            name: string;
            inputs: Record<string, unknown>;
            action: string;
        } | null = null;

        const execute = async (args: string, execCtx: PiCommandContext) => {
            const print = (msg: string): void => execCtx.ui.notify(msg, "info");
            const rawParts = args.trim().split(/\s+/);
            const parts = rawParts[0] === "" ? [] : rawParts;
            const subcommand = parts[0] ?? "";

            const ADMIN = new Set([
                "list",
                "status",
                "interrupt",
                "kill",
                "resume",
                "inputs",
            ]);

            if (!subcommand || subcommand === "list") {
                print(
                    `Registered workflows: ${runtime.registry.names().join(", ")}`,
                );
                return;
            }

            if (!ADMIN.has(subcommand)) {
                dispatchCalled = true;
                const inputTokens = parts.slice(1);
                const inputs = parseWorkflowArgs(inputTokens);
                dispatchedArgs = { name: subcommand, inputs, action: "run" };
                const result = await runtime.dispatch({
                    workflow: subcommand,
                    inputs,
                    action: "run",
                });
                if (result.action === "run" && "runId" in result) {
                    const r = result as {
                        action: "run";
                        runId: string;
                        status: string;
                        error?: string;
                    };
                    if (r.status === "failed" && r.runId === "") {
                        const available = runtime.registry.names();
                        print(
                            `Workflow not found: ${subcommand}\nAvailable: ${available.join(", ")}`,
                        );
                    } else {
                        print(
                            `Workflow "${subcommand}" completed (runId: ${r.runId})`,
                        );
                    }
                }
                return;
            }
            print(`unknown subcommand: ${subcommand}`);
        };

        await execute("test-wf prompt=hello", ctx);

        assert.equal(dispatchCalled, true);
        const d = dispatchedArgs as {
            name: string;
            inputs: Record<string, unknown>;
            action: string;
        } | null;
        assert.equal(d?.name, "test-wf");
        assert.deepEqual(d?.inputs, { prompt: "hello" });
        assert.equal(d?.action, "run");
        assert.equal(
            messages.some((m) => m.includes("completed")),
            true,
        );
        // Must NOT print unknown subcommand
        assert.equal(
            messages.some((m) => m.includes("unknown subcommand")),
            false,
        );
    });

    test.serial("/workflow <unknown-name> prints 'Workflow not found: <name>'", async () => {
        const registry = createRegistry([]);
        const runtime = createExtensionRuntime({ registry });
        const { ctx, messages } = buildCtx();

        const ADMIN = new Set([
            "list",
            "status",
            "interrupt",
            "kill",
            "resume",
            "inputs",
        ]);
        const execute = async (args: string, execCtx: PiCommandContext) => {
            const print = (msg: string): void => execCtx.ui.notify(msg, "info");
            const rawParts = args.trim().split(/\s+/);
            const parts = rawParts[0] === "" ? [] : rawParts;
            const subcommand = parts[0] ?? "";
            if (!ADMIN.has(subcommand) && subcommand) {
                const result = await runtime.dispatch({
                    workflow: subcommand,
                    inputs: {},
                    action: "run",
                });
                if (result.action === "run" && "runId" in result) {
                    const r = result as {
                        action: "run";
                        runId: string;
                        status: string;
                    };
                    if (r.status === "failed" && r.runId === "") {
                        const available = runtime.registry.names();
                        print(
                            `Workflow not found: ${subcommand}\nAvailable: ${available.length > 0 ? available.join(", ") : "(none)"}`,
                        );
                    }
                }
            }
        };

        await execute("ghost-workflow", ctx);

        assert.ok(messages[0].includes("Workflow not found: ghost-workflow"));
        assert.ok(!messages[0].includes("unknown subcommand"));
    });
});

// ---------------------------------------------------------------------------
// Factory command registration + completion integration tests (using real factory)
// ---------------------------------------------------------------------------

