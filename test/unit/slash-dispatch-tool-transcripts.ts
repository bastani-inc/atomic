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
    test.serial("makeExecuteWorkflowTool applies limit and lets tail override limit", async () => {
        const runId = `stage-tool-transcript-limit-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-limit-1",
            name: "limited",
            status: "completed",
            parentIds: [],
            toolEvents: [
                { name: "one", output: "1", startedAt: 1, endedAt: 1 },
                { name: "two", output: "2", startedAt: 2, endedAt: 2 },
                { name: "three", output: "3", startedAt: 3, endedAt: 3 },
            ],
            result: "done",
            endedAt: 4,
        });
        const handler = makeToolHandler();

        const limited = await handler(
            {
                action: "transcript",
                runId,
                stageId: "limited",
                limit: 2,
                includeToolOutput: true,
            },
            {} as never,
        );
        assert.equal(limited.action, "transcript");
        const limitedTranscript = limited as {
            action: string;
            truncated: boolean;
            entries: Array<{ role: string; toolName?: string; text?: string }>;
        };
        assert.equal(limitedTranscript.truncated, true);
        assert.deepEqual(
            limitedTranscript.entries.map(
                (entry) => entry.toolName ?? entry.text,
            ),
            ["three", "done"],
        );

        const tailOverride = await handler(
            {
                action: "transcript",
                runId,
                stageId: "limited",
                limit: 3,
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );
        assert.equal(tailOverride.action, "transcript");
        const tailTranscript = tailOverride as {
            action: string;
            truncated: boolean;
            entries: Array<{ text?: string }>;
        };
        assert.equal(tailTranscript.truncated, true);
        assert.deepEqual(tailTranscript.entries, [
            { role: "assistant", text: "done", timestamp: 4 },
        ]);
    });

    test.serial("makeExecuteWorkflowTool falls back to bounded preview when transcript path is unavailable", async () => {
        const runId = `stage-tool-transcript-no-path-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-no-path-1",
            name: "no-path",
            status: "completed",
            parentIds: [],
            toolEvents: Array.from({ length: 6 }, (_, index) => ({
                name: `tool-${index + 1}`,
                output: `tool-output-${index + 1}`,
                startedAt: index + 1,
                endedAt: index + 1,
            })),
            result: "final-no-path",
        });
        const tool = await makeRegisteredWorkflowTool();

        const toolResult = await tool.execute(
            "tool-content-no-path-fallback",
            {
                action: "transcript",
                runId,
                stageId: "no-path",
                includeToolOutput: true,
            },
            undefined,
            undefined,
            {} as never,
        );
        const textBlock = toolResult.content[0];
        assert.equal(textBlock?.type, "text");
        const textContent = textBlock.type === "text" ? textBlock.text : "";
        assert.ok(textContent.includes("fallbackNote: No transcript file path is available"));
        assert.ok(textContent.includes("entries:"));
        assert.ok(textContent.includes("tool-output-3"));

        const result = toolResult.details;
        assert.equal(result.action, "transcript");
        const transcript = result as Extract<
            WorkflowToolResult,
            { action: "transcript" }
        >;
        assert.equal(transcript.source, "snapshot");
        assert.equal(transcript.sessionFile, undefined);
        assert.equal(transcript.transcriptPath, undefined);
        assert.equal(transcript.lazyReadPrompt, undefined);
        assert.match(transcript.fallbackNote ?? "", /No transcript file path is available/);
        assert.equal(transcript.inlineMode, "fallback_preview");
        assert.equal(transcript.entryCount, 7);
        assert.equal(transcript.entryLimit, 5);
        assert.equal(transcript.truncated, true);
        assert.equal(transcript.entries.length, 5);
        assert.deepEqual(
            transcript.entries.map((entry) => entry.toolName ?? entry.text),
            ["tool-3", "tool-4", "tool-5", "tool-6", "final-no-path"],
        );
        assert.equal(transcript.entries[0]?.output, "tool-output-3");
        assert.match(
            renderResult(result, { plain: true, width: 320 }),
            /no session file; preview:/,
        );
    });

    test.serial("makeExecuteWorkflowTool labels empty live handles as live transcript source", async () => {
        const runId = `stage-tool-live-empty-handle-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-live-empty-handle-1",
            name: "live-empty-handle",
            status: "running",
            parentIds: [],
            toolEvents: [],
            result: "snapshot-result",
            sessionId: "snapshot-session",
            sessionFile: "/tmp/live-empty-snapshot.jsonl",
        });
        const { dispose } = registerLiveStageHandle(
            runId,
            "stage-live-empty-handle-1",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "transcript", runId, stageId: "live-empty-handle" },
                {} as never,
            );

            assert.equal(result.action, "transcript");
            const transcript = result as Extract<
                WorkflowToolResult,
                { action: "transcript" }
            >;
            assert.equal(transcript.source, "live");
            assert.equal(transcript.truncated, false);
            assert.deepEqual(transcript.entries, []);
            assert.equal(transcript.entryCount, 0);
            assert.equal(transcript.entryLimit, 0);
            assert.equal(transcript.inlineMode, "path_only");
            assert.match(transcript.lazyReadPrompt ?? "", /Transcript not inlined/);
            assert.equal(transcript.sessionId, "snapshot-session");
            assert.equal(transcript.sessionFile, "/tmp/live-empty-snapshot.jsonl");
            assert.equal(transcript.transcriptPath, "/tmp/live-empty-snapshot.jsonl");
        } finally {
            dispose();
        }
    });

    test.serial("makeExecuteWorkflowTool uses error transcript source for target errors", async () => {
        const handler = makeToolHandler();

        const result = await handler(
            { action: "transcript", runId: "missing-run", stageId: "stage" },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            source: string;
            entries: Array<{ role: string; text?: string }>;
        };
        assert.equal(transcript.source, "error");
        assert.equal(transcript.entries[0]?.role, "notice");
    });

    test.serial("makeExecuteWorkflowTool preserves empty live transcript text blocks", async () => {
        const runId = `stage-tool-live-empty-block-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-live-empty-block-1",
            name: "live-empty",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { dispose } = registerLiveStageHandle(
            runId,
            "stage-live-empty-block-1",
            {
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "" }],
                        timestamp: 1,
                    },
                ],
            },
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "transcript", runId, stageId: "live-empty", tail: 1 },
                {} as never,
            );

            assert.equal(result.action, "transcript");
            const transcript = result as {
                action: string;
                source: string;
                entries: Array<{ role: string; text?: string }>;
            };
            assert.equal(transcript.source, "live");
            assert.equal(transcript.entries.length, 1);
            assert.equal(transcript.entries[0]?.role, "user");
            assert.equal(transcript.entries[0]?.text, "");
            assert.equal(Object.hasOwn(transcript.entries[0]!, "text"), true);
        } finally {
            dispose();
        }
    });

    test.serial("makeExecuteWorkflowTool omits text for live non-text content blocks", async () => {
        const runId = `stage-tool-live-non-text-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-live-non-text-1",
            name: "live-non-text",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { dispose } = registerLiveStageHandle(
            runId,
            "stage-live-non-text-1",
            {
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "image", data: "", mimeType: "image/png" },
                        ],
                        timestamp: 1,
                    },
                ],
            },
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "transcript", runId, stageId: "live-non-text", tail: 1 },
                {} as never,
            );

            assert.equal(result.action, "transcript");
            const transcript = result as {
                action: string;
                source: string;
                entries: Array<{ role: string; text?: string }>;
            };
            assert.equal(transcript.source, "live");
            assert.equal(transcript.entries.length, 1);
            assert.equal(Object.hasOwn(transcript.entries[0]!, "text"), false);
            assert.equal(transcript.entries[0]?.text, undefined);
        } finally {
            dispose();
        }
    });

});
