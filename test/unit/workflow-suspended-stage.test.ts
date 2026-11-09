/**
 * A stage released from memory reads as `suspended`, not `waiting`, and names what it waits on. Records and requests
 * that still say `waiting` keep working (#4589).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { Value } from "typebox/value";
import { describe, test } from "vitest";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import {
	createStageReplayKeyGenerator,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import { buildWorkflowStatusListing } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { workflowStagesResult } from "../../packages/workflows/src/extension/workflow-tool-inspection.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageWaitSnapshot } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { runSnapshotsFromRecord } from "../../packages/workflows/src/shared/legacy-waiting-status.js";
import { stageStatusWithWait } from "../../packages/workflows/src/shared/stage-display-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { PooledStageRegistrations } from "../../packages/workflows/src/workers/pooled-stage-registry.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const NOW = 1_000_000;
const RUN_ID = "5d0f6a4e-6c1b-4b0e-9d5a-2f7d0c2a9b11";

const TOOL_WAIT: StageWaitSnapshot = {
	kind: "tool",
	since: NOW,
	toolCalls: [{ toolCallId: "call-1", toolName: "bash" }],
};

function stage(id: string, status: StageSnapshot["status"], patch: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status, parentIds: [], toolEvents: [], startedAt: NOW, ...patch };
}

function run(stages: StageSnapshot[], id = RUN_ID, patch: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id,
		name: "suspended-demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages,
		startedAt: NOW,
		...patch,
	};
}

describe("what a suspended stage waits on, as a label (#4589)", () => {
	test("a stage offloaded during a tool call reads suspended with the tool it waits on (#4589)", () => {
		assert.equal(stageStatusWithWait("suspended", TOOL_WAIT), "suspended (tool: bash)");
		assert.equal(
			stageStatusWithWait("suspended", {
				kind: "tool",
				since: NOW,
				toolCalls: [
					{ toolCallId: "c1", toolName: "bash" },
					{ toolCallId: "c2", toolName: "read" },
					{ toolCallId: "c3", toolName: "bash" },
				],
			}),
			"suspended (tool: bash, read)",
		);
	});

	test("a stage released between turns, or held unused, reads suspended between turns (#4589)", () => {
		assert.equal(stageStatusWithWait("suspended", { kind: "release", since: NOW }), "suspended (between turns)");
		assert.equal(stageStatusWithWait("suspended", { kind: "idle", since: NOW }), "suspended (between turns)");
	});

	test("a stage waiting on a human stays awaiting_input (#4589)", () => {
		assert.equal(stageStatusWithWait("awaiting_input", { kind: "prompt", since: NOW }), "awaiting_input (released)");
	});
});

describe("statusFilter waiting, the deprecated name of suspended (#4589)", () => {
	test("the tool schema accepts both names (#4589)", () => {
		for (const statusFilter of ["suspended", "waiting"]) {
			assert.equal(Value.Check(WorkflowParametersSchema, { action: "stages", runId: RUN_ID, statusFilter }), true);
		}
		assert.equal(Value.Check(WorkflowParametersSchema, { action: "stages", statusFilter: "sleeping" }), false);
		const statusFilterSchema = WorkflowParametersSchema.properties.statusFilter;
		assert.ok("description" in statusFilterSchema && typeof statusFilterSchema.description === "string");
		assert.match(statusFilterSchema.description, /'waiting' is a deprecated alias for 'suspended'/);
	});

	test("the status listing selects the same runs and echoes the current name (#4589)", () => {
		const snapshots = [
			run([stage("a", "suspended", { wait: TOOL_WAIT })], "has-suspended"),
			run([stage("a", "running")], "busy"),
		];

		const legacy = buildWorkflowStatusListing(snapshots, "waiting", NOW);
		const current = buildWorkflowStatusListing(snapshots, "suspended", NOW);

		assert.deepEqual(legacy, current);
		assert.equal(legacy.filter, "suspended");
		assert.deepEqual(
			legacy.runs.map((summary) => summary.runId),
			["has-suspended"],
		);
	});

	test("a run-status filter still selects that status rather than runs with suspended stages (#4589)", () => {
		const snapshots = [
			run([stage("parked", "suspended", { wait: TOOL_WAIT })], "active"),
			run([stage("done", "completed")], "finished", { status: "completed" }),
		];
		assert.deepEqual(
			buildWorkflowStatusListing(snapshots, "completed", NOW).runs.map((summary) => summary.runId),
			["finished"],
		);
	});

	test("without a filter the listings select everything and echo all (#4589)", () => {
		const snapshots = [
			run([stage("a", "suspended", { wait: TOOL_WAIT })], "has-suspended"),
			run([stage("a", "running")], "busy"),
		];
		assert.equal(buildWorkflowStatusListing(snapshots).filter, "all");
		assert.equal(buildWorkflowStatusListing(snapshots).runs.length, 2);

		const store = createStore();
		store.recordRunStart(run([stage("parked", "suspended", { wait: TOOL_WAIT }), stage("busy", "running")]));
		const result = workflowStagesResult({ action: "stages", runId: RUN_ID }, { store });
		assert.equal(result.action, "stages");
		if (result.action !== "stages") return;
		assert.equal(result.filter, "all");
		assert.equal(result.stages.length, 2);
	});

	test("the stages listing selects the suspended stages and echoes the current name (#4589)", () => {
		const store = createStore();
		store.recordRunStart(run([stage("parked", "suspended", { wait: TOOL_WAIT }), stage("busy", "running")]));

		const result = workflowStagesResult({ action: "stages", runId: RUN_ID, statusFilter: "waiting" }, { store });

		assert.equal(result.action, "stages");
		if (result.action !== "stages") return;
		assert.equal(result.filter, "suspended");
		assert.deepEqual(
			result.stages.map((listed) => [listed.id, listed.status]),
			[["parked", "suspended"]],
		);
	});
});

test("pooled stage controls stay registered while suspended and are removed after completion (#4589)", () => {
	const registry = createStageControlRegistry();
	const registrations = new PooledStageRegistrations(registry, async () => undefined);
	const work = { id: "work", generation: 1 };
	for (const status of ["running", "awaiting_input", "paused", "blocked", "suspended"] as const) {
		registrations.sync(work, [{ id: RUN_ID, stages: [stage(status, status, { sessionId: `session-${status}` })] }]);
		assert.equal(registry.get(RUN_ID, status)?.status, status);
		registrations.sync(work, [{ id: RUN_ID, stages: [stage(status, "completed")] }]);
		assert.equal(registry.get(RUN_ID, status), undefined);
	}
});

describe("records written while a suspended stage was called waiting (#4589)", () => {
	const recordedStage = (status: "waiting" | "suspended"): StageSnapshot =>
		JSON.parse(
			JSON.stringify({
				id: "review-id",
				name: "review",
				replayKey: "stage:review:1",
				status,
				parentIds: [],
				toolEvents: [],
				startedAt: NOW,
				sessionId: "session-review",
				wait: { kind: "release", since: NOW, promptsCompleted: 1 },
			}),
		) as StageSnapshot;

	for (const recorded of ["waiting", "suspended"] as const) {
		test(`a stage checkpoint recorded as ${recorded} is read back as suspended (#4589)`, async () => {
			const backend = await createMemoryTestBackend();
			await backend.commitWorkflowRegistration({
				workflowId: RUN_ID,
				name: "suspended-demo",
				inputs: {},
				createdAt: 1,
				status: "running",
			});
			await recordStageSessionCheckpoint(
				{
					workflowId: RUN_ID,
					backend,
					nextCheckpointId: createCheckpointIdGenerator(),
					nextReplayKey: createStageReplayKeyGenerator(RUN_ID),
					now: () => NOW,
					runTopology: { runId: RUN_ID, runName: "suspended-demo" },
					sourceOrderForStage: () => 0,
				},
				recordedStage(recorded),
				{ force: true },
			);
			const [stored] = backend.listCheckpoints(RUN_ID);
			assert.equal(stored?.kind === "stage" ? (stored.topology?.status as string) : undefined, recorded);

			const [root] = durableWorkflowRunSnapshots(backend, backend.getWorkflow(RUN_ID)!);

			assert.deepEqual(
				root?.stages.map((rebuilt) => [rebuilt.id, rebuilt.status]),
				[["review-id", "suspended"]],
			);
		});
	}

	test("a stage checkpoint with no recorded status is read back as completed (#4589)", async () => {
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: RUN_ID,
			name: "suspended-demo",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await recordStageSessionCheckpoint(
			{
				workflowId: RUN_ID,
				backend,
				nextCheckpointId: createCheckpointIdGenerator(),
				nextReplayKey: createStageReplayKeyGenerator(RUN_ID),
				now: () => NOW,
				runTopology: { runId: RUN_ID, runName: "suspended-demo" },
				sourceOrderForStage: () => 0,
			},
			JSON.parse(
				JSON.stringify({
					id: "review-id",
					name: "review",
					replayKey: "stage:review:1",
					parentIds: [],
					toolEvents: [],
					sessionId: "session-review",
				}),
			) as StageSnapshot,
			{ force: true },
		);

		const [root] = durableWorkflowRunSnapshots(backend, backend.getWorkflow(RUN_ID)!);

		assert.deepEqual(
			root?.stages.map((rebuilt) => [rebuilt.id, rebuilt.status]),
			[["review-id", "completed"]],
		);
	});

	test("a stage snapshot another host relayed as waiting is shown suspended, and any other status is left as it is (#4589)", () => {
		const relayed = [
			run([stage("parked", "suspended"), stage("busy", "running")], "recorded"),
			run([stage("done", "completed")], "untouched"),
		];
		const legacy = JSON.parse(
			JSON.stringify(relayed).replace('"status":"suspended"', '"status":"waiting"'),
		) as RunSnapshot[];
		assert.equal(legacy[0]?.stages[0]?.status as string, "waiting");

		const read = runSnapshotsFromRecord(legacy);

		assert.deepEqual(read, relayed);
		assert.equal(read[1], legacy[1], "a run with no legacy stage is not copied");
	});

	for (const [name, open] of [
		["memory", async () => new MemoryRunJournal()],
		[
			"sqlite",
			async () => {
				const directory = makeTempDirectory("suspended-journal-");
				const journal = await openSqlRunJournal(join(directory, "journal.sqlite"));
				const close = journal.close.bind(journal);
				journal.close = async () => {
					await close();
					removeTempDirectory(directory);
				};
				return journal;
			},
		],
	] as const satisfies readonly (readonly [string, () => Promise<RunJournal>])[]) {
		test(`the ${name} journal reads a run status recorded as waiting as suspended, and any other text as it was (#4589)`, async () => {
			const journal = await open();
			try {
				const header = { runId: "run", name: "demo", cwd: "/work", createdAt: 0, status: "running" };
				await journal.createRun(header);
				const outcome = await journal.acquire(header.runId, "holder");
				assert.equal(outcome.status, "acquired");
				if (outcome.status !== "acquired") return;

				await journal.append(outcome.lease, { type: "StatusChanged", payload: { status: "waiting" } });
				assert.equal((await journal.getRun(header.runId))?.status, "suspended");
				assert.equal((await journal.listRuns())[0]?.status, "suspended");

				await journal.append(outcome.lease, { type: "StatusChanged", payload: { status: "done" } });
				assert.equal((await journal.getRun(header.runId))?.status, "done");
			} finally {
				await journal.close();
			}
		});
	}
});
