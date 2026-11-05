/**
 * A pooled root's checkpoint index follows the root's own checkpoints, not its children's (#4318).
 *
 * Local workers write every pooled child's checkpoints into the root's run, one stage checkpoint per stage session
 * they open. A long-running root folded 250,000 to 400,000 of them into the parent's in-memory index. This test
 * counts what the parent's backend indexes as the children's checkpoints grow, and what one more checkpoint of the
 * root itself costs: both stay flat. The same journal folded by a backend that keeps every checkpoint shows the
 * growth the narrowing removes.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { createJournalProjection } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { type Lease, RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import {
	DURABLE_BOUNDARY_TOPOLOGY_VERSION,
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageCheckpoint,
} from "../../packages/workflows/src/durable/types.js";

const ROOT = "pooled-root-index";
const CHILDREN = 16;
/**
 * Checkpoints the root records itself: a stage and one boundary start per child before its children run, and a tool
 * after the pool attached whose id starts with the stage's replay key.
 */
const OWN_CHECKPOINTS = CHILDREN + 2;
const DESCENDANT_COUNTS = [1_000, 20_000, 200_000] as const;
/** Structural: appends and folds 200,000 child checkpoints, then folds them again in a backend that keeps them all. */
const ROOT_INDEX_TIMEOUT_MS = 240_000;

const backends: JournalDurableBackend[] = [];
afterEach(async () => {
	for (const backend of backends.splice(0)) await backend.close();
});

function scope(child: number): string {
	return `workflow:pooled-child:${child + 1}`;
}

function boundaryStart(child: number): DurableStageCheckpoint {
	const stageId = `boundary-${child}`;
	return {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `boundary-start:${scope(child)}`,
		name: "workflow:pooled-child",
		replayKey: scope(child),
		startedAt: 1,
		completedAt: 1 + child,
		topology: {
			version: DURABLE_STAGE_TOPOLOGY_VERSION,
			stageId,
			parentIds: ["root-stage"],
			sourceOrder: child + 1,
			status: "running",
			run: { runId: ROOT, runName: "pooled-root" },
			boundary: {
				version: DURABLE_BOUNDARY_TOPOLOGY_VERSION,
				replayScope: scope(child),
				alias: "pooled-child",
				workflow: "pooled-child",
				invocationFingerprint: `fingerprint-${child}`,
				child: {
					runId: `child-run-${child}`,
					runName: "pooled-child",
					parentRunId: ROOT,
					parentStageId: stageId,
					rootRunId: ROOT,
				},
				event: "start",
				status: "running",
			},
		},
	};
}

function rootStage(completedAt: number, id = "root-stage"): DurableStageCheckpoint {
	return {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: id,
		name: id,
		replayKey: `${id}:1`,
		output: `${id} done`,
		completedAt,
		topology: {
			version: DURABLE_STAGE_TOPOLOGY_VERSION,
			stageId: id,
			parentIds: [],
			sourceOrder: 0,
			status: "completed",
			run: { runId: ROOT, runName: "pooled-root" },
		},
	};
}

function rootTool(id: string, completedAt: number): DurableCheckpoint {
	return { kind: "tool", workflowId: ROOT, checkpointId: id, name: id, argsHash: id, output: id, completedAt };
}

/** The checkpoint a local worker records each time a pooled stage opens or replaces its session. */
function sessionCheckpoint(index: number): DurableStageCheckpoint {
	const child = index % CHILDREN;
	return {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `${scope(child)}:session:session-${index}:${index}`,
		replayKey: `${scope(child)}:work:1`,
		name: "work",
		sessionId: `session-${index}`,
		completedAt: 1_000 + index,
		topology: {
			version: DURABLE_STAGE_TOPOLOGY_VERSION,
			stageId: `child-stage-${child}`,
			parentIds: [],
			sourceOrder: 0,
			status: "running",
			run: {
				runId: `child-run-${child}`,
				runName: "pooled-child",
				parentRunId: ROOT,
				parentStageId: `boundary-${child}`,
				rootRunId: ROOT,
			},
		},
	};
}

