import assert from "node:assert/strict";
import { join } from "node:path";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { pendingStageMessagesForDurableRun } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { isStaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import {
	availableRunDurableBackend,
	bindRunDurableBackend,
	durableBackendForRun,
} from "../../packages/workflows/src/durable/run-owner-backend.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { settleUndeliverablePendingStageMessages } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import {
	createWorkflowPendingStageDelivery,
	PENDING_STAGE_READY_STALL_MS,
	WorkflowPendingStageDeliveryFailedError,
} from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { workflowPendingStageRouteCapability } from "../../packages/workflows/src/shared/pending-stage-route-capability.js";
import { registerWorkflowPendingStageRouteReadiness } from "../../packages/workflows/src/shared/pending-stage-route-readiness.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	causedByStaleWorkLease,
	PublicationRejectedError,
	StaleWorkLeaseError,
} from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	infrastructureFaultOf,
	WorkerLostError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { StageInputRefusedError } from "../../packages/workflows/src/workers/placement-errors.js";
import { isRunChanges, type RunChanges, RunChangesEncoder } from "../../packages/workflows/src/workers/run-changes.js";
import {
	failedInSession,
	PoolStageHandoff,
	type PoolStageQueue,
	PUBLICATION_TURN_WRITES,
} from "../../packages/workflows/src/workers/stage-handoff.js";
import { workerRefusal } from "../../packages/workflows/src/workers/worker-refusal.js";
import { countFieldReads, holdFinishedRuns } from "../helpers/finished-runs.js";
import { poolAppendRefused, publicationRejected, staleWorkLease } from "../helpers/pool-errors.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const ROOT = testRunId("pool-stage-handoff-root");
const GROUP = `workflow:${ROOT}`;

/** A validator for the root's refusal of a publication that reaches outside the attempt's work subtree. */
function outsideSubtree(work: Pick<PoolWork, "id" | "generation">, runId: string): (error: unknown) => true {
	return publicationRejected({
		root: ROOT,
		workId: work.id,
		generation: work.generation,
		reason: "outside-subtree",
		runId,
	});
}
const fixtureBoundary = poolWorkFixture();
const descriptor = fixtureBoundary.work;
const boundary: DurableStageCheckpoint = JSON.parse(
	JSON.stringify(fixtureBoundary.boundary).replaceAll('"root"', `"${ROOT}"`),
);
const SIBLING = poolWorkFixture("sibling", "child-sibling", "workflow:sibling:1");

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id,
		name: id,
		status: "running",
		parentIds: [],
		toolEvents: [],
		pendingStageDeliveryAvailable: true,
		replayKey: `${descriptor.scope}:${id}`,
		...overrides,
	};
}

function snapshot(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", stages: [], toolNodes: [], startedAt: 0, ...overrides };
}

function childRun(stages: StageSnapshot[], overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return snapshot(descriptor.childRunId, {
		parentRunId: ROOT,
		parentStageId: descriptor.boundaryId,
		rootRunId: ROOT,
		stages,
		...overrides,
	});
}

function message(id: string) {
	return { id, timestamp: 1_725_000_000_000, content: { text: `body ${id}` } };
}

const from = { id: "planner", name: "planner", group: GROUP };

async function fixture() {
	const directory = makeTempDirectory("pool-stage-handoff-");
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
	const lease = acquired.lease;
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(lease, 60_000);
	await queue.enqueue(lease, descriptor, boundary);
	const first = await queue.claim(lease, "worker-one", [descriptor], 60_000);
	assert.ok(first);
	const store = createStore();
	const root = snapshot(ROOT, {
		rootRunId: ROOT,
		possibleStages: [],
		stages: [
			{
				...stage(descriptor.boundaryId, { name: "child", replayKey: descriptor.scope }),
				pendingStageDeliveryAvailable: false,
				workflowChildRun: { alias: "child", workflow: "child", runId: descriptor.childRunId },
			},
		],
	});
	bindRunDurableBackend(root, backend);
	bindStoreDurableBackend(store, backend);
	store.recordRunStart(root);
	const handoff = new PoolStageHandoff(backend, store, queue, lease);
	async function replacement(): Promise<PoolWork> {
		await database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", first!.id);
		assert.equal(await queue.expire(lease, first!), true);
		const next = await queue.claim(lease, "worker-two", [descriptor], 60_000);
		assert.ok(next);
		return next;
	}
	return {
		database,
		store,
		backend,
		queue,
		lease,
		handoff,
		first,
		replacement,
		async queueDirect(stageKey: string, id: string) {
			const result = await store.queueStageMessage(
				{ runId: descriptor.childRunId, stageKey, from, message: message(id), queuedAt: new Date().toISOString() },
				GROUP,
				GROUP,
				durableBackendForRun(backend, store, descriptor.childRunId)!,
			);
			assert.equal(result?.ok, true);
		},
		async queueBroadcast(id: string) {
			const target = `workflow:${ROOT}/**`;
			const result = await store.queueStickyStageMessage(
				{
					runId: ROOT,
					stageKey: target,
					targetPath: target,
					from,
					message: message(id),
					queuedAt: new Date().toISOString(),
				},
				GROUP,
				GROUP,
				backend,
			);
			assert.equal(result?.ok, true);
		},
		async close() {
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test("a published child subtree appears once under the root and keeps root-owned queued messages (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		await f.queueDirect("stage", "direct-1");
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		const runs = f.store.runs();
		assert.deepEqual(
			runs.map((run) => run.id),
			[ROOT, descriptor.childRunId],
		);
		const child = runs.find((run) => run.id === descriptor.childRunId);
		assert.equal(child?.stages[0]?.sessionId, "session-a");
		assert.deepEqual(
			child?.pendingStageMessages?.map((entry) => entry.message.id),
			["direct-1"],
		);
		const reordered = [childRun([stage("stage")], { pendingStageMessages: [] })];
		await f.handoff.publish(f.first, reordered);
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 1);
	} finally {
		await f.close();
	}
});

test("a message queued while publication waits for its fence is not overwritten (#3869)", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let updating: Promise<void> | undefined;
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		const assertCurrent = f.queue.assertCurrent.bind(f.queue);
		vi.spyOn(f.queue, "assertCurrent").mockImplementationOnce(async (...args) => {
			await assertCurrent(...args);
			entered.resolve();
			await release.promise;
		});
		updating = f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await entered.promise;
		await f.queueDirect("stage", "during-publication");
		release.resolve();
		await updating;
		assert.equal(
			f.store.pendingStageMessagesFor(descriptor.childRunId, "stage")[0]?.message.id,
			"during-publication",
		);
	} finally {
		release.resolve();
		await updating;
		vi.restoreAllMocks();
		await f.close();
	}
});

test("a worker publication while a message persists keeps the accepted message visible and durable (#3869)", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let queueing: Promise<void> | undefined;
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		const persist = f.backend.persistPendingStageMessages.bind(f.backend);
		vi.spyOn(f.backend, "persistPendingStageMessages").mockImplementationOnce(async (...args) => {
			const persisted = await persist(...args);
			entered.resolve();
			await release.promise;
			return persisted;
		});
		queueing = f.queueDirect("stage", "during-persistence");
		await entered.promise;
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		release.resolve();
		await queueing;
		assert.deepEqual(
			f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").map((entry) => entry.message.id),
			["during-persistence"],
		);
		await f.queueDirect("stage", "after-publication");
		assert.deepEqual(
			pendingStageMessagesForDurableRun(f.backend, descriptor.childRunId, ROOT).map((entry) => entry.message.id),
			["during-persistence", "after-publication"],
		);
	} finally {
		release.resolve();
		await queueing;
		vi.restoreAllMocks();
		await f.close();
	}
});

test("publication labels stages with their worker attempt and marks root progress only for real changes (#3869)", async () => {
	const f = await fixture();
	try {
		const rootProgress = () => f.store.runs().find((run) => run.id === ROOT)?.lastProgressAt;
		await f.handoff.publish(f.first, []);
		assert.equal(rootProgress(), undefined);
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		const first = rootProgress();
		assert.ok(first);
		const labelled = f.store.runs().find((run) => run.id === descriptor.childRunId)?.stages[0] as
			| (StageSnapshot & { workerExecution?: unknown })
			| undefined;
		assert.deepEqual(labelled?.workerExecution, {
			worker: "worker-one",
			generation: f.first.generation,
			renewedAt: f.first.renewedAt,
			expiresAt: f.first.expiresAt,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		assert.equal(rootProgress(), first);
		await f.handoff.publish(f.first, [childRun([stage("stage"), stage("more")])]);
		assert.ok((rootProgress() ?? 0) > first);
	} finally {
		await f.close();
	}
});

test("a stage that ended keeps the worker lease it ended under while its attempt renews for its other stages", async () => {
	const f = await fixture();
	try {
		const lane = (status: StageSnapshot["status"]) =>
			stage("lane", status === "running" ? {} : { status, endedAt: f.first.renewedAt + 1, error: "lane failed" });
		await f.handoff.publish(f.first, [childRun([lane("running"), stage("other")])]);
		await f.handoff.publish(f.first, [childRun([lane("failed"), stage("other")])]);
		const renewed = { ...f.first, renewedAt: f.first.renewedAt + 60_000, expiresAt: f.first.expiresAt + 60_000 };
		await f.handoff.publish(renewed, [childRun([lane("failed"), stage("other")])]);
		const stages = f.store.runs().find((run) => run.id === descriptor.childRunId)?.stages ?? [];
		const ended = stages.find((candidate) => candidate.id === "lane");
		assert.equal(ended?.workerExecution?.renewedAt, f.first.renewedAt, "the ended stage shows no later renewal");
		assert.ok((ended?.workerExecution?.renewedAt ?? 0) <= (ended?.endedAt ?? 0));
		assert.equal(stages.find((candidate) => candidate.id === "other")?.workerExecution?.renewedAt, renewed.renewedAt);
		// The child's result keeps each stage's own lease too.
		await f.queue.complete(f.lease, renewed, {
			runId: descriptor.childRunId,
			status: "failed",
			stages: [lane("failed"), stage("other", { status: "completed" })],
			toolNodes: [],
		} as never);
		await f.handoff.complete(renewed);
		const settled = f.store.runs().find((run) => run.id === descriptor.childRunId)?.stages ?? [];
		assert.equal(settled.find((candidate) => candidate.id === "lane")?.workerExecution?.renewedAt, f.first.renewedAt);
		assert.equal(
			settled.find((candidate) => candidate.id === "other")?.workerExecution?.renewedAt,
			renewed.renewedAt,
		);
	} finally {
		await f.close();
	}
});

test("publication rejects root, sibling and unlinked runs without changing the store (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		const before = JSON.stringify(f.store.runs());
		const nested = snapshot("grandchild", { parentRunId: descriptor.childRunId, parentStageId: "nested" });
		const attacks: readonly (readonly [readonly RunSnapshot[], string])[] = [
			[[snapshot(ROOT, { stages: [stage("injected")] })], ROOT],
			[
				[
					childRun([stage("stage")]),
					snapshot(SIBLING.work.childRunId, { parentRunId: ROOT, parentStageId: "sibling" }),
				],
				SIBLING.work.childRunId,
			],
			[[childRun([stage("stage")]), nested], "grandchild"],
			[[childRun([stage("stage")], { parentStageId: "other-boundary" })], descriptor.childRunId],
			[[childRun([stage("stage")], { parentRunId: "another-parent" })], descriptor.childRunId],
			[[childRun([stage("stage")], { rootRunId: "other-root" })], descriptor.childRunId],
		];
		for (const [runs, runId] of attacks)
			await assert.rejects(
				f.handoff.publish(f.first, runs),
				publicationRejected({
					root: ROOT,
					workId: f.first.id,
					generation: f.first.generation,
					reason: "outside-subtree",
					runId,
				}),
			);
		assert.equal(JSON.stringify(f.store.runs()), before);
		const linked = childRun([
			stage("nested", { workflowChildRun: { alias: "n", workflow: "n", runId: "grandchild" } }),
		]);
		await f.handoff.publish(f.first, [linked, { ...nested, parentStageId: "nested", rootRunId: ROOT }]);
		assert.deepEqual(
			f.store.runs().map((run) => run.id),
			[ROOT, descriptor.childRunId, "grandchild"],
		);
	} finally {
		await f.close();
	}
});

test("a replaced worker cannot publish and the successor's capability replaces the stale one (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		const stale = await f.handoff.route(f.first, descriptor.childRunId);
		assert.equal(stale, workflowPendingStageRouteCapability(f.store, descriptor.childRunId));
		const next = await f.replacement();
		const superseded = staleWorkLease({
			root: ROOT,
			workId: f.first.id,
			generation: f.first.generation,
			reason: "generation-mismatch",
		});
		const rejected = (error: unknown) =>
			publicationRejected({ workId: f.first.id, generation: f.first.generation, reason: "stale-lease" })(error) &&
			superseded((error as Error).cause);
		await assert.rejects(f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "ghost" })])]), rejected);
		await assert.rejects(f.handoff.route(f.first, descriptor.childRunId), superseded);
		await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
		const current = await f.handoff.route(next, descriptor.childRunId);
		assert.notEqual(current, stale);
		assert.equal(f.store.runs().find((run) => run.id === descriptor.childRunId)?.stages[0]?.sessionId, "session-b");
		await assert.rejects(f.handoff.publish(f.first, [childRun([stage("stage")])]), rejected);
	} finally {
		await f.close();
	}
});

test("fencing a lost worker clears its live sessions so steering queues for the successor (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [
			childRun([
				stage("stage", { sessionId: "session-a", sessionFile: "/gone/a.jsonl" }),
				stage("done", { status: "completed", sessionId: "session-done" }),
			]),
		]);
		const stale = await f.handoff.route(f.first, descriptor.childRunId);
		f.handoff.fence(f.first);
		const stages = f.store.runs().find((run) => run.id === descriptor.childRunId)?.stages;
		assert.equal(stages?.find((entry) => entry.id === "stage")?.sessionId, undefined);
		assert.equal(stages?.find((entry) => entry.id === "stage")?.sessionFile, undefined);
		assert.equal(stages?.find((entry) => entry.id === "done")?.sessionId, "session-done");
		assert.notEqual(workflowPendingStageRouteCapability(f.store, descriptor.childRunId), stale);
		await f.queueDirect("stage", "while-replacing");
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 1);
	} finally {
		await f.close();
	}
});

test("a direct message is recorded delivered only after the worker transport acknowledges it (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		let acknowledge = () => {};
		const gate = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		const received: string[] = [];
		const delivery = f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async (_from, delivered) => {
				received.push(delivered.id);
				await gate;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(received, ["direct-1"]);
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 1);
		acknowledge();
		await delivery;
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 0);
	} finally {
		await f.close();
	}
});

test("a stale worker's acknowledgement cannot consume a message its successor still owes (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		let acknowledge = () => {};
		const gate = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		const stale = f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			() => gate,
		);
		const staleOutcome = assert.rejects(
			stale,
			staleWorkLease({
				root: ROOT,
				workId: f.first.id,
				generation: f.first.generation,
				reason: "generation-mismatch",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const next = await f.replacement();
		await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
		acknowledge();
		await staleOutcome;
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 1);
		const received: string[] = [];
		await f.handoff.deliver(
			next,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-b", receivedMessageIds: [] },
			async (_from, delivered) => {
				received.push(delivered.id);
			},
		);
		assert.deepEqual(received, ["direct-1"]);
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 0);
	} finally {
		await f.close();
	}
});

for (const kind of ["direct", "sticky"] as const) {
	for (const replacement of ["worker", "session", "lease-only"] as const) {
		for (const admitted of [false, true]) {
			test(`${replacement} replacement before ${kind} receipt commit preserves steering (admitted=${admitted}) (#3869)`, async () => {
				const f = await fixture();
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let delivery: Promise<void> | undefined;
				try {
					await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
					if (kind === "direct") await f.queueDirect("stage", "receipt-race");
					else await f.queueBroadcast("receipt-race");
					if (kind === "direct") {
						const markDelivered = f.store.markPendingStageMessageDelivered.bind(f.store);
						vi.spyOn(f.store, "markPendingStageMessageDelivered").mockImplementationOnce(async (...args) => {
							entered.resolve();
							await release.promise;
							return markDelivered(...args);
						});
					} else {
						const recordDeliveries = f.store.recordPendingStageMessageDeliveries.bind(f.store);
						vi.spyOn(f.store, "recordPendingStageMessageDeliveries").mockImplementationOnce(async (...args) => {
							entered.resolve();
							await release.promise;
							return recordDeliveries(...args);
						});
					}
					delivery = f.handoff.deliver(
						f.first,
						descriptor.childRunId,
						"stage",
						"stage",
						{ sessionId: "session-a", receivedMessageIds: admitted ? ["receipt-race"] : [] },
						async () => {},
					);
					const outcome = delivery.then(
						() => undefined,
						(error: Error) => error,
					);
					await entered.promise;
					const next = replacement === "session" ? f.first : await f.replacement();
					if (replacement !== "lease-only")
						await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
					release.resolve();
					const refusal = await outcome;
					assert.ok(refusal, "the stale delivery must reject before committing its receipt");
					if (replacement === "lease-only")
						assert.ok(causedByStaleWorkLease(refusal), "the receipt guard refuses the replaced attempt");
					assert.equal(
						f.store.runs().find((run) => run.id === ROOT)?.intercomDeliveryIssue,
						undefined,
						"a drain its replacement ended is no failed stage drain",
					);
					const messageRunId = kind === "direct" ? descriptor.childRunId : ROOT;
					await f.backend.hydrateWorkflow(ROOT);
					const queued = pendingStageMessagesForDurableRun(f.backend, messageRunId, ROOT);
					assert.equal(queued[0]?.status, "queued");
					assert.deepEqual(queued[0]?.deliveries ?? [], []);
					if (replacement === "lease-only")
						await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
					const received: string[] = [];
					const ready = f.handoff.ready(next, descriptor.childRunId, "stage", "stage", "session-b").then(
						() => undefined,
						(error: Error) => error,
					);
					await f.handoff.deliver(
						next,
						descriptor.childRunId,
						"stage",
						"stage",
						{ sessionId: "session-b", receivedMessageIds: [] },
						async (_from, message) => {
							received.push(message.id);
						},
					);
					assert.equal(await ready, undefined, "the replacement must not inherit the failed delivery drain");
					assert.deepEqual(received, ["receipt-race"]);
					const committed = pendingStageMessagesForDurableRun(f.backend, messageRunId, ROOT)[0];
					assert.equal(committed?.status, kind === "direct" ? "delivered" : "queued");
					if (kind === "sticky")
						assert.deepEqual(
							committed?.deliveries?.map((entry) => entry.sessionId),
							["session-b"],
						);
				} finally {
					release.resolve();
					await delivery?.catch(() => {});
					vi.restoreAllMocks();
					await f.close();
				}
			});
		}
	}
}

for (const kind of ["direct", "sticky"] as const) {
	test(`fencing during a ${kind} receipt transaction rolls the receipt back (#3869)`, async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let delivery: Promise<void> | undefined;
		try {
			await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
			if (kind === "direct") await f.queueDirect("stage", "during-commit");
			else await f.queueBroadcast("during-commit");
			const transaction = f.database.transaction.bind(f.database);
			let gated = false;
			vi.spyOn(f.database, "transaction").mockImplementation((body) =>
				transaction((tx) =>
					body({
						...tx,
						run: async (sql, ...params) => {
							const result = await tx.run(sql, ...params);
							if (!gated && sql.startsWith("INSERT INTO wf_events")) {
								gated = true;
								entered.resolve();
								await release.promise;
							}
							return result;
						},
					}),
				),
			);
			delivery = f.handoff.deliver(
				f.first,
				descriptor.childRunId,
				"stage",
				"stage",
				{ sessionId: "session-a", receivedMessageIds: [] },
				async () => {},
			);
			const outcome = delivery.then(
				() => undefined,
				(error: Error) => error,
			);
			await entered.promise;
			f.handoff.fence(f.first);
			release.resolve();
			assert.ok(await outcome, "an inserted but uncommitted receipt must be rolled back");
			await f.backend.hydrateWorkflow(ROOT);
			const messageRunId = kind === "direct" ? descriptor.childRunId : ROOT;
			const queued = pendingStageMessagesForDurableRun(f.backend, messageRunId, ROOT);
			assert.equal(queued[0]?.status, "queued");
			assert.deepEqual(queued[0]?.deliveries ?? [], []);
			const next = await f.replacement();
			await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
			const received: string[] = [];
			await f.handoff.deliver(
				next,
				descriptor.childRunId,
				"stage",
				"stage",
				{ sessionId: "session-b", receivedMessageIds: [] },
				async (_from, message) => {
					received.push(message.id);
				},
			);
			assert.deepEqual(received, ["during-commit"]);
		} finally {
			release.resolve();
			await delivery?.catch(() => {});
			vi.restoreAllMocks();
			await f.close();
		}
	});
}

