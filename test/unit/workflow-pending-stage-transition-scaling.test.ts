import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { afterEach, describe, test } from "vitest";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessage, RunSnapshot, StageStatus } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

const ROOT_RUN_ID = testRunId("pending-transition-scaling-root");
const CHILD_RUNS = 480;
const MEASURED_TRANSITIONS = 41;
/** Ten times as many sticky entries may cost at most this many times as much per transition. */
const SCALING_RATIO_LIMIT = 3;
/** One fixture builds 3,000 durable entries across 480 runs and measures 50 transitions twice. */
const SCALING_TEST_TIMEOUT_MS = 120_000;

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

function childRunId(index: number): string {
	return testRunId(`pending-transition-scaling-child-${index}`);
}

function childName(index: number): string {
	return `child-c${String(index).padStart(3, "0")}`;
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
	const child = index % CHILD_RUNS;
	const targetPath = `workflow:${ROOT_RUN_ID}/${childName(child)}/**`;
	return {
		id: `sticky-${index}`,
		runId: ROOT_RUN_ID,
		stageKey: targetPath,
		targetPath,
		from: { id: "planner-session", name: "planner", group: `workflow:${ROOT_RUN_ID}` },
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

async function fixture(entries: number) {
	const store = createStore();
	const pendingStageMessages = Array.from({ length: entries }, (_, index) => stickyEntry(index));
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
	for (let index = 0; index < CHILD_RUNS; index++) {
		store.recordRunStart({
			id: childRunId(index),
			name: childName(index),
			inputs: {},
			status: "running",
			parentRunId: ROOT_RUN_ID,
			rootRunId: ROOT_RUN_ID,
			toolNodes: [],
			stages: [stage("worker", "running", `session-${index}`), stage("reviewer", "pending")],
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
	bindStoreDurableBackend(store, backend);
	return { store, backend };
}

/** Median wall time of one sticky delivery transition at the given list size. */
async function medianTransitionMs(entries: number): Promise<number> {
	const { store, backend } = await fixture(entries);
	const samples: number[] = [];
	for (let round = 0; round < MEASURED_TRANSITIONS; round++) {
		const index = (round * 7) % entries;
		const child = index % CHILD_RUNS;
		const started = performance.now();
		const recorded = await store.recordPendingStageMessageDeliveries(
			ROOT_RUN_ID,
			`sticky-${index}`,
			[{ runId: childRunId(child), stageId: "reviewer", sessionId: `review-${round}`, admission: "context" }],
			"2026-09-01T00:00:02.000Z",
			backend,
		);
		samples.push(performance.now() - started);
		assert.equal(recorded, true);
	}
	assert.equal(store.runs().find((run) => run.id === ROOT_RUN_ID)?.pendingStageMessages?.length, entries);
	samples.sort((left, right) => left - right);
	return samples[Math.floor(samples.length / 2)]!;
}

describe("pending-stage delivery transition scaling", () => {
	test(
		"one sticky delivery transition stays roughly flat as the pending list grows",
		async () => {
			// Warm the code paths so the first measurement does not pay for JIT compilation.
			await medianTransitionMs(300);
			const small = await medianTransitionMs(300);
			const large = await medianTransitionMs(3_000);
			console.log(`transition median: 300 entries ${small.toFixed(3)} ms, 3000 entries ${large.toFixed(3)} ms`);
			assert.ok(
				large < small * SCALING_RATIO_LIMIT,
				`3,000-entry transition took ${large.toFixed(3)} ms; 300-entry transition took ${small.toFixed(3)} ms`,
			);
		},
		SCALING_TEST_TIMEOUT_MS,
	);
});
