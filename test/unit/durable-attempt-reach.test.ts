import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
	attemptReachedCheckpoints,
	beginDurableWorkflowAttempt,
	boundaryAttemptCheckpoint,
	latestWorkflowAttempt,
	stampCheckpointAttempt,
	workflowAttemptCheckpoint,
	workflowAttemptOf,
} from "../../packages/workflows/src/durable/attempt-identity.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	DURABLE_BOUNDARY_TOPOLOGY_VERSION,
	DURABLE_STAGE_TOPOLOGY_VERSION,
	DURABLE_TOOL_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageCheckpoint,
	type DurableStageRunTopology,
	type DurableToolCheckpoint,
} from "../../packages/workflows/src/durable/types.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

const ROOT = "root";
let clock = 0;
const tick = (): number => {
	clock += 1;
	return clock;
};

function stage(
	replayKey: string,
	attempt: number,
	fields: Partial<DurableStageCheckpoint> & { readonly run?: DurableStageRunTopology } = {},
): DurableStageCheckpoint {
	const { run, ...rest } = fields;
	clock += 1;
	return {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `${replayKey}:${attempt}:${clock}`,
		name: replayKey,
		replayKey,
		completedAt: clock,
		topology: {
			version: DURABLE_STAGE_TOPOLOGY_VERSION,
			stageId: replayKey,
			parentIds: [],
			status: "completed",
			...(run === undefined ? {} : { run }),
		},
		...(attempt > 0 ? { attempt } : {}),
		...rest,
	};
}

function tool(argsHash: string, attempt: number, run?: DurableStageRunTopology): DurableToolCheckpoint {
	clock += 1;
	return {
		kind: "tool",
		workflowId: ROOT,
		checkpointId: `tool:${argsHash}:${clock}`,
		name: argsHash,
		argsHash,
		output: argsHash,
		completedAt: clock,
		topology: {
			version: DURABLE_TOOL_TOPOLOGY_VERSION,
			nodeId: `tool:${argsHash}`,
			ordinal: 1,
			order: 1,
			parentIds: [],
			...(run === undefined ? {} : { run }),
		},
		...(attempt > 0 ? { attempt } : {}),
	};
}

/** The start record of child run `child` at boundary `replayKey` of run `parent`. */
function boundaryStart(replayKey: string, child: string, attempt: number, parent = ROOT): DurableStageCheckpoint {
	const record = stage(replayKey, attempt, parent === ROOT ? {} : { run: runOf(parent) });
	return {
		...record,
		checkpointId: `boundary-start:${replayKey}`,
		topology: {
			...record.topology!,
			status: "running",
			boundary: {
				version: DURABLE_BOUNDARY_TOPOLOGY_VERSION,
				replayScope: replayKey,
				alias: child,
				workflow: child,
				invocationFingerprint: "fingerprint",
				child: { runId: child, runName: child, parentRunId: parent, parentStageId: replayKey, rootRunId: ROOT },
				event: "start",
				status: "running",
			},
		},
	};
}

function runOf(runId: string): DurableStageRunTopology {
	return { runId, runName: runId, parentRunId: ROOT, rootRunId: ROOT };
}

const marker = (attempt: number) => workflowAttemptCheckpoint(ROOT, attempt, tick());

function kept(checkpoints: readonly DurableCheckpoint[], rootReach = true): readonly string[] {
	return attemptReachedCheckpoints(checkpoints, ROOT, { rootReach }).map((checkpoint) => checkpoint.checkpointId);
}

