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
    PiCustomOverlayFactoryTui,
    PiCustomOverlayFunction,
    PiCustomOverlayOptions,
    PiOverlayHandle,
    StageSessionRuntime,
    StageControlHandle,
} from "./slash-dispatch-utils.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";

installSlashDispatchTestHooks();

describe("/workflow resume <runId> — active run is refused", () => {
    test.serial("resuming an already-running run refuses and points at /workflow connect", async () => {
        const runId = `resume-slash-overlay-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const openCalls: Array<{ overlay: boolean }> = [];
        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);
        let refreshCalls = 0;
        pi.refreshWorkflowResources = async () => {
            refreshCalls += 1;
            return [];
        };
        const customFn: PiCustomOverlayFunction = (
            _factoryArg,
            options: PiCustomOverlayOptions,
        ) => {
            openCalls.push({ overlay: options.overlay });
            return undefined;
        };
        pi.ui = {
            setWidget: () => {},
            custom: customFn,
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        const ctx: PiCommandContext = {
            ui: {
                notify: (m: string) => {
                    msgs.push(m);
                },
            },
        };

        await workflowCmd.options.handler(`resume ${runId}`, ctx);

        // Active workflows must not be re-resumed: no overlay opens and the
        // user is steered toward `/workflow connect`.
        assert.equal(openCalls.length, 0);
        const joined = msgs.join("\n");
        assert.match(joined, /already running/);
        assert.match(joined, /\/workflow connect/);
        assert.equal(refreshCalls, 0, "exact active runs must bypass durable preparation and discovery");
    });

    test.serial("active run resume output does NOT include 'still active — no resume needed'", async () => {
        const runId = `resume-nomsg-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);
        const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
            const handle: PiOverlayHandle = {
                hide: () => undefined,
                setHidden: () => undefined,
                isHidden: () => false,
                focus: () => undefined,
                unfocus: () => undefined,
                isFocused: () => true,
            };
            options.onHandle?.(handle);
            const tui: PiCustomOverlayFactoryTui = {
                requestRender: () => undefined,
            };
            factoryArg(tui, {}, {}, () => undefined);
            return undefined;
        };
        pi.ui = {
            setWidget: () => {},
            custom: customFn,
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        const ctx: PiCommandContext = {
            ui: {
                notify: (m: string) => {
                    msgs.push(m);
                },
            },
        };

        await workflowCmd.options.handler(`resume ${runId}`, ctx);

        assert.equal(
            msgs.every((m) => !m.includes("still active")),
            true,
        );
        assert.equal(
            msgs.every((m) => !m.includes("no resume needed")),
            true,
        );
    });
});

describe("/workflow resume <runId> — exact live fast path", () => {
    test.serial("exact paused live target bypasses completed durable catalog in headless mode", async () => {
        class CatalogTrapBackend extends InMemoryDurableBackend {
            completedCatalogCalls = 0;

            override listCompletedWorkflows() {
                this.completedCatalogCalls += 1;
                throw new Error("completed durable catalog must not be enumerated");
            }
        }

        const backend = new CatalogTrapBackend();
        setDurableBackend(backend);
        const { pi, commands, sent } = buildMockPi();
        addFactoryStubs(pi);
        const factoryModule = await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);
        const handler = commands.find((command) => command.name === "workflow")!.options.handler;
        const runId = `headless-fast-resume-${Date.now()}`;
        const stageId = "stage-fast-resume";
        backend.registerWorkflow({
            workflowId: runId,
            name: "durable-duplicate",
            inputs: {},
            createdAt: 1,
            status: "completed",
            completedCheckpoints: 1,
        });
        store.recordRunStart({
            ...makeInflightRun(runId),
            stages: [{
                id: stageId,
                name: "worker",
                status: "paused",
                parentIds: [],
                startedAt: Date.now(),
                toolEvents: [],
            }],
        });
        registerTestStageHandle(runId, stageId, "paused");

        const startedAt = performance.now();
        await handler(`resume ${runId}`, { hasUI: false, ui: { notify: () => undefined } });
        const elapsedMs = performance.now() - startedAt;

        assert.equal(backend.completedCatalogCalls, 0);
        assert.ok(elapsedMs < 1_000, `exact live resume took ${elapsedMs.toFixed(1)}ms`);
        const content = sent
            .filter((message) => message.customType === WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE)
            .map((message) => message.content ?? "")
            .join("\n");
        assert.match(content, /Resumed 1 stage\(s\)/);
    });
});

// ---------------------------------------------------------------------------
// resume regression: tool action "resume" against active run returns status:"ok"
// ---------------------------------------------------------------------------

