import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { afterEach, describe, test } from "vitest";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { PENDING_STAGE_TRANSITION_BATCH_LIMIT } from "../../packages/workflows/src/shared/store-pending-stage-delivery-methods.js";
import type { PendingStageMessage, RunSnapshot, StageStatus } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import { sleep } from "../helpers/runtime.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

const ROOT_RUN_ID = testRunId("pending-transition-batching-root");
const GROUP = `workflow:${ROOT_RUN_ID}`;
const WAVE_STAGES = 160;
const STICKY_ENTRIES = 40;
/** A deliberately slow durable write, so each serialized persist is visible in the send's latency. */
const SLOW_PERSIST_MS = 40;
/** The burst may write the pending list at most this many times. */
const BURST_PERSIST_LIMIT = 4;

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

function childRunId(index: number): string {
	return testRunId(`pending-transition-batching-child-${index}`);
}

function stage(id: string, status: StageStatus, sessionId?: string) {
	return {
		id,
		name: id,
		status,
		parentIds: [] as string[],
		toolEvents: [] as never[],
		pendingStageDeliveryAvailable: true,
		...(sessionId === undefined ? {} : { sessionId }),
	};
}

function stickyEntry(index: number): PendingStageMessage {
	const targetPath = `workflow:${ROOT_RUN_ID}/child-c${index}/**`;
	return {
		id: `sticky-${index}`,
		runId: ROOT_RUN_ID,
		stageKey: targetPath,
		targetPath,
		from: { id: "planner-session", name: "planner", group: GROUP },
		message: { id: `sticky-${index}`, timestamp: 1_725_000_000_000, content: { text: `round ${index}` } },
		queuedAt: "2026-09-01T00:00:00.000Z",
		admissionOrder: index + 1,
		status: "queued",
		sticky: true,
		deliveries: [],
		deliveryCount: 0,
	};
}

async function fixture() {
	const store = createStore();
	const pendingStageMessages = Array.from({ length: STICKY_ENTRIES }, (_, index) => stickyEntry(index));
	store.recordRunStart({
		id: ROOT_RUN_ID,
		name: "pool",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [stage("orchestrator", "running", "root-session")],
		startedAt: 1,
		pendingStageMessages,
	} as RunSnapshot);
	for (let index = 0; index < WAVE_STAGES; index++) {
		store.recordRunStart({
			id: childRunId(index),
			name: `child-c${index}`,
			inputs: {},
			status: "running",
			parentRunId: ROOT_RUN_ID,
			rootRunId: ROOT_RUN_ID,
			toolNodes: [],
			stages: [stage("worker", "running", `session-${index}`)],
			startedAt: 2,
		} as RunSnapshot);
	}
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: ROOT_RUN_ID,
		name: "pool",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	assert.equal(await backend.persistPendingStageMessages(ROOT_RUN_ID, pendingStageMessages), true);
	let persists = 0;
	let failNext = false;
	const persist = backend.persistPendingStageMessages.bind(backend);
	backend.persistPendingStageMessages = async (...args) => {
		persists++;
		const fail = failNext;
		failNext = false;
		await sleep(SLOW_PERSIST_MS);
		if (fail) throw new Error("injected metadata fault");
		return await persist(...args);
	};
	return {
		store,
		backend,
		persists: () => persists,
		failNextPersist: () => {
			failNext = true;
		},
	};
}

