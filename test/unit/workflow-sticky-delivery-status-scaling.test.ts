/**
 * Route announcements and receipt folds cost what changed, not the length of the run.
 *
 * Sticky pattern messages stay queued until the root run ends, so a long fan-out accumulates
 * thousands of them. Every root route announcement recomputed each entry's delivery state on every
 * matching stage, and every folded journal receipt re-read the delivery count of every queued entry.
 * These tests count that work with explicit counters rather than wall time.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { afterEach, describe, test } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { createJournalProjection } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { buildWorkflowStatusListing } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/run-inspect.js";
import type { PossibleStageRow } from "../../packages/workflows/src/shared/possible-stage-rows.js";
import { STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT } from "../../packages/workflows/src/shared/sticky-delivery-state-bound.js";
import { stickyStageDeliveryStatuses } from "../../packages/workflows/src/shared/sticky-stage-delivery-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessage, RunSnapshot, StageStatus } from "../../packages/workflows/src/shared/store-types.js";
import { possibleStageRows } from "../helpers/reference-possible-stage-rows/possible-stage-rows.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

const ROOT_RUN_ID = testRunId("sticky-status-scaling-root");
const GROUP = `workflow:${ROOT_RUN_ID}`;
const CHILD_RUNS = 640;
const SMALL_ENTRIES = 800;
const LARGE_ENTRIES = 8_000;
/** Ten times as many sticky entries may cost at most this many times as much per announcement. */
const SCALING_RATIO_LIMIT = 3;
const MEASURED_ANNOUNCEMENTS = 9;
const FOLDED_RECEIPTS = 40;
/** Building 8,000 durable entries across 640 linked runs is structural setup cost, not the measured work. */
const SCALING_TEST_TIMEOUT_MS = 120_000;

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

function childRunId(index: number): string {
	return testRunId(`sticky-status-scaling-child-${index}`);
}

function childName(index: number): string {
	return `child-c${String(index).padStart(3, "0")}`;
}

function stage(id: string, status: StageStatus, extra: Record<string, unknown> = {}) {
	return {
		id,
		name: id,
		status,
		parentIds: [] as string[],
		toolEvents: [] as never[],
		pendingStageDeliveryAvailable: true,
		...extra,
	};
}

function stickyEntry(index: number, targets: number): PendingStageMessage {
	const child = index % targets;
	const targetPath = `workflow:${ROOT_RUN_ID}/${childName(child)}/**`;
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
		deliveries: [
			{
				runId: childRunId(child),
				stageId: "worker",
				sessionId: `session-${child}`,
				admission: "context",
				deliveredAt: "2026-09-01T00:00:01.000Z",
			},
		],
		deliveryCount: 1,
	};
}

