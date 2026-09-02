import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { SessionInfo } from "../../packages/intercom/types.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { encodeMetadata, parseCurrentMetadataRecord } from "../../packages/workflows/src/durable/dbos-metadata.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { DurableWorkflowMetadata } from "../../packages/workflows/src/durable/types.js";
import {
	registerPendingStageIntercomBridge,
	settleUndeliverablePendingStageMessages,
} from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import {
	markPendingStageMessageDelivered,
	PENDING_STAGE_MESSAGE_LIMIT,
	pendingStageMessagesFor,
	queueStageMessage,
	queueStickyStageMessage,
	recordPendingStageMessageDeliveries,
	settleStickyPendingStageMessageDelivered,
} from "../../packages/workflows/src/shared/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	PendingStageMessage,
	PendingStageMessageInput,
	RunStatus,
	StageStatus,
} from "../../packages/workflows/src/shared/store-types.js";
import {
	matchStagePathSegments,
	splitStagePathSegments,
	targetSegmentsInPossibleStages,
} from "../../packages/workflows/src/shared/workflow-stage-path-matching.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const ROOT_RUN_ID = testRunId("sticky-root");
const CHILD_RUN_ID = testRunId("sticky-child");
const GROUP = `workflow:${ROOT_RUN_ID}`;

afterEach(() => setDurableBackend(undefined));

function message(id: string, timestamp = 1_725_000_000_000): PendingStageMessageInput["message"] {
	return { id, timestamp, content: { text: `scope ${id}` } };
}

function stickyInput(id: string, targetPath: string, overrides: Partial<PendingStageMessageInput> = {}) {
	return {
		runId: ROOT_RUN_ID,
		stageKey: targetPath,
		targetPath,
		from: { id: "planner-session", name: "planner", group: GROUP },
		message: message(id),
		queuedAt: `2026-09-01T00:00:00.000Z`,
		...overrides,
	};
}

describe("sticky stage-path matching", () => {
	test("matches globs, embedded globs, and deep broadcast segments", () => {
		assert.equal(matchStagePathSegments(splitStagePathSegments("orchestrator-*"), ["orchestrator-3"]), true);
		assert.equal(matchStagePathSegments(splitStagePathSegments("orchestrator-*"), ["orchestrator"]), false);
		assert.equal(matchStagePathSegments(splitStagePathSegments("review-*-*"), ["review-slice-1-2"]), true);
		assert.equal(matchStagePathSegments(["**"], ["a"]), true);
		assert.equal(matchStagePathSegments(["**"], ["a", "b"]), true);
		assert.equal(matchStagePathSegments(["**"], ["a", "b", "c"]), true);
		assert.equal(matchStagePathSegments(["a", "**", "b"], ["a", "b"]), true);
		assert.equal(matchStagePathSegments(["a", "**", "b"], ["a", "x", "y", "b"]), true);
		assert.equal(matchStagePathSegments(["a", "**"], ["a"]), true);
		assert.equal(matchStagePathSegments(["**", "b"], ["b"]), true);
		assert.equal(matchStagePathSegments(["a*"], ["ab"]), true);
		assert.equal(matchStagePathSegments(["Orchestrator-*"], ["orchestrator-3"]), false);
		assert.equal(matchStagePathSegments([], []), true);
		assert.equal(matchStagePathSegments([], ["a"]), false);
	});

	test("possible-stage membership is advisory and bidirectional", () => {
		const known = ["implement-slice-2/reviewer-a", "orchestrator-*"];
		assert.equal(targetSegmentsInPossibleStages(["orchestrator-3"], known), true);
		assert.equal(targetSegmentsInPossibleStages(["orchestrator-*"], known), true);
		assert.equal(targetSegmentsInPossibleStages(["implement-slice-2", "reviewer-a"], known), true);
		assert.equal(targetSegmentsInPossibleStages(["reviewer-a"], ["reviewer-*"]), true);
		assert.equal(targetSegmentsInPossibleStages(["ghost"], known), false);
		assert.equal(targetSegmentsInPossibleStages(["x"], []), false);
	});
});

describe("sticky queue transitions", () => {
	test("creates a sticky entry with the verbatim target path and empty delivery ledger", () => {
		const result = queueStickyStageMessage(
			[],
			stickyInput("1", `workflow:${ROOT_RUN_ID}/orchestrator-*`),
			GROUP,
			GROUP,
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.entry.sticky, true);
		assert.equal(result.entry.targetPath, `workflow:${ROOT_RUN_ID}/orchestrator-*`);
		assert.equal(result.entry.stageKey, `workflow:${ROOT_RUN_ID}/orchestrator-*`);
		assert.equal(result.entry.notInKnownSet, undefined);
		assert.deepEqual(result.entry.deliveries, []);
		assert.equal(result.entry.deliveryCount, 0);
		assert.equal(result.entry.status, "queued");
		assert.equal(result.position, 1);
		assert.equal(result.deduplicated, false);
	});

	test("keeps the 50-per-target cap independent for distinct targets", () => {
		let messages: readonly PendingStageMessage[] = [];
		for (let index = 1; index <= PENDING_STAGE_MESSAGE_LIMIT; index += 1) {
			const result = queueStickyStageMessage(
				messages,
				stickyInput(String(index), `workflow:${ROOT_RUN_ID}/orchestrator-*`),
				GROUP,
				GROUP,
			);
			assert.equal(result.ok, true);
			if (!result.ok) return;
			messages = result.messages;
		}
		const overflow = queueStickyStageMessage(
			messages,
			stickyInput("51", `workflow:${ROOT_RUN_ID}/orchestrator-*`),
			GROUP,
			GROUP,
		);
		assert.deepEqual(overflow, {
			ok: false,
			reason: "capacity",
			limit: PENDING_STAGE_MESSAGE_LIMIT,
			runId: ROOT_RUN_ID,
			stageKey: `workflow:${ROOT_RUN_ID}/orchestrator-*`,
		});
		// A different target keeps its own budget.
		const other = queueStickyStageMessage(
			messages,
			stickyInput("other-1", `workflow:${ROOT_RUN_ID}/reviewer-*`),
			GROUP,
			GROUP,
		);
		assert.equal(other.ok, true);
	});

	test("deduplicates identical retries and refuses conflicting reuse of the message id", () => {
		const target = `workflow:${ROOT_RUN_ID}/orchestrator-*`;
		const first = queueStickyStageMessage([], stickyInput("stable", target), GROUP, GROUP);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		const retry = queueStickyStageMessage(first.messages, stickyInput("stable", target), GROUP, GROUP);
		assert.equal(retry.ok, true);
		if (!retry.ok) return;
		assert.equal(retry.deduplicated, true);
		assert.equal(retry.entry.id, "stable");
		const conflict = queueStickyStageMessage(
			first.messages,
			stickyInput("stable", target, {
				message: { ...message("stable"), content: { text: "conflicting payload" } },
			}),
			GROUP,
			GROUP,
		);
		assert.deepEqual(conflict, {
			ok: false,
			reason: "message_id_conflict",
			runId: ROOT_RUN_ID,
			stageKey: target,
			messageId: "stable",
		});
	});

	test("refuses a sender outside the invocation group", () => {
		const result = queueStickyStageMessage(
			[],
			stickyInput("1", `workflow:${ROOT_RUN_ID}/orchestrator-*`),
			"other-group",
			GROUP,
		);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "group_mismatch");
	});
});