describe("attempt records (#4874)", () => {
	test("an attempt record names its run and attempt, and only such a record does (#4874)", () => {
		assert.equal(workflowAttemptOf(marker(3)), 3);
		const record = marker(1);
		assert.equal(workflowAttemptOf({ ...record, workflowId: "fork" }), undefined, "a copy made for another run");
		assert.equal(workflowAttemptOf({ ...record, response: null }), undefined);
		for (const suffix of ["0", "-1", "1.5", "x", ""])
			assert.equal(workflowAttemptOf({ ...record, promptHash: `workflow-attempt:${suffix}` }), undefined, suffix);
		assert.equal(workflowAttemptOf({ ...record, promptHash: "ui:prompt" }), undefined);
		assert.equal(workflowAttemptOf(stage("s", 1)), undefined);
		assert.equal(
			latestWorkflowAttempt([stage("s", 0), marker(2), marker(1), { ...marker(5), workflowId: "fork" }]),
			2,
		);
		assert.equal(latestWorkflowAttempt([stage("s", 0)]), 0);
	});

	test("a committed graph record carries its run's attempt unless one is stored under its key (#4874)", () => {
		const fresh = stage("s", 0);
		assert.equal(stampCheckpointAttempt(fresh, 0, undefined), fresh, "no attempt yet");
		assert.equal(stampCheckpointAttempt(fresh, 2, undefined).attempt, 2);
		assert.equal(stampCheckpointAttempt(fresh, 2, stage("s", 1)).attempt, 1, "keeps the stored record's stamp");
		assert.equal("attempt" in stampCheckpointAttempt(stage("s", 2), 2, stage("s", 0)), false);
		const ui = marker(1);
		assert.equal(stampCheckpointAttempt(ui, 2, undefined), ui);
		const reserved: DurableToolCheckpoint = { ...tool("workflow-run-timing", 0), topology: undefined };
		assert.equal(stampCheckpointAttempt(reserved, 2, undefined), reserved);
		assert.equal(stampCheckpointAttempt(tool("t", 0), 2, undefined).attempt, 2);
	});

	test("a boundary attempt record joins its boundary's group without boundary topology (#4874)", () => {
		const start = boundaryStart("workflow:c:1", "c", 0);
		const record = boundaryAttemptCheckpoint({
			workflowId: ROOT,
			replayKey: start.replayKey,
			name: start.name,
			topology: start.topology!,
			attempt: 2,
			now: 7,
		});
		assert.equal(record.checkpointId, "boundary-attempt:workflow:c:1:2");
		assert.equal(record.replayKey, start.replayKey);
		assert.equal(record.topology?.boundary, undefined);
		assert.equal(record.topology?.status, "running");
		assert.equal(record.topology?.stageId, start.topology?.stageId);
	});

	test("an attempt begins with a record only on a run that already has checkpoints (#4874)", async () => {
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: ROOT,
			name: ROOT,
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await beginDurableWorkflowAttempt(backend, ROOT);
		assert.equal(backend.listCheckpoints(ROOT).length, 0, "a run without progress records no attempt");
		await backend.commitCheckpoint(stage("s", 0));
		await beginDurableWorkflowAttempt(backend, ROOT);
		await beginDurableWorkflowAttempt(backend, ROOT);
		assert.deepEqual(
			backend.listCheckpoints(ROOT).map((checkpoint) => workflowAttemptOf(checkpoint)),
			[undefined, 1, 2],
		);
		assert.equal(backend.workflowAttempt(ROOT), 2);
		const later = stage("t", 0);
		await backend.commitCheckpoint(later);
		const last = backend.listCheckpoints(ROOT).find((checkpoint) => checkpoint.checkpointId === later.checkpointId);
		assert.ok(last?.kind === "stage" && last.attempt === 2, "a later record is stamped with the attempt");
		const cannotStamp = new Proxy(backend, {
			get: (target, key) => (key === "workflowAttempt" ? undefined : Reflect.get(target, key)),
		}) as DurableWorkflowBackend;
		await beginDurableWorkflowAttempt(cannotStamp, ROOT);
		assert.equal(latestWorkflowAttempt(backend.listCheckpoints(ROOT)), 2, "a backend that cannot stamp records none");
	});
});

