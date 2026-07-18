/**
 * Workflow tool `status` run-listing tests.
 *
 * Covers the refined no-runId `status` action: concise per-run summaries
 * (status, timing, active stages, awaiting-input prompts), statusFilter
 * support for the run listing, and the agent-visible text/json output.
 */
import { beforeEach, describe, test } from "bun:test";
import {
    installSlashDispatchTestHooks,
    assert,
    createRegistry,
    createExtensionRuntime,
    makeExecuteWorkflowTool,
    makeInflightRun,
    recordTerminalRun,
    store,
} from "./slash-dispatch-utils.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import type { WorkflowRunStatusSummary } from "../../packages/workflows/src/extension/workflow-status-summary.js";

installSlashDispatchTestHooks();

// Other test files in the same bun process may leave retained terminal runs
// in the module-singleton store; start each listing test from a clean slate.
beforeEach(() => {
    store.clear();
});

type StatusListing = {
    action: "status";
    filter: string;
    runs: WorkflowRunStatusSummary[];
    snapshots: Array<{ id: string }>;
};

function makeToolHandler() {
    const registry = createRegistry([]);
    const runtime = createExtensionRuntime({ registry });
    return makeExecuteWorkflowTool(runtime, () => undefined);
}

function recordRunningRunWithStages(runId: string): void {
    store.recordRunStart({
        ...makeInflightRun(runId),
        name: "release-docs",
        startedAt: Date.now() - 5_000,
    });
    store.recordStageStart(runId, {
        id: `${runId}-stage-verify`,
        name: "verify",
        status: "running",
        parentIds: [],
        toolEvents: [],
        startedAt: Date.now() - 4_000,
    });
    store.recordStageStart(runId, {
        id: `${runId}-stage-approve`,
        name: "approve",
        status: "awaiting_input",
        parentIds: [],
        toolEvents: [],
        awaitingInputSince: Date.now() - 1_000,
        pendingPrompt: {
            id: "prompt-1",
            kind: "confirm",
            message: "Approve the release plan?",
            createdAt: Date.now() - 1_000,
        },
    });
}

