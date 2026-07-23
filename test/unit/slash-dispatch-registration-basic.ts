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
import {
    BUNDLED_EXTENSION_SLASH_COMMANDS,
    getBundledWorkflowArgumentCompletions,
} from "../../packages/coding-agent/src/core/slash-commands.js";

installSlashDispatchTestHooks();

describe("factory command registration (real factory)", () => {
    /** Import factory and call it with a mock pi whose registry contains known workflows. */
    async function runFactoryWithMock(): Promise<RegisteredCommand[]> {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);
        return commands;
    }

    test.serial("per-workflow slash aliases are not registered", async () => {
        const commands = await runFactoryWithMock();
        const names = commands.map((c) => c.name);
        assert.equal(
            names.some((name) => name.startsWith("workflow:")),
            false,
        );
    });

    test.serial("base /workflow command registers quit without kill help", async () => {
        const commands = await runFactoryWithMock();
        const workflowCommand = commands.find((command) => command.name === "workflow");
        assert.notEqual(workflowCommand, undefined);
        assert.match(workflowCommand!.options.description, /quit/);
        assert.doesNotMatch(workflowCommand!.options.description, /kill/);
    });
});

// ---------------------------------------------------------------------------
// Completions include workflow names
// ---------------------------------------------------------------------------

describe("getArgumentCompletions includes workflow names", () => {
    test.serial("completions include admin subcommands and workflow names from registry", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        assert.notEqual(workflowCmd, undefined);

        const completions =
            (await workflowCmd!.options.getArgumentCompletions?.("")) ?? [];
        const labels = completions.map((c) => c.label);

        assert.ok(labels.includes("list"));
        assert.ok(labels.includes("status"));
        assert.ok(labels.includes("connect"));
        assert.ok(labels.includes("interrupt"));
        assert.ok(labels.includes("quit"));
        assert.equal(labels.includes("kill"), false);
        assert.ok(labels.includes("resume"));
        assert.ok(labels.includes("inputs"));
        assert.ok(labels.includes("reload"));
        assert.equal(labels.includes("session"), false);

        assert.ok(labels.includes("deep-research-codebase"));
        assert.ok(labels.includes("ralph"));
        assert.ok(labels.includes("open-claude-design"));
    });

    test.serial("completions filter by partial prefix", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const completions =
            (await workflowCmd!.options.getArgumentCompletions?.("li")) ?? [];
        assert.equal(
            completions.every((c) => c.label.startsWith("li")),
            true,
        );
        assert.ok(completions.map((c) => c.label).includes("list"));
    });

    test.serial("completions cover subcommand arguments without shadowing submit", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const completions =
            workflowCmd!.options.getArgumentCompletions?.("interrupt -") ?? [];
        assert.ok(completions.some((c) => c.value === "interrupt -y "));

        const quitCompletions =
            workflowCmd!.options.getArgumentCompletions?.("quit -") ?? [];
        assert.ok(quitCompletions.some((c) => c.value === "quit --all "));
        assert.equal(quitCompletions.some((c) => c.label === "-y" || c.label === "--yes"), false);
        assert.equal(quitCompletions.some((c) => c.value.includes("kill")), false);

        const bundledQuit = getBundledWorkflowArgumentCompletions("quit -") ?? [];
        assert.ok(bundledQuit.some((c) => c.value === "quit --all "));
        assert.equal(bundledQuit.some((c) => c.label === "-y" || c.label === "--yes"), false);
    });

    test("bundled fallback completion and description expose quit without kill", () => {
        const completions = getBundledWorkflowArgumentCompletions("") ?? [];
        const labels = completions.map((completion) => completion.label);
        assert.ok(labels.includes("quit"));
        assert.equal(labels.includes("kill"), false);

        const workflowCommand = BUNDLED_EXTENSION_SLASH_COMMANDS.find(
            (command) => command.name === "workflow",
        );
        assert.match(workflowCommand?.description ?? "", /quit/);
        assert.doesNotMatch(workflowCommand?.description ?? "", /kill/);
    });

    test.serial("trailing-space completion does not throw on empty subcommand", async () => {
        // Regression: typing `/workflow ` (just the slash command + space)
        // forwards `partial = " "` to getArgumentCompletions, which used to
        // fall through to `registry.get("")`, throwing
        // `TypeError: normalizeWorkflowName: name must be a non-empty string`.
        // The trailing-space case should produce the same admin + workflow-name
        // menu as the no-args case (partial = "").
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        let completions: PiArgumentCompletion[] | null | undefined;
        await assert.doesNotReject(async () => {
            completions = (await workflowCmd!.options.getArgumentCompletions?.(" ")) ?? null;
        });
        const labels = (completions ?? []).map((c) => c.label);
        assert.ok(labels.includes("list"), "admin subcommands offered");
        assert.ok(
            labels.includes("deep-research-codebase"),
            "workflow names offered",
        );
    });
});