for (const replacement of ["worker", "session"] as const) {
	for (const kind of ["direct", "sticky"] as const) {
		test(`overlapping ${replacement} replacement waits for the stale ${kind} claim (#3869)`, async () => {
			const f = await fixture();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let stale: Promise<void> | undefined;
			let successor: Promise<void> | undefined;
			try {
				await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
				if (kind === "direct") await f.queueDirect("stage", "overlapping");
				else await f.queueBroadcast("overlapping");
				stale = f.handoff.deliver(
					f.first,
					descriptor.childRunId,
					"stage",
					"stage",
					{ sessionId: "session-a", receivedMessageIds: [] },
					async () => {
						entered.resolve();
						await release.promise;
					},
				);
				const staleOutcome = stale.then(
					() => undefined,
					(error: Error) => error,
				);
				await entered.promise;
				const next = replacement === "session" ? f.first : await f.replacement();
				await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
				const received: string[] = [];
				let finished = false;
				successor = f.handoff
					.deliver(
						next,
						descriptor.childRunId,
						"stage",
						"stage",
						{ sessionId: "session-b", receivedMessageIds: [] },
						async (_from, message) => {
							received.push(message.id);
						},
					)
					.then(() => {
						finished = true;
					});
				await f.handoff.route(next, descriptor.childRunId);
				assert.equal(finished, false, "the successor must not treat a stale claim as delivery");
				release.resolve();
				assert.ok(await staleOutcome);
				await successor;
				assert.deepEqual(received, ["overlapping"]);
			} finally {
				release.resolve();
				await stale?.catch(() => {});
				await successor?.catch(() => {});
				await f.close();
			}
		});
	}
}

test("replacing a session rejects its pending readiness request (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "ready-replacement");
		let failure: Error | undefined;
		const ready = f.handoff
			.ready(f.first, descriptor.childRunId, "stage", "stage", "session-a")
			.catch((error: Error) => {
				failure = error;
			});
		await f.handoff.route(f.first, descriptor.childRunId);
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-b" })])]);
		await f.handoff.route(f.first, descriptor.childRunId);
		assert.ok(failure instanceof WorkflowPendingStageDeliveryFailedError, String(failure));
		assert.equal(failure.code, "pending_stage_delivery_failed");
		publicationRejected({
			workId: f.first.id,
			generation: f.first.generation,
			reason: "session-replaced",
			runId: descriptor.childRunId,
			stageId: "stage",
			sessionId: "session-a",
		})(failure.reason);
		await ready;
	} finally {
		await f.close();
	}
});

test("a coordinator heartbeat lag refuses a receipt without poisoning the root backend (#3869)", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let delivery: Promise<void> | undefined;
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "lagged-receipt");
		const markDelivered = f.store.markPendingStageMessageDelivered.bind(f.store);
		vi.spyOn(f.store, "markPendingStageMessageDelivered").mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return markDelivered(...args);
		});
		delivery = f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async () => {},
		);
		const outcome = delivery.then(
			() => undefined,
			(error: Error) => error,
		);
		await entered.promise;
		await f.database.run("UPDATE wf_leases SET renewed_at = 0 WHERE run_id = ?", ROOT);
		release.resolve();
		assert.ok(await outcome);
		await f.database.run(
			"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE run_id = ?",
			ROOT,
		);
		await f.queueDirect("stage", "after-lag");
		assert.deepEqual(
			f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").map((entry) => entry.message.id),
			["lagged-receipt", "after-lag"],
		);
	} finally {
		release.resolve();
		await delivery?.catch(() => {});
		vi.restoreAllMocks();
		await f.close();
	}
});

test("a late acknowledgement from a session replaced by a newer publication is refused (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		let acknowledge = () => {};
		const gate = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		const replaced = f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			() => gate,
		);
		const replacedOutcome = assert.rejects(
			replaced,
			publicationRejected({
				workId: f.first.id,
				generation: f.first.generation,
				reason: "session-replaced",
				runId: descriptor.childRunId,
				stageId: "stage",
				sessionId: "session-a",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-fallback" })])]);
		acknowledge();
		await replacedOutcome;
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 1);
		const received: string[] = [];
		await f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-fallback", receivedMessageIds: [] },
			async (_from, delivered) => {
				received.push(delivered.id);
			},
		);
		assert.deepEqual(received, ["direct-1"]);
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 0);
	} finally {
		await f.close();
	}
});

test("delivery is refused before transport unless the recipient is the stage's published session (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage"), stage("live", { sessionId: "session-live" })])]);
		await f.queueDirect("stage", "direct-1");
		const sent: string[] = [];
		const transport = async (_from: unknown, delivered: { readonly id: string }) => {
			sent.push(delivered.id);
		};
		const attempts = [
			["stage", "session-a"],
			["live", "session-other"],
			["missing", "session-live"],
		] as const;
		for (const [stageId, sessionId] of attempts)
			await assert.rejects(
				f.handoff.deliver(
					f.first,
					descriptor.childRunId,
					stageId,
					stageId,
					{ sessionId, receivedMessageIds: [] },
					transport,
				),
				publicationRejected({
					reason: "session-mismatch",
					runId: descriptor.childRunId,
					stageId,
					sessionId,
				}),
			);
		assert.equal(sent.length, 0);
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 1);
	} finally {
		await f.close();
	}
});

test("a fenced attempt is refused on every call even while its lease is still live, and its successor proceeds (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		f.handoff.fence(f.first);
		const sent: string[] = [];
		const recipient = { sessionId: "session-a", receivedMessageIds: [] };
		const fenced = staleWorkLease({
			root: ROOT,
			workId: f.first.id,
			generation: f.first.generation,
			reason: "fenced",
		});
		await assert.rejects(
			f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]),
			(error: unknown) =>
				publicationRejected({ reason: "stale-lease", workId: f.first.id, generation: f.first.generation })(error) &&
				fenced((error as Error).cause),
		);
		await assert.rejects(f.handoff.route(f.first, descriptor.childRunId), fenced);
		await assert.rejects(f.handoff.ready(f.first, descriptor.childRunId, "stage", "stage", "session-a"), fenced);
		await assert.rejects(
			f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, async (_from, delivered) => {
				sent.push(delivered.id);
			}),
			fenced,
		);
		assert.equal(sent.length, 0);
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 1);
		const next = await f.replacement();
		await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
		await f.handoff.deliver(
			next,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-b", receivedMessageIds: [] },
			async (_from, delivered) => {
				sent.push(delivered.id);
			},
		);
		assert.deepEqual(sent, ["direct-1"]);
	} finally {
		await f.close();
	}
});

test("readiness checks come from the current attempt only (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		const next = await f.replacement();
		await assert.rejects(
			f.handoff.ready(f.first, descriptor.childRunId, "stage", "stage", "session-a"),
			staleWorkLease({ workId: f.first.id, generation: f.first.generation, reason: "generation-mismatch" }),
		);
		await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
		const waiting = f.handoff.ready(next, descriptor.childRunId, "stage", "stage", "session-b");
		let settled = false;
		void waiting.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(settled, false);
		await f.handoff.deliver(
			next,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-b", receivedMessageIds: [] },
			async () => {},
		);
		await waiting;
	} finally {
		await f.close();
	}
});

test("a sticky root broadcast reaches the replacement worker's stage session (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueBroadcast("broadcast-1");
		const received: string[] = [];
		const transport = async (_from: unknown, delivered: { readonly id: string }) => {
			received.push(delivered.id);
		};
		await f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			transport,
		);
		assert.deepEqual(received, ["broadcast-1"]);
		const next = await f.replacement();
		f.handoff.fence(f.first);
		await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
		await f.handoff.deliver(
			next,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-b", receivedMessageIds: [] },
			transport,
		);
		assert.deepEqual(received, ["broadcast-1", "broadcast-1"]);
		const root = f.store.runs().find((run) => run.id === ROOT);
		assert.equal(root?.pendingStageMessages?.[0]?.status, "queued");
		await assert.rejects(
			f.handoff.deliver(
				f.first,
				descriptor.childRunId,
				"stage",
				"stage",
				{ sessionId: "session-a", receivedMessageIds: [] },
				transport,
			),
			staleWorkLease({ workId: f.first.id, generation: f.first.generation, reason: "generation-mismatch" }),
		);
	} finally {
		await f.close();
	}
});

test("a sticky message queued after the stage's startup drain does not hold its readiness", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueBroadcast("before-start");
		const received: string[] = [];
		await f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async (_from, delivered) => {
				received.push(delivered.id);
			},
		);
		// Arrives between Intercom's last startup replay and the stage asking for readiness: the broker
		// forwards it to the registered session, and nothing drains this stage's queue again.
		await f.queueBroadcast("after-drain");
		let settled = false;
		const ready = f.handoff.ready(f.first, descriptor.childRunId, "stage", "stage", "session-a").then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, true, "stage readiness parked on a message it receives live");
		await ready;
		assert.deepEqual(received, ["before-start"]);
	} finally {
		await f.close();
	}
});

test("the root records messages its worker already delivered without delivering them again", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		await f.queueBroadcast("broadcast-1");
		const received: string[] = [];
		await f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: ["direct-1", "broadcast-1"] },
			async (_from, delivered) => {
				received.push(delivered.id);
			},
		);
		assert.deepEqual(received, []);
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 0);
		const broadcast = f.store.runs().find((run) => run.id === ROOT)?.pendingStageMessages?.[0];
		assert.deepEqual(
			broadcast?.deliveries?.map(({ stageId, sessionId, admission }) => ({ stageId, sessionId, admission })),
			[{ stageId: "stage", sessionId: "session-a", admission: "context" }],
		);
	} finally {
		await f.close();
	}
});

test("a stage whose child completes before the root's background drain records its receipt keeps it", async () => {
	const f = await fixture();
	// The root's drain reaches its first receipt only once the test lets it, as a busy root would.
	const appending = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const handoff = new PoolStageHandoff(
		f.backend,
		f.store,
		{
			assertCurrent: (lease, work) => f.queue.assertCurrent(lease, work),
			result: (root, id) => f.queue.result(root, id),
			withCurrentAppend: async (lease, work, assertSession, action) => {
				appending.resolve();
				await proceed.promise;
				return f.queue.withCurrentAppend(lease, work, assertSession, action);
			},
		},
		f.lease,
	);
	try {
		await handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueBroadcast("broadcast-1");
		const transported: string[] = [];
		// The worker already delivered the broadcast; the root records it.
		const drain = handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: ["broadcast-1"] },
			async (_from, delivered) => {
				transported.push(delivered.id);
			},
		);
		await appending.promise;
		// Meanwhile the stage finishes and its child completes.
		const ended = stage("stage", { sessionId: "session-a", status: "completed", endedAt: 1 });
		await handoff.publish(f.first, [childRun([ended], { status: "completed" })]);
		await f.queue.complete(f.lease, f.first, {
			runId: descriptor.childRunId,
			status: "completed",
			stages: [ended],
			toolNodes: [],
		} as never);
		proceed.resolve();
		await drain;
		assert.deepEqual(transported, []);
		const root = f.store.runs().find((run) => run.id === ROOT);
		// The ended stage's receipt is archived by the durable owner rather than kept in the live list.
		assert.equal(root?.pendingStageMessages?.[0]?.deliveryCount, 1);
		assert.equal(
			await f.backend.hasPendingStageDeliveryReceipt(ROOT, "broadcast-1", {
				runId: descriptor.childRunId,
				stageId: "stage",
				sessionId: "session-a",
				admission: "context",
			}),
			true,
		);
		assert.equal(root?.intercomDeliveryIssue, undefined);
		// A replaced attempt still records nothing: the work is no longer the completed attempt's to report on.
		const otherReceipt = {
			runId: descriptor.childRunId,
			stageId: "other",
			sessionId: "session-x",
			admission: "context" as const,
		};
		await assert.rejects(
			f.queue.withCurrentAppend(
				f.lease,
				{ ...f.first, generation: f.first.generation + 1 },
				() => {},
				() =>
					f.store.recordPendingStageMessageDeliveries(
						ROOT,
						"broadcast-1",
						[otherReceipt],
						new Date().toISOString(),
						f.backend,
					),
			),
			poolAppendRefused(
				{ root: ROOT, workId: f.first.id, generation: f.first.generation + 1, reason: "attempt-refused" },
				staleWorkLease({ workId: f.first.id, generation: f.first.generation + 1, reason: "generation-mismatch" }),
			),
		);
		assert.equal(await f.backend.hasPendingStageDeliveryReceipt(ROOT, "broadcast-1", otherReceipt), false);
	} finally {
		proceed.resolve();
		await f.close();
	}
});

test("the receipt guard refuses another root and a lost coordinator authority as typed refusals (#4327)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueBroadcast("broadcast-1");
		const receipt = {
			runId: descriptor.childRunId,
			stageId: "stage",
			sessionId: "session-a",
			admission: "context" as const,
		};
		const record = () =>
			f.store.recordPendingStageMessageDeliveries(
				ROOT,
				"broadcast-1",
				[receipt],
				new Date().toISOString(),
				f.backend,
			);
		const attempt = { workId: f.first.id, generation: f.first.generation };
		await assert.rejects(
			f.queue.withCurrentAppend({ ...f.lease, runId: "another-root" }, f.first, () => {}, record),
			(error: unknown) =>
				poolAppendRefused({ root: "another-root", ...attempt, reason: "foreign-root" })(error) &&
				!Object.hasOwn(error as object, "cause"),
		);
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		await assert.rejects(
			f.queue.withCurrentAppend(f.lease, f.first, () => {}, record),
			poolAppendRefused({ root: ROOT, ...attempt, reason: "coordinator-authority" }, (cause: unknown) => {
				assert.ok(isStaleLeaseError(cause), String(cause));
				assert.equal(cause.runId, ROOT);
				return true;
			}),
		);
		assert.equal(await f.backend.hasPendingStageDeliveryReceipt(ROOT, "broadcast-1", receipt), false);
	} finally {
		await f.close();
	}
});

test("routes, readiness and deliveries are refused for runs the attempt never published (#4327)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		const outside = publicationRejected({
			root: ROOT,
			workId: f.first.id,
			generation: f.first.generation,
			reason: "outside-subtree",
			runId: "unpublished-run",
		});
		await assert.rejects(f.handoff.route(f.first, "unpublished-run"), outside);
		await assert.rejects(f.handoff.ready(f.first, "unpublished-run", "stage", "stage", "session-a"), outside);
		await assert.rejects(
			f.handoff.deliver(
				f.first,
				"unpublished-run",
				"stage",
				"stage",
				{ sessionId: "session-a", receivedMessageIds: [] },
				async () => {},
			),
			outside,
		);
	} finally {
		await f.close();
	}
});

test("a fenced attempt's route is refused before it waits on readiness, and one fenced while it waits is refused after (#4327)", async () => {
	const f = await fixture();
	const requested: string[] = [];
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const unregister = registerWorkflowPendingStageRouteReadiness(f.store, (runId) => {
		requested.push(runId);
		return gate;
	});
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		const fenced = staleWorkLease({
			root: ROOT,
			workId: f.first.id,
			generation: f.first.generation,
			reason: "fenced",
		});
		const waiting = f.handoff.route(f.first, descriptor.childRunId);
		const outcome = assert.rejects(waiting, fenced);
		while (requested.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
		f.handoff.fence(f.first);
		release();
		await outcome;
		await assert.rejects(f.handoff.route(f.first, descriptor.childRunId), fenced);
		assert.deepEqual(requested, [descriptor.childRunId], "the fenced attempt never asked for readiness again");
	} finally {
		unregister();
		await f.close();
	}
});

test("publication refuses the root's own run nested under a child stage (#4327)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		const before = JSON.stringify(f.store.runs());
		const linked = childRun([stage("nested", { workflowChildRun: { alias: "n", workflow: "n", runId: ROOT } })]);
		const root = snapshot(ROOT, { parentRunId: descriptor.childRunId, parentStageId: "nested", rootRunId: ROOT });
		await assert.rejects(
			f.handoff.publish(f.first, [linked, root]),
			publicationRejected({
				root: ROOT,
				workId: f.first.id,
				generation: f.first.generation,
				reason: "outside-subtree",
				runId: ROOT,
			}),
		);
		assert.equal(JSON.stringify(f.store.runs()), before);
	} finally {
		await f.close();
	}
});

test("a drain that fails after its stage's session was replaced is no delivery issue (#4327)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		const lost = new WorkerLostError({ phase: "delivery", pid: 7 });
		const replacedThenLost = async () => {
			await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-b" })])]);
			throw lost;
		};
		const recipient = { sessionId: "session-a", receivedMessageIds: [] };
		await assert.rejects(
			f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, replacedThenLost),
			(error: unknown) => error === lost,
		);
		assert.equal(f.store.runs().find((run) => run.id === ROOT)?.intercomDeliveryIssue, undefined);
	} finally {
		await f.close();
	}
});

test("fencing an attempt ends the drain it runs as fenced, and a stale refusal there is no delivery issue (#4327)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		const gate = Promise.withResolvers<void>();
		const recipient = { sessionId: "session-a", receivedMessageIds: [] };
		const drain = f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, () => gate.promise);
		const outcome = assert.rejects(
			drain,
			staleWorkLease({ root: ROOT, workId: f.first.id, generation: f.first.generation, reason: "fenced" }),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		f.handoff.fence(f.first);
		gate.resolve();
		await outcome;
		const issue = () => f.store.runs().find((run) => run.id === ROOT)?.intercomDeliveryIssue;
		assert.equal(issue(), undefined, "a fenced drain is no failure");
	} finally {
		await f.close();
	}
});

test("a published run may leave its root unnamed, and a batch reports each publication's typed refusal (#4327)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage")], { rootRunId: undefined })]);
		assert.equal(f.store.run(descriptor.childRunId)?.rootRunId, ROOT, "the root's own id is recorded");
		const outcomes = await f.handoff.publishBatch([
			{ work: f.first, runs: [childRun([stage("stage", { sessionId: "session-a" })])] },
			{ work: f.first, runs: [snapshot(ROOT, { stages: [stage("injected")] })] },
		]);
		assert.equal(outcomes[0], undefined);
		publicationRejected({ reason: "outside-subtree", runId: ROOT, workId: f.first.id })(outcomes[1]);
		await f.replacement();
		const [stale] = await f.handoff.publishBatch([{ work: f.first, runs: [childRun([stage("stage")])] }]);
		publicationRejected({ reason: "stale-lease", workId: f.first.id, generation: f.first.generation })(stale);
		staleWorkLease({ reason: "generation-mismatch" })((stale as Error).cause);
	} finally {
		await f.close();
	}
});

test("a child run the root has not linked to its boundary is refused as unlinked (#4327)", async () => {
	const f = await fixture();
	try {
		const unlinked = { ...f.first, childRunId: "unlinked-child" };
		await assert.rejects(
			f.handoff.publish(unlinked, [
				snapshot("unlinked-child", { parentRunId: ROOT, parentStageId: descriptor.boundaryId, rootRunId: ROOT }),
			]),
			publicationRejected({
				root: ROOT,
				workId: f.first.id,
				generation: f.first.generation,
				reason: "boundary-unlinked",
				runId: "unlinked-child",
				stageId: descriptor.boundaryId,
			}),
		);
		assert.equal(f.store.run("unlinked-child"), undefined);
	} finally {
		await f.close();
	}
});