describe("workflow tool status run listing", () => {
    test.serial("status without runId lists session runs with concise summaries, in-flight first", async () => {
        const activeId = `status-listing-active-${Date.now()}`;
        recordRunningRunWithStages(activeId);
        recordTerminalRun(`status-listing-done-${Date.now()}`, "completed", {
            startedAt: Date.now() - 60_000,
        });
        const handler = makeToolHandler();

        const result = (await handler({ action: "status" }, {} as never)) as StatusListing;

        assert.equal(result.action, "status");
        assert.equal(result.filter, "all");
        assert.equal(result.runs.length, 2);
        // In-flight run sorts before the ended run despite starting later.
        const active = result.runs[0]!;
        assert.equal(active.runId, activeId);
        assert.equal(active.runIdPrefix, activeId.slice(0, 8));
        assert.equal(active.name, "release-docs");
        assert.equal(active.status, "running");
        assert.equal(active.endedAt, undefined);
        assert.ok(active.elapsedMs >= 0);
        assert.deepEqual(
            active.activeStages.map((stage) => stage.name).sort(),
            ["approve", "verify"],
        );
        assert.equal(active.awaitingInputCount, 1);
        assert.equal(active.awaitingInput.length, 1);
        const awaiting = active.awaitingInput[0]!;
        assert.equal(awaiting.stageId, `${activeId}-stage-approve`);
        assert.equal(awaiting.stageName, "approve");
        assert.equal(awaiting.promptId, "prompt-1");
        assert.equal(awaiting.promptKind, "confirm");
        assert.equal(awaiting.message, "Approve the release plan?");

        const terminal = result.runs[1]!;
        assert.equal(terminal.status, "completed");
        assert.notEqual(terminal.endedAt, undefined);
        assert.equal(terminal.awaitingInputCount, 0);

        // Snapshots stay aligned with the summaries (same runs, same order).
        assert.deepEqual(
            result.snapshots.map((snapshot) => snapshot.id),
            result.runs.map((run) => run.runId),
        );
    });

    test.serial("statusFilter filters the run listing by run status", async () => {
        const activeId = `status-filter-active-${Date.now()}`;
        const doneId = `status-filter-done-${Date.now()}`;
        recordRunningRunWithStages(activeId);
        recordTerminalRun(doneId, "completed", { startedAt: Date.now() - 60_000 });
        const handler = makeToolHandler();

        const running = (await handler(
            { action: "status", statusFilter: "running" },
            {} as never,
        )) as StatusListing;
        assert.equal(running.filter, "running");
        assert.deepEqual(running.runs.map((run) => run.runId), [activeId]);
        assert.deepEqual(running.snapshots.map((snapshot) => snapshot.id), [activeId]);

        const completed = (await handler(
            { action: "status", statusFilter: "completed" },
            {} as never,
        )) as StatusListing;
        assert.equal(completed.filter, "completed");
        assert.deepEqual(completed.runs.map((run) => run.runId), [doneId]);

        const failed = (await handler(
            { action: "status", statusFilter: "failed" },
            {} as never,
        )) as StatusListing;
        assert.deepEqual(failed.runs, []);
        assert.deepEqual(failed.snapshots, []);
    });

    test.serial("statusFilter awaiting_input selects runs with a pending stage prompt", async () => {
        const awaitingId = `status-filter-awaiting-${Date.now()}`;
        const plainId = `status-filter-plain-${Date.now()}`;
        recordRunningRunWithStages(awaitingId);
        store.recordRunStart(makeInflightRun(plainId));
        const handler = makeToolHandler();

        const result = (await handler(
            { action: "status", statusFilter: "awaiting_input" },
            {} as never,
        )) as StatusListing;

        assert.equal(result.filter, "awaiting_input");
        assert.deepEqual(result.runs.map((run) => run.runId), [awaitingId]);
        assert.equal(result.runs[0]!.awaitingInputCount, 1);
    });

    test.serial("status text output is a concise per-run listing; json format returns structured data", async () => {
        const activeId = `status-content-active-${Date.now()}`;
        recordRunningRunWithStages(activeId);
        const handler = makeToolHandler();
        const result = await handler({ action: "status" }, {} as never);

        const text = renderWorkflowToolContent(result, { action: "status" });
        assert.match(text, /action: status/);
        assert.match(text, /filter: all/);
        assert.match(text, /runs: 1 \(1 in flight\)/);
        // Concise summary line: [n]  <prefix>  <name>  <status>  <elapsed>  <hint>.
        const summaryLine = text
            .split("\n")
            .find((line) => line.startsWith("[1]"));
        assert.notEqual(summaryLine, undefined);
        assert.match(summaryLine!, new RegExp(activeId.slice(0, 8)));
        assert.match(summaryLine!, /release-docs/);
        assert.match(summaryLine!, /running/);
        assert.match(summaryLine!, /awaiting input \(1\): approve/);
        // Full identifiers for pause/resume/interrupt/quit/send follow-ups.
        assert.match(text, new RegExp(`runId: ${activeId}`));
        assert.match(text, new RegExp(`${activeId}-stage-approve`));
        assert.match(text, /promptId: prompt-1/);

        const json = renderWorkflowToolContent(result, {
            action: "status",
            format: "json",
        });
        const parsed = JSON.parse(json) as StatusListing;
        assert.equal(parsed.action, "status");
        assert.equal(parsed.filter, "all");
        assert.equal(parsed.runs.length, 1);
        assert.equal(parsed.runs[0]!.runId, activeId);
        assert.equal(parsed.runs[0]!.awaitingInput[0]!.promptId, "prompt-1");
        assert.equal(parsed.snapshots.length, 1);
    });

    test.serial("status text output reports an empty filtered listing", async () => {
        const handler = makeToolHandler();
        const result = await handler(
            { action: "status", statusFilter: "paused" },
            {} as never,
        );
        const text = renderWorkflowToolContent(result, {
            action: "status",
            statusFilter: "paused",
        });
        assert.match(text, /runs: none \(statusFilter: paused\)/);
    });
});
