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

    test.serial("/workflow kill <missing> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("kill definitely-missing", headlessNoOpCtx()),
            /Run not found: definitely-missing/,
        );
    });

    test.serial.each([
        ["reload", "reload", /Reloaded workflow resources\./],
        ["interrupt", "interrupt", /interrupted and can be resumed/],
        ["kill", "kill", /killed and retained for inspection/],
        ["pause", "pause", /Paused 1 stage\(s\)/],
        ["resume", "resume", /Resumed 1 stage\(s\)/],
    ])(
        "/workflow %s emits displayable success output in headless mode",
        async (_label, action, expected) => {
            const { handler, sent } = await registerWorkflowCommand();
            const runId = `headless-success-${action}-${Date.now()}`;
            const stageId = `stage-${action}`;

            if (action !== "reload") {
                const stageStatus = action === "resume" ? "paused" : "running";
                store.recordRunStart({
                    ...makeInflightRun(runId),
                    stages: [
                        {
                            id: stageId,
                            name: "worker",
                            status: stageStatus,
                            parentIds: [],
                            startedAt: Date.now(),
                            toolEvents: [],
                        },
                    ],
                });
                registerTestStageHandle(runId, stageId, stageStatus);
            }

            await handler(
                action === "reload" ? "reload" : `${action} ${runId}`,
                headlessNoOpCtx(),
            );

            const outputs = commandOutputMessages(sent);
            assert.ok(
                outputs.length > 0,
                `expected /workflow ${action} to emit command output`,
            );
            const content = outputs
                .map((message) => message.content ?? "")
                .join("\n");
            assert.match(content, expected);
        },
    );

    test.serial("/workflow interrupt --all emits displayable success output in headless mode", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const runId = `headless-interrupt-all-${Date.now()}`;
        const stageId = "stage-interrupt-all";
        store.recordRunStart({
            ...makeInflightRun(runId),
            stages: [
                {
                    id: stageId,
                    name: "worker",
                    status: "running",
                    parentIds: [],
                    startedAt: Date.now(),
                    toolEvents: [],
                },
            ],
        });
        registerTestStageHandle(runId, stageId);

        await handler("interrupt --all", headlessNoOpCtx());

        const content = commandOutputMessages(sent)
            .map((message) => message.content ?? "")
            .join("\n");
        assert.match(content, /Interrupted 1 run\(s\)\./);
    });

    test.serial("/workflow kill --all emits displayable success output in headless mode", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        store.recordRunStart(
            makeInflightRun(`headless-kill-all-${Date.now()}`),
        );

        await handler("kill --all", headlessNoOpCtx());

        const content = commandOutputMessages(sent)
            .map((message) => message.content ?? "")
            .join("\n");
        assert.match(
            content,
            /Killed and retained 1 run\(s\) for inspection\./,
        );
    });

    test.serial("issue #1156: headless terminal workflow failure throws a command-visible error", async () => {
        const resource = await registerWorkflowCommandWithResource(
            "terminal-failure.ts",
            `import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("terminal-failure")
  .description("Fails after dispatch")
  .run(async () => {
    throw new Error("terminal boom");
  })
  .compile();
`,
        );

        try {
            await assertRejectsHeadlessCommand(
                () => resource.handler("terminal-failure", headlessNoOpCtx()),
                /Workflow "terminal-failure" failed: terminal boom/,
            );
        } finally {
            await resource.cleanup();
        }
    }, 15_000);

    test.serial("issue #1156: headless /workflow success emits a printable terminal detail summary", async () => {
        const resource = await registerWorkflowCommandWithResource(
            "headless-terminal-success.ts",
            `import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("headless-terminal-success")
  .description("Completes without user input")
  .output("ok", Type.Optional(Type.Any()))
  .output("value", Type.Optional(Type.Any()))
  .run(async (ctx) => {
    await ctx.stage("terminal-stage").prompt("finish");
    return { ok: true, value: "terminal" };
  })
  .compile();
`,
        );

        try {
            await resource.handler(
                "headless-terminal-success",
                headlessNoOpCtx(),
            );

            assert.equal(
                resource.sent.some(
                    (message) =>
                        chatSurfacePayload(message)?.kind === "dispatch",
                ),
                false,
                "headless success must not emit an interactive dispatch surface",
            );

            const detailMessage = resource.sent.find(
                (message) => chatSurfacePayload(message)?.kind === "detail",
            );
            assert.ok(
                detailMessage,
                "expected a terminal run detail chat surface",
            );
            const detailPayload = chatSurfacePayload(detailMessage);
            assert.ok(
                detailPayload?.kind === "detail",
                "expected terminal run detail payload",
            );
            assert.equal(detailPayload.detail.status, "completed");
            assert.deepEqual(detailPayload.detail.result, {
                ok: true,
                value: "terminal",
            });
            assert.ok(
                detailPayload.detail.stages.length > 0,
                "expected completed stage details",
            );
            assert.equal(
                detailPayload.detail.stages.some(
                    (stage) => stage.status === "completed",
                ),
                true,
            );
            assert.equal(
                resource.sent.some(
                    (message) =>
                        message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
                ),
                false,
                "headless slash completion should not emit a lifecycle steer notice before terminal detail",
            );
            assert.equal(
                detailMessage.display,
                true,
                "terminal detail must be displayable for print mode",
            );
            assert.equal(typeof detailMessage.content, "string");

            const printableDetail = detailMessage.content ?? "";
            assert.match(printableDetail, /headless-terminal-success/);
            assert.match(printableDetail, /completed/);
            assert.match(printableDetail, /STAGES/);
            assert.match(printableDetail, /terminal-stage/);
            assert.match(printableDetail, /"value":"terminal"/);
        } finally {
            await resource.cleanup();
        }
    }, 15_000);

    test.serial("/workflow unknown workflow remains notify-and-handled with an interactive UI", async () => {
        const { handler } = await registerWorkflowCommand();
        const { ctx, notifications } = commandCtx(true);

        await assert.doesNotReject(async () => {
            await handler("ghost-workflow", ctx);
        });

        const error = notifications.find((entry) => entry.type === "error");
        assert.ok(
            error,
            "expected interactive errors to be reported via notify('error')",
        );
        assert.match(error.message, /Workflow not found: ghost-workflow/);
    });

    test.serial("/workflow still uses picker-capable path when a UI is available", async () => {
        const { handler } = await registerWorkflowCommand();
        const { ctx, pickerCalls } = commandCtx(true);

        await handler("deep-research-codebase", ctx);

        assert.ok(
            pickerCalls.length > 0,
            "expected interactive picker path to be attempted",
        );
    });

    test.serial("/workflow proceeds when hasUI is unset (degraded runtimes)", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const { ctx, messages } = commandCtx(undefined);

        await handler("list", ctx);

        assert.equal(messages.length, 0);
        assert.ok(
            sent.length > 0,
            "expected /workflow list to emit a chat surface",
        );
    });
});