test("a stage waiting for its startup delivery learns why the root ended its attempt (#4327)", async () => {
	for (const ending of ["fenced", "superseded", "session-replaced"] as const) {
		const f = await fixture();
		try {
			await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
			await f.queueDirect("stage", "direct-1");
			const waiting = f.handoff.ready(f.first, descriptor.childRunId, "stage", "stage", "session-a");
			const outcome = waiting.then(
				() => undefined,
				(error: unknown) => error,
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (ending === "fenced") f.handoff.fence(f.first);
			else if (ending === "superseded") {
				const next = await f.replacement();
				await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
			} else await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-b" })])]);
			const failure = (await outcome) as { readonly code?: unknown; readonly reason?: unknown } | undefined;
			assert.equal(failure?.code, "pending_stage_delivery_failed", ending);
			const reason = failure?.reason;
			if (ending === "session-replaced")
				publicationRejected({
					root: ROOT,
					workId: f.first.id,
					generation: f.first.generation,
					reason: "session-replaced",
					runId: descriptor.childRunId,
					stageId: "stage",
					sessionId: "session-a",
				})(reason);
			else
				staleWorkLease({ root: ROOT, workId: f.first.id, generation: f.first.generation, reason: ending })(reason);
		} finally {
			await f.close();
		}
	}
});

test("a successor the root already accepted supersedes the drain its predecessor still runs (#4327)", async () => {
	const f = await fixture();
	// The pool's lease checks pass for both attempts: only the root's own record of the current attempt decides.
	const handoff = new PoolStageHandoff(
		f.backend,
		f.store,
		{
			assertCurrent: async () => {},
			result: (root, id) => f.queue.result(root, id),
			withCurrentAppend: (lease, work, assertSession, action) =>
				f.queue.withCurrentAppend(lease, work, assertSession, action),
		},
		f.lease,
	);
	try {
		await handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		const gate = Promise.withResolvers<void>();
		const drain = handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			() => gate.promise,
		);
		const superseded = staleWorkLease({
			root: ROOT,
			workId: f.first.id,
			generation: f.first.generation,
			reason: "superseded",
		});
		const outcome = assert.rejects(drain, superseded);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const next = { ...f.first, generation: f.first.generation + 1 };
		await handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
		gate.resolve();
		await outcome;
		await assert.rejects(
			handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]),
			(error: unknown) =>
				publicationRejected({ reason: "stale-lease", generation: f.first.generation })(error) &&
				superseded((error as Error).cause),
		);
	} finally {
		await f.close();
	}
});

test("a drain whose transport reports a stale work lease records no delivery issue; any other failure does (#4327)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		const recipient = { sessionId: "session-a", receivedMessageIds: [] };
		const issue = () => f.store.runs().find((run) => run.id === ROOT)?.intercomDeliveryIssue;
		await assert.rejects(
			f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, async () => {
				throw new StaleWorkLeaseError({
					root: ROOT,
					workId: f.first.id,
					generation: f.first.generation,
					reason: "expired",
				});
			}),
			staleWorkLease({ reason: "expired" }),
		);
		assert.equal(issue(), undefined);
		await assert.rejects(
			f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, async () => {
				throw new WorkerLostError({ phase: "delivery", pid: 9 });
			}),
			(error: unknown) => error instanceof WorkerLostError,
		);
		assert.match(issue() ?? "", /^1 stage drain on local workers failed; .*\(worker_lost\)/);
	} finally {
		await f.close();
	}
});

test("a drain into a session the host that took the stage over refused as replaced records no delivery issue; another refusal does (#4391)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		const recipient = { sessionId: "session-a", receivedMessageIds: [] };
		const issue = () => f.store.runs().find((run) => run.id === ROOT)?.intercomDeliveryIssue;
		const input = {
			root: ROOT,
			runId: descriptor.childRunId,
			stageId: "stage",
			seq: 1,
			kind: "intercom-message" as const,
		};
		await assert.rejects(
			f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, async () => {
				throw new StageInputRefusedError("session-replaced", input);
			}),
			(error: unknown) => error instanceof StageInputRefusedError,
		);
		assert.equal(issue(), undefined, "the replacement's own drain delivers the message");
		assert.deepEqual(
			f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").map((entry) => entry.message.id),
			["direct-1"],
			"the message stays queued",
		);
		await assert.rejects(
			f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, async () => {
				throw new StageInputRefusedError("stage-not-live", input);
			}),
			(error: unknown) => error instanceof StageInputRefusedError,
		);
		assert.match(issue() ?? "", /^1 stage drain on local workers failed; .*\(stage-input-refused\)/);
	} finally {
		await f.close();
	}
});

test("a message the session on another host failed is settled undeliverable, once, and the drain goes on to the next (#4391)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		await f.queueDirect("stage", "direct-2");
		const recipient = { sessionId: "session-a", receivedMessageIds: [] };
		const input = {
			root: ROOT,
			runId: descriptor.childRunId,
			stageId: "stage",
			seq: 1,
			kind: "intercom-message" as const,
		};
		const handed: string[] = [];
		await f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, async (_from, message) => {
			handed.push(message.id);
			if (message.id === "direct-1")
				throw new Error("drain failed", {
					cause: new StageInputRefusedError("stage-failed", input, { detail: "card rejected" }),
				});
		});
		assert.deepEqual(handed, ["direct-1", "direct-2"], "the next message is handed over");
		const entries = f.store.run(descriptor.childRunId)?.pendingStageMessages ?? [];
		const failed = entries.find((entry) => entry.message.id === "direct-1");
		assert.deepEqual(
			[failed?.status, failed?.undeliverableReason, typeof failed?.undeliverableNotificationId],
			["undeliverable", "The stage's session failed to take it: card rejected", "string"],
			"its sender is told once, by the run's undeliverable notice",
		);
		assert.equal(entries.find((entry) => entry.message.id === "direct-2")?.status, "delivered");
		assert.deepEqual(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage"), []);
		assert.equal(f.store.run(ROOT)?.intercomDeliveryIssue, undefined, "nothing is left for a later drain");
		handed.length = 0;
		await f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, async (_from, message) => {
			handed.push(message.id);
		});
		assert.deepEqual(handed, [], "a settled message is not handed over again");
		assert.deepEqual(
			[
				failedInSession(new StageInputRefusedError("stage-failed", input, { detail: "busy" })),
				failedInSession(new StageInputRefusedError("session-replaced", input)),
				failedInSession(new Error("worker gone")),
			],
			["The stage's session failed to take it: busy", undefined, undefined],
		);
	} finally {
		await f.close();
	}
});

test("failed stage drains are summarized once on the root run, never as a warning per stage", async () => {
	const f = await fixture();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueBroadcast("broadcast-1");
		const failing = async () => {
			throw new WorkerLostError({ phase: "delivery", pid: 4 });
		};
		const recipient = { sessionId: "session-a", receivedMessageIds: [] };
		await assert.rejects(f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, failing));
		await assert.rejects(f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, failing));
		const issue = () => f.store.runs().find((run) => run.id === ROOT)?.intercomDeliveryIssue;
		assert.match(
			issue() ?? "",
			/^2 stage drains on local workers failed; .*worker process 4 exited before it acknowledged a delivery \(worker_lost\)/,
		);
		// A drain that ends because its attempt was replaced is no failure.
		await f.replacement();
		f.handoff.fence(f.first);
		await assert.rejects(
			f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, failing),
			staleWorkLease({ workId: f.first.id, generation: f.first.generation, reason: "generation-mismatch" }),
		);
		assert.match(issue() ?? "", /^2 stage drains/);
		assert.equal(warn.mock.calls.length, 0);
	} finally {
		warn.mockRestore();
		await f.close();
	}
});

/** The handoff of `f`, whose receipts commit only once `release` is called, and which counts its receipt commits. */
function gatedHandoff(f: Awaited<ReturnType<typeof fixture>>) {
	const appending = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	let commits = 0;
	const handoff = new PoolStageHandoff(
		f.backend,
		f.store,
		{
			assertCurrent: (lease, work) => f.queue.assertCurrent(lease, work),
			result: (root, id) => f.queue.result(root, id),
			withCurrentAppend: async (lease, work, assertSession, action) => {
				commits++;
				appending.resolve();
				await proceed.promise;
				return f.queue.withCurrentAppend(lease, work, assertSession, action);
			},
		},
		f.lease,
	);
	return { handoff, appending: appending.promise, release: () => proceed.resolve(), commits: () => commits };
}

/** Settles the store's queued messages as the root's Intercom bridge does, recording whom it told. */
function settleQueued(f: Awaited<ReturnType<typeof fixture>>, notified: string[]): Promise<number> {
	return settleUndeliverablePendingStageMessages(f.store, async (entry) => {
		notified.push(entry.message.id);
		return true;
	});
}

function queuedEntry(f: Awaited<ReturnType<typeof fixture>>, runId: string, id: string) {
	return f.store.run(runId)?.pendingStageMessages?.find((entry) => entry.message.id === id);
}

test("a stage on another host that took its messages at startup and ended before the root's drain keeps them delivered once, and their senders hear nothing (#4505)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		await f.queueDirect("stage", "direct-2");
		await f.queueBroadcast("broadcast-1");
		// The stage took two of them before its first turn, and the publication that ended it ended its child too.
		const receipts = { sessionId: "session-a", messageIds: ["direct-1", "broadcast-1"] };
		const ended = stage("stage", {
			sessionId: "session-a",
			status: "completed",
			endedAt: 1,
			intercomReceipts: receipts,
		});
		await f.handoff.publish(f.first, [childRun([ended], { status: "completed", endedAt: 2 })]);
		const notified: string[] = [];
		// Even when the root's settlement runs before the handoff records the receipts, settlement marks what the
		// stage's session received as delivered and settles only the message it never took as undeliverable.
		await settleQueued(f, notified);
		assert.deepEqual(
			[
				queuedEntry(f, descriptor.childRunId, "direct-1")?.status,
				queuedEntry(f, descriptor.childRunId, "direct-2")?.status,
			],
			["delivered", "undeliverable"],
		);
		assert.deepEqual(notified, ["direct-2"], "only the message the stage never took is reported");
		const delivered = vi.spyOn(f.store, "markPendingStageMessageDelivered");
		const recipient = { sessionId: "session-a", receivedMessageIds: receipts.messageIds };
		await f.handoff.recordReceipts(f.first, descriptor.childRunId, "stage", "stage", recipient);
		assert.equal(queuedEntry(f, descriptor.childRunId, "direct-1")?.status, "delivered");
		assert.equal(
			delivered.mock.calls.length,
			0,
			"the exact receipt settlement already recorded is not written again",
		);
		const broadcast = () => queuedEntry(f, ROOT, "broadcast-1");
		assert.deepEqual([broadcast()?.status, broadcast()?.deliveryCount], ["queued", 1], "the broadcast stays queued");
		assert.equal(
			await f.backend.hasPendingStageDeliveryReceipt(ROOT, "broadcast-1", {
				runId: descriptor.childRunId,
				stageId: "stage",
				sessionId: "session-a",
				admission: "context",
			}),
			true,
		);
		// Recording them again, or with the child's completion, writes nothing.
		const deliveries = vi.spyOn(f.store, "recordPendingStageMessageDeliveries");
		await f.handoff.recordReceipts(f.first, descriptor.childRunId, "stage", "stage", recipient);
		await f.queue.complete(f.lease, f.first, {
			runId: descriptor.childRunId,
			status: "completed",
			stages: [ended],
			toolNodes: [],
		} as never);
		await f.handoff.complete(f.first);
		assert.deepEqual([deliveries.mock.calls.length, delivered.mock.calls.length], [0, 0]);
		await settleQueued(f, notified);
		assert.deepEqual(notified, ["direct-2"]);
		assert.deepEqual(
			[queuedEntry(f, descriptor.childRunId, "direct-1")?.status, broadcast()?.deliveryCount],
			["delivered", 1],
		);
		assert.equal(f.store.run(ROOT)?.intercomDeliveryIssue, undefined);
	} finally {
		await f.close();
	}
});

test("a receipt record that settlement got to first finds the message delivered, and reports no failed drain (#4505)", async () => {
	const f = await fixture();
	const gated = gatedHandoff(f);
	try {
		await gated.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		// One publication ends the stage, which took the message at startup, and its child.
		const receipts = { sessionId: "session-a", messageIds: ["direct-1"] };
		const ended = stage("stage", {
			sessionId: "session-a",
			status: "completed",
			endedAt: 1,
			intercomReceipts: receipts,
		});
		await gated.handoff.publish(f.first, [childRun([ended], { status: "completed", endedAt: 2 })]);
		// The handoff starts recording the receipts and waits at its append; the root's settlement runs meanwhile.
		const recording = gated.handoff.recordReceipts(f.first, descriptor.childRunId, "stage", "stage", {
			sessionId: "session-a",
			receivedMessageIds: receipts.messageIds,
		});
		await gated.appending;
		const notified: string[] = [];
		await settleQueued(f, notified);
		assert.equal(queuedEntry(f, descriptor.childRunId, "direct-1")?.status, "delivered");
		gated.release();
		await recording;
		assert.deepEqual(notified, [], "the message was delivered once, and its sender hears nothing");
		assert.equal(queuedEntry(f, descriptor.childRunId, "direct-1")?.status, "delivered");
		assert.equal(f.store.run(ROOT)?.intercomDeliveryIssue, undefined, "no drain failed");
	} finally {
		gated.release();
		await f.close();
	}
});

test("a child whose publication ending a stage never reached the root records that stage's receipts as it completes (#4505)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [
			childRun([stage("stage", { sessionId: "session-a" }), stage("other", { sessionId: "session-c" })]),
		]);
		await f.queueDirect("stage", "direct-1");
		await f.queueDirect("other", "direct-2");
		await f.queueDirect("other", "direct-3");
		await f.queueDirect("untouched", "direct-4");
		await f.queueDirect("never-ran", "direct-5");
		await f.queueBroadcast("broadcast-1");
		// The root refuses the attempt's activity once its work completed, so only the result shows the stages ended.
		await f.queue.complete(f.lease, f.first, {
			runId: descriptor.childRunId,
			status: "completed",
			stages: [
				stage("stage", {
					sessionId: "session-a",
					status: "completed",
					intercomReceipts: { sessionId: "session-a", messageIds: ["direct-1", "broadcast-1"] },
				}),
				// A session the stage replaced took this one; the stage took it all the same.
				stage("other", {
					sessionId: "session-d",
					status: "completed",
					intercomReceipts: { sessionId: "session-c", messageIds: ["direct-2"] },
				}),
				stage("untouched", { status: "completed" }),
			],
			toolNodes: [],
		} as never);
		await f.handoff.complete(f.first);
		assert.deepEqual(
			["direct-1", "direct-2", "direct-3"].map((id) => queuedEntry(f, descriptor.childRunId, id)?.status),
			["delivered", "delivered", "queued"],
		);
		assert.equal(queuedEntry(f, ROOT, "broadcast-1")?.deliveryCount, 1);
		const notified: string[] = [];
		await settleQueued(f, notified);
		assert.deepEqual(
			notified,
			["direct-3", "direct-4", "direct-5"],
			"the child ended, and only the messages no session took are reported",
		);
		assert.equal(f.store.run(ROOT)?.intercomDeliveryIssue, undefined);
	} finally {
		await f.close();
	}
});

test("a root whose handoff started afresh records the receipts a completed child's result reports, and reports a record that fails (#4505)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [
			childRun([stage("stage", { sessionId: "session-a" }), stage("other", { sessionId: "session-b" })]),
		]);
		await f.queueDirect("stage", "direct-1");
		await f.queueDirect("other", "direct-2");
		await f.queue.complete(f.lease, f.first, {
			runId: descriptor.childRunId,
			status: "completed",
			stages: [
				stage("stage", {
					sessionId: "session-a",
					status: "completed",
					intercomReceipts: { sessionId: "session-a", messageIds: ["direct-1"] },
				}),
				stage("other", {
					sessionId: "session-b",
					status: "completed",
					intercomReceipts: { sessionId: "session-b", messageIds: ["direct-2"] },
				}),
			],
			toolNodes: [],
		} as never);
		// The root's process restarted: its handoff holds no attempt of the work, and the run is the journal's.
		const restarted = new PoolStageHandoff(f.backend, f.store, f.queue, f.lease);
		const write = f.store.markPendingStageMessageDelivered.bind(f.store);
		let shouldReturnFalse = false;
		vi.spyOn(f.store, "markPendingStageMessageDelivered")
			.mockRejectedValueOnce(new Error("journal write refused"))
			.mockImplementation(async (runId, stageKey, messageId, deliveredAt, backend) =>
				shouldReturnFalse ? false : write(runId, stageKey, messageId, deliveredAt, backend),
			);
		await restarted.complete(f.first);
		assert.deepEqual(
			["direct-1", "direct-2"].map((id) => queuedEntry(f, descriptor.childRunId, id)?.status),
			["queued", "delivered"],
			"one stage's failed record leaves its message queued and the next stage's is recorded",
		);
		assert.match(
			f.store.run(ROOT)?.intercomDeliveryIssue ?? "",
			/^1 stage drain on local workers failed; .*journal write refused/,
		);
		const notified: string[] = [];
		shouldReturnFalse = true;
		assert.equal(await settleQueued(f, notified), 0);
		shouldReturnFalse = false;
		assert.equal(await settleQueued(f, notified), 1);
		assert.equal(await settleQueued(f, notified), 0);
		assert.deepEqual(
			["direct-1", "direct-2"].map((id) => queuedEntry(f, descriptor.childRunId, id)?.status),
			["delivered", "delivered"],
			"settlement records the stage's receipt that completion failed to write",
		);
		assert.deepEqual(notified, []);
	} finally {
		await f.close();
	}
});

test("an ended stage's receipt on a cancelled run whose attempt was fenced is recorded by settlement (#4505)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		await f.queueDirect("stage", "direct-2");
		const receipts = { sessionId: "session-a", messageIds: ["direct-1"] };
		const ended = stage("stage", {
			sessionId: "session-a",
			status: "completed",
			endedAt: 1,
			intercomReceipts: receipts,
		});
		await f.handoff.publish(f.first, [childRun([ended], { status: "cancelled", endedAt: 2 })]);
		f.handoff.fence(f.first);
		await assert.rejects(
			f.handoff.recordReceipts(f.first, descriptor.childRunId, "stage", "stage", {
				sessionId: "session-a",
				receivedMessageIds: receipts.messageIds,
			}),
		);
		const notified: string[] = [];
		await settleQueued(f, notified);
		assert.deepEqual(
			["direct-1", "direct-2"].map((id) => queuedEntry(f, descriptor.childRunId, id)?.status),
			["delivered", "undeliverable"],
		);
		assert.deepEqual(notified, ["direct-2"]);
	} finally {
		await f.close();
	}
});

test("a child the root never held a run of has no receipts to record as it completes (#4505)", async () => {
	const f = await fixture();
	try {
		await f.queue.complete(f.lease, f.first, {
			runId: descriptor.childRunId,
			status: "completed",
			stages: [
				stage("stage", {
					sessionId: "session-a",
					status: "completed",
					intercomReceipts: { sessionId: "session-a", messageIds: ["direct-1"] },
				}),
			],
			toolNodes: [],
		} as never);
		await f.handoff.complete(f.first);
		assert.equal(f.store.run(descriptor.childRunId), undefined);
		assert.equal(f.store.run(ROOT)?.intercomDeliveryIssue, undefined);
	} finally {
		await f.close();
	}
});