/** A pooled invocation: one root with a boundary stage per child run, each child running one worker. */
/** `targets` children receive the entries round-robin, so each child's target accumulates `entries / targets`. */
async function invocation(entries: number, targets = CHILD_RUNS) {
	const store = createStore();
	store.recordRunStart({
		id: ROOT_RUN_ID,
		name: "pool",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [
			stage("orchestrator", "running", { sessionId: "root-session" }),
			...Array.from({ length: CHILD_RUNS }, (_, index) =>
				stage(childName(index), "running", { workflowChildRun: { runId: childRunId(index) } }),
			),
		],
		startedAt: 1,
		possibleStages: ["child-*/worker", "child-*/reviewer"],
		pendingStageMessages: Array.from({ length: entries }, (_, index) => stickyEntry(index, targets)),
	} as RunSnapshot);
	for (let index = 0; index < CHILD_RUNS; index++) {
		store.recordRunStart({
			id: childRunId(index),
			name: childName(index),
			inputs: {},
			status: "running",
			parentRunId: ROOT_RUN_ID,
			parentStageId: childName(index),
			rootRunId: ROOT_RUN_ID,
			toolNodes: [],
			stages: [stage("worker", "running", { sessionId: `session-${index}` }), stage("reviewer", "pending")],
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
	const root = store.runs().find((run) => run.id === ROOT_RUN_ID)!;
	assert.equal(await backend.persistPendingStageMessages(ROOT_RUN_ID, root.pendingStageMessages ?? []), true);
	bindStoreDurableBackend(store, backend);
	return { store, backend };
}

function countCalls<K extends keyof DurableWorkflowBackend>(
	backend: DurableWorkflowBackend,
	method: K,
): { readonly calls: () => number } {
	let calls = 0;
	const original = backend[method] as (...args: never[]) => unknown;
	(backend as unknown as Record<string, unknown>)[method] = (...args: never[]) => {
		calls++;
		return original.apply(backend, args);
	};
	return { calls: () => calls };
}

/** Delivery-status checks and wall time of announcements that each follow one delivery transition. */
async function announcementCost(entries: number, targets = CHILD_RUNS) {
	const { store, backend } = await invocation(entries, targets);
	const announcements: Record<string, unknown>[] = [];
	const bridge = registerPendingStageIntercomBridge(
		{
			events: {
				emit(event: string, payload: Record<string, unknown>) {
					if (event !== "atomic:workflow-pending-stage-route") return;
					payload.completion = Promise.resolve();
					if (payload.runId === ROOT_RUN_ID) announcements.push(payload);
				},
				on: () => () => {},
			},
		},
		store,
	);
	try {
		const checks = countCalls(backend, "hasCachedPendingStageDeliveryReceipt");
		const before = checks.calls();
		const samples: number[] = [];
		for (let round = 0; round < MEASURED_ANNOUNCEMENTS; round++) {
			const index = (round * 97) % entries;
			const child = index % targets;
			assert.equal(
				await store.recordPendingStageMessageDeliveries(
					ROOT_RUN_ID,
					`sticky-${index}`,
					[{ runId: childRunId(child), stageId: "reviewer", sessionId: `review-${round}`, admission: "context" }],
					"2026-09-01T00:00:02.000Z",
					backend,
				),
				true,
			);
			const started = performance.now();
			bridge.refresh();
			samples.push(performance.now() - started);
		}
		samples.sort((left, right) => left - right);
		const root = store.runs().find((run) => run.id === ROOT_RUN_ID)!;
		return {
			checksPerAnnouncement: (checks.calls() - before) / MEASURED_ANNOUNCEMENTS,
			medianMs: samples[Math.floor(samples.length / 2)]!,
			announcements: announcements.length,
			rows: announcements.at(-1)?.possibleStages as PossibleStageRow[],
			unboundedRows: possibleStageRows(store.runs(), ROOT_RUN_ID, root, backend),
		};
	} finally {
		bridge();
	}
}

/** Durable delivery-count reads made while folding receipts into a projection holding `entries` entries. */
async function foldReads(entries: number): Promise<number> {
	const { backend } = await invocation(entries);
	const projection = Object.getPrototypeOf(createJournalProjection()) as {
		getPendingStageMessageDeliveryCount: (...args: never[]) => number;
	};
	const original = projection.getPendingStageMessageDeliveryCount;
	let reads = 0;
	projection.getPendingStageMessageDeliveryCount = function (this: unknown, ...args: never[]) {
		reads++;
		return original.apply(this, args);
	};
	try {
		for (let receipt = 0; receipt < FOLDED_RECEIPTS; receipt++) {
			const child = receipt % CHILD_RUNS;
			await backend.archivePendingStageDeliveryReceipt(
				ROOT_RUN_ID,
				`sticky-${receipt}`,
				{
					runId: childRunId(child),
					stageId: "worker",
					sessionId: `session-${child}`,
					admission: "context",
					deliveredAt: "2026-09-01T00:00:01.000Z",
				},
				{ messageRunId: ROOT_RUN_ID, deliveryCount: 1 },
			);
		}
	} finally {
		projection.getPendingStageMessageDeliveryCount = original;
	}
	return reads / FOLDED_RECEIPTS;
}

describe("sticky delivery status scaling", () => {
	test(
		"one root route announcement after a delivery re-checks only what the delivery changed",
		async () => {
			const small = await announcementCost(SMALL_ENTRIES);
			const large = await announcementCost(LARGE_ENTRIES);
			console.log(
				`announcement after one delivery: ${SMALL_ENTRIES} entries ${small.checksPerAnnouncement} checks, ${small.medianMs.toFixed(2)} ms; ${LARGE_ENTRIES} entries ${large.checksPerAnnouncement} checks, ${large.medianMs.toFixed(2)} ms`,
			);
			// Every measured delivery changes the root's statuses, so every one is announced.
			assert.ok(small.announcements >= MEASURED_ANNOUNCEMENTS && large.announcements >= MEASURED_ANNOUNCEMENTS);
			assert.ok(
				large.checksPerAnnouncement <= Math.max(small.checksPerAnnouncement, 1) * SCALING_RATIO_LIMIT,
				`${LARGE_ENTRIES} entries: ${large.checksPerAnnouncement} delivery-status checks per announcement; ${SMALL_ENTRIES} entries: ${small.checksPerAnnouncement}`,
			);
		},
		SCALING_TEST_TIMEOUT_MS,
	);

	test(
		"every announced row carries a bounded number of delivery states at 8,000 entries",
		async () => {
			// 160 child targets with 50 queued messages each, the per-target queue limit: about the 163 rows of
			// the 640-child load test, each with a delivery state per message and stage.
			const { rows, unboundedRows } = await announcementCost(LARGE_ENTRIES, 160);
			let bounded = 0;
			for (const row of rows) {
				const listed = row.deliveryStates?.length ?? 0;
				assert.ok(listed <= STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT, `${row.target} lists ${listed} delivery states`);
				const total = Object.values(row.deliveryStateCounts ?? {}).reduce((sum, count) => sum + count, 0);
				assert.equal(total, listed + (row.omittedDeliveryStates ?? 0), `${row.target} counts`);
				const unbounded = unboundedRows.find((candidate) => candidate.target === row.target);
				assert.equal(total, unbounded?.deliveryStates?.length ?? 0, `${row.target} counts every state`);
				if ((row.omittedDeliveryStates ?? 0) > 0) bounded++;
			}
			assert.ok(bounded > 0, "no row was long enough to be bounded");
			// A list result carries each row as a roster entry with its run and group.
			const listBytes = (announced: readonly object[]) =>
				Buffer.byteLength(
					JSON.stringify(
						announced.map((row) => ({ kind: "workflow-future-stage", runId: ROOT_RUN_ID, ...row, group: GROUP })),
					),
				);
			console.log(
				`${LARGE_ENTRIES} entries, ${rows.length} rows: announcement possibleStages ${Buffer.byteLength(JSON.stringify(unboundedRows))} bytes unbounded, ${Buffer.byteLength(JSON.stringify(rows))} bytes bounded; list details ${listBytes(unboundedRows)} bytes unbounded, ${listBytes(rows)} bytes bounded`,
			);
		},
		SCALING_TEST_TIMEOUT_MS,
	);

	test(
		"workflow status and run inspection list a bounded number of delivery states at 8,000 entries",
		async () => {
			const { store, backend } = await invocation(LARGE_ENTRIES);
			const root = store.runs().find((run) => run.id === ROOT_RUN_ID)!;
			const states = stickyStageDeliveryStatuses(store.runs(), ROOT_RUN_ID, backend);
			const total = states.length;
			assert.ok(total > LARGE_ENTRIES, `only ${total} delivery states`);
			const inspected = inspectRun(ROOT_RUN_ID, { store });
			assert.ok(inspected.ok);
			const listing = buildWorkflowStatusListing([root], "all", Date.now(), {
				allRuns: store.runs(),
				durableBackend: backend,
			});
			for (const bounded of [inspected.detail, listing.runs[0]!]) {
				assert.equal(bounded.deliveryStates?.length, STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT);
				assert.equal(bounded.omittedDeliveryStates, total - STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT);
				assert.equal(
					Object.values(bounded.deliveryStateCounts ?? {}).reduce((sum, count) => sum + count, 0),
					total,
				);
			}
			const text = renderWorkflowToolContent({ action: "status", ...listing }, { action: "status" });
			assert.equal(text.match(/Intercom delivery /g)?.length, STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT);
			assert.match(
				text,
				new RegExp(`… ${total - STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT} more delivery states omitted \\(all: `),
			);
			console.log(
				`${LARGE_ENTRIES} entries, ${total} delivery states (${Buffer.byteLength(JSON.stringify(states))} bytes unbounded): inspect detail ${Buffer.byteLength(JSON.stringify(inspected.detail))} bytes, status text ${Buffer.byteLength(text)} bytes`,
			);
		},
		SCALING_TEST_TIMEOUT_MS,
	);

	test(
		"folding one delivery receipt reads a constant number of delivery counts",
		async () => {
			const small = await foldReads(SMALL_ENTRIES);
			const large = await foldReads(LARGE_ENTRIES);
			console.log(
				`count reads per folded receipt: ${SMALL_ENTRIES} entries ${small}; ${LARGE_ENTRIES} entries ${large}`,
			);
			assert.ok(large <= 4, `${LARGE_ENTRIES} entries: ${large} count reads per folded receipt`);
			assert.equal(large, small);
		},
		SCALING_TEST_TIMEOUT_MS,
	);
});