/**
 * Appends checkpoints to the root's run under its lease, as the pool coordinator writes a worker's checkpoints. Unkeyed:
 * the memory journal finds a key by scanning the run, and a fold does not read keys.
 */
async function appendAsPool(journal: MemoryRunJournal, lease: Lease, checkpoints: Iterable<DurableCheckpoint>) {
	for (const checkpoint of checkpoints)
		await journal.append(lease, { type: RUN_EVENT_TYPES.checkpointRecorded, payload: checkpoint as never });
}

function* sessions(count: number): Iterable<DurableCheckpoint> {
	for (let index = 0; index < count; index++) yield sessionCheckpoint(index);
}

interface ProjectionCounts {
	indexed: number;
	counted: number;
}

/** Counts the checkpoints every projection indexes (keeps in its maps) and only counts, from now until `restore`. */
function countProjectionWork(): { readonly counts: ProjectionCounts; restore(): void } {
	const projection = Object.getPrototypeOf(createJournalProjection()) as {
		index: (...args: never[]) => DurableCheckpoint | undefined;
		countCheckpoint: (...args: never[]) => void;
	};
	const { index, countCheckpoint } = projection;
	const counts: ProjectionCounts = { indexed: 0, counted: 0 };
	projection.index = function (this: unknown, ...args: never[]) {
		const indexed = index.apply(this, args);
		if (indexed !== undefined) counts.indexed++;
		return indexed;
	};
	projection.countCheckpoint = function (this: unknown, ...args: never[]) {
		counts.counted++;
		return countCheckpoint.apply(this, args);
	};
	return {
		counts,
		restore() {
			projection.index = index;
			projection.countCheckpoint = countCheckpoint;
		},
	};
}

async function open(journal: MemoryRunJournal, runs?: readonly string[]): Promise<JournalDurableBackend> {
	const backend = await JournalDurableBackend.open(journal, runs === undefined ? {} : { runs, ownsJournal: false });
	backends.push(backend);
	return backend;
}

interface RootIndex {
	/** Child checkpoints folded into the root's index, and folded only as counted. */
	readonly descendantsIndexed: number;
	readonly descendantsCounted: number;
	/** What the root's index lists, what its handle counts, and what one more own checkpoint indexes and lists. */
	readonly listed: number;
	readonly completed: number;
	readonly ownCommitIndexed: number;
	readonly listedAfterOwnCommit: number;
	/** What a backend that keeps every checkpoint lists from the same journal. */
	readonly listedKeepingAll: number;
}