test("a stage's receipts are recorded after its running drain, and its child completes only once they are (#4505)", async () => {
	const f = await fixture();
	const gated = gatedHandoff(f);
	try {
		await gated.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		const handed: string[] = [];
		// A live drain of the stage reaches its first receipt and waits there.
		const drain = gated.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async (_from, message) => {
				handed.push(message.id);
			},
		);
		await gated.appending;
		// The stage took a message queued after that drain began at startup, and ended.
		await f.queueDirect("stage", "direct-2");
		const receipts = { sessionId: "session-a", messageIds: ["direct-1", "direct-2"] };
		const ended = stage("stage", { sessionId: "session-a", status: "completed", intercomReceipts: receipts });
		await gated.handoff.publish(f.first, [childRun([ended])]);
		const recording = gated.handoff.recordReceipts(f.first, descriptor.childRunId, "stage", "stage", {
			sessionId: "session-a",
			receivedMessageIds: receipts.messageIds,
		});
		await f.queue.complete(f.lease, f.first, {
			runId: descriptor.childRunId,
			status: "completed",
			stages: [ended],
			toolNodes: [],
		} as never);
		const caughtUp = Promise.withResolvers<void>();
		const catchUp = f.backend.catchUpWorkflow.bind(f.backend);
		vi.spyOn(f.backend, "catchUpWorkflow").mockImplementation(async (runId) => {
			await catchUp(runId);
			caughtUp.resolve();
		});
		let completed = false;
		const completing = gated.handoff.complete(f.first).then(() => {
			completed = true;
		});
		await caughtUp.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(completed, false, "the child waits for the stage's receipts");
		gated.release();
		await Promise.all([drain, recording, completing]);
		assert.deepEqual(handed, ["direct-1"], "the live drain had handed over its first message");
		assert.deepEqual(
			["direct-1", "direct-2"].map((id) => queuedEntry(f, descriptor.childRunId, id)?.status),
			["delivered", "delivered"],
		);
		assert.equal(gated.commits(), 2, "the drain's receipt and the record's, none again at completion");
		assert.equal(f.store.run(ROOT)?.intercomDeliveryIssue, undefined);
	} finally {
		gated.release();
		await f.close();
	}
});

test("receipts are recorded only for the session the stage shows, of a run and attempt the root holds, and again after a failure (#4505)", async () => {
	const f = await fixture();
	let refuse: Error | undefined;
	let commits = 0;
	const handoff = new PoolStageHandoff(
		f.backend,
		f.store,
		{
			assertCurrent: (lease, work) => f.queue.assertCurrent(lease, work),
			result: (root, id) => f.queue.result(root, id),
			withCurrentAppend: async (lease, work, assertSession, action) => {
				commits++;
				const refusal = refuse;
				refuse = undefined;
				if (refusal !== undefined) throw refusal;
				return f.queue.withCurrentAppend(lease, work, assertSession, action);
			},
		},
		f.lease,
	);
	try {
		const receipts = { sessionId: "session-a", messageIds: ["direct-1"] };
		const ended = stage("stage", { sessionId: "session-a", status: "completed", intercomReceipts: receipts });
		await handoff.publish(f.first, [childRun([ended])]);
		await f.queueDirect("stage", "direct-1");
		const record = (runId: string, sessionId: string) =>
			handoff.recordReceipts(f.first, runId, "stage", "stage", { sessionId, receivedMessageIds: ["direct-1"] });
		await assert.rejects(
			record(descriptor.childRunId, "session-b"),
			publicationRejected({
				reason: "session-mismatch",
				runId: descriptor.childRunId,
				stageId: "stage",
				sessionId: "session-b",
			}),
		);
		await assert.rejects(record("unpublished-run", "session-a"), outsideSubtree(f.first, "unpublished-run"));
		assert.equal(commits, 0);
		refuse = new WorkerLostError({ phase: "delivery", pid: 9 });
		await assert.rejects(
			record(descriptor.childRunId, "session-a"),
			(error: unknown) => error instanceof WorkerLostError,
		);
		assert.match(
			f.store.run(ROOT)?.intercomDeliveryIssue ?? "",
			/^1 stage drain on local workers failed; .*\(worker_lost\)/,
		);
		assert.equal(queuedEntry(f, descriptor.childRunId, "direct-1")?.status, "queued");
		await record(descriptor.childRunId, "session-a");
		assert.equal(queuedEntry(f, descriptor.childRunId, "direct-1")?.status, "delivered", "a later call records them");
		await record(descriptor.childRunId, "session-a");
		assert.equal(commits, 2, "and they are recorded once");
		// A fenced attempt records nothing, and its refusal is no delivery issue.
		handoff.fence(f.first);
		await assert.rejects(
			record(descriptor.childRunId, "session-a"),
			staleWorkLease({ workId: f.first.id, generation: f.first.generation, reason: "fenced" }),
		);
		assert.match(f.store.run(ROOT)?.intercomDeliveryIssue ?? "", /^1 stage drain/);
	} finally {
		await f.close();
	}
});

test("a sticky message one stage's session failed stays queued for its other stages, and the root run shows the failure once per drain (#4505)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [
			childRun([stage("first", { sessionId: "session-a" }), stage("second", { sessionId: "session-b" })]),
		]);
		await f.queueBroadcast("broadcast-1");
		await f.queueBroadcast("broadcast-2");
		const input = {
			root: ROOT,
			runId: descriptor.childRunId,
			stageId: "first",
			seq: 1,
			kind: "intercom-message" as const,
		};
		const issue = () => f.store.run(ROOT)?.intercomDeliveryIssue;
		const handed: string[] = [];
		await f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"first",
			"first",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async (_from, message) => {
				handed.push(`first:${message.id}`);
				throw new StageInputRefusedError("stage-failed", input, { detail: `card ${message.id} rejected` });
			},
		);
		assert.deepEqual(handed, ["first:broadcast-1", "first:broadcast-2"], "the drain goes on past each failure");
		assert.match(issue() ?? "", /^1 stage drain on local workers failed; .*card broadcast-2 rejected/);
		const broadcasts = () => f.store.run(ROOT)?.pendingStageMessages ?? [];
		assert.deepEqual(
			broadcasts().map((entry) => [entry.message.id, entry.status, entry.deliveries ?? []]),
			[
				["broadcast-1", "queued", []],
				["broadcast-2", "queued", []],
			],
			"both stay queued, with no receipt for the stage that failed them",
		);
		const deliverSecond = () =>
			f.handoff.deliver(
				f.first,
				descriptor.childRunId,
				"second",
				"second",
				{ sessionId: "session-b", receivedMessageIds: [] },
				async (_from, message) => {
					handed.push(`second:${message.id}`);
				},
			);
		await deliverSecond();
		await deliverSecond();
		assert.deepEqual(
			handed.slice(2),
			["second:broadcast-1", "second:broadcast-2"],
			"the other stage takes each once",
		);
		assert.deepEqual(
			broadcasts().map((entry) => entry.deliveries?.map((delivery) => delivery.stageId)),
			[["second"], ["second"]],
		);
		// A drain without anyone to report to keeps the message queued and succeeds; a drain that fails is one issue.
		const unreported = createWorkflowPendingStageDelivery(
			f.store,
			descriptor.childRunId,
			"first",
			"first",
			undefined,
			{
				holdUntilDrained: true,
				undeliverable: failedInSession,
			},
		);
		await unreported.deliverPending(
			async () => {
				throw new StageInputRefusedError("stage-failed", input, { detail: "busy" });
			},
			{ sessionId: "session-a", receivedMessageIds: [] },
		);
		// Without a reason the stage will never take it, the failure is the drain's own.
		const unexplained = new StageInputRefusedError("stage-failed", input, { detail: "no reason asked" });
		await assert.rejects(
			createWorkflowPendingStageDelivery(f.store, descriptor.childRunId, "first", "first", undefined, {
				holdUntilDrained: true,
			}).deliverPending(
				async () => {
					throw unexplained;
				},
				{ sessionId: "session-a", receivedMessageIds: [] },
			),
			(error: unknown) => error === unexplained,
		);
		await assert.rejects(
			f.handoff.deliver(
				f.first,
				descriptor.childRunId,
				"first",
				"first",
				{ sessionId: "session-a", receivedMessageIds: [] },
				async () => {
					throw new WorkerLostError({ phase: "delivery", pid: 7 });
				},
			),
			(error: unknown) => error instanceof WorkerLostError,
		);
		assert.match(issue() ?? "", /^2 stage drains on local workers failed; .*\(worker_lost\)/);
		assert.deepEqual(
			broadcasts().map((entry) => entry.status),
			["queued", "queued"],
		);
	} finally {
		await f.close();
	}
});

test("a stage's receipt record waits for every drain of the stage before it, however many wait behind the running one (#4505)", async () => {
	const f = await fixture();
	const commits: (() => void)[] = [];
	let committing = Promise.withResolvers<void>();
	const handoff = new PoolStageHandoff(
		f.backend,
		f.store,
		{
			assertCurrent: (lease, work) => f.queue.assertCurrent(lease, work),
			result: (root, id) => f.queue.result(root, id),
			withCurrentAppend: async (lease, work, assertSession, action) => {
				const go = Promise.withResolvers<void>();
				commits.push(go.resolve);
				committing.resolve();
				await go.promise;
				return f.queue.withCurrentAppend(lease, work, assertSession, action);
			},
		},
		f.lease,
	);
	const handed: string[] = [];
	const drain = (label: string) =>
		handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async (_from, message) => {
				handed.push(`${label}:${message.id}`);
			},
		);
	try {
		await handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		const first = drain("first");
		await committing.promise;
		committing = Promise.withResolvers();
		await f.queueDirect("stage", "direct-2");
		const second = drain("second");
		commits[0]!();
		await first;
		await committing.promise;
		// The first drain ended while the second waits on its receipt: a record of the stage's receipts waits for the
		// second, not only for the first.
		await f.queueDirect("stage", "direct-3");
		const record = handoff.recordReceipts(f.first, descriptor.childRunId, "stage", "stage", {
			sessionId: "session-a",
			receivedMessageIds: ["direct-3"],
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(commits.length, 2, "the record has not reached its receipt");
		commits[1]!();
		await second;
		while (commits.length < 3) await new Promise((resolve) => setImmediate(resolve));
		commits[2]!();
		await record;
		assert.deepEqual(handed, ["first:direct-1", "second:direct-2"], "the record hands nothing over");
		assert.deepEqual(
			["direct-1", "direct-2", "direct-3"].map((id) => queuedEntry(f, descriptor.childRunId, id)?.status),
			["delivered", "delivered", "delivered"],
		);
	} finally {
		for (const commit of commits) commit();
		await f.close();
	}
});

test("a fresh coordinator restores pending stage messages, receipts and control intent (#3869)", async () => {
	const f = await fixture();
	let recovered: JournalDurableBackend | undefined;
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "pending-direct");
		await f.queueBroadcast("sticky");
		await f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async () => {},
		);
		await f.queueDirect("stage", "after-delivery");
		await f.queue.setControl(f.lease, "paused");
		await f.backend.close();
		recovered = await JournalDurableBackend.open(f.backend.journal, { ownsJournal: false });
		await recovered.hydrateWorkflow(ROOT);
		const acquired = await recovered.journal.acquire(ROOT, recovered.holderId);
		assert.equal(acquired.status, "acquired");
		if (acquired.status !== "acquired") assert.fail("no recovered root lease");
		const lease = acquired.lease;
		const queue = await openSqlPoolQueue(recovered.journal);
		await queue.initialize(lease, 60_000);
		assert.equal((await queue.control(lease)).state, "paused");
		assert.equal(await queue.expire(lease, f.first), true);
		assert.equal(await queue.claim(lease, "worker-two", [descriptor], 60_000), undefined);
		await queue.setControl(lease, "running");
		// The resumed root re-enqueues its child before any worker may claim it (#3979).
		await queue.enqueue(lease, descriptor, boundary);
		const next = await queue.claim(lease, "worker-two", [descriptor], 60_000);
		assert.ok(next);
		const store = createStore();
		const root = {
			...f.store.runs().find((run) => run.id === ROOT)!,
			pendingStageMessages: [...pendingStageMessagesForDurableRun(recovered, ROOT, ROOT)],
		};
		bindRunDurableBackend(root, recovered);
		bindStoreDurableBackend(store, recovered);
		store.recordRunStart(root);
		const handoff = new PoolStageHandoff(recovered, store, queue, lease);
		await handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
		const received: string[] = [];
		await handoff.deliver(
			next,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-b", receivedMessageIds: [] },
			async (_from, delivered) => {
				received.push(delivered.id);
			},
		);
		assert.deepEqual(received.sort(), ["after-delivery", "sticky"]);
		assert.equal(store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 0);
		const sticky = pendingStageMessagesForDurableRun(recovered, ROOT, ROOT)[0]!;
		assert.equal(
			await recovered.hasPendingStageDeliveryReceipt(ROOT, sticky.id, {
				runId: descriptor.childRunId,
				stageId: "stage",
				sessionId: "session-a",
				admission: "context",
			}),
			true,
		);
		assert.deepEqual(
			sticky.deliveries?.map((entry) => entry.sessionId),
			["session-b"],
		);
		await recovered.journal.release(lease);
	} finally {
		await recovered?.close();
		await f.close();
	}
});

test("completing the work ends projections a replaying successor never republished, only from durable records (#3869)", async () => {
	const f = await fixture();
	try {
		const link = { alias: "n", workflow: "n", runId: "grandchild" };
		const orphan = (id: string) =>
			snapshot(id, { parentRunId: descriptor.childRunId, parentStageId: "nested", rootRunId: ROOT });
		await f.handoff.publish(f.first, [
			childRun([stage("nested", { workflowChildRun: link }), stage("agent")]),
			orphan("grandchild"),
		]);
		const next = await f.replacement();
		await f.handoff.publish(next, [
			childRun([stage("nested", { workflowChildRun: link, status: "completed" }), stage("agent")]),
		]);
		const status = (id: string) => f.store.runs().find((run) => run.id === id)?.status;
		await f.handoff.complete(f.first);
		assert.equal(status("grandchild"), "running", "no durable terminal record, nothing is fabricated");
		assert.equal(status(descriptor.childRunId), "running", "no committed work result yet");
		const terminal: DurableStageCheckpoint = {
			kind: "stage",
			workflowId: ROOT,
			checkpointId: "terminal:grandchild",
			name: "nested",
			replayKey: `${descriptor.scope}:nested`,
			startedAt: 0,
			completedAt: 0,
			output: { workflow: "n", runId: "grandchild", status: "completed", exited: false, outputs: { pid: 7 } },
			topology: {
				version: 1,
				stageId: "nested",
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: { runId: descriptor.childRunId, runName: descriptor.childRunId },
				boundary: {
					version: 1,
					event: "terminal",
					status: "completed",
					replayScope: `${descriptor.scope}:nested`,
					alias: "n",
					workflow: "n",
					invocationFingerprint: "fingerprint",
					child: {
						runId: "grandchild",
						runName: "n",
						parentRunId: descriptor.childRunId,
						parentStageId: "nested",
						rootRunId: ROOT,
					},
				},
			},
		};
		await f.backend.commitCheckpoint(terminal);
		await f.queue.complete(f.lease, next, {
			runId: descriptor.childRunId,
			status: "completed",
			result: { done: true },
			stages: [stage("nested", { status: "completed" }), stage("agent", { status: "completed" })],
			toolNodes: [],
		} as never);
		await f.handoff.complete(f.first);
		const ended = f.store.runs().filter((run) => run.id !== ROOT);
		assert.deepEqual(
			ended.map((run) => [run.id, run.status]),
			[
				[descriptor.childRunId, "completed"],
				["grandchild", "completed"],
			],
		);
		assert.ok(ended.every((run) => run.endedAt !== undefined));
		assert.equal(f.store.runs().find((run) => run.id === "grandchild")?.result?.pid, 7);
		const top = f.store.runs().find((run) => run.id === descriptor.childRunId)!;
		assert.deepEqual(
			top.stages.map((entry) => entry.status),
			["completed", "completed"],
		);
		assert.ok(
			top.stages.every(
				(entry) => (entry as StageSnapshot & { workerExecution?: unknown }).workerExecution !== undefined,
			),
		);
		assert.equal(f.store.activeRunId(), ROOT);
	} finally {
		await f.close();
	}
});

test("completing a pooled child settles its nested runs from the terminal records its root leaves in the journal (#4318)", async () => {
	const f = await fixture();
	try {
		await f.backend.commitCheckpoint(boundary);
		await f.backend.retainOwnCheckpoints(ROOT);
		const link = { alias: "n", workflow: "n", runId: "grandchild" };
		await f.handoff.publish(f.first, [
			childRun([stage("nested", { workflowChildRun: link }), stage("agent")]),
			snapshot("grandchild", { parentRunId: descriptor.childRunId, parentStageId: "nested", rootRunId: ROOT }),
		]);
		const nestedScope = `${descriptor.scope}:workflow:n:1`;
		const terminal: DurableStageCheckpoint = {
			kind: "stage",
			workflowId: ROOT,
			checkpointId: `${descriptor.scope}:boundary-terminal:workflow:n:1:completed`,
			name: "nested",
			replayKey: nestedScope,
			startedAt: 0,
			completedAt: 0,
			output: { workflow: "n", runId: "grandchild", status: "completed", exited: false, outputs: { pid: 7 } },
			topology: {
				version: 1,
				stageId: "nested",
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: { runId: descriptor.childRunId, runName: descriptor.childRunId },
				boundary: {
					version: 1,
					event: "terminal",
					status: "completed",
					replayScope: nestedScope,
					alias: "n",
					workflow: "n",
					invocationFingerprint: "fingerprint",
					child: {
						runId: "grandchild",
						runName: "n",
						parentRunId: descriptor.childRunId,
						parentStageId: "nested",
						rootRunId: ROOT,
					},
				},
			},
		};
		await f.backend.commitCheckpoint(terminal);
		assert.equal(
			f.backend.listCheckpoints(ROOT).some((checkpoint) => checkpoint.checkpointId === terminal.checkpointId),
			false,
			"the root does not keep its child's checkpoints in memory",
		);
		await f.queue.complete(f.lease, f.first, {
			runId: descriptor.childRunId,
			status: "completed",
			result: { done: true },
			stages: [stage("nested", { status: "completed" }), stage("agent", { status: "completed" })],
			toolNodes: [],
		} as never);
		await f.handoff.complete(f.first);
		const grandchild = f.store.runs().find((run) => run.id === "grandchild");
		assert.equal(grandchild?.status, "completed");
		assert.equal(grandchild?.result?.pid, 7);
	} finally {
		await f.close();
	}
});

test("a live worker whose work lease lapsed before the coordinator extended it still records its stage's delivery", async () => {
	const f = await fixture();
	try {
		// The coordinator's attempt view, as the local pool answers it: a lapse alone does not fence a live worker (#3888).
		const handoff = new PoolStageHandoff(
			f.backend,
			f.store,
			{
				assertCurrent: async () => {},
				withCurrentAppend: (lease, work, assertSession, action) =>
					f.queue.withCurrentAppend(lease, work, assertSession, action),
				result: (root, id) => f.queue.result(root, id),
			},
			f.lease,
		);
		await handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "after-resume");
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", f.first.id);
		const received: string[] = [];
		await handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async (_from, delivered) => {
				received.push(delivered.id);
			},
		);
		assert.deepEqual(received, ["after-resume"]);
		await f.backend.hydrateWorkflow(ROOT);
		assert.equal(pendingStageMessagesForDurableRun(f.backend, descriptor.childRunId, ROOT)[0]?.status, "delivered");
	} finally {
		await f.close();
	}
});

