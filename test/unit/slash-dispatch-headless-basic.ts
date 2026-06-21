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

describe("/workflow command in non-interactive (-p) mode (#1156 regressions)", () => {
    async function registerWorkflowCommand(): Promise<{
        handler: NonNullable<PiCommandOptions["handler"]>;
        sent: SentMessage[];
    }> {
        const { pi, commands, sent } = buildMockPi();
        await runFactory(pi);
        const cmd = commands.find((c) => c.name === "workflow");
        assert.ok(cmd, "expected /workflow command registration");
        return { handler: cmd.options.handler, sent };
    }

    type ExtensionEventHandler = Parameters<NonNullable<ExtensionAPI["on"]>>[1];
    type NotificationType = "info" | "warning" | "error";
    interface RecordedNotification {
        message: string;
        type?: NotificationType;
    }

    function commandCtx(hasUI: boolean | undefined): {
        ctx: PiCommandContext;
        messages: string[];
        notifications: RecordedNotification[];
        pickerCalls: string[];
    } {
        const messages: string[] = [];
        const notifications: RecordedNotification[] = [];
        const pickerCalls: string[] = [];
        const ctx: PiCommandContext = {
            ...(hasUI === undefined ? {} : { hasUI }),
            ui: {
                notify: (msg: string, type?: NotificationType) => {
                    messages.push(msg);
                    notifications.push({ message: msg, type });
                },
                setEditorComponent: () => {
                    pickerCalls.push("inline");
                    throw new Error("inline form unsupported in test");
                },
                custom: async (factory) => {
                    pickerCalls.push("overlay");
                    const component = await factory(
                        { requestRender: () => undefined },
                        {},
                        {},
                        () => undefined,
                    );
                    component.dispose?.();
                    return undefined;
                },
            },
        };
        return { ctx, messages, notifications, pickerCalls };
    }

    function headlessNoOpCtx(): PiCommandContext {
        return {
            hasUI: false,
            ui: { notify: () => undefined },
        };
    }

    function isHeadlessWorkflowCommandError(
        pattern: RegExp,
    ): (error: unknown) => boolean {
        return (error: unknown): boolean =>
            error instanceof Error &&
            error.name === "WorkflowHeadlessCommandError" &&
            pattern.test(error.message);
    }

    async function assertRejectsHeadlessCommand(
        action: () => Promise<void> | void,
        messagePattern: RegExp,
    ): Promise<void> {
        await assert.rejects(async () => {
            await action();
        }, isHeadlessWorkflowCommandError(messagePattern));
    }

    function chatSurfacePayload(
        message: SentMessage,
    ): ChatSurfacePayload | undefined {
        const details = message.details;
        if (
            typeof details !== "object" ||
            details === null ||
            !("kind" in details)
        ) {
            return undefined;
        }
        return details as ChatSurfacePayload;
    }

    function commandOutputMessages(
        sent: readonly SentMessage[],
    ): SentMessage[] {
        return sent.filter(
            (message) =>
                message.customType === WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
        );
    }

    async function registerWorkflowCommandWithResource(
        fileName: string,
        source: string,
    ): Promise<{
        handler: NonNullable<PiCommandOptions["handler"]>;
        sent: SentMessage[];
        cleanup: () => Promise<void>;
    }> {
        const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-slash-"));
        const filePath = join(dir, fileName);
        await writeFile(filePath, source, "utf8");

        const { pi, commands, sent } = buildMockPi();
        addFactoryStubs(pi);
        pi.disableAsyncDiscovery = false;
        pi.getWorkflowResources = () => [{ path: filePath, enabled: true }];

        const events = new Map<string, ExtensionEventHandler[]>();
        pi.on = (event, handler) => {
            const handlers = events.get(event) ?? [];
            handlers.push(handler);
            events.set(event, handlers);
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        for (const startHandler of events.get("session_start") ?? []) {
            await startHandler({}, { ui: { notify: () => undefined } });
        }

        const cmd = commands.find((c) => c.name === "workflow");
        assert.ok(cmd, "expected /workflow command registration");
        return {
            handler: cmd.options.handler,
            sent,
            cleanup: () => rm(dir, { recursive: true, force: true }),
        };
    }

    test.serial("workflowPolicyFromContext derives non-interactive policy from hasUI false", () => {
        assert.equal(
            workflowPolicyFromContext({ hasUI: false }).mode,
            "non_interactive",
        );
        assert.equal(
            workflowPolicyFromContext({ hasUI: false }).allowInputPicker,
            false,
        );
        assert.equal(
            workflowPolicyFromContext({ hasUI: true }).mode,
            "interactive",
        );
        assert.equal(workflowPolicyFromContext({}).mode, "interactive");
    });

    test.serial("/workflow list proceeds when no UI is available and emits printable content", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const { ctx, messages } = commandCtx(false);

        await handler("list", ctx);

        assert.equal(messages.length, 0);
        assert.ok(
            sent.length > 0,
            "expected /workflow list to emit a chat surface",
        );
        const listMessage = sent.find(
            (message) => chatSurfacePayload(message)?.kind === "list",
        );
        assert.ok(listMessage, "expected a list chat-surface message");
        assert.match(listMessage.content ?? "", /WORKFLOWS/);
        assert.match(
            listMessage.content ?? "",
            /deep-research-codebase|ralph|open-claude-design/,
        );
        assert.doesNotMatch(
            listMessage.content ?? "",
            /^workflows · \d+ registered$/,
        );
    });

    test.serial("/workflow status emits printable list and detail content when no UI is available", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const runId = `headless-printable-status-${Date.now()}`;
        recordTerminalRun(runId, "completed", {
            name: "headless-printable-workflow",
        });

        await handler("status", headlessNoOpCtx());
        await handler(`status ${runId}`, headlessNoOpCtx());

        const statusMessage = sent.find(
            (message) => chatSurfacePayload(message)?.kind === "status",
        );
        assert.ok(statusMessage, "expected a status chat-surface message");
        assert.match(statusMessage.content ?? "", /BACKGROUND/);
        assert.match(
            statusMessage.content ?? "",
            /headless-printable-workflow/,
        );
        assert.match(statusMessage.content ?? "", /completed/);
        assert.match(statusMessage.content ?? "", new RegExp(runId));
        assert.doesNotMatch(
            statusMessage.content ?? "",
            /^status · \d+ runs?$/,
        );

        const detailMessage = sent.find(
            (message) => chatSurfacePayload(message)?.kind === "detail",
        );
        assert.ok(detailMessage, "expected a detail chat-surface message");
        assert.match(detailMessage.content ?? "", /RUN/);
        assert.match(
            detailMessage.content ?? "",
            /headless-printable-workflow/,
        );
        assert.match(detailMessage.content ?? "", /completed/);
        assert.match(detailMessage.content ?? "", new RegExp(runId));
        assert.doesNotMatch(detailMessage.content ?? "", /^run detail · /);
    });

    test.serial("/workflow inputs <known> emits displayable command output in headless mode", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const { ctx, messages } = commandCtx(false);

        await handler("inputs ralph", ctx);

        assert.deepEqual(messages, []);
        assert.equal(
            store.runs().length,
            0,
            "inputs inspection must not dispatch a run",
        );
        const outputs = commandOutputMessages(sent);
        assert.equal(outputs.length, 1);
        const output = outputs[0]!;
        assert.equal(output.display, true);
        assert.equal(typeof output.content, "string");
        assert.match(
            output.content ?? "",
            /INPUTS FOR RALPH|Inputs for "ralph":/,
        );
        assert.deepEqual(output.details, {
            command: "inputs",
            workflowName: "ralph",
        });
    });

    test.serial("/workflow <known> --help emits displayable command output and skips dispatch headlessly", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const { ctx, messages } = commandCtx(false);

        await handler("deep-research-codebase --help", ctx);

        assert.deepEqual(messages, []);
        assert.equal(store.runs().length, 0, "--help must not dispatch a run");
        assert.equal(
            sent.some(
                (message) => chatSurfacePayload(message)?.kind === "dispatch",
            ),
            false,
            "--help must not emit the run dispatch surface",
        );
        const outputs = commandOutputMessages(sent);
        assert.equal(outputs.length, 1);
        const output = outputs[0]!;
        assert.equal(output.display, true);
        assert.equal(typeof output.content, "string");
        assert.match(
            output.content ?? "",
            /INPUTS FOR DEEP-RESEARCH-CODEBASE|Inputs for "deep-research-codebase":/,
        );
        assert.deepEqual(output.details, {
            command: "help",
            workflowName: "deep-research-codebase",
        });
    });

    test.serial("/workflow rejects missing required input in headless mode without relying on notify", async () => {
        const { handler } = await registerWorkflowCommand();
        const { ctx, messages, pickerCalls } = commandCtx(false);

        await assertRejectsHeadlessCommand(
            () => handler("deep-research-codebase", ctx),
            /required input "prompt" not provided/,
        );

        assert.deepEqual(pickerCalls, []);
        assert.deepEqual(messages, []);
    });

    test.serial("/workflow rejects unknown workflow in headless mode with a visible command error", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("ghost-workflow", headlessNoOpCtx()),
            /Workflow not found: ghost-workflow/,
        );
    });

    test.serial("/workflow status <missing> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("status definitely-missing", headlessNoOpCtx()),
            /Run not found: definitely-missing/,
        );
    });

    test.serial("/workflow connect <missing> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("connect definitely-missing", headlessNoOpCtx()),
            /Run not found: definitely-missing/,
        );
    });

    test.serial("/workflow connect without a run id rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("connect", headlessNoOpCtx()),
            /Pass a runId: \/workflow connect <id>/,
        );
    });

    test.serial("/workflow connect <valid> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();
        const runId = `headless-connect-valid-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        await assertRejectsHeadlessCommand(
            () => handler(`connect ${runId}`, headlessNoOpCtx()),
            /requires an interactive UI surface.*Use \/workflow status/i,
        );
    });

    test.serial("/workflow attach <valid> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();
        const runId = `headless-attach-valid-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        await assertRejectsHeadlessCommand(
            () => handler(`attach ${runId}`, headlessNoOpCtx()),
            /requires an interactive UI surface.*Use \/workflow status/i,
        );
    });

    test.serial("/workflow attach <valid> <stage> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();
        const runId = `headless-attach-stage-${Date.now()}`;
        const stageId = "stage-headless-attach";
        store.recordRunStart({
            ...makeInflightRun(runId),
            stages: [
                {
                    id: stageId,
                    name: "review",
                    status: "running",
                    parentIds: [],
                    startedAt: Date.now(),
                    toolEvents: [],
                },
            ],
        });

        await assertRejectsHeadlessCommand(
            () => handler(`attach ${runId} ${stageId}`, headlessNoOpCtx()),
            /requires an interactive UI surface.*workflow tool.*inspection/i,
        );
    });

});
