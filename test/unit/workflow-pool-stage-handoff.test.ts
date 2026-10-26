import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { pendingStageMessagesForDurableRun } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { bindRunDurableBackend, durableBackendForRun } from "../../packages/workflows/src/durable/run-owner-backend.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { workflowPendingStageRouteCapability } from "../../packages/workflows/src/shared/pending-stage-route-capability.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { asWorkflowInfrastructureError } from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { PoolStageHandoff } from "../../packages/workflows/src/workers/stage-handoff.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const ROOT = testRunId("pool-stage-handoff-root");
const GROUP = `workflow:${ROOT}`;
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
				durableBackendForRun(backend, store.runs(), descriptor.childRunId)!,
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

test("publication rejects root, sibling and unlinked runs without changing the store (#3869)", async () => {
	const f = await fixture();
	try {
		await f.handoff.publish(f.first, [childRun([stage("stage")])]);
		const before = JSON.stringify(f.store.runs());
		const nested = snapshot("grandchild", { parentRunId: descriptor.childRunId, parentStageId: "nested" });
		const attacks: readonly (readonly RunSnapshot[])[] = [
			[snapshot(ROOT, { stages: [stage("injected")] })],
			[
				childRun([stage("stage")]),
				snapshot(SIBLING.work.childRunId, { parentRunId: ROOT, parentStageId: "sibling" }),
			],
			[childRun([stage("stage")]), nested],
			[childRun([stage("stage")], { parentStageId: "other-boundary" })],
			[childRun([stage("stage")], { rootRunId: "other-root" })],
		];
		for (const runs of attacks) await assert.rejects(f.handoff.publish(f.first, runs), /outside the work subtree/);
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
		await assert.rejects(f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "ghost" })])]), /stale/i);
		await assert.rejects(f.handoff.route(f.first, descriptor.childRunId), /stale/i);
		await f.handoff.publish(next, [childRun([stage("stage", { sessionId: "session-b" })])]);
		const current = await f.handoff.route(next, descriptor.childRunId);
		assert.notEqual(current, stale);
		assert.equal(f.store.runs().find((run) => run.id === descriptor.childRunId)?.stages[0]?.sessionId, "session-b");
		await assert.rejects(f.handoff.publish(f.first, [childRun([stage("stage")])]), /stale/i);
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
		const staleOutcome = assert.rejects(stale, /stale/i);
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
					assert.ok(await outcome, "the stale delivery must reject before committing its receipt");
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
		assert.match(failure?.message ?? "unsettled readiness", /replaced/);
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
		const replacedOutcome = assert.rejects(replaced, /session-a was replaced/);
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
				/published session/,
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
		await assert.rejects(
			f.handoff.publish(f.first, [childRun([stage("stage", { sessionId: "session-a" })])]),
			/stale/i,
		);
		await assert.rejects(f.handoff.route(f.first, descriptor.childRunId), /stale/i);
		await assert.rejects(f.handoff.ready(f.first, descriptor.childRunId, "stage", "stage", "session-a"), /stale/i);
		await assert.rejects(
			f.handoff.deliver(f.first, descriptor.childRunId, "stage", "stage", recipient, async (_from, delivered) => {
				sent.push(delivered.id);
			}),
			/stale/i,
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
		await assert.rejects(f.handoff.ready(f.first, descriptor.childRunId, "stage", "stage", "session-a"), /stale/i);
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
			/stale/i,
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
		// The worker IPC relays only the message, so the message itself must name the refusal.
		assert.equal(error.message, "Stale work lease");
		assert.equal(asWorkflowInfrastructureError(new Error(error.message))?.code, "stale_work_lease");
	} finally {
		release.resolve();
		await delivery?.catch(() => {});
		vi.restoreAllMocks();
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