test("a receipt refused for a replaced attempt reaches the worker as a stale work lease, not as unavailable storage", async () => {
	const f = await fixture();
	let delivery: Promise<void> | undefined;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "fenced-receipt");
		const markDelivered = f.store.markPendingStageMessageDelivered.bind(f.store);
		vi.spyOn(f.store, "markPendingStageMessageDelivered").mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return markDelivered(...args);
		});
		delivery = f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async () => {},
		);
		const outcome = delivery.then(
			() => undefined,
			(error: Error) => error,
		);
		await entered.promise;
		await f.replacement();
		release.resolve();
		const error = await outcome;
		assert.ok(error);
		// The refusal crosses the root -> coordinator -> worker hops typed, and the worker fences on its type.
		const atCoordinator = rehydrateError(JSON.parse(JSON.stringify(serializeError(error))));
		const atWorker = rehydrateError(JSON.parse(JSON.stringify(serializeError(atCoordinator))));
		const attempt = { workId: f.first.id, generation: f.first.generation };
		for (const refusal of [error, atCoordinator, atWorker]) {
			poolAppendRefused(
				{ root: ROOT, ...attempt, reason: "attempt-refused" },
				staleWorkLease({ root: ROOT, ...attempt, reason: "generation-mismatch" }),
			)(refusal);
			assert.equal(refusal instanceof StorageUnavailableError, false);
			assert.equal(infrastructureFaultOf(refusal), "stale_work_lease");
			assert.equal(workerRefusal(refusal, attempt).kind, "fenced");
		}
	} finally {
		release.resolve();
		await delivery?.catch(() => {});
		vi.restoreAllMocks();
		await f.close();
	}
});

test("a pooled stage's drain keeps its worker transport past the startup stall bound and its readiness succeeds", async () => {
	const f = await fixture();
	let delivery: Promise<void> | undefined;
	const firstAcknowledged = Promise.withResolvers<void>();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		await f.queueDirect("stage", "direct-2");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		// The coordinator's contract: a delivery's transport reaches the worker only while the root still answers the
		// worker's delivery request, which ends when `deliver` settles.
		let requestOpen = true;
		const received: string[] = [];
		delivery = f.handoff
			.deliver(
				f.first,
				descriptor.childRunId,
				"stage",
				"stage",
				{ sessionId: "session-a", receivedMessageIds: [] },
				async (_from, delivered) => {
					if (!requestOpen) throw new WorkerLostError({ phase: "delivery" });
					// A worker starved of CPU acknowledges the first message only after the stall bound.
					if (delivered.id === "direct-1") await firstAcknowledged.promise;
					received.push(delivered.id);
				},
			)
			.finally(() => {
				requestOpen = false;
			});
		delivery.catch(() => {});
		await vi.advanceTimersByTimeAsync(PENDING_STAGE_READY_STALL_MS + 1);
		firstAcknowledged.resolve();
		vi.useRealTimers();
		await delivery;
		await f.handoff.ready(f.first, descriptor.childRunId, "stage", "stage", "session-a");
		assert.deepEqual(received, ["direct-1", "direct-2"]);
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 0);
	} finally {
		vi.useRealTimers();
		firstAcknowledged.resolve();
		await delivery?.catch(() => {});
		await f.close();
	}
});

test("a replacement worker's first publications keep the replaced attempt's stages, marked reconnecting, until it republishes them (#4009)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [
			childRun([
				stage("plan", { status: "completed" }),
				stage("work", { sessionId: "session-a", parentIds: ["plan"] }),
			]),
		]);
		const next = await f.replacement();
		f.handoff.fence(f.first);
		const childStages = () => f.store.runs().find((run) => run.id === descriptor.childRunId)?.stages ?? [];
		// The replacement replays the child from scratch: its first activity has the run before any stage.
		await f.handoff.publish(next, [childRun([])]);
		assert.deepEqual(
			childStages().map((entry) => [entry.id, entry.status, entry.workerExecution?.reconnecting]),
			[
				["plan", "completed", true],
				["work", "running", true],
			],
		);
		assert.equal(childStages()[1]?.sessionId, undefined, "the replaced attempt's session stays released");
		// Each stage the replacement republishes takes the place of its last known state.
		await f.handoff.publish(next, [childRun([stage("plan", { status: "completed" })])]);
		assert.deepEqual(
			childStages().map((entry) => [
				entry.id,
				entry.workerExecution?.generation,
				entry.workerExecution?.reconnecting,
			]),
			[
				["plan", next.generation, undefined],
				["work", f.first.generation, true],
			],
		);
		// Replay may give a stage a new id; its replay key still names the stage it replaces.
		await f.handoff.publish(next, [
			childRun([
				stage("plan", { status: "completed" }),
				stage("work-replayed", {
					sessionId: "session-b",
					parentIds: ["plan"],
					replayKey: `${descriptor.scope}:work`,
				}),
			]),
		]);
		assert.deepEqual(
			childStages().map((entry) => [entry.id, entry.sessionId, entry.workerExecution?.reconnecting]),
			[
				["plan", undefined, undefined],
				["work-replayed", "session-b", undefined],
			],
		);
	} finally {
		await f.close();
	}
});

test("#4022: a replacement that asks a different prompt where the replaced attempt's unanswered prompt was does not keep the superseded prompt", async () => {
	const f = await fixture();
	try {
		const asked = (id: string, message: string): StageSnapshot =>
			stage(id, {
				status: "awaiting_input",
				parentIds: ["plan"],
				replayKey: `${descriptor.scope}:prompt:${message}`,
				pendingPrompt: { id: `hil-${id}`, kind: "input", message, createdAt: 1 },
				promptFootprint: { id: `hil-${id}`, kind: "input", message, createdAt: 1 },
			});
		await f.handoff.publish(f.first, [
			childRun([stage("plan", { status: "completed" }), asked("branch", "Which branch?")]),
		]);
		const next = await f.replacement();
		f.handoff.fence(f.first);
		const childStages = () => f.store.runs().find((run) => run.id === descriptor.childRunId)?.stages ?? [];
		// Until the replacement reaches the prompt, the replaced attempt's prompt is kept, reconnecting.
		await f.handoff.publish(next, [childRun([stage("plan", { status: "completed" })])]);
		assert.deepEqual(
			childStages().map((entry) => [entry.id, entry.workerExecution?.reconnecting]),
			[
				["plan", undefined],
				["branch", true],
			],
		);
		// The replacement asks a different question at that point: it supersedes the unanswered one.
		await f.handoff.publish(next, [childRun([stage("plan", { status: "completed" }), asked("tag", "Which tag?")])]);
		assert.deepEqual(
			childStages().map((entry) => [entry.id, entry.pendingPrompt?.message, entry.workerExecution?.reconnecting]),
			[
				["plan", undefined, undefined],
				["tag", "Which tag?", undefined],
			],
		);
	} finally {
		await f.close();
	}
});

test("a replacement worker's terminal publication drops the replaced attempt's stages it did not republish (#4009)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("abandoned", { sessionId: "session-a" })])]);
		const next = await f.replacement();
		f.handoff.fence(f.first);
		await f.handoff.publish(next, [childRun([])]);
		assert.deepEqual(
			f.store
				.runs()
				.find((run) => run.id === descriptor.childRunId)
				?.stages.map((entry) => entry.id),
			["abandoned"],
		);
		await f.handoff.publish(next, [
			childRun([stage("other", { status: "completed" })], { status: "completed", endedAt: 5 }),
		]);
		assert.deepEqual(
			f.store
				.runs()
				.find((run) => run.id === descriptor.childRunId)
				?.stages.map((entry) => entry.id),
			["other"],
		);
	} finally {
		await f.close();
	}
});

test("a retained reconnecting stage follows its parent to the id the replacement republished it under (#4009)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [
			childRun([
				stage("plan", { status: "completed", replayKey: `${descriptor.scope}:plan` }),
				stage("work", { sessionId: "session-a", parentIds: ["plan"], replayKey: `${descriptor.scope}:work` }),
			]),
		]);
		const next = await f.replacement();
		f.handoff.fence(f.first);
		await f.handoff.publish(next, [
			childRun([stage("plan-replayed", { status: "completed", replayKey: `${descriptor.scope}:plan` })]),
		]);
		const stages = f.store.runs().find((run) => run.id === descriptor.childRunId)?.stages ?? [];
		assert.deepEqual(
			stages.map((entry) => [entry.id, [...entry.parentIds], entry.workerExecution?.reconnecting]),
			[
				["plan-replayed", [], undefined],
				["work", ["plan-replayed"], true],
			],
		);
		// The graph keeps the edge: `work` hangs from the republished `plan`, not from the root boundary.
		const graph = expandWorkflowGraph(f.store.graphSnapshot(), ROOT);
		const work = graph.stages.find((entry) => entry.workflowGraphTarget.stageId === "work");
		assert.deepEqual(work?.parentIds, [`${descriptor.childRunId}:plan-replayed`]);
	} finally {
		await f.close();
	}
});

test("applying activity batches reads only the published runs, however many finished runs the store holds (#4182)", async () => {
	const f = await fixture();
	try {
		// A long-lived host keeps thousands of finished runs; each one counts when anything reads its id.
		let reads = 0;
		for (let index = 0; index < 5_000; index++) {
			const id = `finished-${index}`;
			const finished = snapshot(id, { status: "completed", endedAt: 1 });
			Object.defineProperty(finished, "id", {
				enumerable: true,
				get: () => {
					reads++;
					return id;
				},
			});
			f.store.recordRunStart(finished);
		}
		reads = 0;
		const batches = [
			[{ work: f.first, runs: [childRun([stage("stage")])] }],
			[
				{ work: f.first, runs: [childRun([stage("stage", { sessionId: "session-a" })])] },
				{ work: f.first, runs: [childRun([stage("stage", { sessionId: "session-a" }), stage("next")])] },
			],
		];
		for (const batch of batches)
			assert.deepEqual(await f.handoff.publishBatch(batch), [undefined, undefined].slice(0, batch.length));
		assert.equal(
			reads,
			0,
			`applying ${batches.length} activity batches read the id of a finished run ${reads} times`,
		);
		assert.deepEqual(
			f.store.run(descriptor.childRunId)?.stages.map((entry) => [entry.id, entry.sessionId]),
			[
				["stage", "session-a"],
				["next", undefined],
			],
		);
		assert.equal(f.store.run("finished-4999")?.status, "completed");
	} finally {
		await f.close();
	}
});

test("the store finds runs by id through additions, replacements, removals and clears (#4182)", () => {
	const store = createStore();
	for (const id of ["a", "b", "c"]) store.recordRunStart(snapshot(id));
	const replacement = snapshot("b", { name: "b2" });
	store.recordRunStart(replacement);
	assert.deepEqual(
		store.runs().map((run) => run.id),
		["a", "b", "c"],
	);
	assert.equal(store.run("b"), replacement);
	assert.equal(store.removeRun("a"), true);
	assert.equal(store.run("a"), undefined);
	assert.equal(store.run("c")?.id, "c");
	store.recordRunStart(snapshot("d"));
	assert.deepEqual(
		["b", "c", "d"].map((id) => store.run(id)?.id),
		["b", "c", "d"],
	);
	assert.equal(
		store.restoreActiveBlockedRun(snapshot("c", { status: "failed" }), "blocked", {
			failureKind: "provider",
			failureCode: "rate_limit",
			failureRecoverability: "recoverable",
			failureDisposition: "active_blocked",
			failureMessage: "blocked",
			resumable: true,
		} as never),
		true,
	);
	assert.equal(store.run("c")?.status, "running");
	assert.deepEqual(
		store.runs().map((run) => run.id),
		["b", "c", "d"],
	);
	store.clear();
	assert.equal(store.run("b"), undefined);
	store.recordRunStart(snapshot("e"));
	assert.equal(store.run("e")?.id, "e");
});

test("completing a work item reads none of the finished runs the store holds (#4190)", async () => {
	const f = await fixture();
	try {
		const finished = holdFinishedRuns(f.store, 5_000);
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queue.complete(f.lease, f.first, {
			runId: descriptor.childRunId,
			status: "completed",
			result: { done: true },
			stages: [stage("stage", { status: "completed" })],
			toolNodes: [],
		} as never);
		finished.reads = 0;
		await f.handoff.complete(f.first);
		assert.equal(finished.reads, 0, `completing one child read finished runs ${finished.reads} times`);
		const child = f.store.run(descriptor.childRunId)!;
		assert.equal(child.status, "completed");
		assert.deepEqual(child.result, { done: true });
		assert.notEqual(child.endedAt, undefined);
		assert.notEqual(child.stages[0]?.workerExecution, undefined);
		assert.equal(f.store.run("finished-4999")?.status, "completed");
	} finally {
		await f.close();
	}
});

test("completing a work item with nested runs ends them in store order and reads none of the finished runs (#4190)", async () => {
	const f = await fixture();
	try {
		const link = (name: string) => ({ alias: name, workflow: name, runId: `${name}-run` });
		const nested = (name: string) =>
			snapshot(`${name}-run`, { parentRunId: descriptor.childRunId, parentStageId: name, rootRunId: ROOT });
		const terminal = (name: string, pid: number): DurableStageCheckpoint => ({
			kind: "stage",
			workflowId: ROOT,
			checkpointId: `terminal:${name}`,
			name,
			replayKey: `${descriptor.scope}:${name}`,
			startedAt: 0,
			completedAt: 0,
			output: { workflow: name, runId: `${name}-run`, status: "completed", exited: false, outputs: { pid } },
			topology: {
				version: 1,
				stageId: name,
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: { runId: descriptor.childRunId, runName: descriptor.childRunId },
				boundary: {
					version: 1,
					event: "terminal",
					status: "completed",
					replayScope: `${descriptor.scope}:${name}`,
					alias: name,
					workflow: name,
					invocationFingerprint: "fingerprint",
					child: {
						runId: `${name}-run`,
						runName: name,
						parentRunId: descriptor.childRunId,
						parentStageId: name,
						rootRunId: ROOT,
					},
				},
			},
		});
		const finished = holdFinishedRuns(f.store, 5_000);
		await f.handoff.publish(f.first, [
			childRun([
				stage("first", { workflowChildRun: link("first") }),
				stage("second", { workflowChildRun: link("second") }),
			]),
			nested("second"),
			nested("first"),
		]);
		await f.backend.commitCheckpoint(terminal("first", 1));
		await f.backend.commitCheckpoint(terminal("second", 2));
		await f.queue.complete(f.lease, f.first, {
			runId: descriptor.childRunId,
			status: "completed",
			result: { done: true },
			stages: [stage("first", { status: "completed" }), stage("second", { status: "completed" })],
			toolNodes: [],
		} as never);
		finished.reads = 0;
		await f.handoff.complete(f.first);
		assert.equal(finished.reads, 0, `completing one child read finished runs ${finished.reads} times`);
		assert.deepEqual(
			["second-run", "first-run", descriptor.childRunId].map((id) => [id, f.store.run(id)?.status]),
			[
				["second-run", "completed"],
				["first-run", "completed"],
				[descriptor.childRunId, "completed"],
			],
		);
		assert.deepEqual(f.store.run("first-run")?.result, { pid: 1 });
		assert.deepEqual(f.store.run("second-run")?.result, { pid: 2 });
		assert.equal(f.store.runPosition(descriptor.childRunId)! < f.store.runPosition("second-run")!, true);
		assert.equal(f.store.runPosition("second-run")! < f.store.runPosition("first-run")!, true);
	} finally {
		await f.close();
	}
});

test("queueing, draining and acknowledging a delivery reads none of the finished runs the store holds (#4190)", async () => {
	const f = await fixture();
	try {
		const finished = holdFinishedRuns(f.store, 5_000);
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		finished.reads = 0;
		await f.queueDirect("stage", "direct-1");
		await f.queueBroadcast("broadcast-1");
		const received: string[] = [];
		await f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async (_from, delivered) => {
				received.push(delivered.id);
			},
		);
		assert.equal(finished.reads, 0, `one direct and one sticky delivery read finished runs ${finished.reads} times`);
		assert.deepEqual([...received].sort(), ["broadcast-1", "direct-1"]);
		assert.equal(f.store.pendingStageMessagesFor(descriptor.childRunId, "stage").length, 0);
		const sticky = f.store.run(ROOT)?.pendingStageMessages?.find((entry) => entry.id === "broadcast-1");
		assert.equal(sticky?.deliveryCount, 1);
	} finally {
		await f.close();
	}
});

test("a durable owner is found by exact id, unique prefix and unknown id the same from a store as from a list (#4190)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		const finished = holdFinishedRuns(f.store, 1_000);
		const lists = f.store.runs();
		for (const id of [ROOT, descriptor.childRunId, ROOT.slice(0, 8), "00000000", "unknown-run"])
			assert.equal(availableRunDurableBackend(f.store, id), availableRunDurableBackend(lists, id), `owner of ${id}`);
		assert.equal(availableRunDurableBackend(f.store, ROOT.slice(0, 8)), f.backend);
		assert.equal(availableRunDurableBackend(f.store, "unknown-run"), undefined);
		finished.reads = 0;
		assert.equal(availableRunDurableBackend(f.store, descriptor.childRunId), f.backend);
		assert.notEqual(durableBackendForRun(f.backend, f.store, descriptor.childRunId), undefined);
		assert.equal(finished.reads, 0, `resolving a durable owner read finished runs ${finished.reads} times`);
	} finally {
		await f.close();
	}
});

function header(run: RunSnapshot): RunChanges["header"] {
	const { stages: _stages, toolNodes: _tools, pendingStageMessages: _queue, ...own } = run;
	return own;
}

test("a run published as changes is updated in place: unchanged stages keep their identity (#4317)", async () => {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		const publish = (stages: StageSnapshot[], overrides: Partial<RunSnapshot> = {}) => {
			const runs = encoder.encode(f.first, [childRun(stages, overrides)]);
			return f.handoff.publishBatch([{ work: f.first, runs }]).then((outcomes) => ({ runs, outcomes }));
		};
		const done = stage("done", { status: "completed", endedAt: 1, sessionId: "session-done" });
		assert.deepEqual(
			(await publish([done, stage("live", { sessionId: "session-a" })], { label: "first" })).outcomes,
			[undefined],
		);
		const stored = f.store.run(descriptor.childRunId)!;
		const kept = stored.stages[0];
		stored.stages[1]!.attached = true;
		const firstProgress = f.store.run(ROOT)?.lastProgressAt;
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = await publish([done, stage("live", { sessionId: "session-b" }), stage("next")], {
			label: "second",
		});
		assert.deepEqual(second.outcomes, [undefined]);
		assert.equal(isRunChanges(second.runs[0]!), true);
		const run = f.store.run(descriptor.childRunId)!;
		assert.equal(run, stored, "the run keeps its identity");
		assert.equal(run.stages[0], kept, "an unchanged stage is neither replaced nor relabelled");
		assert.deepEqual(
			run.stages.map((entry) => [entry.id, entry.sessionId, entry.attached, entry.workerExecution?.generation]),
			[
				["done", "session-done", undefined, f.first.generation],
				["live", "session-b", true, f.first.generation],
				["next", undefined, undefined, f.first.generation],
			],
		);
		assert.equal(run.label, "second");
		assert.equal(run.rootRunId, ROOT);
		assert.ok((f.store.run(ROOT)?.lastProgressAt ?? 0) > (firstProgress ?? 0), "a change marks root progress");
		await assert.rejects(
			f.handoff.deliver(
				f.first,
				descriptor.childRunId,
				"live",
				"live",
				{ sessionId: "session-a", receivedMessageIds: [] },
				async () => {},
			),
			publicationRejected({
				workId: f.first.id,
				generation: f.first.generation,
				reason: "session-mismatch",
				runId: descriptor.childRunId,
				stageId: "live",
				sessionId: "session-a",
			}),
		);
		await f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"live",
			"live",
			{ sessionId: "session-b", receivedMessageIds: [] },
			async () => {},
		);
		const graphLabel = () => f.store.graphSnapshot().runs.find((entry) => entry.id === descriptor.childRunId)?.label;
		assert.equal(graphLabel(), "second");
		await publish([done, stage("live", { sessionId: "session-b" }), stage("next")]);
		assert.equal("label" in f.store.run(descriptor.childRunId)!, false, "a field the worker dropped is dropped");
		assert.equal(graphLabel(), undefined, "a change to the run's own fields reaches its observers");
		assert.equal(f.store.run(descriptor.childRunId)?.stages[0], kept);
	} finally {
		await f.close();
	}
});

