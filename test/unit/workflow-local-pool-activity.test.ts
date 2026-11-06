import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import {
	openSqlPoolQueue,
	type PoolWork,
	type SqlPoolQueue,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { bindRunDurableBackend, durableBackendForRun } from "../../packages/workflows/src/durable/run-owner-backend.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { rehydrateError, type SerializedError } from "../../packages/workflows/src/shared/error-codec.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type {
	CoordinatorEvent,
	CoordinatorNotice,
	PoolActivityUpdate,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import type { PublishedStages } from "../../packages/workflows/src/workers/open-stages.js";
import type { PublishedRun } from "../../packages/workflows/src/workers/run-changes.js";
import { PoolStageHandoff, type PoolStageQueue } from "../../packages/workflows/src/workers/stage-handoff.js";
import { publicationRejected, staleWorkLease } from "../helpers/pool-errors.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const ROOT = testRunId("local-pool-activity-root");
const fixtureBoundary = poolWorkFixture();
const descriptor = fixtureBoundary.work;
const boundary: DurableStageCheckpoint = JSON.parse(
	JSON.stringify(fixtureBoundary.boundary).replaceAll('"root"', `"${ROOT}"`),
);

afterEach(() => {
	vi.restoreAllMocks();
});

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status: "running", parentIds: [], toolEvents: [], ...overrides };
}

function childRun(stages: StageSnapshot[]): RunSnapshot {
	return {
		id: descriptor.childRunId,
		name: descriptor.childRunId,
		inputs: {},
		status: "running",
		stages,
		toolNodes: [],
		startedAt: 0,
		parentRunId: ROOT,
		parentStageId: descriptor.boundaryId,
		rootRunId: ROOT,
	};
}

/** The parts of a pool this file drives directly, as its coordinator and the root's store would. */
interface PoolInternals {
	root?: string;
	store?: ReturnType<typeof createStore>;
	queue?: SqlPoolQueue;
	coordinator?: { readonly port: { send(message: CoordinatorNotice): void } };
	handoff?: PoolStageHandoff;
	readonly works: Map<string, PoolWork>;
	queueView(): PoolStageQueue;
	receive(event: CoordinatorEvent): Promise<void>;
	routePrompts(publications: readonly { readonly work: PoolWork; readonly runs: readonly PublishedStages[] }[]): void;
}

/**
 * The pool's side of activity a coordinator sends, with the pool's handoff over a real root journal. With `host`, the
 * pool is the root's pool of a shared placement on that host, whose root store and queue it holds (#4505).
 */