describe("pending-stage transition batching", () => {
	test("a send queued during a wave-start delivery burst waits for a few persists, not the whole burst", async () => {
		const { store, backend, persists } = await fixture();
		const deliveries: Promise<boolean>[] = [];
		let sticky: Promise<unknown> | undefined;
		let stickyPersists = Number.NaN;
		let stickyMs = Number.NaN;
		const started = performance.now();
		for (let index = 0; index < WAVE_STAGES; index++) {
			if (index === WAVE_STAGES / 2) {
				// Let the first half's write start, so the send and the second half queue behind it.
				await sleep(SLOW_PERSIST_MS / 4);
				sticky = store
					.queueStickyStageMessage(
						{
							runId: ROOT_RUN_ID,
							stageKey: `workflow:${ROOT_RUN_ID}/child-*/**`,
							targetPath: `workflow:${ROOT_RUN_ID}/child-*/**`,
							from: { id: "planner-session", name: "planner", group: GROUP },
							message: { id: "mid-burst", timestamp: 1_725_000_000_000, content: { text: "steer" } },
							queuedAt: "2026-09-01T00:00:01.000Z",
						},
						GROUP,
						GROUP,
						backend,
					)
					.then((result) => {
						stickyPersists = persists();
						stickyMs = performance.now() - started;
						return result;
					});
			}
			// Each starting stage drains the sticky message that targets its run.
			deliveries.push(
				store.recordPendingStageMessageDeliveries(
					ROOT_RUN_ID,
					`sticky-${index % STICKY_ENTRIES}`,
					[{ runId: childRunId(index), stageId: "worker", sessionId: `session-${index}`, admission: "context" }],
					"2026-09-01T00:00:02.000Z",
					backend,
				),
			);
		}
		const queued = (await sticky) as { readonly ok: boolean; readonly deduplicated?: boolean };
		assert.equal(queued.ok, true);
		assert.equal(queued.deduplicated, false);
		assert.deepEqual(await Promise.all(deliveries), Array(WAVE_STAGES).fill(true));
		console.log(
			`burst: ${persists()} persists; mid-burst send resolved after ${stickyPersists} persists, ${stickyMs.toFixed(0)} ms`,
		);
		assert.ok(stickyPersists <= 2, `the mid-burst send resolved after ${stickyPersists} persists`);
		assert.ok(
			stickyMs < SLOW_PERSIST_MS * (BURST_PERSIST_LIMIT + 2),
			`the mid-burst send resolved after ${stickyMs.toFixed(0)} ms`,
		);
		assert.ok(persists() <= BURST_PERSIST_LIMIT, `the burst wrote the pending list ${persists()} times`);
		const persisted = backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? [];
		assert.equal(persisted.length, STICKY_ENTRIES + 1);
		assert.equal(
			persisted.reduce((total, entry) => total + (entry.deliveries?.length ?? 0), 0),
			WAVE_STAGES,
		);
		assert.deepEqual(store.runs().find((run) => run.id === ROOT_RUN_ID)?.pendingStageMessages, persisted);
	});

	test("a failed shared persist rejects every caller that depended on it and leaves the run as persisted", async () => {
		const { store, backend, persists, failNextPersist } = await fixture();
		const record = (index: number) =>
			store.recordPendingStageMessageDeliveries(
				ROOT_RUN_ID,
				`sticky-${index}`,
				[{ runId: childRunId(index), stageId: "worker", sessionId: `session-${index}`, admission: "context" }],
				"2026-09-01T00:00:02.000Z",
				backend,
			);
		const first = record(0);
		await sleep(SLOW_PERSIST_MS / 4);
		failNextPersist();
		// Queued behind the first write: an unchanged settle, then a change, then a duplicate of that change.
		const unchanged = store.settleStickyPendingStageMessageDelivered(ROOT_RUN_ID, "sticky-1", "now", backend);
		const changed = record(1);
		const duplicate = record(1);
		assert.equal(await first, true);
		assert.equal(await unchanged, false);
		await assert.rejects(changed, /injected metadata fault/);
		await assert.rejects(duplicate, /injected metadata fault/);
		assert.equal(persists(), 2);
		const live = store.runs().find((run) => run.id === ROOT_RUN_ID)?.pendingStageMessages ?? [];
		assert.deepEqual(live, backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages);
		assert.deepEqual(
			live.map((entry) => entry.deliveries?.length ?? 0),
			[1, ...Array(STICKY_ENTRIES - 1).fill(0)],
		);
		// The run continues from its persisted list: the failed delivery is recorded again.
		assert.equal(await record(1), true);
		assert.deepEqual(
			(backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? []).map((entry) => entry.deliveries?.length ?? 0),
			[1, 1, ...Array(STICKY_ENTRIES - 2).fill(0)],
		);
	});

	test("bounds each batch and keeps transitions in arrival order", async () => {
		const { store, backend, persists } = await fixture();
		const sends = PENDING_STAGE_TRANSITION_BATCH_LIMIT + 44;
		const queue = (index: number) =>
			store.queueStickyStageMessage(
				{
					runId: ROOT_RUN_ID,
					stageKey: `workflow:${ROOT_RUN_ID}/send-${index}/**`,
					targetPath: `workflow:${ROOT_RUN_ID}/send-${index}/**`,
					from: { id: "planner-session", name: "planner", group: GROUP },
					message: { id: `send-${index}`, timestamp: 1_725_000_000_000, content: { text: `send ${index}` } },
					queuedAt: "2026-09-01T00:00:01.000Z",
				},
				GROUP,
				GROUP,
				backend,
			);
		const first = queue(0);
		await sleep(SLOW_PERSIST_MS / 4);
		const rest = Array.from({ length: sends - 1 }, (_, index) => queue(index + 1));
		await first;
		await Promise.all(rest);
		// One write for the first send, one per full batch behind it, one for the remainder.
		assert.equal(persists(), 3);
		const persisted = (backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? []).slice(STICKY_ENTRIES);
		assert.deepEqual(
			persisted.map((entry) => entry.id),
			Array.from({ length: sends }, (_, index) => `send-${index}`),
		);
		assert.deepEqual(
			persisted.map((entry) => entry.admissionOrder),
			Array.from({ length: sends }, (_, index) => STICKY_ENTRIES + index + 1),
		);
	});
});