describe("sticky delivery ledger", () => {
	function queuedSticky(): readonly PendingStageMessage[] {
		const result = queueStickyStageMessage(
			[],
			stickyInput("1", `workflow:${ROOT_RUN_ID}/**`, { notInKnownSet: true }),
			GROUP,
			GROUP,
		);
		assert.equal(result.ok, true);
		if (!result.ok) return [];
		return result.messages;
	}

	test("records exactly-once deliveries per (entry, stage) and exposes the count", () => {
		const first = recordPendingStageMessageDeliveries(
			queuedSticky(),
			ROOT_RUN_ID,
			"1",
			[{ runId: ROOT_RUN_ID, stageId: "orch-3-id", stageName: "orchestrator-3" }],
			"2026-09-01T00:00:01.000Z",
		);
		assert.equal(first.length, 1);
		assert.equal(first[0]?.deliveryCount, 1);
		assert.equal(first[0]?.status, "queued");
		assert.deepEqual(first[0]?.deliveries, [
			{
				runId: ROOT_RUN_ID,
				stageId: "orch-3-id",
				stageName: "orchestrator-3",
				deliveredAt: "2026-09-01T00:00:01.000Z",
			},
		]);
		const repeat = recordPendingStageMessageDeliveries(
			first,
			ROOT_RUN_ID,
			"1",
			[{ runId: ROOT_RUN_ID, stageId: "orch-3-id", stageName: "orchestrator-3" }],
			"2026-09-01T00:00:02.000Z",
		);
		assert.equal(repeat, first);
		const secondStage = recordPendingStageMessageDeliveries(
			first,
			ROOT_RUN_ID,
			"1",
			[{ runId: CHILD_RUN_ID, stageId: "child-reviewer-id", stageName: "reviewer" }],
			"2026-09-01T00:00:03.000Z",
		);
		assert.equal(secondStage[0]?.deliveryCount, 2);
	});

	test("ignores exact entries and settled entries", () => {
		const messages = queuedSticky();
		assert.equal(
			recordPendingStageMessageDeliveries(
				messages,
				ROOT_RUN_ID,
				"missing",
				[{ runId: ROOT_RUN_ID, stageId: "x" }],
				"2026-09-01T00:00:01.000Z",
			),
			messages,
		);
		const settled = settleStickyPendingStageMessageDelivered(messages, ROOT_RUN_ID, "1", "2026-09-01T00:00:05.000Z");
		assert.equal(settled, messages);
	});

	test("settles a delivered sticky entry at terminal status without an undeliverable record", () => {
		const withDelivery = recordPendingStageMessageDeliveries(
			queuedSticky(),
			ROOT_RUN_ID,
			"1",
			[{ runId: ROOT_RUN_ID, stageId: "orch-3-id" }],
			"2026-09-01T00:00:01.000Z",
		);
		const settled = settleStickyPendingStageMessageDelivered(
			withDelivery,
			ROOT_RUN_ID,
			"1",
			"2026-09-01T00:00:05.000Z",
		);
		assert.equal(settled[0]?.status, "delivered");
		assert.equal(settled[0]?.deliveredAt, "2026-09-01T00:00:05.000Z");
		assert.equal(settled[0]?.undeliverableReason, undefined);
		assert.equal(settled[0]?.undeliverableNotificationId, undefined);
	});

	test("sticky entries never leak into exact stage lookups", () => {
		const messages = queuedSticky();
		assert.deepEqual(pendingStageMessagesFor(messages, ROOT_RUN_ID, `workflow:${ROOT_RUN_ID}/**`), []);
	});
});

function baseStage(
	overrides: Partial<{
		id: string;
		name: string;
		status: StageStatus;
		pendingStageDeliveryAvailable: boolean;
		sessionId: string | undefined;
		replayKey: string;
	}> = {},
) {
	return {
		id: overrides.id ?? "orch-3-id",
		name: overrides.name ?? "orchestrator-3",
		status: overrides.status ?? ("pending" as StageStatus),
		parentIds: [] as string[],
		toolEvents: [] as never[],
		pendingStageDeliveryAvailable: overrides.pendingStageDeliveryAvailable ?? true,
		...(overrides.sessionId === undefined ? {} : { sessionId: overrides.sessionId }),
		...(overrides.replayKey === undefined ? {} : { replayKey: overrides.replayKey }),
	};
}

