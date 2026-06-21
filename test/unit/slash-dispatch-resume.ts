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

describe("/workflow resume <runId> — overlay open + no legacy message", () => {
    test.serial("seeds active run; /workflow resume calls overlay.open with overlay:true", async () => {
        const runId = `resume-slash-overlay-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const openCalls: Array<{ overlay: boolean }> = [];
        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);
        const customFn: PiCustomOverlayFunction = (
            factoryArg,
            options: PiCustomOverlayOptions,
        ) => {
            openCalls.push({ overlay: options.overlay });
            // Mirror Pi's runtime: invoke the factory and surface a handle
            // so the adapter has the same control surface it would in prod.
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
            const component = factoryArg(tui, {}, {}, () => undefined);
            if (component instanceof Promise)
                throw new Error("expected sync factory");
            // Touch render so the GraphView's render path is exercised.
            (component as PiCustomComponent).render(80);
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

        assert.ok(openCalls.length > 0);
        assert.equal(openCalls[0].overlay, true);
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

// ---------------------------------------------------------------------------
// resume regression: tool action "resume" against active run returns status:"ok"
// ---------------------------------------------------------------------------

