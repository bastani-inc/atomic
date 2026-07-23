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
    cancellationRegistry,
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

describe("/workflow run-control chat commands", () => {
    test.serial.each([["completed"], ["failed"], ["killed"]] as const)(
        "top-level /workflow quit <id> leaves %s terminal runs unchanged",
        async (status) => {
            const runId = `slash-quit-${status}-${Date.now()}`;
            recordTerminalRun(runId, status);

            const { workflowCmd } = await registerWorkflowCommand();
            const msgs: string[] = [];
            const ctx: PiCommandContext = {
                ui: {
                    notify: (message: string) => {
                        msgs.push(message);
                    },
                },
            };

            await workflowCmd.options.handler(`quit ${runId}`, ctx);

            const joined = msgs.join("\n");
            assert.match(joined, /already ended/i);
            assert.doesNotMatch(joined, /Run not found/);
            assert.equal(store.runs().find((r) => r.id === runId)?.status, status);
        },
    );


    test.serial("/workflow connect no-custom-UI fallback includes older retained terminal runs", async () => {
        const oldEndedAt = Date.now() - 2 * 60 * 60 * 1000;
        recordTerminalRun("old-connect-terminal-run", "completed", {
            name: "old-connect-terminal",
            startedAt: oldEndedAt - 5_000,
            endedAt: oldEndedAt,
        });

        const { workflowCmd } = await registerWorkflowCommand();
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler("connect", ctx);

        const joined = messages.join("\n");
        assert.match(joined, /old-connect-terminal/);
        assert.match(joined, /Picker requires an interactive UI surface/);
    });

    test.serial("/workflow attach no-custom-UI fallback includes older retained terminal runs", async () => {
        const oldEndedAt = Date.now() - 2 * 60 * 60 * 1000;
        recordTerminalRun("old-attach-terminal-run", "failed", {
            name: "old-attach-terminal",
            startedAt: oldEndedAt - 5_000,
            endedAt: oldEndedAt,
        });

        const { workflowCmd } = await registerWorkflowCommand();
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler("attach", ctx);

        const joined = messages.join("\n");
        assert.match(joined, /old-attach-terminal/);
        assert.match(joined, /Picker requires an interactive UI surface/);
    });

    test.serial("top-level /workflow quit <id> pauses and preserves resumability without confirmation", async () => {
        const runId = `quit-chat-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        registerTestStageHandle(runId, "quit-stage");
        const controller = new AbortController();
        cancellationRegistry.register(runId, controller);

        const { pi, commands, sent } = buildMockPi();
        addFactoryStubs(pi);

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        let confirmCalls = 0;
        const ctx: PiCommandContext = {
            ui: {
                notify: (message: string) => {
                    msgs.push(message);
                },
                confirm: async () => {
                    confirmCalls++;
                    return false;
                },
            },
        };

        await workflowCmd.options.handler(`quit ${runId}`, ctx);

        const run = store.runs().find((r) => r.id === runId);
        assert.equal(confirmCalls, 0);
        assert.equal(run?.status, "paused");
        assert.equal(run?.endedAt, undefined);
        assert.equal(run?.exitReason, "quit");
        assert.equal(run?.resumable, true);
        assert.equal(controller.signal.aborted, false);
        assert.equal(msgs.some((message) => /quit.*resume|resume.*quit/i.test(message)), true);
        assert.equal(
            sent.some((message) =>
                (message.details as { kind?: string } | undefined)?.kind === "killed"
            ),
            false,
        );
    });

    test.serial("top-level /workflow quit without a controllable stage reports that the run remains active", async () => {
        const runId = `quit-no-control-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const { workflowCmd } = await registerWorkflowCommand();
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler(`quit ${runId}`, ctx);

        assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
        assert.match(messages.join("\n"), /no controllable stages.*remains active/i);
        assert.doesNotMatch(messages.join("\n"), /Run not found/i);
    });

    test.serial("top-level /workflow quit --all reports mixed no-controller failures", async () => {
        const controllable = `quit-slash-mixed-ok-${Date.now()}`;
        const noController = `quit-slash-mixed-no-controller-${Date.now()}`;
        store.recordRunStart(makeInflightRun(controllable));
        store.recordRunStart(makeInflightRun(noController));
        registerTestStageHandle(controllable, "quit-stage");
        const { workflowCmd } = await registerWorkflowCommand();
        const messages: string[] = [];
        const levels: string[] = [];
        const ctx = { ui: { notify(message: string, level: string) { messages.push(message); levels.push(level); } } };

        await workflowCmd.options.handler("quit --all", ctx);

        const output = messages.join("\n");
        assert.match(output, /Quit 1 run\(s\)/);
        assert.ok(output.indexOf(controllable) < output.indexOf(noController));
        assert.match(output, new RegExp(noController));
        assert.deepEqual(levels, ["info"]);
        assert.match(output, /no_active_stages|no controllable stages/i);
        assert.equal(store.runs().find((run) => run.id === controllable)?.status, "paused");
        assert.equal(store.runs().find((run) => run.id === noController)?.status, "running");
    });

    test.serial.each([
        ["-y <id>", "-y"],
        ["--yes <id>", "--yes"],
        ["<id> -y", "-y"],
        ["<id> --yes", "--yes"],
        ["--all -y", "-y"],
        ["--all --yes", "--yes"],
        ["-y --all", "-y"],
        ["--yes --all", "--yes"],
    ])("top-level /workflow quit %s rejects yes compatibility as an ordinary unsupported target", async (argsTemplate, unsupportedToken) => {
        const runId = `quit-unsupported-confirmation-${unsupportedToken}-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        registerTestStageHandle(runId, "quit-stage");
        const { workflowCmd } = await registerWorkflowCommand();
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler(`quit ${argsTemplate.replace("<id>", runId)}`, ctx);

        const run = store.runs().find((candidate) => candidate.id === runId);
        assert.equal(run?.status, "running");
        assert.equal(run?.exitReason, undefined);
        assert.match(messages.join("\n"), new RegExp(`Run not found: ${unsupportedToken}`));
    });

    test.serial("top-level /workflow quit without an id defaults to the active run", async () => {
        const runId = `quit-active-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        registerTestStageHandle(runId, "quit-stage");
        const { workflowCmd } = await registerWorkflowCommand();
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler("quit", ctx);

        const run = store.runs().find((candidate) => candidate.id === runId);
        assert.equal(run?.status, "paused");
        assert.equal(run?.endedAt, undefined);
        assert.equal(run?.resumable, true);
        assert.equal(messages.some((message) => /resume/i.test(message)), true);
    });

    test.serial("removed /workflow kill is not a compatibility alias for quit", async () => {
        const runId = `removed-kill-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const { workflowCmd } = await registerWorkflowCommand();
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler(`kill ${runId}`, ctx);

        const run = store.runs().find((candidate) => candidate.id === runId);
        assert.equal(run?.status, "running");
        assert.equal(run?.endedAt, undefined);
        assert.equal(run?.exitReason, undefined);
        assert.equal(messages.some((message) => /killed and retained/i.test(message)), false);
    });

    test.serial("top-level /workflow interrupt defaults to the active run", async () => {
        const runId = `interrupt-active-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        const ctx: PiCommandContext = {
            ui: {
                notify: (message: string) => {
                    msgs.push(message);
                },
                confirm: async () => false,
            },
        };

        await workflowCmd.options.handler("interrupt", ctx);

        const run = store.runs().find((r) => r.id === runId);
        assert.equal(run?.status, "running");
        assert.equal(
            msgs.some((m) => m.includes("No active stages to interrupt")),
            true,
        );
    });

    test.serial("top-level /workflow interrupt <id> reports no active stages without confirmation", async () => {
        const runId = `interrupt-chat-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        let confirmCalls = 0;
        const ctx: PiCommandContext = {
            ui: {
                notify: (message: string) => {
                    msgs.push(message);
                },
                confirm: async () => {
                    confirmCalls++;
                    return false;
                },
            },
        };

        await workflowCmd.options.handler(`interrupt ${runId}`, ctx);

        const run = store.runs().find((r) => r.id === runId);
        assert.equal(confirmCalls, 0);
        assert.equal(run?.status, "running");
        assert.equal(
            msgs.some((m) => m.includes("No active stages to interrupt")),
            true,
        );
    });

    test.serial("top-level /workflow reload stays available while workflows are in flight", async () => {
        const runId = `reload-slash-inflight-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler("reload", ctx);

        assert.equal(
            messages.some((message) =>
                message.includes("Reloaded workflow resources"),
            ),
            true,
        );
        assert.equal(store.runs().find((run) => run.id === runId)?.endedAt, undefined);
    });

    test.serial("top-level /workflow reload reports reload failures", async () => {
        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);
        pi.getWorkflowResources = () => {
            throw new Error("package loader unavailable");
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler("reload", ctx);

        assert.equal(
            messages.some((message) =>
                message.includes("current registry was retained: package loader unavailable"),
            ),
            true,
        );
    });

    test.serial("top-level /workflow reload refreshes package workflow resources before discovery", async () => {
        const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-refresh-"));
        try {
            const existingWorkflow = join(dir, "existing.ts");
            const addedWorkflow = join(dir, "added.ts");
            await writeWorkflowFixture(existingWorkflow, "refresh-existing");
            await writeWorkflowFixture(addedWorkflow, "refresh-added");

            const { pi, commands } = buildMockPi();
            addFactoryStubs(pi);
            let refreshCalls = 0;
            pi.getWorkflowResources = () => [
                { path: existingWorkflow, enabled: true },
            ];
            pi.refreshWorkflowResources = async () => {
                refreshCalls += 1;
                return [
                    { path: existingWorkflow, enabled: true },
                    { path: addedWorkflow, enabled: true },
                ];
            };

            const factoryModule =
                await import("../../packages/workflows/src/extension/index.js");
            factoryModule.default(pi);

            const workflowCmd = commands.find((c) => c.name === "workflow")!;
            const { ctx, messages } = buildCtx();

            await workflowCmd.options.handler("reload", ctx);

            assert.equal(refreshCalls, 1);
            assert.equal(
                messages.some((message) =>
                    message.includes("Reloaded workflow resources."),
                ),
                true,
            );
            const completions =
                (await workflowCmd.options.getArgumentCompletions?.(
                    "refresh-add",
                )) ?? [];
            assert.equal(
                completions?.some(
                    (completion) => completion.label === "refresh-added",
                ),
                true,
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test.serial("top-level /workflow reload falls back to getWorkflowResources when refresh is unavailable", async () => {
        const dir = await mkdtemp(
            join(tmpdir(), "atomic-workflow-refresh-fallback-"),
        );
        try {
            const fallbackWorkflow = join(dir, "fallback.ts");
            await writeWorkflowFixture(fallbackWorkflow, "refresh-fallback");

            const { pi, commands } = buildMockPi();
            addFactoryStubs(pi);
            let getCalls = 0;
            pi.getWorkflowResources = () => {
                getCalls += 1;
                return [{ path: fallbackWorkflow, enabled: true }];
            };

            const factoryModule =
                await import("../../packages/workflows/src/extension/index.js");
            factoryModule.default(pi);

            const workflowCmd = commands.find((c) => c.name === "workflow")!;
            const { ctx, messages } = buildCtx();

            await workflowCmd.options.handler("reload", ctx);

            assert.equal(getCalls, 1);
            assert.equal(
                messages.some((message) =>
                    message.includes("Reloaded workflow resources."),
                ),
                true,
            );
            const completions =
                (await workflowCmd.options.getArgumentCompletions?.(
                    "refresh-fall",
                )) ?? [];
            assert.equal(
                completions?.some(
                    (completion) => completion.label === "refresh-fallback",
                ),
                true,
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// resume regression: /workflow resume opens overlay + no legacy message
// ---------------------------------------------------------------------------