function rootFixture(
	stage: ReturnType<typeof baseStage> | ReturnType<typeof baseStage>[] = baseStage(),
	possibleStages?: readonly string[],
) {
	const store = createStore();
	store.recordRunStart({
		id: ROOT_RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		stages: Array.isArray(stage) ? stage : [stage],
		startedAt: 1,
		...(possibleStages === undefined ? {} : { possibleStages }),
	});
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: ROOT_RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	return { store, backend };
}

describe("pre-start sticky drain", () => {
	test("delivers a matching pattern entry once and keeps the entry queued for later iterations", async () => {
		const { store, backend } = rootFixture();
		const queued = await store.queueStickyStageMessage(
			stickyInput("loop", `workflow:${ROOT_RUN_ID}/orchestrator-*`),
			GROUP,
			GROUP,
			backend,
		);
		assert.equal(queued?.ok, true);

		const delivered: string[] = [];
		const drain = (stageId: string, stageName: string) =>
			createWorkflowPendingStageDelivery(store, ROOT_RUN_ID, stageId, stageName).deliverPending((from, msg) => {
				delivered.push(`${stageName}:${msg.id}:${from.id}`);
			});

		await drain("orch-3-id", "orchestrator-3");
		await drain("orch-3-id", "orchestrator-3");
		await drain("orch-4-id", "orchestrator-4");
		await drain("orch-5-id", "orchestrator-5");
		// A stage the pattern never matches receives nothing.
		await drain("reviewer-id", "reviewer");

		assert.deepEqual(delivered, [
			"orchestrator-3:loop:planner-session",
			"orchestrator-4:loop:planner-session",
			"orchestrator-5:loop:planner-session",
		]);
		const entry = store.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(entry?.status, "queued");
		assert.equal(entry?.deliveryCount, 3);
		assert.deepEqual(
			entry?.deliveries?.map((delivery) => delivery.stageId),
			["orch-3-id", "orch-4-id", "orch-5-id"],
		);
	});

	test("matches nested child stages through depth-faithful boundary paths", async () => {
		const store = createStore();
		store.recordRunStart({
			id: ROOT_RUN_ID,
			name: "root",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "slice-boundary",
					name: "slice-2-implement",
					status: "running",
					parentIds: [],
					toolEvents: [],
					replayKey: "workflow:child:1",
					workflowChildRun: { alias: "child", workflow: "child", runId: CHILD_RUN_ID },
				},
			],
			startedAt: 1,
		});
		store.recordRunStart({
			id: CHILD_RUN_ID,
			name: "child",
			inputs: {},
			status: "running",
			parentRunId: ROOT_RUN_ID,
			parentStageId: "slice-boundary",
			rootRunId: ROOT_RUN_ID,
			stages: [baseStage({ id: "child-reviewer-id", name: "reviewer-a" })],
			startedAt: 2,
		});
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: ROOT_RUN_ID, name: "root", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		assert.equal(
			(
				await store.queueStickyStageMessage(
					stickyInput("nested", `workflow:${ROOT_RUN_ID}/slice-*/reviewer-*`),
					GROUP,
					GROUP,
					backend,
				)
			)?.ok,
			true,
		);
		assert.equal(
			(
				await store.queueStickyStageMessage(
					stickyInput("other", `workflow:${ROOT_RUN_ID}/other-*/reviewer-*`),
					GROUP,
					GROUP,
					backend,
				)
			)?.ok,
			true,
		);

		const delivered: string[] = [];
		await createWorkflowPendingStageDelivery(store, CHILD_RUN_ID, "child-reviewer-id", "reviewer-a").deliverPending(
			(_from, msg) => {
				delivered.push(msg.id);
			},
		);
		assert.deepEqual(delivered, ["nested"]);
		const nested = store
			.runs()
			.find((run) => run.id === ROOT_RUN_ID)
			?.pendingStageMessages?.find((entry) => entry.id === "nested");
		assert.equal(nested?.deliveryCount, 1);
		assert.deepEqual(nested?.deliveries?.[0], {
			runId: CHILD_RUN_ID,
			stageId: "child-reviewer-id",
			stageName: "reviewer-a",
			deliveredAt: nested?.deliveries?.[0]?.deliveredAt,
		});
		assert.equal(
			store
				.runs()
				.find((run) => run.id === ROOT_RUN_ID)
				?.pendingStageMessages?.find((entry) => entry.id === "other")?.deliveryCount,
			0,
		);
	});

	test("concurrently draining matching stages each receive the sticky entry (parallel reviewers)", async () => {
		const { store, backend } = rootFixture([
			baseStage({ id: "reviewer-a-id", name: "reviewer-a", status: "pending", sessionId: undefined }),
			baseStage({ id: "reviewer-b-id", name: "reviewer-b", status: "pending", sessionId: undefined }),
		]);
		const queued = await store.queueStickyStageMessage(
			stickyInput("bcast", `workflow:${ROOT_RUN_ID}/**`),
			GROUP,
			GROUP,
			backend,
		);
		assert.equal(queued?.ok, true);

		const delivered: string[] = [];
		const drainFor = (stageId: string, stageName: string) =>
			createWorkflowPendingStageDelivery(store, ROOT_RUN_ID, stageId, stageName).deliverPending(
				async (_from, msg) => {
					// Real drains await admission I/O; the overlap is what exposed the
					// shared-claim race (round-1 review, findings 1 and 4).
					await new Promise<void>((resolve) => setTimeout(resolve, 20));
					delivered.push(`${stageName}:${msg.id}`);
				},
			);
		await Promise.all([drainFor("reviewer-a-id", "reviewer-a"), drainFor("reviewer-b-id", "reviewer-b")]);
		assert.deepEqual(delivered.sort(), ["reviewer-a:bcast", "reviewer-b:bcast"]);
		assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.deliveryCount, 2);
	});

	test("accepts the materialized child run id as a boundary segment (D5)", async () => {
		const store = createStore();
		store.recordRunStart({
			id: ROOT_RUN_ID,
			name: "root",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "slice-boundary",
					name: "slice-2-implement",
					status: "running",
					parentIds: [],
					toolEvents: [],
					replayKey: "workflow:child:1",
					workflowChildRun: { alias: "child", workflow: "child", runId: CHILD_RUN_ID },
				},
			],
			startedAt: 1,
		});
		store.recordRunStart({
			id: CHILD_RUN_ID,
			name: "child",
			inputs: {},
			status: "running",
			parentRunId: ROOT_RUN_ID,
			parentStageId: "slice-boundary",
			rootRunId: ROOT_RUN_ID,
			stages: [baseStage({ id: "child-reviewer-id", name: "reviewer-a" })],
			startedAt: 2,
		});
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: ROOT_RUN_ID, name: "root", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		for (const target of [
			`workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/reviewer-*`,
			`workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/reviewer-a`,
		]) {
			assert.equal(
				(await store.queueStickyStageMessage(stickyInput(target, target), GROUP, GROUP, backend))?.ok,
				true,
				target,
			);
		}

		const delivered: string[] = [];
		await createWorkflowPendingStageDelivery(store, CHILD_RUN_ID, "child-reviewer-id", "reviewer-a").deliverPending(
			(_from, msg) => {
				delivered.push(msg.id);
			},
		);
		assert.deepEqual(delivered.sort(), [
			`workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/reviewer-*`,
			`workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/reviewer-a`,
		]);
		const counts = store
			.runs()
			.find((run) => run.id === ROOT_RUN_ID)
			?.pendingStageMessages?.map((entry) => [entry.targetPath, entry.deliveryCount]);
		assert.deepEqual(counts, [
			[`workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/reviewer-*`, 1],
			[`workflow:${ROOT_RUN_ID}/${CHILD_RUN_ID}/reviewer-a`, 1],
		]);
	});

	test("ready() gates on sticky-only queues", async () => {
		const { store, backend } = rootFixture(baseStage({ status: "pending", sessionId: undefined }));
		const delivery = createWorkflowPendingStageDelivery(store, ROOT_RUN_ID, "orch-3-id", "orchestrator-3");
		assert.equal(delivery.ready(), undefined);
		const queued = await store.queueStickyStageMessage(
			stickyInput("gate", `workflow:${ROOT_RUN_ID}/orchestrator-*`),
			GROUP,
			GROUP,
			backend,
		);
		assert.equal(queued?.ok, true);
		assert.ok(delivery.ready() instanceof Promise);
	});
});