test("a lease renewal relabels only the stages still running, and is no progress (#4317)", async () => {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		const stages = [stage("done", { status: "completed", endedAt: 1 }), stage("live")];
		await f.handoff.publish(f.first, encoder.encode(f.first, [childRun(stages)]));
		const before = [...f.store.run(descriptor.childRunId)!.stages];
		const progress = f.store.run(ROOT)?.lastProgressAt;
		const renewed = { ...f.first, renewedAt: f.first.renewedAt + 60_000, expiresAt: f.first.expiresAt + 60_000 };
		const runs = encoder.encode(renewed, [childRun(stages)]);
		assert.deepEqual(runs, [{ kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] }]);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await f.handoff.publish(renewed, runs);
		const after = [...f.store.run(descriptor.childRunId)!.stages];
		assert.equal(after[0], before[0]);
		assert.equal(after[0]?.workerExecution?.renewedAt, f.first.renewedAt);
		assert.notEqual(after[1], before[1]);
		assert.deepEqual(after[1]?.workerExecution, {
			worker: "worker-one",
			generation: f.first.generation,
			renewedAt: renewed.renewedAt,
			expiresAt: renewed.expiresAt,
		});
		assert.equal(f.store.run(ROOT)?.lastProgressAt, progress);
		await f.handoff.publish(renewed, encoder.encode(renewed, [childRun(stages)]));
		assert.equal(f.store.run(descriptor.childRunId)?.stages[1], after[1], "the same lease is not written again");
		for (const token of [
			{ ...renewed, renewedAt: renewed.renewedAt + 1 },
			{ ...renewed, renewedAt: renewed.renewedAt + 1, expiresAt: renewed.expiresAt + 1 },
			// A coordinator whose clock stepped back still relabels: leases are compared for equality, never order.
			{ ...renewed, renewedAt: renewed.renewedAt - 5_000, expiresAt: renewed.expiresAt - 5_000 },
		]) {
			await f.handoff.publish(token, encoder.encode(token, [childRun(stages)]));
			const shown = f.store.run(descriptor.childRunId)?.stages[1]?.workerExecution;
			assert.deepEqual([shown?.renewedAt, shown?.expiresAt], [token.renewedAt, token.expiresAt]);
		}
		const ended = [stages[0]!, stage("live", { status: "completed", endedAt: 2 })];
		await f.handoff.publish(renewed, encoder.encode(renewed, [childRun(ended)]));
		const later = { ...renewed, renewedAt: renewed.renewedAt + 60_000, expiresAt: renewed.expiresAt + 60_000 };
		const unlabelled = f.store.run(descriptor.childRunId)!;
		f.store.recordRunStart({ ...unlabelled, stages: [...unlabelled.stages, stage("root-side")] });
		await f.handoff.publish(later, encoder.encode(later, [childRun(ended)]));
		assert.equal(
			f.store.run(descriptor.childRunId)?.stages[1]?.workerExecution?.renewedAt,
			renewed.renewedAt,
			"a stage that ended keeps the lease it ended under",
		);
		assert.equal(
			f.store.run(descriptor.childRunId)?.stages[2]?.workerExecution?.renewedAt,
			later.renewedAt,
			"an open stage without a lease takes the current one",
		);
	} finally {
		await f.close();
	}
});

test("changes to a run the attempt does not hold, or that move it, are refused without changing the store (#4317)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		const before = JSON.stringify(f.store.runs());
		const own = header(childRun([stage("stage")]));
		const refused: readonly RunChanges[] = [
			{ kind: "changes", id: "unknown-run", stages: [], toolNodes: [] },
			{
				kind: "changes",
				id: descriptor.childRunId,
				header: { ...own!, parentStageId: "other" },
				stages: [],
				toolNodes: [],
			},
			{
				kind: "changes",
				id: descriptor.childRunId,
				header: { ...own!, parentRunId: "other" },
				stages: [],
				toolNodes: [],
			},
			{
				kind: "changes",
				id: descriptor.childRunId,
				header: { ...own!, rootRunId: "other-root" },
				stages: [],
				toolNodes: [],
			},
			{ kind: "changes", id: ROOT, stages: [stage("injected")], toolNodes: [] },
		];
		for (const change of refused) {
			// Each case on a base the attempt published in full, so no earlier refusal decides it.
			await f.handoff.publish(f.first, [childRun([stage("stage")])]);
			let first: Error | undefined;
			await assert.rejects(f.handoff.publish(f.first, [change]), (error: Error) => {
				first = error;
				return outsideSubtree(f.first, change.id)(error);
			});
			await assert.rejects(
				f.handoff.publish(f.first, [{ kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] }]),
				(error) => error === first,
				`the attempt's later changes keep the refusal of ${change.id}`,
			);
		}
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		await assert.rejects(
			f.handoff.publish(f.first, [childRun([stage("stage")]), childRun([stage("stage")])]),
			outsideSubtree(f.first, descriptor.childRunId),
		);
		const unchanged: RunChanges = { kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] };
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		await assert.rejects(
			f.handoff.publish(f.first, [unchanged, unchanged]),
			outsideSubtree(f.first, descriptor.childRunId),
		);
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		await assert.rejects(
			f.handoff.publish({ ...f.first, id: "another-work" }, [childRun([stage("stage")])]),
			outsideSubtree({ ...f.first, id: "another-work" }, descriptor.childRunId),
			"a run another work published is not this work's",
		);
		const sibling = poolWorkFixture("sibling", "child-sibling", "workflow:sibling:1");
		await assert.rejects(
			f.handoff.publish({ ...f.first, id: sibling.work.boundaryId }, [
				{ kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] },
			]),
		);
		assert.equal(JSON.stringify(f.store.runs()), before);
	} finally {
		await f.close();
	}
});

test("a replacement's changes republish the stages an earlier attempt left reconnecting (#4009, #4317)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [
			childRun([stage("plan", { status: "completed" }), stage("work", { sessionId: "old" })]),
		]);
		const next = await f.replacement();
		const encoder = new RunChangesEncoder();
		await f.handoff.publish(next, encoder.encode(next, [childRun([stage("plan", { status: "completed" })])]));
		const reconnecting = () =>
			f.store
				.run(descriptor.childRunId)
				?.stages.map((entry) => [entry.id, entry.workerExecution?.generation, entry.workerExecution?.reconnecting]);
		assert.deepEqual(reconnecting(), [
			["plan", next.generation, undefined],
			["work", f.first.generation, true],
		]);
		const runs = encoder.encode(next, [
			childRun([stage("plan", { status: "completed" }), stage("work", { sessionId: "new" })]),
		]);
		assert.equal(isRunChanges(runs[0]!), true);
		// A stage another writer added stays where it is, under the attempt that now publishes the run.
		f.store.run(descriptor.childRunId)!.stages.splice(1, 0, stage("root-side", { status: "completed" }));
		await f.handoff.publish(next, runs);
		assert.deepEqual(reconnecting(), [
			["plan", next.generation, undefined],
			["root-side", next.generation, undefined],
			["work", next.generation, undefined],
		]);
		const plan = f.store.run(descriptor.childRunId)?.stages[0];
		await f.handoff.publish(
			next,
			encoder.encode(next, [
				childRun([stage("plan", { status: "completed" }), stage("work", { sessionId: "new" }), stage("more")]),
			]),
		);
		assert.equal(
			f.store.run(descriptor.childRunId)?.stages[0],
			plan,
			"with nothing reconnecting, changes apply in place",
		);
		assert.deepEqual(
			f.store.run(descriptor.childRunId)?.stages.map((entry) => entry.id),
			["plan", "root-side", "work", "more"],
		);
	} finally {
		await f.close();
	}
});

test("a stored run another writer replaced or grew is read again before changes apply to it (#4317)", async () => {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		const stages = [stage("a", { status: "completed" }), stage("b")];
		await f.handoff.publish(f.first, encoder.encode(f.first, [childRun(stages)]));
		const stored = f.store.run(descriptor.childRunId)!;
		f.store.recordRunStart({ ...stored, stages: [...stored.stages].reverse() });
		await f.handoff.publish(
			f.first,
			encoder.encode(f.first, [childRun([stages[0]!, stage("b", { sessionId: "s" })])]),
		);
		assert.deepEqual(
			f.store.run(descriptor.childRunId)?.stages.map((entry) => [entry.id, entry.sessionId]),
			[
				["b", "s"],
				["a", undefined],
			],
		);
		f.store.run(descriptor.childRunId)!.stages.push(stage("root-side"));
		await f.handoff.publish(
			f.first,
			encoder.encode(f.first, [childRun([stages[0]!, stage("b", { sessionId: "s" }), stage("c")])]),
		);
		assert.deepEqual(
			f.store.run(descriptor.childRunId)?.stages.map((entry) => entry.id),
			["b", "a", "root-side", "c"],
		);
	} finally {
		await f.close();
	}
});

test("tool nodes published as changes replace or follow the stored ones in place (#4317)", async () => {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		const node = (id: string, status: "running" | "completed") =>
			({ id, name: id, status, parentIds: [] }) as unknown as RunSnapshot["toolNodes"][number];
		await f.handoff.publish(
			f.first,
			encoder.encode(f.first, [childRun([], { toolNodes: [node("t1", "completed"), node("t2", "running")] })]),
		);
		const first = f.store.run(descriptor.childRunId)!.toolNodes[0];
		await f.handoff.publish(
			f.first,
			encoder.encode(f.first, [
				childRun([], { toolNodes: [node("t1", "completed"), node("t2", "completed"), node("t3", "running")] }),
			]),
		);
		await f.handoff.publish(
			f.first,
			encoder.encode(f.first, [
				childRun([], { toolNodes: [node("t1", "completed"), node("t2", "completed"), node("t3", "completed")] }),
			]),
		);
		const nodes = f.store.run(descriptor.childRunId)!.toolNodes;
		assert.equal(nodes[0], first);
		assert.deepEqual(
			nodes.map((entry) => [entry.id, entry.status]),
			[
				["t1", "completed"],
				["t2", "completed"],
				["t3", "completed"],
			],
		);
	} finally {
		await f.close();
	}
});

/** Publishes a child of `size` ended stages and two running ones, then measures one batch that changes one of them. */
async function measureChangedBatch(size: number) {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		const stages = (live: Partial<StageSnapshot> = {}, added: StageSnapshot[] = []) => [
			...Array.from({ length: size }, (_, index) =>
				stage(`done-${index}`, { status: "completed", endedAt: 1, sessionId: `session-${index}` }),
			),
			stage("live", { sessionId: "live", ...live }),
			stage("idle", { sessionId: "idle" }),
			...added,
		];
		type Status = "pending" | "running" | "completed";
		const tool = (id: string, status: Status) =>
			({ id, name: id, status, parentIds: [] }) as unknown as RunSnapshot["toolNodes"][number];
		const tools = (last: Status = "pending") => [
			...Array.from({ length: size }, (_, index) => tool(`tool-${index}`, "completed")),
			tool("tool-live", last),
		];
		const run = (live: Partial<StageSnapshot> = {}, added: StageSnapshot[] = [], last?: Status) =>
			childRun(stages(live, added), { toolNodes: tools(last) });
		await f.handoff.publishBatch([{ work: f.first, runs: encoder.encode(f.first, [run()]) }]);
		// Another writer replaces the stored run; the next change reads its lists whole once, to index them again.
		const replaced = f.store.run(descriptor.childRunId)!;
		f.store.recordRunStart({ ...replaced, stages: [...replaced.stages], toolNodes: [...replaced.toolNodes] });
		const warm = { ...f.first, renewedAt: f.first.renewedAt + 500, expiresAt: f.first.expiresAt + 500 };
		await f.handoff.publishBatch([{ work: warm, runs: encoder.encode(warm, [run({}, [], "running")]) }]);
		const before = [...f.store.run(descriptor.childRunId)!.stages];
		const stored = countFieldReads(before);
		countFieldReads(f.store.run(descriptor.childRunId)!.toolNodes, stored);
		const renewed = { ...f.first, renewedAt: f.first.renewedAt + 1_000, expiresAt: f.first.expiresAt + 1_000 };
		const runs = encoder.encode(renewed, [
			run({ toolEvents: [{ name: "read" } as StageSnapshot["toolEvents"][number]] }, [stage("next")], "completed"),
		]);
		stored.reads = 0;
		assert.deepEqual(await f.handoff.publishBatch([{ work: renewed, runs }]), [undefined]);
		const firstReads = stored.reads;
		const after = f.store.run(descriptor.childRunId)!.stages;
		assert.equal(after.length, size + 3);
		assert.equal(after[size]?.toolEvents.length, 1);
		assert.equal(after[size + 1]?.workerExecution?.renewedAt, renewed.renewedAt);
		assert.equal(after[0]?.workerExecution?.renewedAt, f.first.renewedAt);
		assert.equal(after[0], before[0]);
		// The batch after it, which follows a stage it added, costs the same again.
		const following = encoder.encode(renewed, [
			run(
				{ toolEvents: [{ name: "read" }, { name: "write" }] as StageSnapshot["toolEvents"] },
				[stage("next"), stage("last")],
				"completed",
			),
		]);
		stored.reads = 0;
		assert.deepEqual(await f.handoff.publishBatch([{ work: renewed, runs: following }]), [undefined]);
		assert.equal(f.store.run(descriptor.childRunId)!.stages.length, size + 4);
		assert.equal(f.store.run(descriptor.childRunId)!.toolNodes.at(-1)?.status, "completed");
		return {
			carried: runs.flatMap((published) => published.stages).length,
			storedReads: firstReads,
			followingReads: stored.reads,
			replaced: before.filter((entry, index) => after[index] !== entry).length,
		};
	} finally {
		await f.close();
	}
}

test("one batch changing one stage of a run costs the same at 250, 1,000 and 4,000 stages (#4317)", async () => {
	const sizes = [250, 1_000, 4_000];
	const measured: Awaited<ReturnType<typeof measureChangedBatch>>[] = [];
	for (const size of sizes) measured.push(await measureChangedBatch(size));
	assert.deepEqual(
		measured,
		sizes.map(() => measured[0]),
		`per-batch work grew with the run: ${JSON.stringify(measured)}`,
	);
	assert.deepEqual(measured[0], {
		carried: 2,
		storedReads: measured[0]!.storedReads,
		followingReads: measured[0]!.followingReads,
		replaced: 2,
	});
	assert.ok(measured[0]!.storedReads <= 40, `the batch read ${measured[0]!.storedReads} fields of stored stages`);
});

test("a large batch yields the event loop between slices, so a due lease-renewal timer runs before it ends (#4317)", async () => {
	const f = await fixture();
	try {
		const queue: PoolStageQueue = {
			assertCurrent: async () => {},
			withCurrentAppend: f.queue.withCurrentAppend.bind(f.queue),
			result: f.queue.result.bind(f.queue),
		};
		const handoff = new PoolStageHandoff(f.backend, f.store, queue, f.lease);
		const stages = Array.from({ length: 500 }, (_, index) => stage(`stage-${index}`, { status: "completed" }));
		const toolNodes = Array.from(
			{ length: 100 },
			(_, index) => ({ id: `tool-${index}`, name: "tool", status: "completed", parentIds: [] }) as never,
		);
		await handoff.publish(f.first, [childRun(stages, { toolNodes })]);
		// Each publication writes 600 snapshots, so two fill a turn's budget of 1,000 and 20 take 10 turns.
		const publications = Array.from({ length: 20 }, () => ({
			work: f.first,
			runs: [childRun(stages, { toolNodes })],
		}));
		const slices: number[] = [];
		const unsubscribe = f.store.subscribeInvalidation(() => slices.push(slices.length));
		let renewals = 0;
		let settled = false;
		const renewal = setInterval(() => {
			if (!settled) renewals++;
		}, 1);
		const started = performance.now();
		while (performance.now() - started < 5) {
			// The renewal is due before the batch starts.
		}
		try {
			const outcomes = await handoff.publishBatch(publications);
			settled = true;
			assert.deepEqual(
				outcomes,
				publications.map(() => undefined),
			);
		} finally {
			clearInterval(renewal);
			unsubscribe();
		}
		assert.equal(slices.length, publications.length / Math.ceil(PUBLICATION_TURN_WRITES / 601));
		assert.ok(renewals > 0, "the renewal timer ran while the batch was being applied");
		// A publication that writes nothing still takes its share of a turn.
		const unchanged = { kind: "changes" as const, id: descriptor.childRunId, stages: [], toolNodes: [] };
		const idle = Array.from({ length: PUBLICATION_TURN_WRITES + 1 }, () => ({ work: f.first, runs: [unchanged] }));
		let turns = 0;
		let applying = true;
		const tick = () => {
			if (!applying) return;
			turns++;
			setImmediate(tick);
		};
		setImmediate(tick);
		try {
			await handoff.publishBatch(idle);
		} finally {
			applying = false;
		}
		assert.ok(turns > 0, "the event loop turned while the batch was being applied");
		// A tool node written counts toward the turn's budget like a stage does.
		const toolChanges = Array.from({ length: PUBLICATION_TURN_WRITES / 2 + 1 }, (_, index) => ({
			work: f.first,
			runs: [
				{
					kind: "changes" as const,
					id: descriptor.childRunId,
					stages: [],
					toolNodes: [
						{
							id: "tool-0",
							name: "tool",
							status: index % 2 === 0 ? "running" : "completed",
							parentIds: [],
						} as never,
					],
				},
			],
		}));
		const toolSlices: number[] = [];
		const stopCounting = f.store.subscribeInvalidation(() => toolSlices.push(toolSlices.length));
		try {
			await handoff.publishBatch(toolChanges);
		} finally {
			stopCounting();
		}
		assert.equal(toolSlices.length, 2, "two writes per publication fill a turn after half the budget");
		// A batch within one turn's budget applies before the event loop turns.
		let turned = false;
		setImmediate(() => {
			turned = true;
		});
		await handoff.publishBatch([{ work: f.first, runs: [unchanged] }]);
		assert.equal(turned, false);
	} finally {
		await f.close();
	}
});

for (const kind of ["full", "renewal"] as const) {
	test(`an oversized ${kind} publication is visible atomically and yields before the next publication (#4317)`, async () => {
		const f = await fixture();
		try {
			const size = PUBLICATION_TURN_WRITES * 4;
			const stages = Array.from({ length: size }, (_, index) => stage(`stage-${index}`));
			const child = childRun([
				stage("host", { workflowChildRun: { alias: "nested", workflow: "nested", runId: "nested" } }),
				...stages,
			]);
			const nested = snapshot("nested", {
				parentRunId: child.id,
				parentStageId: "host",
				rootRunId: ROOT,
				stages: [stage("nested-stage")],
			});
			await f.handoff.publish(f.first, [child, nested]);
			const renewed = {
				...f.first,
				renewedAt: f.first.renewedAt + 1_000,
				expiresAt: f.first.expiresAt + 1_000,
			};
			const unchanged: RunChanges = { kind: "changes", id: child.id, stages: [], toolNodes: [] };
			const observe = () => ({
				name: f.store.run(child.id)!.name,
				renewedStages: f.store
					.run(child.id)!
					.stages.filter((stage) => stage.workerExecution?.renewedAt === renewed.renewedAt).length,
				nestedRenewedAt: f.store.run(nested.id)!.stages[0]!.workerExecution?.renewedAt,
			});
			const invalidations: ReturnType<typeof observe>[] = [];
			const betweenTurns: ReturnType<typeof observe>[] = [];
			const unsubscribe = f.store.subscribeInvalidation(() => {
				invalidations.push(observe());
				if (invalidations.length === 1) setImmediate(() => betweenTurns.push(observe()));
			});
			try {
				assert.deepEqual(
					await f.handoff.publishBatch([
						{ work: renewed, runs: kind === "full" ? [child, nested] : [unchanged] },
						{ work: renewed, runs: [{ ...unchanged, header: { ...header(child)!, name: "following" } }] },
					]),
					[undefined, undefined],
				);
			} finally {
				unsubscribe();
			}
			const published = { name: child.name, renewedStages: size + 1, nestedRenewedAt: renewed.renewedAt };
			assert.deepEqual(invalidations, [published, { ...published, name: "following" }]);
			assert.deepEqual(betweenTurns, [published]);
		} finally {
			await f.close();
		}
	});
}