async function activityPool(options: { readonly host?: string } = {}) {
	const directory = makeTempDirectory("local-pool-activity-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	await backend.commitWorkflowRegistration({
		workflowId: ROOT,
		name: ROOT,
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire(ROOT, backend.holderId);
	if (acquired.status !== "acquired") throw new Error("No root lease");
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(acquired.lease, 60_000);
	await queue.enqueue(acquired.lease, descriptor, boundary);
	const work = await queue.claim(acquired.lease, "worker-one", [descriptor], 60_000);
	assert.ok(work);
	const store = createStore();
	const root: RunSnapshot = {
		id: ROOT,
		name: ROOT,
		inputs: {},
		status: "running",
		rootRunId: ROOT,
		toolNodes: [],
		startedAt: 0,
		stages: [
			stage(descriptor.boundaryId, {
				name: "child",
				replayKey: descriptor.scope,
				workflowChildRun: { alias: "child", workflow: "child", runId: descriptor.childRunId },
			}),
		],
	};
	bindRunDurableBackend(root, backend);
	bindStoreDurableBackend(store, backend);
	store.recordRunStart(root);
	const pool = new LocalWorkerPool(
		backend,
		options.host === undefined
			? { journalPath: path, workers: 1, definitions: [] }
			: {
					durable: { selection: "{}", agentDir: directory },
					shared: { stateDirectory: directory, host: options.host, claimWindowMs: 0 },
					workers: 1,
					definitions: [],
				},
	);
	const internals = pool as never as PoolInternals;
	if (options.host !== undefined) {
		internals.store = store;
		internals.queue = queue;
	}
	const notices: CoordinatorNotice[] = [];
	// A pool hears its coordinator's activity only once it prepared its root.
	internals.root = ROOT;
	internals.coordinator = { port: { send: (message) => notices.push(message) } };
	internals.handoff = new PoolStageHandoff(backend, store, internals.queueView(), acquired.lease);
	const routed = vi.spyOn(internals, "routePrompts");
	let batch = 0;
	return {
		store,
		work,
		notices,
		/** The stages of each run the latest accepted publications handed prompt routing, by run. */
		routed: () =>
			(routed.mock.lastCall?.[0] ?? []).flatMap(({ runs }) =>
				runs.map((run) => [run.id, run.stages.map((entry) => entry.id)]),
			),
		known: () => internals.works.set(work.id, work),
		/** Records the handoff's receipt records, which a publication starts without waiting for them. */
		recordings: () => vi.spyOn(internals.handoff!, "recordReceipts"),
		async queueDirect(stageKey: string, id: string) {
			const group = `workflow:${ROOT}`;
			const queued = await store.queueStageMessage(
				{
					runId: descriptor.childRunId,
					stageKey,
					from: { id: "planner", name: "planner", group },
					message: { id, timestamp: 1, content: { text: id } },
					queuedAt: new Date().toISOString(),
				},
				group,
				group,
				durableBackendForRun(backend, store, descriptor.childRunId)!,
			);
			assert.equal(queued?.ok, true);
		},
		receive: (event: CoordinatorEvent) => internals.receive(event),
		async publish(runs: readonly PublishedRun[]) {
			const token = (({ id, generation, worker, epoch, renewedAt, expiresAt }: PoolWork) => ({
				id,
				generation,
				worker,
				epoch,
				renewedAt,
				expiresAt,
			}))(work);
			const entries: PoolActivityUpdate[] = [{ work: token, runs }];
			await internals.receive({ kind: "activity", batch: ++batch, entries });
			const published = notices.at(-1);
			assert.equal(published?.kind, "published");
			return published.kind === "published" ? published.rejected : [];
		},
		close() {
			// No coordinator ever ran to answer the pool's close.
			internals.coordinator = undefined;
			return pool.close();
		},
		async dispose() {
			internals.coordinator = undefined;
			await pool.close();
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test("an attempt refused before the root knew its work keeps that refusal for its later changes (#4317)", async () => {
	const pool = await activityPool();
	try {
		const attempt = { root: ROOT, workId: pool.work.id, generation: pool.work.generation };
		const refusedAsUntracked = (
			rejected: readonly { workId: string; generation: number; error: SerializedError }[],
		) => {
			assert.equal(rejected.length, 1);
			assert.deepEqual([rejected[0]!.workId, rejected[0]!.generation], [attempt.workId, attempt.generation]);
			const error = rehydrateError(rejected[0]!.error);
			publicationRejected({ ...attempt, reason: "stale-lease" })(error);
			staleWorkLease({ ...attempt, reason: "missing" })(error.cause);
			return rejected[0]!.error;
		};
		const first = refusedAsUntracked(await pool.publish([childRun([stage("a")])]));
		pool.known();
		const changed = { kind: "changes" as const, id: descriptor.childRunId, stages: [stage("a")], toolNodes: [] };
		const later = refusedAsUntracked(await pool.publish([changed]));
		assert.deepEqual(later, first, "not refused as outside the work's runs, but with the first refusal");
		assert.deepEqual(pool.routed(), [], "a refused publication reaches no prompt routing");
		assert.deepEqual(await pool.publish([childRun([stage("a")])]), []);
		assert.deepEqual(await pool.publish([changed]), []);
		assert.equal(pool.store.run(descriptor.childRunId)?.stages[0]?.id, "a");
	} finally {
		await pool.dispose();
	}
});

test("prompt routing gets a changed run's changed stages and its other open stages, until its work ends (#4317)", async () => {
	const pool = await activityPool();
	try {
		pool.known();
		const published = [stage("done", { status: "completed" }), stage("open"), stage("asked")];
		assert.deepEqual(await pool.publish([childRun(published)]), []);
		assert.deepEqual(pool.routed(), [[descriptor.childRunId, ["done", "open", "asked"]]]);
		const changed = {
			kind: "changes" as const,
			id: descriptor.childRunId,
			stages: [stage("asked", { status: "completed" })],
			toolNodes: [],
		};
		assert.deepEqual(await pool.publish([changed]), []);
		assert.deepEqual(pool.routed(), [[descriptor.childRunId, ["asked", "open"]]]);
		await pool.receive({ kind: "result", workId: pool.work.id, result: {} });
		assert.deepEqual(await pool.publish([{ ...changed, stages: [] }]), []);
		assert.deepEqual(pool.routed(), [[descriptor.childRunId, []]], "a work that ended hands over nothing it held");
	} finally {
		await pool.dispose();
	}
});

/** Prompt routing's stages for one change to a child whose `size` nested runs ended but the first. */
async function routedForNestedChange(size: number) {
	const pool = await activityPool();
	try {
		pool.known();
		const nested = Array.from({ length: size }, (_, index) => ({
			...childRun([stage(`work-${index}`, index === 0 ? {} : { status: "completed" })]),
			id: `nested-${index}`,
			parentRunId: descriptor.childRunId,
			parentStageId: `host-${index}`,
		}));
		const hosts = Array.from({ length: size }, (_, index) =>
			stage(`host-${index}`, {
				status: "completed",
				workflowChildRun: { alias: `n${index}`, workflow: "nested", runId: `nested-${index}` },
			}),
		);
		assert.deepEqual(await pool.publish([childRun(hosts), ...nested]), []);
		assert.deepEqual(
			await pool.publish([{ kind: "changes", id: descriptor.childRunId, stages: [stage("next")], toolNodes: [] }]),
			[],
		);
		return pool.routed();
	} finally {
		await pool.dispose();
	}
}

test("prompt routing gets the open stages of the nested runs a change leaves out, however many ended (#4317)", async () => {
	const small = await routedForNestedChange(100);
	assert.deepEqual(small, [
		[descriptor.childRunId, ["next"]],
		["nested-0", ["work-0"]],
	]);
	assert.deepEqual(await routedForNestedChange(1_000), small);
});

test("a pool that closes stops applying an activity batch between turns (#4317)", async () => {
	const pool = await activityPool();
	try {
		pool.known();
		const stages = Array.from({ length: 600 }, (_, index) => stage(`stage-${index}`, { status: "completed" }));
		assert.deepEqual(await pool.publish([childRun(stages)]), []);
		const token = (({ id, generation, worker, epoch, renewedAt, expiresAt }: PoolWork) => ({
			id,
			generation,
			worker,
			epoch,
			renewedAt,
			expiresAt,
		}))(pool.work);
		const entries = ["first", "second", "third"].map((label) => ({
			work: token,
			runs: [{ ...childRun(stages), label }],
		}));
		setImmediate(() => void pool.close());
		await assert.rejects(pool.receive({ kind: "activity", batch: 99, entries }), { name: "AbortError" });
		assert.equal(pool.store.run(descriptor.childRunId)?.label, "second");
	} finally {
		await pool.dispose();
	}
});

test("a stage on another host that ended with its startup receipts has them recorded as its publication is applied, before its child ends (#4505)", async () => {
	const pool = await activityPool({ host: "root-host" });
	try {
		pool.known();
		assert.deepEqual(await pool.publish([childRun([stage("stage", { sessionId: "session-a" })])]), []);
		await pool.queueDirect("stage", "direct-1");
		await pool.queueDirect("stage", "direct-2");
		const recordings = pool.recordings();
		const receipts = { sessionId: "session-a", messageIds: ["direct-1"] };
		const ended = stage("stage", { sessionId: "session-a", status: "completed", intercomReceipts: receipts });
		assert.deepEqual(await pool.publish([childRun([ended])]), []);
		assert.equal(recordings.mock.calls.length, 1, "the publication that ended the stage records its receipts");
		await recordings.mock.results[0]!.value;
		const status = (id: string) =>
			pool.store.run(descriptor.childRunId)?.pendingStageMessages?.find((entry) => entry.message.id === id)?.status;
		assert.deepEqual(
			[status("direct-1"), status("direct-2")],
			["delivered", "queued"],
			"only what the session took is recorded",
		);
		assert.equal(pool.store.run(descriptor.childRunId)?.status, "running", "the child has not ended");
		assert.equal(pool.store.run(ROOT)?.intercomDeliveryIssue, undefined);
		// Receipts of another session of the stage are not the stage's session's to record.
		const replaced = { sessionId: "session-b", messageIds: ["direct-2"] };
		assert.deepEqual(await pool.publish([childRun([{ ...ended, intercomReceipts: replaced }])]), []);
		assert.equal(recordings.mock.calls.length, 1);
	} finally {
		await pool.dispose();
	}
});

test("the root's own host records no receipts a stage on it published: its worker's drain records them (#4505)", async () => {
	const pool = await activityPool({ host: "" });
	try {
		pool.known();
		assert.deepEqual(await pool.publish([childRun([stage("stage", { sessionId: "session-a" })])]), []);
		const recordings = pool.recordings();
		const receipts = { sessionId: "session-a", messageIds: ["direct-1"] };
		const ended = stage("stage", { sessionId: "session-a", status: "completed", intercomReceipts: receipts });
		assert.deepEqual(await pool.publish([childRun([ended])]), []);
		assert.equal(recordings.mock.calls.length, 0);
	} finally {
		await pool.dispose();
	}
});