async function measure(descendants: number): Promise<RootIndex> {
	const journal = new MemoryRunJournal();
	const parent = await open(journal);
	await parent.commitWorkflowRegistration({
		workflowId: ROOT,
		name: "pooled-root",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	await parent.commitCheckpoint(rootStage(1));
	for (let child = 0; child < CHILDREN; child++) await parent.commitCheckpoint(boundaryStart(child));
	// The pool attaches here (`LocalWorkerPool.prepare`), before any child runs.
	await parent.retainOwnCheckpoints(ROOT);
	// Only a boundary's replay key scopes a child's checkpoints, not any replay key of the root.
	await parent.commitCheckpoint(rootTool("root-stage:1:after-pool", 2));
	const state = await journal.leaseState(ROOT);
	assert.ok(state !== undefined);
	await appendAsPool(journal, { runId: ROOT, holderId: state.holderId, epoch: state.epoch }, sessions(descendants));

	const folding = countProjectionWork();
	try {
		await parent.catchUpWorkflow(ROOT);
	} finally {
		folding.restore();
	}
	const listed = parent.listCheckpoints(ROOT).length;
	const completed = parent.getWorkflow(ROOT)?.completedCheckpoints ?? -1;

	const committing = countProjectionWork();
	try {
		await parent.commitCheckpoint(rootStage(10_000_000, "root-after-children"));
	} finally {
		committing.restore();
	}
	const listedAfterOwnCommit = parent.listCheckpoints(ROOT).length;

	const keepingAll = await open(journal, [ROOT]);
	return {
		descendantsIndexed: folding.counts.indexed,
		descendantsCounted: folding.counts.counted,
		listed,
		completed,
		ownCommitIndexed: committing.counts.indexed,
		listedAfterOwnCommit,
		listedKeepingAll: keepingAll.listCheckpoints(ROOT).length,
	};
}

test(
	"a pooled root's checkpoint index and the cost of its own checkpoints stay flat as its children's grow to 200,000 (#4318)",
	async () => {
		const measured = new Map<number, RootIndex>();
		for (const descendants of DESCENDANT_COUNTS) measured.set(descendants, await measure(descendants));
		console.log(
			[...measured]
				.map(
					([descendants, index]) =>
						`${descendants} child checkpoints: root index ${index.listed} (keeping all: ${index.listedKeepingAll}), ` +
						`${index.descendantsIndexed} indexed, ${index.descendantsCounted} counted`,
				)
				.join("\n"),
		);
		for (const [descendants, index] of measured) {
			assert.deepEqual(
				index,
				{
					descendantsIndexed: 0,
					descendantsCounted: descendants,
					listed: OWN_CHECKPOINTS,
					completed: OWN_CHECKPOINTS + descendants,
					ownCommitIndexed: 1,
					listedAfterOwnCommit: OWN_CHECKPOINTS + 1,
					listedKeepingAll: OWN_CHECKPOINTS + 1 + descendants,
				},
				`${descendants} child checkpoints`,
			);
		}
	},
	ROOT_INDEX_TIMEOUT_MS,
);

const WRITERS = 32;
const WRITES_PER_WRITER = 250;
const ROOT_WRITES = 40;

test("many pool writers racing the root's own writes and catch-ups leave exactly the root's checkpoints in its index (#4318)", async () => {
	const journal = new MemoryRunJournal();
	const parent = await open(journal);
	await parent.commitWorkflowRegistration({
		workflowId: ROOT,
		name: "pooled-root",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	await parent.commitCheckpoint(rootStage(1));
	for (let child = 0; child < CHILDREN; child++) await parent.commitCheckpoint(boundaryStart(child));
	await parent.retainOwnCheckpoints(ROOT);
	const state = await journal.leaseState(ROOT);
	assert.ok(state !== undefined);
	const lease = { runId: ROOT, holderId: state.holderId, epoch: state.epoch };
	// Worker clocks disagree with the root's: a child checkpoint may complete "before" the boundary that started it.
	const skewed = (index: number): DurableCheckpoint => ({
		...sessionCheckpoint(index),
		completedAt: index % 3 === 0 ? 0 : 5_000_000 + ((index * 7_919) % 100_000),
	});
	const writers = Array.from({ length: WRITERS }, async (_, writer) => {
		for (let write = 0; write < WRITES_PER_WRITER; write++) {
			await appendAsPool(journal, lease, [skewed(writer * WRITES_PER_WRITER + write)]);
			if (write % 16 === 0) await new Promise((resolve) => setImmediate(resolve));
		}
	});
	const root = (async () => {
		for (let write = 0; write < ROOT_WRITES; write++) {
			await parent.commitCheckpoint(rootStage(5_000_000 + write, `root-step-${write}`));
			await parent.catchUpWorkflow(ROOT);
		}
	})();
	await Promise.all([...writers, root]);
	await parent.catchUpWorkflow(ROOT);

	const keepingAll = (await open(journal, [ROOT])).listCheckpoints(ROOT);
	const childWrites = WRITERS * WRITES_PER_WRITER;
	const own = OWN_CHECKPOINTS - 1;
	assert.equal(keepingAll.length, own + ROOT_WRITES + childWrites);
	assert.deepEqual(
		parent.listCheckpoints(ROOT),
		keepingAll.filter((checkpoint) => !checkpoint.checkpointId.startsWith("workflow:pooled-child:")),
	);
	assert.equal(parent.listCheckpoints(ROOT).length, own + ROOT_WRITES);
	assert.equal(parent.getWorkflow(ROOT)?.completedCheckpoints, keepingAll.length);
});

test("a child checkpoint folded twice while its scope is retained is let go of once (#4318)", async () => {
	const journal = new MemoryRunJournal();
	const parent = await open(journal);
	await parent.commitWorkflowRegistration({
		workflowId: ROOT,
		name: "pooled-root",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	await parent.commitCheckpoint(rootStage(1));
	await parent.commitCheckpoint(boundaryStart(0));
	// The child wrote before the pool attached, as a resumed root folds it: its scope stays retained.
	await parent.commitCheckpoint(sessionCheckpoint(0));
	await parent.retainOwnCheckpoints(ROOT);
	const state = await journal.leaseState(ROOT);
	assert.ok(state !== undefined);
	const repeated = sessionCheckpoint(CHILDREN);
	await appendAsPool(journal, { runId: ROOT, holderId: state.holderId, epoch: state.epoch }, [repeated, repeated]);
	await parent.catchUpWorkflow(ROOT);
	const listed = () => parent.listCheckpoints(ROOT).map((checkpoint) => checkpoint.checkpointId);
	assert.deepEqual(listed(), [
		"root-stage",
		`boundary-start:${scope(0)}`,
		sessionCheckpoint(0).checkpointId,
		repeated.checkpointId,
	]);
	parent.releaseCheckpointScope(ROOT, scope(0));
	assert.deepEqual(listed(), ["root-stage", `boundary-start:${scope(0)}`]);
	assert.equal(parent.getWorkflow(ROOT)?.completedCheckpoints, 4);
});

test("a root's own checkpoints in older shapes and other runs' boundaries stay in its index (#4318)", async () => {
	const parent = await open(new MemoryRunJournal());
	await parent.commitWorkflowRegistration({
		workflowId: ROOT,
		name: "pooled-root",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	await parent.retainOwnCheckpoints(ROOT);
	const boundary = (scope: string, run?: { readonly runId: string; readonly runName: string }): DurableCheckpoint => ({
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `boundary-start:${scope}`,
		name: scope,
		replayKey: scope,
		completedAt: 3,
		topology: {
			version: DURABLE_STAGE_TOPOLOGY_VERSION,
			stageId: `${scope}-boundary`,
			parentIds: [],
			...(run === undefined ? {} : { run }),
			boundary: {
				version: DURABLE_BOUNDARY_TOPOLOGY_VERSION,
				replayScope: scope,
				alias: scope,
				workflow: scope,
				invocationFingerprint: `fingerprint-${scope}`,
				child: {
					runId: `${scope}-run`,
					runName: scope,
					parentRunId: ROOT,
					parentStageId: `${scope}-boundary`,
					rootRunId: ROOT,
				},
				event: "start",
				status: "running",
			},
		},
	});
	for (const checkpoint of [
		// A stage recorded before stages carried topology.
		{
			kind: "stage",
			workflowId: ROOT,
			checkpointId: "legacy-stage",
			name: "legacy",
			replayKey: "legacy-stage:1",
			completedAt: 2,
		},
		// A boundary start recorded before boundaries named their owning run: the root's own.
		boundary("legacy-scope:1"),
		rootTool("legacy-scope:1:child-record", 4),
		// The scope `legacy-scope:1` is a prefix of this id's, but not up to a colon: the record is the root's.
		rootTool("legacy-scope:10:own-record", 4),
		// A boundary start another run recorded opens no scope of the root's.
		boundary("foreign-scope:1", { runId: "another-run", runName: "another" }),
		rootTool("foreign-scope:1:record", 5),
	] satisfies DurableCheckpoint[])
		await parent.commitCheckpoint(checkpoint);
	assert.deepEqual(
		parent.listCheckpoints(ROOT).map((checkpoint) => checkpoint.checkpointId),
		[
			"legacy-stage",
			"boundary-start:legacy-scope:1",
			"boundary-start:foreign-scope:1",
			"legacy-scope:10:own-record",
			"foreign-scope:1:record",
		],
	);
	assert.equal(parent.getWorkflow(ROOT)?.completedCheckpoints, 6);
});
