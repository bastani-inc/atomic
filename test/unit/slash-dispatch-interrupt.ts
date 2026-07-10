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

describe("/workflow interrupt chat command", () => {
    test.serial.each([["completed"], ["failed"], ["killed"]] as const)(
        "top-level /workflow kill <id> reports %s runs as already ended and retained",
        async (status) => {
            const runId = `slash-kill-${status}-${Date.now()}`;
            recordTerminalRun(runId, status);

            const { workflowCmd } = await registerWorkflowCommand();
            const msgs: string[] = [];
            let confirmCalls = 0;
            const ctx: PiCommandContext = {
                ui: {
                    notify: (message: string) => {
                        msgs.push(message);
                    },
                    confirm: async () => {
                        confirmCalls++;
                        return true;
                    },
                },
            };

            await workflowCmd.options.handler(`kill ${runId}`, ctx);

            const joined = msgs.join("\n");
            assert.equal(confirmCalls, 0);
            assert.match(joined, /already ended/i);
            assert.match(joined, /retained/i);
            assert.doesNotMatch(joined, /Run not found/);
            assert.equal(
                store.runs().find((r) => r.id === runId)?.status,
                status,
            );
        },
    );

    test.serial("picker kill on a terminal row is a no-op", async () => {
        const runId = `picker-kill-ended-${Date.now()}`;
        recordTerminalRun(runId, "completed");

        const { workflowCmd } = await registerWorkflowCommand();
        const msgs: string[] = [];
        const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
            const tui: PiCustomOverlayFactoryTui = {
                requestRender: () => undefined,
            };
            const component = factoryArg(tui, {}, {}, () => undefined);
            if (component instanceof Promise)
                throw new Error("expected sync factory");
            if (options.overlay) {
                (component as PiCustomComponent).handleInput?.("y");
            } else {
                (component as PiCustomComponent).render(80);
                (component as PiCustomComponent).handleInput?.("x");
                (component as PiCustomComponent).handleInput?.("\x1b");
            }
            return undefined;
        };
        const ctx: PiCommandContext = {
            ui: {
                notify: (message: string) => {
                    msgs.push(message);
                },
                custom: customFn,
            },
        };

        await workflowCmd.options.handler("connect", ctx);

        assert.deepEqual(msgs, []);
    });

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

    test.serial("top-level /workflow kill <id> kills and retains run without requiring confirmation", async () => {
        const runId = `kill-chat-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

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

        await workflowCmd.options.handler(`kill ${runId}`, ctx);

        const run = store.runs().find((r) => r.id === runId);
        assert.equal(confirmCalls, 0);
        assert.equal(run?.status, "killed");
        assert.equal(
            msgs.some((m) => m.includes("killed and retained for inspection")),
            true,
        );
        assert.equal(
            sent.some(
                (m) =>
                    (m.details as { kind?: string } | undefined)?.kind ===
                    "killed",
            ),
            true,
        );
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

    test.serial("top-level /workflow reload is skipped while workflows are in flight", async () => {
        const runId = `reload-slash-blocked-${Date.now()}`;
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
            messages.some((message) => message.includes("still in flight")),
            true,
        );
        assert.equal(
            messages.some((message) =>
                message.includes("Reloaded workflow resources"),
            ),
            false,
        );
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
                message.includes("Reload failed: package loader unavailable"),
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