describe("the records of the attempt each run last ran in (#4874)", () => {
	test("a history without attempt records is returned as it is (#4874)", () => {
		const history = [stage("s1", 0), tool("t1", 0), stage("s2", 0)];
		assert.equal(attemptReachedCheckpoints(history, ROOT, { rootReach: true }), history);
	});

	test("the root shows what its latest attempt reached, with the outputs replay reads (#4874)", () => {
		const s1Output = stage("s1", 0, { output: "s1" });
		const s1Session = stage("s1", 0, { sessionId: "session" });
		const s2Failed = stage("s2", 0, { topology: { version: 1, stageId: "s2", parentIds: [], status: "failed" } });
		const t1Failed = tool("t1", 0);
		const reserved: DurableToolCheckpoint = { ...tool("workflow-run-timing", 0), topology: undefined };
		const attempt = marker(1);
		const s1Replay = stage("s1", 1);
		const t1Replay = tool("t1", 1);
		const history = [s1Output, s1Session, s2Failed, t1Failed, reserved, attempt, s1Replay, t1Replay];
		assert.deepEqual(kept(history), [
			s1Output.checkpointId,
			reserved.checkpointId,
			attempt.checkpointId,
			s1Replay.checkpointId,
			t1Replay.checkpointId,
		]);
		assert.deepEqual(
			kept(history, false),
			history.map((checkpoint) => checkpoint.checkpointId),
		);
	});

	test("a cached child keeps the attempt it completed in, and a child the root never reached is left out (#4874)", () => {
		const cached = runOf("cached");
		const unreached = runOf("unreached");
		const nested = { ...runOf("nested"), parentRunId: "unreached" };
		const cachedStart = boundaryStart("workflow:cached:1", "cached", 1);
		const cachedOwn = [stage("workflow:cached:1:c1", 1, { run: cached }), tool("workflow:cached:1:ct", 1, cached)];
		const unreachedStart = boundaryStart("workflow:unreached:1", "unreached", 1);
		const unreachedOwn = stage("workflow:unreached:1:u1", 1, { run: unreached });
		const nestedStart = boundaryStart("workflow:unreached:1:workflow:nested:1", "nested", 1, "unreached");
		const nestedOwn = stage("workflow:unreached:1:workflow:nested:1:n1", 1, { run: nested });
		const cachedReplay = stage("workflow:cached:1", 2);
		const [first, second] = [marker(1), marker(2)];
		const history = [
			first,
			cachedStart,
			...cachedOwn,
			unreachedStart,
			unreachedOwn,
			nestedStart,
			nestedOwn,
			second,
			cachedReplay,
		];
		const expected = [first, cachedStart, ...cachedOwn, second, cachedReplay];
		assert.deepEqual(
			kept(history),
			expected.map((checkpoint) => checkpoint.checkpointId),
		);
		// Replay looks a cached child up before it records the replay: every root boundary stays, and so do the runs
		// under it.
		const withoutReplay = history.slice(0, -1);
		assert.deepEqual(
			kept(withoutReplay, false),
			withoutReplay.map((checkpoint) => checkpoint.checkpointId),
		);
	});

	test("a child started again shows what that attempt reached (#4874)", () => {
		const child = runOf("child");
		const start = boundaryStart("workflow:child:1", "child", 0);
		const c1 = stage("workflow:child:1:c1", 0, { run: child, output: "c1" });
		const ct = tool("workflow:child:1:ct", 0, child);
		const restarted = boundaryAttemptCheckpoint({
			workflowId: ROOT,
			replayKey: start.replayKey,
			name: start.name,
			topology: start.topology!,
			attempt: 1,
			now: tick(),
		});
		const stamped = { ...restarted, attempt: 1 };
		const c1Replay = stage("workflow:child:1:c1", 1, { run: child });
		const history = [start, c1, ct, marker(1), stamped, c1Replay];
		assert.deepEqual(
			kept(history),
			[start, c1, history[3]!, stamped, c1Replay].map((checkpoint) => checkpoint.checkpointId),
		);
	});

	test("the records of a child run whose boundary is not listed are kept (#4874)", () => {
		const child = runOf("released");
		const own = [stage("workflow:released:1:c1", 0, { run: child }), tool("workflow:released:1:ct", 0, child)];
		const history = [marker(1), stage("s1", 1), ...own];
		assert.deepEqual(
			kept(history),
			history.map((checkpoint) => checkpoint.checkpointId),
		);
	});

	test("each prompt occurrence is a node of its own (#4874)", () => {
		const occurrence = (key: string, attempt: number) =>
			stage("prompt:input:1", attempt, {
				topology: { version: 1, stageId: key, parentIds: [], status: "completed", occurrenceKey: key },
			});
		const first = occurrence("first", 0);
		const second = occurrence("second", 1);
		assert.deepEqual(
			kept([first, marker(1), second]).filter((id) => id.startsWith("prompt:")),
			[second.checkpointId],
		);
	});
});
