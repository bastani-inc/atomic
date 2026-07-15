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
    test.serial("makeExecuteWorkflowTool stages clones pending prompts", async () => {
        const runId = `stage-tool-prompt-clone-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-clone",
            name: "ask",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-clone", {
            id: "prompt-clone",
            kind: "select",
            message: "Original?",
            choices: ["yes"],
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler({ action: "stages", runId }, {} as never);

        assert.equal(result.action, "stages");
        const stages = result as {
            action: string;
            stages: Array<{
                pendingPrompt?: { message: string; choices?: string[] };
            }>;
        };
        assert.equal(stages.stages[0]?.pendingPrompt?.message, "Original?");
        stages.stages[0]!.pendingPrompt!.message = "Mutated";
        stages.stages[0]!.pendingPrompt!.choices!.push("no");
        const storedPrompt = store.runs().find((run) => run.id === runId)
            ?.stages[0]?.pendingPrompt;
        assert.equal(storedPrompt?.message, "Original?");
        assert.deepEqual(storedPrompt?.choices, ["yes"]);
    });

    test.serial("makeExecuteWorkflowTool stage rejects all-run inspection", async () => {
        const handler = makeToolHandler();

        const result = await handler(
            { action: "stage", all: true },
            {} as never,
        );

        assert.equal(result.action, "stage");
        const stage = result as {
            action: string;
            runId: string;
            error?: string;
        };
        assert.equal(stage.runId, "--all");
        assert.match(stage.error ?? "", /requires a single run/);
    });

    test.serial("makeExecuteWorkflowTool stages supports all stage status filters", async () => {
        const runId = `stage-tool-status-filters-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        for (const status of [
            "pending",
            "running",
            "awaiting_input",
            "paused",
            "blocked",
            "completed",
            "failed",
            "skipped",
        ] as const) {
            store.recordStageStart(runId, {
                id: `stage-${status}`,
                name: status,
                status,
                parentIds: [],
                toolEvents: [],
            });
        }
        const handler = makeToolHandler();

        const completedResult = await handler(
            { action: "stages", runId, statusFilter: "completed" },
            {} as never,
        );

        assert.equal(completedResult.action, "stages");
        const completed = completedResult as {
            action: string;
            stages: Array<{ name: string; status: string }>;
        };
        assert.deepEqual(
            completed.stages.map(({ name, status }) => ({ name, status })),
            [{ name: "completed", status: "completed" }],
        );
    });

    test.serial("makeExecuteWorkflowTool stages reports missing and ambiguous run targets", async () => {
        const handler = makeToolHandler();

        const missing = await handler({ action: "stages" }, {} as never);
        assert.equal(missing.action, "stages");
        const missingStages = missing as {
            action: string;
            runId: string;
            error?: string;
            stages: unknown[];
        };
        assert.equal(missingStages.runId, "");
        assert.deepEqual(missingStages.stages, []);
        assert.match(missingStages.error ?? "", /No active run to inspect/);
        assert.match(
            renderResult(missing, { plain: true }),
            /No active run to inspect/,
        );

        store.recordRunStart(makeInflightRun("stages-ambiguous-run-a"));
        store.recordRunStart(makeInflightRun("stages-ambiguous-run-b"));
        const ambiguous = await handler(
            { action: "stages", runId: "stages-ambiguous-run" },
            {} as never,
        );
        assert.equal(ambiguous.action, "stages");
        const ambiguousStages = ambiguous as {
            action: string;
            runId: string;
            error?: string;
            stages: unknown[];
        };
        assert.equal(ambiguousStages.runId, "stages-ambiguous-run");
        assert.deepEqual(ambiguousStages.stages, []);
        assert.match(ambiguousStages.error ?? "", /Ambiguous run prefix/);
        assert.match(
            renderResult(ambiguous, { plain: true }),
            /Ambiguous run prefix/,
        );
    });

    test.serial("workflow status rejects an ambiguous run ID exactly as abbreviated in its list", async () => {
        const firstId = "abc123-first-full-run-id";
        const secondId = "abc123-second-full-run-id";
        store.recordRunStart(makeInflightRun(firstId));
        store.recordRunStart(makeInflightRun(secondId));
        const handler = makeToolHandler();

        const listed = await handler({ action: "status" }, {} as never);
        const rendered = renderResult(listed, { plain: true });
        assert.match(rendered, /abc123/);

        const detail = await handler(
            { action: "status", runId: "abc123" },
            {} as never,
        );
        assert.equal(detail.action, "statusDetail");
        const statusDetail = detail as { action: string; runId: string; error?: string };
        assert.equal(statusDetail.runId, "abc123");
        assert.match(statusDetail.error ?? "", /Ambiguous run prefix/);
        assert.match(statusDetail.error ?? "", new RegExp(firstId.slice(0, 12)));
        assert.match(statusDetail.error ?? "", new RegExp(secondId.slice(0, 12)));
    });

    test.serial("makeExecuteWorkflowTool returns chronologically final snapshot result after tools", async () => {
        const runId = `stage-tool-transcript-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-1",
            name: "summarize",
            status: "completed",
            parentIds: [],
            toolEvents: [
                {
                    name: "read",
                    output: "file contents",
                    startedAt: 1,
                    endedAt: 2,
                },
            ],
            result: "done",
            sessionId: "session-1",
            sessionFile: "/tmp/session.jsonl",
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "summarize",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            source: string;
            entries: Array<{ role: string; text?: string; output?: string }>;
            truncated: boolean;
            sessionFile?: string;
            transcriptPath?: string;
        };
        assert.equal(transcript.source, "snapshot");
        assert.equal(transcript.sessionFile, "/tmp/session.jsonl");
        assert.equal(transcript.transcriptPath, "/tmp/session.jsonl");
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [
            { role: "assistant", text: "done" },
        ]);
    });

});