test("after one refused publication an attempt's later changes are refused with the same reason (#4317)", async () => {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		await f.handoff.publish(f.first, encoder.encode(f.first, [childRun([stage("a")])]));
		const unchanged: RunChanges = { kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] };
		const moved: RunChanges = {
			...unchanged,
			header: { ...header(childRun([]))!, parentStageId: "elsewhere" },
		};
		const changed: RunChanges = { ...unchanged, stages: [stage("a", { sessionId: "s" })] };
		const [first, second] = await f.handoff.publishBatch([
			{ work: f.first, runs: [moved] },
			{ work: f.first, runs: [changed] },
		]);
		outsideSubtree(f.first, descriptor.childRunId)(first);
		assert.equal(second, first, "a later change is refused with the first refusal itself");
		await assert.rejects(
			f.handoff.publish(f.first, [childRun([stage("a")], { rootRunId: "other-root" })]),
			outsideSubtree(f.first, descriptor.childRunId),
		);
		await assert.rejects(f.handoff.publish(f.first, [changed]), (error) => error === first);
		assert.equal(f.store.run(descriptor.childRunId)?.stages[0]?.sessionId, undefined);
		await f.handoff.publish(f.first, [childRun([stage("a", { sessionId: "full" })])]);
		assert.equal(
			f.store.run(descriptor.childRunId)?.stages[0]?.sessionId,
			"full",
			"a full publication does not depend on the refused one",
		);
		await f.handoff.publish(f.first, [changed]);
		assert.equal(
			f.store.run(descriptor.childRunId)?.stages[0]?.sessionId,
			"s",
			"changes after an accepted full publication apply to it",
		);
		const next = await f.replacement();
		const stale = new PublicationRejectedError({
			root: ROOT,
			workId: next.id,
			generation: next.generation,
			reason: "stale-lease",
		});
		f.handoff.refuse(next, stale);
		f.handoff.refuse(f.first, new Error("an older attempt's refusal"));
		await assert.rejects(f.handoff.publish(next, [changed]), (error) => error === stale);
		await f.handoff.publish(next, [childRun([stage("a", { sessionId: "replacement" })])]);
		assert.equal(f.store.run(descriptor.childRunId)?.stages[0]?.sessionId, "replacement");
		await f.queue.complete(f.lease, next, {
			runId: descriptor.childRunId,
			status: "completed",
			result: {},
			stages: [],
			toolNodes: [],
		} as never);
		await f.handoff.complete(next);
		await assert.rejects(f.handoff.publish(next, [changed]), (error) => error !== stale, "completion forgets it");
	} finally {
		await f.close();
	}
});

test("changes apply only to a run the current attempt published in full (#4317)", async () => {
	const f = await fixture();
	try {
		const changed: RunChanges = {
			kind: "changes",
			id: descriptor.childRunId,
			stages: [stage("a", { sessionId: "s" })],
			toolNodes: [],
		};
		await f.handoff.publish(f.first, [childRun([stage("a")])]);
		await f.handoff.publish(f.first, [changed]);
		assert.equal(f.store.run(descriptor.childRunId)?.stages[0]?.sessionId, "s");
		const next = await f.replacement();
		await assert.rejects(f.handoff.publish(next, [changed]), outsideSubtree(next, descriptor.childRunId));
		assert.equal(f.store.run(descriptor.childRunId)?.stages[0]?.sessionId, "s");
	} finally {
		await f.close();
	}
});

function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

test("a refusal holds only for its own attempt's changes, and outlives a newer attempt's publication (#4317)", async () => {
	const f = await fixture();
	try {
		const changed: RunChanges = {
			kind: "changes",
			id: descriptor.childRunId,
			stages: [stage("a", { sessionId: "s" })],
			toolNodes: [],
		};
		await f.handoff.publish(f.first, [childRun([stage("a")])]);
		const refused = new Error("refused for the first attempt");
		f.handoff.refuse(f.first, refused);
		const next = await f.replacement();
		await f.handoff.publish(next, [childRun([stage("a")])]);
		await f.handoff.publish(next, [changed]);
		assert.equal(f.store.run(descriptor.childRunId)?.stages[0]?.sessionId, "s");
		await assert.rejects(f.handoff.publish(f.first, [changed]), (error) => error === refused);
	} finally {
		await f.close();
	}
});

test("changes to a run removed while they were validated are refused (#4317)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("a")])]);
		const assertCurrent = f.queue.assertCurrent.bind(f.queue);
		vi.spyOn(f.queue, "assertCurrent").mockImplementationOnce(async (...args) => {
			await assertCurrent(...args);
			f.store.removeRun(descriptor.childRunId);
		});
		await assert.rejects(
			f.handoff.publish(f.first, [
				{ kind: "changes", id: descriptor.childRunId, stages: [stage("a")], toolNodes: [] },
			]),
			outsideSubtree(f.first, descriptor.childRunId),
		);
		assert.equal(f.store.run(descriptor.childRunId), undefined);
	} finally {
		vi.restoreAllMocks();
		await f.close();
	}
});

test("changes find their stages again after another writer reordered the stored lists in place (#4317)", async () => {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		const node = (id: string, status: "running" | "completed") =>
			({ id, name: id, status, parentIds: [] }) as unknown as RunSnapshot["toolNodes"][number];
		const stages = [stage("a", { status: "completed" }), stage("b"), stage("c")];
		const tools = [node("t1", "completed"), node("t2", "running")];
		await f.handoff.publish(f.first, encoder.encode(f.first, [childRun(stages, { toolNodes: [...tools] })]));
		const stored = f.store.run(descriptor.childRunId)!;
		stored.stages.reverse();
		stored.toolNodes.reverse();
		const renewed = { ...f.first, renewedAt: f.first.renewedAt + 1_000, expiresAt: f.first.expiresAt + 1_000 };
		await f.handoff.publish(
			renewed,
			encoder.encode(renewed, [
				childRun([stages[0]!, stage("b", { sessionId: "s" }), stages[2]!], {
					toolNodes: [tools[0]!, node("t2", "completed")],
				}),
			]),
		);
		const run = f.store.run(descriptor.childRunId)!;
		assert.deepEqual(
			run.stages.map((entry) => [entry.id, entry.sessionId, entry.workerExecution?.renewedAt]),
			[
				["c", undefined, renewed.renewedAt],
				["b", "s", renewed.renewedAt],
				["a", undefined, f.first.renewedAt],
			],
		);
		assert.deepEqual(
			run.toolNodes.map((entry) => [entry.id, entry.status]),
			[
				["t2", "completed"],
				["t1", "completed"],
			],
		);
		run.stages.reverse();
		const later = { ...renewed, renewedAt: renewed.renewedAt + 1_000, expiresAt: renewed.expiresAt + 1_000 };
		await f.handoff.publish(
			later,
			encoder.encode(later, [
				childRun([stages[0]!, stage("b", { sessionId: "s" }), stages[2]!], {
					toolNodes: [tools[0]!, node("t2", "completed")],
				}),
			]),
		);
		assert.deepEqual(
			f.store.run(descriptor.childRunId)?.stages.map((entry) => [entry.id, entry.workerExecution?.renewedAt]),
			[
				["a", f.first.renewedAt],
				["b", later.renewedAt],
				["c", later.renewedAt],
			],
		);
	} finally {
		await f.close();
	}
});

test("a work's boundary is found again when the root's stages before it change (#4317)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("a")])]);
		const root = f.store.run(ROOT)!;
		f.store.recordRunStart({ ...root, stages: [stage("earlier"), ...root.stages] });
		await f.handoff.publish(f.first, [childRun([stage("a", { sessionId: "s" })])]);
		assert.equal(f.store.run(descriptor.childRunId)?.stages[0]?.sessionId, "s");
		f.store.recordRunStart({ ...root, stages: [] });
		await assert.rejects(
			f.handoff.publish(f.first, [childRun([stage("a")])]),
			publicationRejected({
				workId: f.first.id,
				generation: f.first.generation,
				reason: "boundary-unlinked",
				runId: descriptor.childRunId,
				stageId: descriptor.boundaryId,
			}),
		);
	} finally {
		await f.close();
	}
});

test("a later attempt's refusal replaces an earlier attempt's, and a mixed publication counts as changes (#4317)", async () => {
	const f = await fixture();
	try {
		const host = stage("host", { workflowChildRun: { alias: "n", workflow: "n", runId: "nested" } });
		const nested = snapshot("nested", { parentRunId: descriptor.childRunId, parentStageId: "host", rootRunId: ROOT });
		await f.handoff.publish(f.first, [childRun([host]), nested]);
		const earlier = new Error("refused for the first attempt");
		f.handoff.refuse(f.first, earlier);
		const mixed = [{ kind: "changes" as const, id: descriptor.childRunId, stages: [], toolNodes: [] }, nested];
		await assert.rejects(f.handoff.publish(f.first, mixed), (error) => error === earlier);
		const next = await f.replacement();
		const later = new Error("refused for the replacement");
		f.handoff.refuse(next, later);
		await assert.rejects(
			f.handoff.publish(next, [{ kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] }]),
			(error) => error === later,
		);
	} finally {
		await f.close();
	}
});

test("changes are validated with the stages they carry: a host stage that lost its run is refused (#4317)", async () => {
	const f = await fixture();
	try {
		const link = { workflowChildRun: { alias: "n", workflow: "n", runId: "nested" } };
		const nested = snapshot("nested", { parentRunId: descriptor.childRunId, parentStageId: "host", rootRunId: ROOT });
		await f.handoff.publish(f.first, [childRun([stage("host", link)]), nested]);
		const unchanged = { kind: "changes" as const, id: "nested", stages: [], toolNodes: [] };
		await assert.rejects(
			f.handoff.publish(f.first, [
				{
					kind: "changes",
					id: descriptor.childRunId,
					stages: [stage("host", { ...link, status: "failed" })],
					toolNodes: [],
				},
				unchanged,
			]),
			outsideSubtree(f.first, "nested"),
		);
		await f.handoff.publish(f.first, [childRun([stage("host", link)]), nested]);
		await assert.rejects(
			f.handoff.publish(f.first, [
				{
					kind: "changes",
					id: descriptor.childRunId,
					stages: [stage("host", { ...link, workflowChildRun: { ...link.workflowChildRun, runId: "other" } })],
					toolNodes: [],
				},
			]),
			outsideSubtree(f.first, "nested"),
			"a host stage is checked whether or not the run it hosts is in the publication",
		);
		await f.handoff.publish(f.first, [childRun([stage("host", link)]), nested]);
		await f.handoff.publish(f.first, [
			{
				kind: "changes",
				id: descriptor.childRunId,
				stages: [stage("host", { ...link, sessionId: "s" })],
				toolNodes: [],
			},
			unchanged,
		]);
		assert.equal(f.store.run(descriptor.childRunId)?.stages[0]?.sessionId, "s");
		await assert.rejects(
			f.handoff.publish(f.first, [{ ...unchanged, id: descriptor.childRunId }, nested]),
			outsideSubtree(f.first, "nested"),
			"a publication of changes carries no run in full",
		);
		await f.handoff.publish(f.first, [childRun([stage("host", link)])]);
		const relinked = { workflowChildRun: { ...link.workflowChildRun, runId: "other" } };
		await f.handoff.publish(f.first, [
			{ kind: "changes", id: descriptor.childRunId, stages: [stage("host", relinked)], toolNodes: [] },
		]);
		assert.equal(
			f.store.run(descriptor.childRunId)?.stages[0]?.workflowChildRun?.runId,
			"other",
			"a host stage whose run the last full publication left out changes, now linking a run never published",
		);
	} finally {
		await f.close();
	}
});

test("a publication naming a run twice is refused, in full or as changes (#4317)", async () => {
	const f = await fixture();
	try {
		const twice = outsideSubtree(f.first, descriptor.childRunId);
		await assert.rejects(f.handoff.publish(f.first, [childRun([stage("a")]), childRun([stage("b")])]), twice);
		await f.handoff.publish(f.first, [childRun([stage("a")])]);
		const unchanged = { kind: "changes" as const, id: descriptor.childRunId, stages: [], toolNodes: [] };
		await assert.rejects(f.handoff.publish(f.first, [unchanged, unchanged]), twice);
	} finally {
		await f.close();
	}
});

test("changes for a run the store holds but this handoff never published are refused (#4317)", async () => {
	const f = await fixture();
	try {
		f.store.recordRunStart(childRun([stage("a")]));
		await assert.rejects(
			f.handoff.publish(f.first, [
				{ kind: "changes", id: descriptor.childRunId, stages: [stage("a")], toolNodes: [] },
			]),
			outsideSubtree(f.first, descriptor.childRunId),
		);
	} finally {
		await f.close();
	}
});

test("a publication is refused when the root run is gone (#4317)", async () => {
	const f = await fixture();
	try {
		f.store.removeRun(ROOT);
		await assert.rejects(
			f.handoff.publish(f.first, [childRun([stage("a")])]),
			publicationRejected({
				workId: f.first.id,
				generation: f.first.generation,
				reason: "boundary-unlinked",
				runId: descriptor.childRunId,
				stageId: descriptor.boundaryId,
			}),
		);
	} finally {
		await f.close();
	}
});

test("a work's boundary is found by its last position, without reading the root's other stages (#4317)", async () => {
	const f = await fixture();
	try {
		const root = f.store.run(ROOT)!;
		const siblings = Array.from({ length: 1_000 }, (_, index) => stage(`sibling-${index}`, { status: "completed" }));
		f.store.recordRunStart({ ...root, stages: [...siblings, ...root.stages] });
		await f.handoff.publish(f.first, [childRun([stage("a", { status: "completed" })])]);
		const reads = countFieldReads(f.store.run(ROOT)!.stages);
		await f.handoff.publish(f.first, [{ kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] }]);
		assert.ok(reads.reads <= 5, `the publication read ${reads.reads} fields of the root's stages`);
	} finally {
		await f.close();
	}
});

test("a stage's session follows its changes: a removed session is refused and an unchanged one keeps its delivery (#4317)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]);
		await f.queueDirect("stage", "direct-1");
		const ready = f.handoff.ready(f.first, descriptor.childRunId, "stage", "stage", "session-a");
		const progressed = stage("stage", { sessionId: "session-a", toolEvents: [{ name: "read" } as never] });
		await f.handoff.publish(f.first, [
			{ kind: "changes", id: descriptor.childRunId, stages: [progressed], toolNodes: [] },
		]);
		const received: string[] = [];
		await f.handoff.deliver(
			f.first,
			descriptor.childRunId,
			"stage",
			"stage",
			{ sessionId: "session-a", receivedMessageIds: [] },
			async (_from, delivered) => {
				received.push(delivered.id);
			},
		);
		await ready;
		assert.deepEqual(received, ["direct-1"]);
		await f.handoff.publish(f.first, [
			{ kind: "changes", id: descriptor.childRunId, stages: [stage("stage")], toolNodes: [] },
		]);
		await assert.rejects(
			f.handoff.deliver(
				f.first,
				descriptor.childRunId,
				"stage",
				"stage",
				{ sessionId: "session-a", receivedMessageIds: [] },
				async () => {},
			),
			publicationRejected({
				workId: f.first.id,
				generation: f.first.generation,
				reason: "session-mismatch",
				runId: descriptor.childRunId,
				stageId: "stage",
				sessionId: "session-a",
			}),
		);
	} finally {
		await f.close();
	}
});

test("changes read the stored run again when another writer replaced or grew its lists (#4317)", async () => {
	const f = await fixture();
	try {
		const node = (id: string, status: "running" | "completed") =>
			({ id, name: id, status, parentIds: [] }) as unknown as RunSnapshot["toolNodes"][number];
		const changes = (stages: StageSnapshot[], toolNodes: RunSnapshot["toolNodes"] = []): RunChanges => ({
			kind: "changes",
			id: descriptor.childRunId,
			stages,
			toolNodes,
		});
		const ids = () => f.store.run(descriptor.childRunId)!.stages.map((entry) => entry.id);
		const tools = () => f.store.run(descriptor.childRunId)!.toolNodes.map((entry) => entry.id);
		await f.handoff.publish(f.first, [childRun([stage("a", { status: "completed" })])]);
		let stored = f.store.run(descriptor.childRunId)!;
		f.store.recordRunStart({ ...stored, stages: [stage("b")] });
		await f.handoff.publish(f.first, [changes([stage("b", { sessionId: "s" })])]);
		assert.deepEqual(ids(), ["b"], "a stage the replaced list holds is replaced, not added again");
		f.store.run(descriptor.childRunId)!.stages.push(stage("c"));
		await f.handoff.publish(f.first, [changes([stage("c", { sessionId: "s" })])]);
		assert.deepEqual(ids(), ["b", "c"], "a stage another writer added is replaced, not added again");
		await f.handoff.publish(f.first, [
			childRun(
				[
					stage("x", { status: "completed" }),
					stage("y", { status: "completed" }),
					stage("z", { status: "completed" }),
				],
				{ toolNodes: [node("t1", "completed")] },
			),
		]);
		stored = f.store.run(descriptor.childRunId)!;
		[stored.stages[1], stored.stages[2]] = [stored.stages[2]!, stored.stages[1]!];
		await f.handoff.publish(f.first, [
			changes([stage("x", { status: "completed", name: "x2" }), stage("y", { status: "completed", name: "y2" })]),
		]);
		assert.deepEqual(
			f.store.run(descriptor.childRunId)!.stages.map((entry) => [entry.id, entry.name]),
			[
				["x", "x2"],
				["z", "z"],
				["y", "y2"],
			],
		);
		f.store.recordRunStart({ ...stored, toolNodes: [node("t2", "running")] });
		await f.handoff.publish(f.first, [changes([], [node("t2", "completed")])]);
		assert.deepEqual(tools(), ["t2"], "a tool node the replaced list holds is replaced, not added again");
		f.store.run(descriptor.childRunId)!.toolNodes.push(node("t3", "running"));
		await f.handoff.publish(f.first, [changes([], [node("t3", "completed")])]);
		assert.deepEqual(tools(), ["t2", "t3"], "a tool node another writer added is replaced, not added again");
	} finally {
		await f.close();
	}
});

test("stages that share an id are matched by the first of them, as the store finds them (#4317)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("dup", { status: "completed" }), stage("dup")])]);
		const stored = f.store.run(descriptor.childRunId)!;
		stored.stages[0]!.attached = true;
		await f.handoff.publish(f.first, [childRun([stage("dup", { status: "completed" }), stage("dup")])]);
		assert.deepEqual(
			f.store.run(descriptor.childRunId)!.stages.map((entry) => entry.attached),
			[true, true],
		);
		await f.handoff.publish(f.first, [
			{ kind: "changes", id: descriptor.childRunId, stages: [stage("dup", { name: "first" })], toolNodes: [] },
		]);
		assert.deepEqual(
			f.store.run(descriptor.childRunId)!.stages.map((entry) => entry.name),
			["first", "dup"],
		);
	} finally {
		await f.close();
	}
});

test("changes keep the run under the root even when the worker's own fields do not name it (#4317)", async () => {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		const run = (label: string) => childRun([stage("a")], { rootRunId: undefined, label });
		await f.handoff.publish(f.first, encoder.encode(f.first, [run("first")]));
		const runs = encoder.encode(f.first, [run("second")]);
		assert.equal(isRunChanges(runs[0]!), true);
		await f.handoff.publish(f.first, runs);
		assert.deepEqual(
			[f.store.run(descriptor.childRunId)?.label, f.store.run(descriptor.childRunId)?.rootRunId],
			["second", ROOT],
		);
	} finally {
		await f.close();
	}
});