describe("sticky entries in durable metadata", () => {
	function metadata(pendingStageMessages?: readonly PendingStageMessage[]): DurableWorkflowMetadata {
		return {
			workflowId: ROOT_RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			completedCheckpoints: 0,
			pendingPrompts: 0,
			promptReservationEpoch: "epoch",
			createdAt: 1,
			updatedAt: 2,
			...(pendingStageMessages !== undefined ? { pendingStageMessages } : {}),
		};
	}

	test("round-trips sticky fields verbatim", () => {
		const accepted = queueStickyStageMessage(
			[],
			stickyInput("sticky-1", `workflow:${ROOT_RUN_ID}/**`, { notInKnownSet: true }),
			GROUP,
			GROUP,
		);
		assert.equal(accepted.ok, true);
		if (!accepted.ok) return;
		const withDelivery = recordPendingStageMessageDeliveries(
			accepted.messages,
			ROOT_RUN_ID,
			"sticky-1",
			[{ runId: ROOT_RUN_ID, stageId: "orch-3-id", stageName: "orchestrator-3" }],
			"2026-09-01T00:00:01.000Z",
		);
		const parsed = parseCurrentMetadataRecord(
			{ stepName: "__atomic_metadata:2:test", output: encodeMetadata(metadata(withDelivery)) },
			ROOT_RUN_ID,
		);
		assert.deepEqual(parsed?.pendingStageMessages, withDelivery);
	});

	test("a legacy exact entry and a sticky entry hydrate side by side", () => {
		const exact = queueStageMessage(
			[],
			{
				runId: ROOT_RUN_ID,
				stageKey: "reviewer",
				from: { id: "planner-session", group: GROUP },
				message: message("exact-1"),
				queuedAt: "2026-09-01T00:00:00.000Z",
			},
			GROUP,
			GROUP,
		);
		assert.equal(exact.ok, true);
		if (!exact.ok) return;
		const sticky = queueStickyStageMessage(
			exact.messages,
			stickyInput("sticky-1", `workflow:${ROOT_RUN_ID}/orchestrator-*`),
			GROUP,
			GROUP,
		);
		assert.equal(sticky.ok, true);
		if (!sticky.ok) return;
		const parsed = parseCurrentMetadataRecord(
			{ stepName: "__atomic_metadata:2:test", output: encodeMetadata(metadata(sticky.messages)) },
			ROOT_RUN_ID,
		);
		assert.deepEqual(parsed?.pendingStageMessages, sticky.messages);
		// The legacy entry hydrates with no sticky fields at all.
		assert.equal(parsed?.pendingStageMessages?.[0]?.sticky, undefined);
		assert.equal(parsed?.pendingStageMessages?.[0]?.targetPath, undefined);
	});

	test("a sticky delivery ledger survives a DBOS reload and never redelivers (resume/replay exactly-once)", async () => {
		const sdk = createMockSdk();
		const first = new DbosDurableBackend(sdk);
		first.registerWorkflow({ workflowId: ROOT_RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(first);
		const store = createStore();
		store.recordRunStart({
			id: ROOT_RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [baseStage(), baseStage({ id: "orch-4-id", name: "orchestrator-4" })],
			startedAt: 1,
		});
		assert.equal(
			(
				await store.queueStickyStageMessage(
					stickyInput("resume", `workflow:${ROOT_RUN_ID}/orchestrator-*`),
					GROUP,
					GROUP,
					first,
				)
			)?.ok,
			true,
		);
		const before: string[] = [];
		await createWorkflowPendingStageDelivery(store, ROOT_RUN_ID, "orch-3-id", "orchestrator-3").deliverPending(
			(_from, msg) => {
				before.push(msg.id);
			},
		);
		assert.deepEqual(before, ["resume"]);

		await first.flush(ROOT_RUN_ID);
		const second = new DbosDurableBackend(sdk);
		await second.hydrateWorkflow(ROOT_RUN_ID);
		const hydrated = [...(second.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? [])];
		assert.equal(hydrated[0]?.deliveryCount, 1);
		const resumed = createStore();
		resumed.recordRunStart({
			id: ROOT_RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [baseStage(), baseStage({ id: "orch-4-id", name: "orchestrator-4" })],
			pendingStageMessages: hydrated,
			startedAt: 2,
		});

		// Re-draining the already-delivered stage must not redeliver (the hydrated ledger
		// record for (runId, stageId) is the exactly-once authority across restarts).
		const sameStage = createWorkflowPendingStageDelivery(resumed, ROOT_RUN_ID, "orch-3-id", "orchestrator-3");
		assert.equal(sameStage.ready(), undefined);
		const after: string[] = [];
		await sameStage.deliverPending((_from, msg) => {
			after.push(`repeat:${msg.id}`);
		});
		// ...while the next iteration still receives the entry.
		await createWorkflowPendingStageDelivery(resumed, ROOT_RUN_ID, "orch-4-id", "orchestrator-4").deliverPending(
			(_from, msg) => {
				after.push(msg.id);
			},
		);
		assert.deepEqual(after, ["resume"]);
		assert.equal(resumed.runs()[0]?.pendingStageMessages?.[0]?.deliveryCount, 2);
	});

	test("a sticky entry survives a DBOS backend reload", async () => {
		const sdk = createMockSdk();
		const first = new DbosDurableBackend(sdk);
		first.registerWorkflow({ workflowId: ROOT_RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(first);
		const store = createStore();
		store.recordRunStart({
			id: ROOT_RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		const queued = await store.queueStickyStageMessage(
			stickyInput("sticky-1", `workflow:${ROOT_RUN_ID}/orchestrator-*`),
			GROUP,
			GROUP,
			first,
		);
		assert.equal(queued?.ok, true);
		await first.flush(ROOT_RUN_ID);
		const second = new DbosDurableBackend(sdk);
		await second.hydrateWorkflow(ROOT_RUN_ID);
		const hydrated = second.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? [];
		assert.equal(hydrated.length, 1);
		assert.equal(hydrated[0]?.sticky, true);
		assert.equal(hydrated[0]?.targetPath, `workflow:${ROOT_RUN_ID}/orchestrator-*`);
		assert.equal(hydrated[0]?.deliveryCount, 0);
	});
});

function senderInfo(group = GROUP): SessionInfo {
	return {
		id: "planner-session",
		name: "planner",
		cwd: "/repo",
		model: "test-model",
		pid: 10,
		startedAt: 11,
		lastActivity: 12,
		group,
	};
}

interface StickyBridgeHarness {
	readonly store: ReturnType<typeof createStore>;
	readonly backend: InMemoryDurableBackend;
	readonly emitted: Array<{ event: string; payload: Record<string, unknown> }>;
	request(
		id: string,
		options?: {
			readonly group?: string;
			readonly target?: string;
			readonly expectsReply?: boolean;
			readonly sender?: SessionInfo;
		},
	): Promise<{
		handled: boolean;
		result:
			| {
					readonly outcome: "queued";
					readonly position: number;
					readonly notInKnownSet?: true;
					readonly forwardTargets?: readonly string[];
			  }
			| { readonly outcome: "delivered" }
			| { readonly outcome: "refused"; readonly reason: string }
			| undefined;
	}>;
	/** Replay the broker's confirmation of which forward targets were actually written to. */
	confirm(messageId: string, target: string, deliveredTargets: readonly string[]): Promise<boolean>;
	dispose(): void;
}

function stickyBridgeFixture(
	stages: Parameters<typeof rootFixture>[0] | Parameters<typeof rootFixture>[0][],
	options: { readonly possibleStages?: readonly string[]; readonly childRun?: boolean } = {},
): StickyBridgeHarness {
	const store = createStore();
	const stageList = Array.isArray(stages) ? stages : [stages];
	store.recordRunStart({
		id: ROOT_RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		stages: stageList as never,
		startedAt: 1,
		...(options.possibleStages === undefined ? {} : { possibleStages: options.possibleStages }),
	});
	if (options.childRun) {
		store.recordRunStart({
			id: CHILD_RUN_ID,
			name: "child",
			inputs: {},
			status: "running",
			parentRunId: ROOT_RUN_ID,
			parentStageId: "slice-boundary",
			rootRunId: ROOT_RUN_ID,
			stages: [],
			startedAt: 2,
		});
	}
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: ROOT_RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	const listeners = new Map<string, (payload: unknown) => void>();
	const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
	const dispose = registerPendingStageIntercomBridge(
		{
			events: {
				emit(event: string, payload: Record<string, unknown>) {
					emitted.push({ event, payload });
					listeners.get(event)?.(payload);
				},
				on(event: string, listener: (payload: unknown) => void) {
					listeners.set(event, listener);
					return () => listeners.delete(event);
				},
			},
		},
		store,
	);
	const request: StickyBridgeHarness["request"] = async (id, requestOptions = {}) => {
		const payload: {
			handled: boolean;
			completion?: Promise<
				| {
						readonly outcome: "queued";
						readonly position: number;
						readonly notInKnownSet?: true;
						readonly forwardTargets?: readonly string[];
				  }
				| { readonly outcome: "delivered" }
				| { readonly outcome: "refused"; readonly reason: string }
			>;
			requestId: string;
			from: SessionInfo;
			runId: string;
			target: string;
			message: PendingStageMessageInput["message"];
		} = {
			handled: false,
			requestId: `request-${id}`,
			from: requestOptions.sender ?? senderInfo(requestOptions.group ?? GROUP),
			runId: ROOT_RUN_ID,
			target: requestOptions.target ?? `workflow:${ROOT_RUN_ID}/orchestrator-*`,
			message: message(id, 1_725_000_000_000 + id.length),
			...(requestOptions.expectsReply ? { message: { ...message(id), expectsReply: true } } : {}),
		};
		listeners.get("atomic:workflow-pending-stage-message")?.(payload);
		return {
			handled: payload.handled,
			result: payload.completion === undefined ? undefined : await payload.completion,
		};
	};
	const confirm: StickyBridgeHarness["confirm"] = async (messageId, target, deliveredTargets) => {
		const payload: {
			handled: boolean;
			completion?: Promise<boolean>;
			runId: string;
			messageId: string;
			target: string;
			deliveredTargets: readonly string[];
		} = {
			handled: false,
			runId: ROOT_RUN_ID,
			messageId,
			target,
			deliveredTargets,
		};
		listeners.get("atomic:workflow-sticky-live-delivered")?.(payload);
		return payload.completion === undefined ? false : await payload.completion;
	};
	return { store, backend, emitted, request, confirm, dispose };
}

describe("pending-stage bridge sticky delivery", () => {
	afterEach(() => setDurableBackend(undefined));

	test("queues a pattern target speculatively with notInKnownSet when the scan excludes it", async () => {
		const harness = stickyBridgeFixture(baseStage(), { possibleStages: ["reviewer", "pull-request"] });
		const { handled, result } = await harness.request("1");
		assert.equal(handled, true);
		assert.deepEqual(result, {
			outcome: "queued",
			position: 1,
			notInKnownSet: true,
		});
		assert.equal(harness.store.runs()[0]?.pendingStageMessages?.[0]?.sticky, true);
		assert.equal(harness.store.runs()[0]?.pendingStageMessages?.[0]?.notInKnownSet, true);
		harness.dispose();
	});

	test("omits notInKnownSet when the persisted possible-stage set matches the target", async () => {
		const knownHarness = stickyBridgeFixture(baseStage(), { possibleStages: ["orchestrator-*", "pull-request"] });
		const literal = await knownHarness.request("1");
		assert.deepEqual(literal.result, { outcome: "queued", position: 1 });

		const patternHarness = stickyBridgeFixture(baseStage(), { possibleStages: ["pull-request"] });
		const wildcardTarget = await patternHarness.request("2", { target: `workflow:${ROOT_RUN_ID}/pull-*` });
		assert.deepEqual(wildcardTarget.result, { outcome: "queued", position: 1 });

		const literalTarget = await patternHarness.request("3", { target: `workflow:${ROOT_RUN_ID}/pull-request` });
		assert.deepEqual(literalTarget.result, { outcome: "queued", position: 1 });
		knownHarness.dispose();
		patternHarness.dispose();
	});

	test("queues an unresolved literal future-stage target (D3 name targets are sticky)", async () => {
		// `orchestrator-9` is materialized nowhere; only the pattern appears in the scan,
		// so the literal target is accepted speculatively as a sticky entry without the
		// notInKnownSet flag. A target that resolves to a materialized stage instead
		// keeps today's exactly-once queueing (covered by the exact-path suites).
		const harness = stickyBridgeFixture(baseStage(), { possibleStages: ["orchestrator-*", "pull-request"] });
		const { result } = await harness.request("1", { target: `workflow:${ROOT_RUN_ID}/orchestrator-9` });
		assert.deepEqual(result, { outcome: "queued", position: 1 });
		const entry = harness.store.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(entry?.sticky, true);
		assert.equal(entry?.targetPath, `workflow:${ROOT_RUN_ID}/orchestrator-9`);
		assert.equal(entry?.notInKnownSet, undefined);
		harness.dispose();
	});

	test("refuses asks to pattern targets and terminal roots", async () => {
		const harness = stickyBridgeFixture(baseStage());
		const ask = await harness.request("ask", { expectsReply: true });
		assert.deepEqual(ask.result, {
			outcome: "refused",
			reason:
				"Cannot ask a workflow stage whose session has not initialized. Use send; Atomic will queue the message until the stage session initializes.",
		});
		harness.dispose();

		const terminalStore = createStore();
		terminalStore.recordRunStart({
			id: ROOT_RUN_ID,
			name: "flow",
			inputs: {},
			status: "completed" as RunStatus,
			stages: [],
			startedAt: 1,
		});
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: ROOT_RUN_ID,
			name: "flow",
			inputs: {},
			status: "completed",
			createdAt: 1,
		});
		setDurableBackend(backend);
		const listeners = new Map<string, (payload: unknown) => void>();
		const terminalHarnessDispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit() {},
					on(event: string, listener: (payload: unknown) => void) {
						listeners.set(event, listener);
						return () => listeners.delete(event);
					},
				},
			},
			terminalStore,
		);
		const payload = {
			handled: false,
			completion: undefined as
				| Promise<
						| {
								readonly outcome: "queued";
								readonly position: number;
								readonly notInKnownSet?: true;
								readonly forwardTargets?: readonly string[];
						  }
						| { readonly outcome: "delivered" }
						| { readonly outcome: "refused"; readonly reason: string }
				  >
				| undefined,
			requestId: "terminal",
			from: senderInfo(),
			runId: ROOT_RUN_ID,
			target: `workflow:${ROOT_RUN_ID}/orchestrator-*`,
			message: message("terminal"),
		};
		listeners.get("atomic:workflow-pending-stage-message")?.(payload);
		assert.equal(payload.handled, true);
		assert.deepEqual(await payload.completion, {
			outcome: "refused",
			reason: `Workflow run ${ROOT_RUN_ID} terminated with status completed before any stage matching workflow:${ROOT_RUN_ID}/orchestrator-* started`,
		});
		terminalHarnessDispose();
	});

	test("queues sticky when the target resolves to one terminal stage instead of forwarding to a dead alias", async () => {
		// Round-1 review, finding 6: reviewer-a completed in iteration 1 (its stale
		// sessionId used to route the send to `forward` and die with Session not found).
		const harness = stickyBridgeFixture(
			baseStage({ id: "rev-a-1", name: "reviewer-a", status: "completed", sessionId: "stale-session" }),
			{ possibleStages: ["reviewer-a", "pull-request"] },
		);
		const { result } = await harness.request("next-iteration", { target: `workflow:${ROOT_RUN_ID}/reviewer-a` });
		assert.equal(result?.outcome, "queued");
		if (result?.outcome !== "queued") return;
		assert.equal(result.notInKnownSet, undefined);
		const entry = harness.store.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(entry?.sticky, true);
		assert.equal(entry?.targetPath, `workflow:${ROOT_RUN_ID}/reviewer-a`);
		assert.equal(entry?.status, "queued");
		harness.dispose();
	});

	test("live matching honors the materialized child run id as a boundary segment (D5)", async () => {
		// Round-1 review, findings 0/2/5: a pattern addressed through the child run id
		// must match the child's live stage just like the boundary-name spelling.
		const childRunId = testRunId("sticky-live-child");
		const store = createStore();
		store.recordRunStart({
			id: ROOT_RUN_ID,
			name: "root",
			inputs: {},
			status: "running",
			possibleStages: ["slice-*/reviewer-*"],
			stages: [
				{
					id: "slice-boundary",
					name: "slice-2-implement",
					status: "running",
					parentIds: [],
					toolEvents: [],
					replayKey: "workflow:child:1",
					workflowChildRun: { alias: "child", workflow: "child", runId: childRunId },
				},
			],
			startedAt: 1,
		});
		store.recordRunStart({
			id: childRunId,
			name: "child",
			inputs: {},
			status: "running",
			parentRunId: ROOT_RUN_ID,
			parentStageId: "slice-boundary",
			rootRunId: ROOT_RUN_ID,
			stages: [
				baseStage({ id: "child-reviewer-id", name: "reviewer-a", status: "running", sessionId: "live-child" }),
			],
			startedAt: 2,
		});
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: ROOT_RUN_ID, name: "root", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		const listeners = new Map<string, (payload: unknown) => void>();
		const dispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit() {},
					on(event: string, listener: (payload: unknown) => void) {
						listeners.set(event, listener);
						return () => listeners.delete(event);
					},
				},
			},
			store,
		);
		const send = async (id: string, target: string) => {
			const payload: {
				handled: boolean;
				completion?: Promise<
					| { readonly outcome: "queued"; readonly position: number; readonly forwardTargets?: readonly string[] }
					| { readonly outcome: "refused"; readonly reason: string }
				>;
				requestId: string;
				from: SessionInfo;
				runId: string;
				target: string;
				message: PendingStageMessageInput["message"];
			} = {
				handled: false,
				requestId: id,
				from: senderInfo(),
				runId: ROOT_RUN_ID,
				target,
				message: message(id),
			};
			listeners.get("atomic:workflow-pending-stage-message")?.(payload);
			return payload.completion === undefined ? undefined : await payload.completion;
		};
		// The forward target stays in the announced boundary-name form (broker-resolvable).
		const viaRunId = await send("via-run-id", `workflow:${ROOT_RUN_ID}/${childRunId}/reviewer-*`);
		assert.equal(viaRunId?.outcome, "queued");
		if (viaRunId?.outcome !== "queued") return;
		assert.deepEqual(viaRunId.forwardTargets, [`workflow:${ROOT_RUN_ID}/slice-2-implement/child-reviewer-id`]);
		const viaName = await send("via-name", `workflow:${ROOT_RUN_ID}/slice-2-implement/reviewer-*`);
		assert.equal(viaName?.outcome, "queued");
		if (viaName?.outcome !== "queued") return;
		assert.deepEqual(viaName.forwardTargets, [`workflow:${ROOT_RUN_ID}/slice-2-implement/child-reviewer-id`]);
		dispose();
	});

	test("records a live delivery only after the broker confirms the write, and a dedup retry re-forwards the unconfirmed target", async () => {
		const harness = stickyBridgeFixture([
			baseStage({ id: "live-id", name: "orchestrator-1", status: "running", sessionId: "session-live" }),
			baseStage({ id: "future-id", name: "orchestrator-2" }),
		]);
		const target = `workflow:${ROOT_RUN_ID}/**`;
		const first = await harness.request("broadcast", { target });
		assert.equal(first.result?.outcome, "queued");
		assert.equal(first.handled, true);
		if (first.result?.outcome !== "queued") return;
		assert.deepEqual(first.result.forwardTargets, [`${GROUP}/live-id`]);
		// Nothing is in the ledger until the broker reports the socket write succeeded
		// (review P1: a recipient that drops between answer and write must not be marked delivered).
		const entry = harness.store.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(entry?.deliveryCount ?? 0, 0);
		assert.equal(entry?.status, "queued");

		// The broker could not reach the stage: a retried send forwards to it again.
		const retryBeforeConfirm = await harness.request("broadcast", { target });
		assert.equal(retryBeforeConfirm.result?.outcome, "queued");
		if (retryBeforeConfirm.result?.outcome !== "queued") return;
		assert.deepEqual(retryBeforeConfirm.result.forwardTargets, [`${GROUP}/live-id`]);

		// The broker confirms the write; the ledger records exactly that stage once.
		const messageId = entry?.message.id ?? "";
		assert.equal(await harness.confirm(messageId, target, [`${GROUP}/live-id`]), true);
		const confirmed = harness.store.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(confirmed?.deliveryCount, 1);
		assert.deepEqual(
			confirmed?.deliveries?.map((delivery) => delivery.stageId),
			["live-id"],
		);
		// A duplicate confirmation is a no-op, and a confirmation for a target the
		// broker did not actually reach records nothing.
		assert.equal(await harness.confirm(messageId, target, [`${GROUP}/live-id`]), false);
		assert.equal(await harness.confirm(messageId, target, [`${GROUP}/unknown-id`]), false);
		assert.equal(harness.store.runs()[0]?.pendingStageMessages?.[0]?.deliveryCount, 1);

		// Once confirmed, a dedup retry has nothing left to forward.
		const retry = await harness.request("broadcast", { target });
		assert.deepEqual(retry.result, { outcome: "queued", position: 1, notInKnownSet: true });
		assert.equal(harness.store.runs()[0]?.pendingStageMessages?.[0]?.deliveryCount, 1);
		harness.dispose();
	});

	test("settles sticky entries at terminal status: undeliverable with notice for zero deliveries, delivered silently otherwise", async () => {
		const store = createStore();
		terminalStickyFixture(store, "sticky-zero", "sticky-delivered");
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: ROOT_RUN_ID,
			name: "flow",
			inputs: {},
			status: "cancelled",
			createdAt: 1,
		});
		setDurableBackend(backend);
		await store.queueStickyStageMessage(
			stickyInput("sticky-zero", `workflow:${ROOT_RUN_ID}/never-*`),
			GROUP,
			GROUP,
			backend,
		);
		await store.queueStickyStageMessage(
			stickyInput("sticky-delivered", `workflow:${ROOT_RUN_ID}/**`),
			GROUP,
			GROUP,
			backend,
		);
		await store.recordPendingStageMessageDeliveries(
			ROOT_RUN_ID,
			"sticky-delivered",
			[{ runId: ROOT_RUN_ID, stageId: "orch-3-id" }],
			"2026-09-01T00:00:01.000Z",
			backend,
		);

		const notified: string[] = [];
		const settled = await settleUndeliverablePendingStageMessages(store, async (entry, reason) => {
			notified.push(`${entry.id}:${reason}`);
			return true;
		});
		assert.equal(settled, 2);
		const entries = store.runs()[0]?.pendingStageMessages ?? [];
		const zero = entries.find((entry) => entry.id === "sticky-zero");
		const delivered = entries.find((entry) => entry.id === "sticky-delivered");
		assert.equal(zero?.status, "undeliverable");
		assert.match(
			zero?.undeliverableReason ?? "",
			new RegExp(
				`terminated with status cancelled before any stage matching workflow:${ROOT_RUN_ID}/never-\\* started`,
			),
		);
		assert.ok(zero?.undeliverableNotificationId);
		assert.deepEqual(notified, [`sticky-zero:${zero?.undeliverableReason}`]);
		assert.equal(delivered?.status, "delivered");
		assert.equal(delivered?.undeliverableNotificationId, undefined);

		// The notification loop marks the sender notice acknowledged.
		await settleUndeliverablePendingStageMessages(store, async () => true);
		const afterNotified = store.runs()[0]?.pendingStageMessages?.find((entry) => entry.id === "sticky-zero");
		assert.ok(afterNotified?.undeliverableNotifiedAt);
	});

	test("exact-id pending-stage queueing still consumes the entry on first delivery", async () => {
		const { store, backend } = rootFixture();
		const accepted = await store.queueStageMessage(
			{
				runId: ROOT_RUN_ID,
				stageKey: "orchestrator-3",
				from: { id: "planner-session", group: GROUP },
				message: message("exact-1"),
				queuedAt: "2026-09-01T00:00:00.000Z",
			},
			GROUP,
			GROUP,
			backend,
		);
		assert.equal(accepted?.ok, true);
		const delivered: string[] = [];
		await createWorkflowPendingStageDelivery(store, ROOT_RUN_ID, "orch-3-id", "orchestrator-3").deliverPending(
			(_from, msg) => {
				delivered.push(msg.id);
			},
		);
		assert.deepEqual(delivered, ["exact-1"]);
		assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.status, "delivered");
		// A redelivery attempt does not see the consumed entry.
		await createWorkflowPendingStageDelivery(store, ROOT_RUN_ID, "orch-3-id", "orchestrator-3").deliverPending(
			(_from, msg) => {
				delivered.push(msg.id);
			},
		);
		assert.deepEqual(delivered, ["exact-1"]);
		assert.ok(markPendingStageMessageDelivered);
	});
});

function terminalStickyFixture(store: ReturnType<typeof createStore>, ..._ids: string[]): void {
	store.recordRunStart({
		id: ROOT_RUN_ID,
		name: "flow",
		inputs: {},
		status: "cancelled" as RunStatus,
		stages: [baseStage()],
		startedAt: 1,
	});
}