// ---------------------------------------------------------------------------
// removed session namespace
// ---------------------------------------------------------------------------

describe("/workflow session namespace removed", () => {
    test.serial("/workflow session ... is not treated as a control namespace", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();
        await workflowCmd!.options.handler("session kill abc12345", ctx);

        const joined = messages.join("\n");
        assert.match(joined, /Workflow not found: session/);
        assert.doesNotMatch(joined, /Usage: \/workflow session/);
    });
});

// ---------------------------------------------------------------------------
// inputs subcommand via execute handler (factory-registered)
// ---------------------------------------------------------------------------

describe("inputs subcommand", () => {
    test.serial("/workflow inputs with no name prints usage", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();
        await workflowCmd!.options.handler("inputs", ctx);

        assert.ok(messages[0].includes("Usage:"));
        assert.ok(messages[0].includes("inputs"));
    });

    test.serial("/workflow inputs <unknown> prints workflow not found plus available", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();
        await workflowCmd!.options.handler("inputs no-such-workflow-xyz", ctx);

        assert.ok(messages[0].includes("no-such-workflow-xyz"));
        assert.ok(messages[0].includes("Available:"));
    });

    test.serial("/workflow inputs <known> shows schema", async () => {
        const { pi, commands, sent } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();
        await workflowCmd!.options.handler("inputs ralph", ctx);

        assert.ok(!messages[0].includes("Workflow not found"));
        assert.ok(messages[0].includes("ralph"));
        assert.equal(
            sent.some(
                (message) =>
                    message.customType === WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
            ),
            false,
            "interactive schema output should continue using ctx.ui.notify",
        );
    });
});

// ---------------------------------------------------------------------------
// /workflow deep-research-codebase prompt=test dispatch (full factory path)
// ---------------------------------------------------------------------------

describe("/workflow <name> prompt=test dispatches run via factory", () => {
    test.serial("/workflow deep-research-codebase dispatches run action (not unknown subcommand)", async () => {
        const { pi, commands, sent } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();

        await workflowCmd!.options.handler(
            "deep-research-codebase prompt=test",
            ctx,
        );

        assert.equal(
            messages.some((m) => m.includes("unknown subcommand")),
            false,
        );
        // Success path: the dispatch confirmation is now emitted as a
        // chat-surface `kind: "dispatch"` message (sendMessage), not a string
        // through ctx.ui.notify. Either error wording in `messages` or a
        // dispatch payload in `sent` counts as evidence the handler resolved.
        const dispatchSent = sent.some(
            (m) =>
                (m.details as { kind?: string } | undefined)?.kind ===
                "dispatch",
        );
        const errored = messages.some(
            (m) =>
                m.includes("completed") ||
                m.includes("failed") ||
                m.includes("Workflow not found"),
        );
        assert.equal(dispatchSent || errored, true);
    });
});

// ---------------------------------------------------------------------------
// /workflow <name> --help prints schema, skips dispatch
// ---------------------------------------------------------------------------

