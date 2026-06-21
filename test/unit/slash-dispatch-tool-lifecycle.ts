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
    test.serial("workflow tool answers ctx.ui.input prompts on running workflows", async () => {
        const def = workflow({
          name: "tool-answers-ctx-ui-input",
          description: "",
          inputs: {},
          outputs: {
            answer: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const answer = await ctx.ui.input("Value?");
                return { answer };
            },
        });
        const runtime = createExtensionRuntime({
            registry: createRegistry([def]),
        });
        const handler = makeExecuteWorkflowTool(
            runtime,
            () => undefined,
            () => undefined,
        );

        const started = await handler(
            { action: "run", workflow: "tool-answers-ctx-ui-input" },
            {} as never,
        );
        assert.equal(started.action, "run");
        const runId = (started as { runId: string }).runId;
        assert.ok(runId);

        const prompt = await waitForToolPrompt(runId);
        const stages = await handler(
            { action: "stages", runId, statusFilter: "all" },
            {} as never,
        );
        assert.equal(stages.action, "stages");
        const awaitingStage = (
            stages as {
                stages: Array<{
                    id: string;
                    status: string;
                    pendingPrompt?: { kind: string; message: string };
                }>;
            }
        ).stages.find((stage) => stage.id === prompt.stageId);
        assert.equal(awaitingStage?.status, "awaiting_input");
        assert.equal(awaitingStage?.pendingPrompt?.kind, "input");
        assert.equal(awaitingStage?.pendingPrompt?.message, "Value?");

        const sent = await handler(
            {
                action: "send",
                runId,
                stageId: prompt.stageId,
                text: "from workflow tool",
            },
            {} as never,
        );
        assert.equal(sent.action, "send");
        assert.equal(
            (sent as { delivery: string; status: string }).delivery,
            "answer",
        );
        assert.equal(
            (sent as { delivery: string; status: string }).status,
            "ok",
        );

        await waitForToolRunEnded(runId);
        const completed = store
            .runs()
            .find((candidate) => candidate.id === runId);
        assert.equal(completed?.status, "completed");
        assert.deepEqual(completed?.result, { answer: "from workflow tool" });
    });

    test.serial("registered workflow tool content defaults to path-only transcripts and supports explicit previews", async () => {
        const runId = `tool-content-transcript-${Date.now()}`;
        const longText = `start-${"x".repeat(180)}-sentinel-end`;
        const toolOutput = `tool-output-${"y".repeat(120)}-sentinel-end`;
        const sessionFile = "C:\\Users\\atomic runner\\tool-content.jsonl";
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-tool-content-1",
            name: "summarize",
            status: "completed",
            parentIds: [],
            toolEvents: [
                {
                    name: "read",
                    output: toolOutput,
                    startedAt: 1,
                    endedAt: 1,
                },
            ],
            result: longText,
            endedAt: 2,
            sessionId: "session-tool-content",
            sessionFile,
        });
        const tool = await makeRegisteredWorkflowTool();

        const textResult = await tool.execute(
            "tool-content-text",
            {
                action: "transcript",
                runId,
                stageId: "summarize",
                includeToolOutput: true,
            },
            undefined,
            undefined,
            {} as never,
        );
        const textBlock = textResult.content[0];
        assert.equal(textBlock?.type, "text");
        const textContent = textBlock.type === "text" ? textBlock.text : "";
        assert.equal(
            textContent.includes(longText),
            false,
            "default tool content should not inline transcript text when a path is available",
        );
        assert.equal(
            textContent.includes(toolOutput),
            false,
            "includeToolOutput alone should not bypass the path-only default",
        );
        assert.ok(textContent.includes(`sessionFile: ${sessionFile}`));
        assert.ok(textContent.includes(`sessionFileJson: ${JSON.stringify(sessionFile)}`));
        assert.ok(textContent.includes(`transcriptPath: ${sessionFile}`));
        assert.ok(textContent.includes(`transcriptPathJson: ${JSON.stringify(sessionFile)}`));
        assert.ok(textContent.includes("availableEntries: 2"));
        assert.ok(textContent.includes("entryLimit: 0"));
        assert.ok(textContent.includes("lazyReadPrompt: Transcript not inlined to protect context."));
        assert.ok(textContent.includes("entries: not inlined"));
        assert.equal(
            textContent.includes("╭"),
            false,
            "tool content should not use clipped UI chrome",
        );
        const referenceDetails = textResult.details as Extract<
            WorkflowToolResult,
            { action: "transcript" }
        >;
        assert.deepEqual(referenceDetails.entries, []);
        assert.equal(referenceDetails.entryCount, 2);
        assert.equal(referenceDetails.entryLimit, 0);
        assert.equal(referenceDetails.truncated, true);
        assert.equal(referenceDetails.transcriptPath, sessionFile);
        assert.equal(referenceDetails.inlineMode, "path_only");
        assert.match(referenceDetails.lazyReadPrompt ?? "", /Read it lazily from C:\\Users\\atomic runner\\tool-content\.jsonl/);

        const explicitTextResult = await tool.execute(
            "tool-content-text-tail",
            { action: "transcript", runId, stageId: "summarize", tail: 1 },
            undefined,
            undefined,
            {} as never,
        );
        const explicitTextBlock = explicitTextResult.content[0];
        assert.equal(explicitTextBlock?.type, "text");
        const explicitTextContent = explicitTextBlock.type === "text"
            ? explicitTextBlock.text
            : "";
        assert.ok(
            explicitTextContent.includes(longText),
            "explicit tail should inline the requested transcript entry",
        );
        const explicitTailDetails = explicitTextResult.details as Extract<
            WorkflowToolResult,
            { action: "transcript" }
        >;
        assert.equal(explicitTailDetails.entryLimit, 1);
        assert.equal(explicitTailDetails.inlineMode, "preview");
        assert.equal(explicitTailDetails.lazyReadPrompt, undefined);

        const explicitLimitResult = await tool.execute(
            "tool-content-text-limit",
            {
                action: "transcript",
                runId,
                stageId: "summarize",
                limit: 2,
                includeToolOutput: true,
            },
            undefined,
            undefined,
            {} as never,
        );
        const explicitLimitBlock = explicitLimitResult.content[0];
        assert.equal(explicitLimitBlock?.type, "text");
        const explicitLimitContent = explicitLimitBlock.type === "text"
            ? explicitLimitBlock.text
            : "";
        assert.ok(explicitLimitContent.includes(toolOutput));
        assert.ok(explicitLimitContent.includes(longText));
        const explicitLimitDetails = explicitLimitResult.details as Extract<
            WorkflowToolResult,
            { action: "transcript" }
        >;
        assert.equal(explicitLimitDetails.entryLimit, 2);
        assert.equal(explicitLimitDetails.entries.length, 2);

        const defaultJsonResult = await tool.execute(
            "tool-content-json-default",
            {
                action: "transcript",
                runId,
                stageId: "summarize",
                includeToolOutput: true,
                format: "json",
            },
            undefined,
            undefined,
            {} as never,
        );
        const defaultJsonBlock = defaultJsonResult.content[0];
        assert.equal(defaultJsonBlock?.type, "text");
        const defaultJsonText = defaultJsonBlock.type === "text"
            ? defaultJsonBlock.text
            : "{}";
        const defaultParsed = JSON.parse(defaultJsonText);
        assert.deepEqual(defaultParsed.entries, []);
        assert.equal(defaultParsed.entryCount, 2);
        assert.equal(defaultParsed.entryLimit, 0);
        assert.equal(defaultParsed.transcriptPath, sessionFile);
        assert.equal(defaultParsed.inlineMode, "path_only");
        assert.match(defaultParsed.lazyReadPrompt ?? "", /Transcript not inlined/);
        assert.equal(defaultJsonText.includes(longText), false);
        assert.equal(defaultJsonText.includes(toolOutput), false);

        const jsonResult = await tool.execute(
            "tool-content-json",
            {
                action: "transcript",
                runId,
                stageId: "summarize",
                tail: 1,
                format: "json",
            },
            undefined,
            undefined,
            {} as never,
        );
        const jsonBlock = jsonResult.content[0];
        assert.equal(jsonBlock?.type, "text");
        const parsed = JSON.parse(
            jsonBlock.type === "text" ? jsonBlock.text : "{}",
        );
        assert.equal(parsed.entries[0].text, longText);
        assert.equal(parsed.entryLimit, 1);
    });

});