test("observers are told exactly which stages, tool nodes and fields a change wrote (#4317)", async () => {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		const node = (id: string, status: "running" | "completed") =>
			({ id, name: id, status, parentIds: [] }) as unknown as RunSnapshot["toolNodes"][number];
		const run = (stages: StageSnapshot[], toolNodes: RunSnapshot["toolNodes"], label?: string) =>
			childRun(stages, { toolNodes, ...(label === undefined ? {} : { label }) });
		await f.handoff.publish(
			f.first,
			encoder.encode(f.first, [
				run([stage("done", { status: "completed" }), stage("live"), stage("idle")], [node("t1", "running")]),
			]),
		);
		const told: unknown[] = [];
		const unsubscribe = f.store.subscribeInvalidation((changes) => told.push(changes));
		const progress = () => f.store.run(ROOT)?.lastProgressAt;
		try {
			const renewed = { ...f.first, renewedAt: f.first.renewedAt + 1_000, expiresAt: f.first.expiresAt + 1_000 };
			await f.handoff.publish(
				renewed,
				encoder.encode(renewed, [
					run(
						[
							stage("done", { status: "completed" }),
							stage("live", { sessionId: "s" }),
							stage("idle"),
							stage("new"),
						],
						[node("t1", "completed"), node("t2", "running")],
						"label",
					),
				]),
			);
			const child = descriptor.childRunId;
			assert.deepEqual(told, [
				[
					{ runId: child },
					{ runId: child, stageId: "live" },
					{ runId: child, stageId: "new" },
					{ runId: child, stageId: "idle" },
					{ runId: child, toolNodeId: "t1" },
					{ runId: child, toolNodeId: "t2" },
					{ runId: ROOT },
				],
			]);
			for (const toolNodes of [[node("t1", "completed"), node("t2", "completed")]]) {
				const before = progress();
				await new Promise((resolve) => setTimeout(resolve, 5));
				await f.handoff.publish(
					renewed,
					encoder.encode(renewed, [
						run(
							[
								stage("done", { status: "completed" }),
								stage("live", { sessionId: "s" }),
								stage("idle"),
								stage("new"),
							],
							toolNodes,
							"label",
						),
					]),
				);
				assert.ok((progress() ?? 0) > (before ?? 0), "a tool node that changed is progress");
			}
			const before = progress();
			await new Promise((resolve) => setTimeout(resolve, 5));
			await f.handoff.publish(
				renewed,
				encoder.encode(renewed, [
					run(
						[
							stage("done", { status: "completed" }),
							stage("live", { sessionId: "s" }),
							stage("idle"),
							stage("new"),
						],
						[node("t1", "completed"), node("t2", "completed")],
						"another",
					),
				]),
			);
			assert.ok((progress() ?? 0) > (before ?? 0), "a changed own field is progress");
			const beforeStage = progress();
			await new Promise((resolve) => setTimeout(resolve, 5));
			await f.handoff.publish(
				renewed,
				encoder.encode(renewed, [
					run(
						[
							stage("done", { status: "completed" }),
							stage("live", { sessionId: "t" }),
							stage("idle"),
							stage("new"),
						],
						[node("t1", "completed"), node("t2", "completed")],
						"another",
					),
				]),
			);
			assert.ok((progress() ?? 0) > (beforeStage ?? 0), "a changed stage is progress");
		} finally {
			unsubscribe();
		}
	} finally {
		await f.close();
	}
});

/** Runs of a child with `size` ended host stages, each hosting a nested run; the first `open` nested runs still run. */
function nestedRuns(size: number, open: number, live: Partial<StageSnapshot> = {}): RunSnapshot[] {
	return [
		childRun(
			Array.from({ length: size }, (_, index) =>
				stage(`host-${index}`, {
					status: "completed",
					endedAt: 1,
					workflowChildRun: { alias: `n${index}`, workflow: "nested", runId: `nested-${index}` },
				}),
			),
		),
		...Array.from({ length: size }, (_, index) =>
			snapshot(`nested-${index}`, {
				parentRunId: descriptor.childRunId,
				parentStageId: `host-${index}`,
				rootRunId: ROOT,
				stages: [
					stage(`work-${index}`, index < open ? (index === 0 ? live : {}) : { status: "completed", endedAt: 1 }),
				],
			}),
		),
	];
}

/** One change to the first nested run, then one lease renewal alone, over a child with `size` nested runs. */
async function measureNestedBatches(size: number) {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		await f.handoff.publish(f.first, encoder.encode(f.first, nestedRuns(size, 3)));
		const stored = f.store.runs().filter((run) => run.id !== ROOT);
		const before = stored.flatMap((run) => run.stages);
		const reads = countFieldReads(before);
		countFieldReads(stored, reads);
		const measure = async (work: PoolWork, live: Partial<StageSnapshot>) => {
			const runs = encoder.encode(work, nestedRuns(size, 3, live));
			reads.reads = 0;
			await f.handoff.publish(work, runs);
			const counted = reads.reads;
			const after = f.store.runs().filter((run) => run.id !== ROOT);
			return {
				entries: runs.length,
				stages: runs.flatMap((run) => run.stages).length,
				reads: counted,
				relabelled: after
					.flatMap((run) => run.stages)
					.filter((entry) => entry.workerExecution?.renewedAt === work.renewedAt).length,
			};
		};
		const renewed = { ...f.first, renewedAt: f.first.renewedAt + 1_000, expiresAt: f.first.expiresAt + 1_000 };
		const changed = await measure(renewed, { toolEvents: [{ name: "read" } as never] });
		const later = { ...renewed, renewedAt: renewed.renewedAt + 1_000, expiresAt: renewed.expiresAt + 1_000 };
		const renewal = await measure(later, { toolEvents: [{ name: "read" } as never] });
		assert.equal(f.store.run("nested-1")?.stages[0]?.workerExecution?.renewedAt, later.renewedAt);
		assert.equal(f.store.run("nested-3")?.stages[0]?.workerExecution?.renewedAt, f.first.renewedAt);
		return { changed, renewal };
	} finally {
		await f.close();
	}
}

/** Field reads of a first full publication of a child with `size` nested runs, of the runs and stages it carries. */
async function measureNestedFullPublication(size: number) {
	const f = await fixture();
	try {
		const runs = nestedRuns(size, 3);
		const reads = countFieldReads(runs);
		countFieldReads(
			runs.flatMap((run) => run.stages),
			reads,
		);
		await f.handoff.publish(f.first, runs);
		assert.equal(f.store.childRuns(descriptor.childRunId).length, size);
		return reads.reads;
	} finally {
		await f.close();
	}
}

test("a change to one of thousands of nested runs carries and reads the same as one of hundreds (#4317)", async () => {
	const sizes = [250, 1_000, 4_000];
	const measured: Awaited<ReturnType<typeof measureNestedBatches>>[] = [];
	for (const size of sizes) measured.push(await measureNestedBatches(size));
	assert.deepEqual(
		measured,
		sizes.map(() => measured[0]),
		`per-batch work grew with the nested runs: ${JSON.stringify(measured)}`,
	);
	assert.deepEqual(
		[measured[0]!.changed.entries, measured[0]!.changed.stages, measured[0]!.changed.relabelled],
		[2, 1, 3],
		"the first run names the publication, the changed run carries its stage, and the open stages show the lease",
	);
	assert.deepEqual(
		[measured[0]!.renewal.entries, measured[0]!.renewal.stages, measured[0]!.renewal.relabelled],
		[1, 0, 3],
	);
});

test("a full publication of a child and its nested runs reads each of them a fixed number of times (#4317)", async () => {
	const [small, medium, large] = [
		await measureNestedFullPublication(250),
		await measureNestedFullPublication(1_000),
		await measureNestedFullPublication(4_000),
	];
	assert.equal(large! - medium!, 4 * (medium! - small!), `reads ${small} / ${medium} / ${large} are not linear`);
});

test("a batch stops before any turn once its signal aborts, the first included, so a run its pool ended is not written again (#4317)", async () => {
	const f = await fixture();
	try {
		const queue: PoolStageQueue = {
			assertCurrent: async () => {},
			withCurrentAppend: f.queue.withCurrentAppend.bind(f.queue),
			result: f.queue.result.bind(f.queue),
		};
		const handoff = new PoolStageHandoff(f.backend, f.store, queue, f.lease);
		const stages = Array.from({ length: 600 }, (_, index) => stage(`stage-${index}`, { status: "completed" }));
		await handoff.publish(f.first, [childRun(stages)]);
		const publications = ["first", "second", "third"].map((label) => ({
			work: f.first,
			runs: [childRun(stages, { label })],
		}));
		const disposal = new AbortController();
		setImmediate(() => {
			disposal.abort();
			f.store.recordRunEnd(descriptor.childRunId, "failed", undefined, "pool failed");
		});
		await assert.rejects(
			handoff.publishBatch(publications, disposal.signal),
			(error) => error === disposal.signal.reason,
		);
		const run = f.store.run(descriptor.childRunId)!;
		assert.deepEqual([run.status, run.label], ["failed", "second"]);
		const closed = new AbortController();
		closed.abort();
		await assert.rejects(
			handoff.publishBatch([{ work: f.first, runs: [childRun(stages, { label: "after close" })] }], closed.signal),
			(error) => error === closed.signal.reason,
		);
		assert.equal(
			f.store.run(descriptor.childRunId)?.label,
			"second",
			"a batch its pool closed before writes nothing",
		);
	} finally {
		await f.close();
	}
});

test("a full publication is the attempt's runs from then on, and open runs the store dropped are not relabelled (#4317)", async () => {
	const f = await fixture();
	try {
		const link = { workflowChildRun: { alias: "n", workflow: "n", runId: "nested" } };
		const nested = snapshot("nested", {
			parentRunId: descriptor.childRunId,
			parentStageId: "host",
			rootRunId: ROOT,
			stages: [stage("open")],
		});
		await f.handoff.publish(f.first, [childRun([stage("host", link), stage("live")]), nested]);
		f.store.removeRun("nested");
		const renewed = { ...f.first, renewedAt: f.first.renewedAt + 1_000, expiresAt: f.first.expiresAt + 1_000 };
		await f.handoff.publish(renewed, [{ kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] }]);
		assert.equal(f.store.run("nested"), undefined);
		assert.equal(f.store.run(descriptor.childRunId)?.stages[1]?.workerExecution?.renewedAt, renewed.renewedAt);
		const reads = vi.spyOn(f.store, "run");
		const again = { ...renewed, renewedAt: renewed.renewedAt + 500, expiresAt: renewed.expiresAt + 500 };
		await f.handoff.publish(again, [{ kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] }]);
		const read = reads.mock.calls.map(([id]) => id);
		reads.mockRestore();
		assert.ok(!read.includes("nested"), "a run the store dropped is looked for once, then forgotten");
		await f.handoff.publish(f.first, [childRun([stage("host", link), stage("live")]), nested]);
		await f.handoff.publish(f.first, [childRun([stage("host", link), stage("live")])]);
		await assert.rejects(
			f.handoff.publish(f.first, [{ kind: "changes", id: "nested", stages: [], toolNodes: [] }]),
			outsideSubtree(f.first, "nested"),
		);
		await f.handoff.publish(f.first, [childRun([stage("host", link), stage("live")])]);
		const later = { ...f.first, renewedAt: f.first.renewedAt + 2_000, expiresAt: f.first.expiresAt + 2_000 };
		const dropped = f.store.run("nested")!.stages[0];
		await f.handoff.publish(later, [{ kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] }]);
		assert.equal(f.store.run("nested")?.stages[0], dropped, "a run the attempt no longer publishes is left alone");
	} finally {
		await f.close();
	}
});

test("an empty publication holds no runs: it ends a refusal, and nothing it left out is relabelled or changed (#4317)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("live")])]);
		await assert.rejects(
			f.handoff.publish(f.first, [{ kind: "changes", id: "stranger", stages: [], toolNodes: [] }]),
			outsideSubtree(f.first, "stranger"),
		);
		const renewed = { ...f.first, renewedAt: f.first.renewedAt + 1_000, expiresAt: f.first.expiresAt + 1_000 };
		await f.handoff.publish(renewed, []);
		assert.equal(f.store.run(descriptor.childRunId)?.stages[0]?.workerExecution?.renewedAt, f.first.renewedAt);
		await assert.rejects(
			f.handoff.publish(renewed, [{ kind: "changes", id: descriptor.childRunId, stages: [], toolNodes: [] }]),
			outsideSubtree(f.first, descriptor.childRunId),
		);
	} finally {
		await f.close();
	}
});

test("a renewal after nested runs ended reads none of them (#4317)", async () => {
	const f = await fixture();
	try {
		const encoder = new RunChangesEncoder();
		await f.handoff.publish(f.first, encoder.encode(f.first, nestedRuns(50, 50)));
		await f.handoff.publish(f.first, encoder.encode(f.first, nestedRuns(50, 0)));
		const renewed = { ...f.first, renewedAt: f.first.renewedAt + 1_000, expiresAt: f.first.expiresAt + 1_000 };
		const reads = vi.spyOn(f.store, "run");
		await f.handoff.publish(renewed, encoder.encode(renewed, nestedRuns(50, 0)));
		const read = reads.mock.calls.map(([id]) => id);
		reads.mockRestore();
		assert.deepEqual(
			read.filter((id) => id.startsWith("nested-")),
			[],
		);
	} finally {
		await f.close();
	}
});

test("stages a renewal relabels in runs its publication leaves out count toward the turn's budget (#4317)", async () => {
	const f = await fixture();
	try {
		const link = { workflowChildRun: { alias: "n", workflow: "n", runId: "nested" } };
		const nested = snapshot("nested", {
			parentRunId: descriptor.childRunId,
			parentStageId: "host",
			rootRunId: ROOT,
			stages: Array.from({ length: PUBLICATION_TURN_WRITES / 2 }, (_, index) => stage(`open-${index}`)),
		});
		await f.handoff.publish(f.first, [childRun([stage("host", { ...link, status: "completed" })]), nested]);
		const renewals = Array.from({ length: 4 }, (_, index) => ({
			work: {
				...f.first,
				renewedAt: f.first.renewedAt + (index + 1) * 1_000,
				expiresAt: f.first.expiresAt + (index + 1) * 1_000,
			},
			runs: [{ kind: "changes" as const, id: descriptor.childRunId, stages: [], toolNodes: [] }],
		}));
		const slices: number[] = [];
		const unsubscribe = f.store.subscribeInvalidation(() => slices.push(slices.length));
		try {
			assert.deepEqual(
				await f.handoff.publishBatch(renewals),
				renewals.map(() => undefined),
			);
		} finally {
			unsubscribe();
		}
		assert.equal(slices.length, 2, "each renewal relabels half a turn's budget, so two of them fill a turn");
		assert.equal(f.store.run("nested")?.stages[0]?.workerExecution?.renewedAt, renewals[3]!.work.renewedAt);
	} finally {
		await f.close();
	}
});

const MODEL_SEEDS = 40;
const MODEL_STEPS = 80;

test("a root fed changes holds what a root fed full publications holds, through renewals, replays and replacements (#4317)", async () => {
	let compared = 0;
	let incremental = 0;
	for (let seed = 1; seed <= MODEL_SEEDS; seed++) {
		const f = await fixture();
		try {
			const queue: PoolStageQueue = {
				assertCurrent: async () => {},
				withCurrentAppend: f.queue.withCurrentAppend.bind(f.queue),
				result: f.queue.result.bind(f.queue),
			};
			const reference = createStore();
			bindStoreDurableBackend(reference, f.backend);
			const rootRun = structuredClone(f.store.run(ROOT)!);
			bindRunDurableBackend(rootRun, f.backend);
			reference.recordRunStart(rootRun);
			const changes = new PoolStageHandoff(f.backend, f.store, queue, f.lease);
			const full = new PoolStageHandoff(f.backend, reference, queue, f.lease);
			const encoder = new RunChangesEncoder();
			const next = seeded(seed);
			const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)];
			let counter = 0;
			const worker = { generation: f.first.generation, name: "worker-one", renewedAt: f.first.renewedAt };
			let runs: RunSnapshot[] = [childRun([])];
			let pending: { readonly work: PoolWork; readonly runs: RunSnapshot[] } | undefined;
			for (let step = 0; step < MODEL_STEPS; step++) {
				const child = runs[0]!;
				const id = `n${counter++}`;
				switch (Math.floor(next() * 10)) {
					case 0:
					case 1:
						child.stages.push(stage(id, next() < 0.5 ? { sessionId: `session-${id}` } : {}));
						break;
					case 2: {
						const index = Math.floor(next() * child.stages.length);
						const target = child.stages[index];
						if (target === undefined) break;
						const status = pick(["running", "completed", "failed", "paused"] as const)!;
						child.stages[index] = {
							...target,
							status,
							...(status === "completed" || status === "failed" ? { endedAt: step } : {}),
							...(next() < 0.3 ? { sessionId: `session-${id}` } : {}),
						};
						break;
					}
					case 3: {
						const index = Math.floor(next() * child.stages.length);
						const target = child.stages[index];
						if (target !== undefined)
							child.stages[index] = { ...target, toolEvents: [...target.toolEvents, { name: id } as never] };
						break;
					}
					case 4:
						runs[0] =
							next() < 0.5 ? { ...child, label: id } : childRun(child.stages, { toolNodes: child.toolNodes });
						break;
					case 5:
						child.toolNodes.push({ id, name: id, status: "running", parentIds: [] } as never);
						break;
					case 6:
						if (runs.length < 7) {
							const nested = `nested-${id}`;
							child.stages.push(stage(id, { workflowChildRun: { alias: id, workflow: id, runId: nested } }));
							runs.push(
								snapshot(nested, {
									parentRunId: child.id,
									parentStageId: id,
									rootRunId: ROOT,
									stages: [stage(`${id}-a`)],
								}),
							);
						}
						break;
					case 7: {
						// Nested runs open and end stages of their own, which publications of changes leave out.
						const nested = runs[1 + Math.floor(next() * (runs.length - 1))];
						if (nested === undefined || nested === child) break;
						const last = nested.stages.length - 1;
						if (next() < 0.5) nested.stages.push(stage(id));
						else
							nested.stages[last] = {
								...nested.stages[last]!,
								status: nested.stages[last]!.status === "running" ? "completed" : "running",
							};
						break;
					}
					case 8:
						worker.renewedAt += 1_000;
						break;
					case 9:
						if (next() < 0.4) {
							// A replacement replays the child from the start: it publishes fewer stages at first.
							worker.generation++;
							worker.name = `worker-${worker.generation}`;
							runs = [
								childRun(
									child.stages
										.slice(0, Math.floor(next() * child.stages.length))
										.map((kept) => stage(kept.id, { replayKey: kept.replayKey })),
								),
							];
						}
						break;
				}
				if (next() < 0.6)
					pending = {
						work: {
							...f.first,
							generation: worker.generation,
							worker: worker.name,
							renewedAt: worker.renewedAt,
							expiresAt: worker.renewedAt + 60_000,
						},
						runs: structuredClone(runs),
					};
				if (pending === undefined || next() < 0.6) continue;
				const sent = encoder.encode(pending.work, pending.runs);
				if (sent.some(isRunChanges)) incremental++;
				const outcomes = await changes.publishBatch([{ work: pending.work, runs: sent }]);
				assert.deepEqual(
					outcomes,
					await full.publishBatch([{ work: pending.work, runs: structuredClone(pending.runs) }]),
					`seed ${seed} step ${step}`,
				);
				pending = undefined;
				const published = (store: typeof reference) =>
					JSON.parse(JSON.stringify(store.runs().filter((run) => run.id !== ROOT)));
				assert.deepEqual(published(f.store), published(reference), `seed ${seed} step ${step}`);
				compared++;
			}
		} finally {
			await f.close();
		}
	}
	assert.ok(compared > MODEL_SEEDS * 10, `only ${compared} publications compared`);
	assert.ok(incremental > compared / 2, `only ${incremental} of ${compared} publications carried changes`);
});
