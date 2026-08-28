import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { Message } from "../../packages/intercom/types.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { encodeMetadata, parseCurrentMetadataRecord } from "../../packages/workflows/src/durable/dbos-metadata.js";
import type { DurableWorkflowMetadata } from "../../packages/workflows/src/durable/types.js";
import {
	markPendingStageMessageDelivered,
	PENDING_STAGE_MESSAGE_LIMIT,
	type PendingStageMessage,
	type PendingStageMessageInput,
	pendingStageMessagesFor,
	queuedPendingStageMessageCount,
	queueStageMessage,
} from "../../packages/workflows/src/shared/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const RUN_ID = "run-1";
const STAGE_KEY = " Reviewer Stage ";
const RUN_GROUP = "workflow:run-1";

function message(id: string, text = `message ${id}`): Message {
	return {
		id,
		timestamp: 1_725_000_000_000 + Number(id.replace(/\D/g, "") || 0),
		content: {
			text,
			attachments: [{ type: "snippet", name: "contract.md", content: "literal amendment", language: "md" }],
		},
	};
}
function pendingMessage(id: string, overrides: Partial<PendingStageMessageInput> = {}): PendingStageMessageInput {
	return {
		runId: RUN_ID,
		stageKey: STAGE_KEY,
		from: { id: "sender-1", name: "planner", group: RUN_GROUP },
		message: message(id),
		queuedAt: `2026-08-26T00:00:${id.padStart(2, "0")}.000Z`,
		...overrides,
	};
}

describe("workflow stage messages store", () => {
	test("assigns durable FIFO admission order independently of sender timestamps", () => {
		const first = pendingMessage("1", {
			message: { ...message("1", "scope changed"), timestamp: 200 },
			queuedAt: "2026-08-26T00:00:02.000Z",
		});
		const second = pendingMessage("2", {
			message: { ...message("2"), timestamp: 100 },
			queuedAt: "2026-08-26T00:00:01.000Z",
		});
		const firstResult = queueStageMessage([], first, RUN_GROUP, RUN_GROUP);
		assert.equal(firstResult.ok, true);
		if (!firstResult.ok) return;
		const secondResult = queueStageMessage(firstResult.messages, second, RUN_GROUP, RUN_GROUP);
		assert.equal(secondResult.ok, true);
		if (!secondResult.ok) return;

		const queued = pendingStageMessagesFor(secondResult.messages, RUN_ID, STAGE_KEY);
		assert.deepEqual(
			queued.map((entry) => ({ id: entry.id, admissionOrder: entry.admissionOrder })),
			[
				{ id: "1", admissionOrder: 1 },
				{ id: "2", admissionOrder: 2 },
			],
		);
		assert.strictEqual(queued[0]?.message, first.message);
		assert.strictEqual(queued[0]?.from, first.from);
		assert.equal(queued[0]?.stageKey, STAGE_KEY);
		assert.equal(queued[0]?.queuedAt, first.queuedAt);
		assert.deepEqual(queued[0]?.message.content.attachments, first.message.content.attachments);
	});

	test("deduplicates a logical message id as a no-op success", () => {
		const first = queueStageMessage([], pendingMessage("same"), RUN_GROUP, RUN_GROUP);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		const duplicate = queueStageMessage(
			first.messages,
			pendingMessage("same", { queuedAt: "later" }),
			RUN_GROUP,
			RUN_GROUP,
		);
		assert.equal(duplicate.ok, true);
		if (!duplicate.ok) return;
		assert.equal(duplicate.deduplicated, true);
		assert.strictEqual(duplicate.messages, first.messages);
		assert.strictEqual(duplicate.entry, first.entry);
		assert.equal(duplicate.entry.queuedAt, first.entry.queuedAt);
	});

	test("deduplicates a durable retry across volatile sender presence changes", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		const original = pendingMessage("presence", {
			senderReturnAddress: "host-session-planner",
			from: {
				id: "stable-sender-id",
				name: "planner",
				group: RUN_GROUP,
				cwd: "/repo/first",
				model: "model-a",
				pid: 10,
				startedAt: 11,
				lastActivity: 12,
				status: "idle",
			} as PendingStageMessageInput["from"],
		});
		const writer = createStore();
		writer.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		assert.equal((await writer.queueStageMessage(original, RUN_GROUP, RUN_GROUP, backend))?.ok, true);

		const retry = pendingMessage("presence", {
			from: {
				id: "reconnected-broker-sender-id",
				name: "renamed-planner",
				group: "presence-display-group",
				cwd: "/repo/second",
				model: "model-b",
				pid: 20,
				startedAt: 21,
				lastActivity: 22,
				status: "working",
			} as PendingStageMessageInput["from"],
			queuedAt: "later transport attempt",
			senderReturnAddress: "host-session-planner",
		});
		const restoredQueued = createStore();
		restoredQueued.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [],
			pendingStageMessages: [...(backend.getWorkflow(RUN_ID)?.pendingStageMessages ?? [])],
			startedAt: 1,
		});
		const queuedRetry = await restoredQueued.queueStageMessage(retry, RUN_GROUP, RUN_GROUP, backend);
		assert.equal(queuedRetry?.ok, true);
		if (queuedRetry?.ok !== true) return;
		assert.equal(queuedRetry.deduplicated, true);
		assert.equal(queuedRetry.entry.status, "queued");
		assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.length, 1);

		assert.equal(
			await restoredQueued.markPendingStageMessageDelivered(RUN_ID, STAGE_KEY, "presence", "delivered", backend),
			true,
		);
		const restoredDelivered = createStore();
		restoredDelivered.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [],
			pendingStageMessages: [...(backend.getWorkflow(RUN_ID)?.pendingStageMessages ?? [])],
			startedAt: 1,
		});
		const deliveredRetry = await restoredDelivered.queueStageMessage(retry, RUN_GROUP, RUN_GROUP, backend);
		assert.equal(deliveredRetry?.ok, true);
		if (deliveredRetry?.ok !== true) return;
		assert.equal(deliveredRetry.deduplicated, true);
		assert.equal(deliveredRetry.entry.status, "delivered");

		const senderConflict = await restoredDelivered.queueStageMessage(
			{
				...retry,
				from: { ...retry.from, id: "different-sender-id" },
				senderReturnAddress: "different-host-session",
			},
			RUN_GROUP,
			RUN_GROUP,
			backend,
		);
		assert.equal(senderConflict?.ok, false);
		if (senderConflict?.ok === false) assert.equal(senderConflict.reason, "message_id_conflict");
	});

	test("deduplicates a reconstructed durable retry with a regenerated timestamp", async () => {
		const sdk = createMockSdk();
		const writerBackend = new DbosDurableBackend(sdk, { executorId: "timestamp-retry-writer" });
		writerBackend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await writerBackend.flush();
		const writerStore = createStore();
		writerStore.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const original = pendingMessage("timestamp-retry", {
			message: {
				...message("timestamp-retry", "same logical send"),
				timestamp: 100,
				replyTo: "question-1",
				expectsReply: true,
				replyError: "same reply error",
				source: { subagentRunId: "subagent-run-1", subagentAgent: "reviewer", subagentIndex: 1 },
			},
		});
		const admitted = await writerStore.queueStageMessage(original, RUN_GROUP, RUN_GROUP, writerBackend);
		assert.equal(admitted?.ok, true);
		if (admitted?.ok !== true) return;

		const retryBackend = new DbosDurableBackend(sdk, { executorId: "timestamp-retry-reader" });
		await retryBackend.hydrateWorkflow(RUN_ID);
		const durableBeforeRetry = retryBackend.getWorkflow(RUN_ID)?.pendingStageMessages ?? [];
		const retryStore = createStore();
		retryStore.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [],
			pendingStageMessages: [...durableBeforeRetry],
			startedAt: 1,
		});
		let invalidations = 0;
		retryStore.subscribeInvalidation(() => invalidations++);
		const retry = await retryStore.queueStageMessage(
			{
				...original,
				message: { ...original.message, timestamp: 200 },
				queuedAt: "regenerated transport attempt",
			},
			RUN_GROUP,
			RUN_GROUP,
			retryBackend,
		);
		assert.equal(retry?.ok, true);
		if (retry?.ok !== true) return;
		assert.equal(retry.deduplicated, true);
		assert.equal(retry.entry.status, "queued");
		assert.equal(retry.position, 1);
		assert.equal(retry.entry.message.timestamp, 100);
		assert.equal(retry.entry.stageKey, STAGE_KEY);
		assert.equal(retry.entry.admissionOrder, 1);
		assert.equal(invalidations, 0);
		assert.strictEqual(retry.messages, retryStore.runs()[0]?.pendingStageMessages);
		assert.deepEqual(retry.messages, durableBeforeRetry);
		assert.deepEqual(retryBackend.getWorkflow(RUN_ID)?.pendingStageMessages, durableBeforeRetry);
		assert.deepEqual(
			retryStore.pendingStageMessagesFor(RUN_ID, STAGE_KEY).map(({ id }) => id),
			["timestamp-retry"],
		);

		assert.equal(
			await retryStore.markPendingStageMessageDelivered(
				RUN_ID,
				STAGE_KEY,
				"timestamp-retry",
				"2026-08-27T12:00:00.000Z",
				retryBackend,
			),
			true,
		);
		const deliveredBackend = new DbosDurableBackend(sdk, { executorId: "timestamp-retry-delivered-reader" });
		await deliveredBackend.hydrateWorkflow(RUN_ID);
		const deliveredBeforeRetry = deliveredBackend.getWorkflow(RUN_ID)?.pendingStageMessages ?? [];
		const deliveredStore = createStore();
		deliveredStore.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [],
			pendingStageMessages: [...deliveredBeforeRetry],
			startedAt: 1,
		});
		const deliveredRetry = await deliveredStore.queueStageMessage(
			{ ...original, message: { ...original.message, timestamp: 300 } },
			RUN_GROUP,
			RUN_GROUP,
			deliveredBackend,
		);
		assert.equal(deliveredRetry?.ok, true);
		if (deliveredRetry?.ok !== true) return;
		assert.equal(deliveredRetry.deduplicated, true);
		assert.equal(deliveredRetry.entry.status, "delivered");
		assert.equal(deliveredRetry.position, undefined);
		assert.equal(deliveredRetry.entry.message.timestamp, 100);
		assert.equal(deliveredRetry.entry.stageKey, STAGE_KEY);
		assert.equal(deliveredRetry.entry.admissionOrder, 1);
		assert.deepEqual(deliveredRetry.messages, deliveredBeforeRetry);
		assert.deepEqual(deliveredBackend.getWorkflow(RUN_ID)?.pendingStageMessages, deliveredBeforeRetry);
		assert.equal(deliveredStore.pendingStageMessagesFor(RUN_ID, STAGE_KEY).length, 0);
		assert.equal(deliveredRetry.messages.length, 1);
	});

	test("canonicalizes omitted message defaults across durable queued and delivered retries", async () => {
		const sdk = createMockSdk();
		const writerBackend = new DbosDurableBackend(sdk, { executorId: "optional-defaults-writer" });
		writerBackend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await writerBackend.flush();
		const writerStore = createStore();
		writerStore.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const omitted = pendingMessage("defaults-omitted", {
			message: {
				id: "defaults-omitted",
				timestamp: 100,
				replyTo: "question-1",
				replyError: "same reply error",
				source: { subagentRunId: "subagent-run-1", subagentAgent: "reviewer", subagentIndex: 1 },
				content: { text: "omitted then explicit" },
			},
			queuedAt: "2026-08-27T12:00:00.000Z",
		});
		const explicit = pendingMessage("defaults-explicit", {
			message: {
				id: "defaults-explicit",
				timestamp: 101,
				replyTo: "question-2",
				expectsReply: false,
				replyError: "same reply error",
				source: { subagentRunId: "subagent-run-2", subagentAgent: "reviewer", subagentIndex: 2 },
				content: { text: "explicit then omitted", attachments: [] },
			},
			queuedAt: "2026-08-27T12:00:01.000Z",
		});
		assert.equal((await writerStore.queueStageMessage(omitted, RUN_GROUP, RUN_GROUP, writerBackend))?.ok, true);
		assert.equal((await writerStore.queueStageMessage(explicit, RUN_GROUP, RUN_GROUP, writerBackend))?.ok, true);

		const retryInputs: readonly PendingStageMessageInput[] = [
			{
				...omitted,
				message: {
					...omitted.message,
					timestamp: 200,
					expectsReply: false,
					content: { ...omitted.message.content, attachments: [] },
				},
				queuedAt: "regenerated omitted transport attempt",
			},
			{
				...explicit,
				message: {
					id: explicit.message.id,
					timestamp: 201,
					replyTo: explicit.message.replyTo,
					replyError: explicit.message.replyError,
					source: explicit.message.source,
					content: { text: explicit.message.content.text },
				},
				queuedAt: "regenerated explicit transport attempt",
			},
		];
		const queuedBackend = new DbosDurableBackend(sdk, { executorId: "optional-defaults-queued-reader" });
		await queuedBackend.hydrateWorkflow(RUN_ID);
		const queuedBeforeRetry = queuedBackend.getWorkflow(RUN_ID)?.pendingStageMessages ?? [];
		const queuedStore = createStore();
		queuedStore.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [],
			pendingStageMessages: [...queuedBeforeRetry],
			startedAt: 1,
		});
		let invalidations = 0;
		queuedStore.subscribeInvalidation(() => invalidations++);
		for (const [index, retryInput] of retryInputs.entries()) {
			const retry = await queuedStore.queueStageMessage(retryInput, RUN_GROUP, RUN_GROUP, queuedBackend);
			assert.equal(retry?.ok, true);
			if (retry?.ok !== true) continue;
			assert.equal(retry.deduplicated, true);
			assert.equal(retry.entry.status, "queued");
			assert.equal(retry.position, index + 1);
			assert.deepEqual(retry.entry, queuedBeforeRetry[index]);
		}
		const changedDefaults: readonly PendingStageMessageInput[] = [
			{
				...retryInputs[0]!,
				message: { ...retryInputs[0]!.message, expectsReply: true },
			},
			{
				...retryInputs[0]!,
				message: {
					...retryInputs[0]!.message,
					content: {
						...retryInputs[0]!.message.content,
						attachments: [{ type: "snippet", name: "new.md", content: "not the empty default", language: "md" }],
					},
				},
			},
		];
		for (const changedDefault of changedDefaults) {
			const conflict = await queuedStore.queueStageMessage(changedDefault, RUN_GROUP, RUN_GROUP, queuedBackend);
			assert.equal(conflict?.ok, false);
			if (conflict?.ok === false) assert.equal(conflict.reason, "message_id_conflict");
		}
		assert.equal(invalidations, 0);
		assert.equal(queuedStore.pendingStageMessagesFor(RUN_ID, STAGE_KEY).length, 2);
		assert.deepEqual(queuedBackend.getWorkflow(RUN_ID)?.pendingStageMessages, queuedBeforeRetry);
		assert.equal(Object.hasOwn(queuedBeforeRetry[0]?.message ?? {}, "expectsReply"), false);
		assert.equal(Object.hasOwn(queuedBeforeRetry[0]?.message.content ?? {}, "attachments"), false);
		assert.equal(queuedBeforeRetry[0]?.message.timestamp, 100);
		assert.equal(queuedBeforeRetry[0]?.queuedAt, "2026-08-27T12:00:00.000Z");
		assert.equal(queuedBeforeRetry[0]?.admissionOrder, 1);
		assert.equal(queuedBeforeRetry[1]?.message.expectsReply, false);
		assert.deepEqual(queuedBeforeRetry[1]?.message.content.attachments, []);
		assert.equal(queuedBeforeRetry[1]?.admissionOrder, 2);

		for (const retryInput of retryInputs) {
			assert.equal(
				await queuedStore.markPendingStageMessageDelivered(
					RUN_ID,
					STAGE_KEY,
					retryInput.message.id,
					"2026-08-27T13:00:00.000Z",
					queuedBackend,
				),
				true,
			);
		}
		const deliveredBackend = new DbosDurableBackend(sdk, { executorId: "optional-defaults-delivered-reader" });
		await deliveredBackend.hydrateWorkflow(RUN_ID);
		const deliveredBeforeRetry = deliveredBackend.getWorkflow(RUN_ID)?.pendingStageMessages ?? [];
		const deliveredStore = createStore();
		deliveredStore.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [],
			pendingStageMessages: [...deliveredBeforeRetry],
			startedAt: 1,
		});
		for (const [index, retryInput] of retryInputs.entries()) {
			const retry = await deliveredStore.queueStageMessage(retryInput, RUN_GROUP, RUN_GROUP, deliveredBackend);
			assert.equal(retry?.ok, true);
			if (retry?.ok !== true) continue;
			assert.equal(retry.deduplicated, true);
			assert.equal(retry.entry.status, "delivered");
			assert.equal(retry.position, undefined);
			assert.deepEqual(retry.entry, deliveredBeforeRetry[index]);
		}
		assert.equal(deliveredStore.pendingStageMessagesFor(RUN_ID, STAGE_KEY).length, 0);
		assert.deepEqual(deliveredBackend.getWorkflow(RUN_ID)?.pendingStageMessages, deliveredBeforeRetry);
		assert.equal(deliveredBeforeRetry.length, 2);
		assert.equal(Object.hasOwn(deliveredBeforeRetry[0]?.message ?? {}, "expectsReply"), false);
		assert.equal(Object.hasOwn(deliveredBeforeRetry[0]?.message.content ?? {}, "attachments"), false);
		assert.equal(deliveredBeforeRetry[0]?.message.timestamp, 100);
		assert.deepEqual(deliveredBeforeRetry[0]?.message.source, omitted.message.source);
	});

	test("a delivered retry is a terminal no-op without an active queue position", () => {
		const accepted = queueStageMessage([], pendingMessage("delivered"), RUN_GROUP, RUN_GROUP);
		assert.equal(accepted.ok, true);
		if (!accepted.ok) return;
		const delivered = markPendingStageMessageDelivered(
			accepted.messages,
			RUN_ID,
			STAGE_KEY,
			"delivered",
			"2026-08-27T12:00:00.000Z",
		);
		const retry = queueStageMessage(delivered, pendingMessage("delivered"), RUN_GROUP, RUN_GROUP);
		assert.equal(retry.ok, true);
		if (!retry.ok) return;
		assert.equal(retry.deduplicated, true);
		assert.equal(retry.entry.status, "delivered");
		assert.equal(retry.position, undefined);
		assert.strictEqual(retry.messages, delivered);
	});

	test("rejects stable sender, canonical target, and exact payload message-id conflicts", () => {
		const original = pendingMessage("same", {
			message: {
				...message("same"),
				content: {
					text: "message same",
					attachments: [
						{ type: "snippet", name: "contract.md", content: "literal amendment", language: "md" },
						{ type: "context", name: "context.txt", content: "ordered context", language: "txt" },
					],
				},
				replyTo: "question-1",
				expectsReply: false,
				replyError: "original error",
				source: { subagentRunId: "subagent-run-1", subagentAgent: "reviewer", subagentIndex: 1 },
			},
		});
		const first = queueStageMessage([], original, RUN_GROUP, RUN_GROUP);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		const changedMessages: PendingStageMessageInput["message"][] = [
			{ ...original.message, content: { ...original.message.content, text: "different payload" } },
			{
				...original.message,
				content: {
					...original.message.content,
					attachments: [
						{ type: "snippet", name: "contract.md", content: "changed", language: "md" },
						{ type: "context", name: "context.txt", content: "ordered context", language: "txt" },
					],
				},
			},
			{
				...original.message,
				content: {
					...original.message.content,
					attachments: [...(original.message.content.attachments ?? [])].reverse(),
				},
			},
			{ ...original.message, replyTo: "question-2" },
			{ ...original.message, expectsReply: true },
			{ ...original.message, replyError: "changed error" },
			{ ...original.message, source: { ...original.message.source!, subagentRunId: "subagent-run-2" } },
		];
		for (const changedMessage of changedMessages) {
			const conflict = queueStageMessage(
				first.messages,
				pendingMessage("same", { message: changedMessage }),
				RUN_GROUP,
				RUN_GROUP,
			);
			assert.equal(conflict.ok, false);
			if (!conflict.ok) assert.equal(conflict.reason, "message_id_conflict");
		}

		const senderConflict = queueStageMessage(
			first.messages,
			pendingMessage("same", { message: original.message, from: { ...original.from, id: "sender-2" } }),
			RUN_GROUP,
			RUN_GROUP,
		);
		assert.equal(senderConflict.ok, false);
		if (!senderConflict.ok) assert.equal(senderConflict.reason, "message_id_conflict");

		const canonical = { id: "stage-id", replayKey: "stage:original", aliases: [STAGE_KEY, "stage-id"] };
		const canonicalFirst = queueStageMessage([], original, RUN_GROUP, RUN_GROUP, canonical);
		assert.equal(canonicalFirst.ok, true);
		if (!canonicalFirst.ok) return;
		const targetConflict = queueStageMessage(canonicalFirst.messages, original, RUN_GROUP, RUN_GROUP, {
			...canonical,
			replayKey: "stage:replacement",
		});
		assert.equal(targetConflict.ok, false);
		if (!targetConflict.ok) assert.equal(targetConflict.reason, "message_id_conflict");
		assert.equal(first.messages.length, 1);
	});

	test("enforces the exact queued cap and delivered entries free capacity", () => {
		let messages: readonly PendingStageMessage[] = [];
		for (let index = 1; index <= PENDING_STAGE_MESSAGE_LIMIT; index++) {
			const result = queueStageMessage(messages, pendingMessage(String(index)), RUN_GROUP, RUN_GROUP);
			assert.equal(result.ok, true, `queue ${index}`);
			if (!result.ok) return;
			messages = result.messages;
		}
		assert.equal(queuedPendingStageMessageCount(messages, RUN_ID, STAGE_KEY), 50);
		const refused = queueStageMessage(messages, pendingMessage("51"), RUN_GROUP, RUN_GROUP);
		assert.deepEqual(refused, {
			ok: false,
			reason: "capacity",
			limit: PENDING_STAGE_MESSAGE_LIMIT,
			runId: RUN_ID,
			stageKey: STAGE_KEY,
		});

		messages = markPendingStageMessageDelivered(messages, RUN_ID, STAGE_KEY, "1", "2026-08-26T01:00:00.000Z");
		assert.equal(queuedPendingStageMessageCount(messages, RUN_ID, STAGE_KEY), 49);
		const afterDelivery = queueStageMessage(messages, pendingMessage("51"), RUN_GROUP, RUN_GROUP);
		assert.equal(afterDelivery.ok, true);
		if (!afterDelivery.ok) return;
		assert.equal(queuedPendingStageMessageCount(afterDelivery.messages, RUN_ID, STAGE_KEY), 50);
	});

	test("rejects a sending session outside the run group", () => {
		const result = queueStageMessage([], pendingMessage("isolated"), "other", RUN_GROUP);
		assert.deepEqual(result, {
			ok: false,
			reason: "group_mismatch",
			runId: RUN_ID,
			stageKey: STAGE_KEY,
		});
	});

	test("shares identity, dedupe, positions, and the exact cap across a stage id and unique name", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [{ id: "review-stage-id", name: "reviewer", status: "pending", parentIds: [], toolEvents: [] }],
			startedAt: 1,
		});
		for (let index = 1; index <= PENDING_STAGE_MESSAGE_LIMIT; index++) {
			const stageKey = index % 2 === 0 ? "review-stage-id" : "reviewer";
			const accepted = await store.queueStageMessage(
				pendingMessage(String(index), { stageKey }),
				RUN_GROUP,
				RUN_GROUP,
				backend,
			);
			assert.equal(accepted?.ok && accepted.position, index);
		}
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "review-stage-id").length, 50);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 50);
		assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.length, 50);
		assert.deepEqual(
			await store.queueStageMessage(
				pendingMessage("51", { stageKey: "review-stage-id" }),
				RUN_GROUP,
				RUN_GROUP,
				backend,
			),
			{
				ok: false,
				reason: "capacity",
				limit: 50,
				runId: RUN_ID,
				stageKey: "review-stage-id",
			},
		);

		const replay = await store.queueStageMessage(
			pendingMessage("1", { stageKey: "review-stage-id" }),
			RUN_GROUP,
			RUN_GROUP,
			backend,
		);
		assert.equal(replay?.ok && replay.deduplicated, true);
		const conflict = await store.queueStageMessage(
			pendingMessage("1", { stageKey: "review-stage-id", message: message("1", "conflicting alias replay") }),
			RUN_GROUP,
			RUN_GROUP,
			backend,
		);
		assert.equal(conflict?.ok, false);
		if (conflict?.ok === false) assert.equal(conflict.reason, "message_id_conflict");
		assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.length, 50);
		assert.equal(
			await store.markPendingStageMessageDelivered(RUN_ID, "reviewer", "1", "2026-08-27T12:00:00.000Z", backend),
			true,
		);
		const admittedAfterDelivery = await store.queueStageMessage(
			pendingMessage("51", { stageKey: "review-stage-id" }),
			RUN_GROUP,
			RUN_GROUP,
			backend,
		);
		assert.equal(admittedAfterDelivery?.ok && admittedAfterDelivery.position, 50);
		const queuedAliasRetry = await store.queueStageMessage(
			pendingMessage("51", { stageKey: "reviewer" }),
			RUN_GROUP,
			RUN_GROUP,
			backend,
		);
		assert.equal(queuedAliasRetry?.ok && queuedAliasRetry.position, 50);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "review-stage-id").length, 50);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 50);
		assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.length, 51);
	});

	test("live store methods publish only persisted message transitions", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const result = await store.queueStageMessage(pendingMessage("live"), RUN_GROUP, RUN_GROUP, backend);
		assert.equal(result?.ok, true);
		assert.deepEqual(
			store.pendingStageMessagesFor(RUN_ID, STAGE_KEY).map((entry) => entry.id),
			["live"],
		);
		assert.equal(await store.markPendingStageMessageDelivered(RUN_ID, STAGE_KEY, "live", "done", backend), true);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, STAGE_KEY).length, 0);
		assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.status, "delivered");
	});
});

describe("durable workflow stage messages metadata", () => {
	function metadata(pendingStageMessages?: readonly PendingStageMessage[]): DurableWorkflowMetadata {
		return {
			workflowId: RUN_ID,
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

	test("encode and parse restore messages verbatim", () => {
		const accepted = queueStageMessage(
			[],
			pendingMessage("durable", { senderReturnAddress: "host-session-durable" }),
			RUN_GROUP,
			RUN_GROUP,
		);
		assert.equal(accepted.ok, true);
		if (!accepted.ok) return;
		const parsed = parseCurrentMetadataRecord(
			{ stepName: "__atomic_metadata:2:test", output: encodeMetadata(metadata(accepted.messages)) },
			RUN_ID,
		);
		assert.deepEqual(parsed?.pendingStageMessages, accepted.messages);
	});

	test("accepts legacy durable messages without a return address", () => {
		const accepted = queueStageMessage([], pendingMessage("legacy"), RUN_GROUP, RUN_GROUP);
		assert.equal(accepted.ok, true);
		if (!accepted.ok) return;
		const parsed = parseCurrentMetadataRecord(
			{ stepName: "__atomic_metadata:2:test", output: encodeMetadata(metadata(accepted.messages)) },
			RUN_ID,
		);
		assert.equal(parsed?.pendingStageMessages?.[0]?.senderReturnAddress, undefined);
	});

	test("metadata without pending messages hydrates an empty collection", () => {
		const parsed = parseCurrentMetadataRecord(
			{ stepName: "__atomic_metadata:2:test", output: encodeMetadata(metadata()) },
			RUN_ID,
		);
		assert.deepEqual(parsed?.pendingStageMessages, []);
	});

	test("in-memory metadata preserves updates and defaults absent pending message collections", () => {
		const accepted = queueStageMessage([], pendingMessage("memory"), RUN_GROUP, RUN_GROUP);
		assert.equal(accepted.ok, true);
		if (!accepted.ok) return;
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
			pendingStageMessages: accepted.messages,
		});
		assert.deepEqual(backend.toMetadata(RUN_ID)?.pendingStageMessages, accepted.messages);
		backend.registerWorkflow({ workflowId: "empty", name: "empty", inputs: {}, status: "running", createdAt: 1 });
		assert.deepEqual(backend.getWorkflow("empty")?.pendingStageMessages, []);
	});

	test("store lifecycle transitions survive DBOS metadata reload", async () => {
		const sdk = createMockSdk();
		const backend = new DbosDurableBackend(sdk, { executorId: "pending-stage-writer" });
		backend.registerWorkflow({
			workflowId: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		await backend.flush();
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });

		const queued = await store.queueStageMessage(pendingMessage("queued"), RUN_GROUP, RUN_GROUP, backend);
		assert.equal(queued?.ok, true);
		let reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-reader-add" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(
			reloaded.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ id, status }) => ({ id, status })),
			[{ id: "queued", status: "queued" }],
		);

		assert.equal(
			await store.markPendingStageMessageDelivered(RUN_ID, STAGE_KEY, "queued", "2026-08-27T12:00:00.000Z", backend),
			true,
		);
		reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-reader-delivered" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(
			reloaded.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ id, status }) => ({ id, status })),
			[{ id: "queued", status: "delivered" }],
		);

		const refused = await store.queueStageMessage(pendingMessage("refused"), RUN_GROUP, RUN_GROUP, backend);
		assert.equal(refused?.ok, true);
		assert.equal(
			await store.markPendingStageMessageUndeliverable(RUN_ID, STAGE_KEY, "refused", "stage ended", backend),
			true,
		);
		reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-reader-undeliverable" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(
			reloaded.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ id, status }) => ({ id, status })),
			[
				{ id: "queued", status: "delivered" },
				{ id: "refused", status: "undeliverable" },
			],
		);
	});

	test("concurrent queue transitions retain FIFO in live and reloaded metadata", async () => {
		const sdk = createMockSdk();
		const backend = new DbosDurableBackend(sdk, { executorId: "pending-stage-concurrent-writer" });
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await backend.flush();
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });

		const [first, second] = await Promise.all([
			store.queueStageMessage(pendingMessage("1"), RUN_GROUP, RUN_GROUP, backend),
			store.queueStageMessage(pendingMessage("2"), RUN_GROUP, RUN_GROUP, backend),
		]);
		assert.equal(first?.ok && first.position, 1);
		assert.equal(second?.ok && second.position, 2);
		assert.deepEqual(
			store.pendingStageMessagesFor(RUN_ID, STAGE_KEY).map(({ id }) => id),
			["1", "2"],
		);

		const reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-concurrent-reader" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(
			reloaded.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ id }) => id),
			["1", "2"],
		);
	});

	test("DBOS rejection leaves the transition invisible and propagates the error", async () => {
		const sdk = createMockSdk();
		let rejectWrites = false;
		const backend = new DbosDurableBackend(
			{
				...sdk,
				async recordStepOutput(workflowId, stepName, output) {
					if (rejectWrites) throw new Error("pending stage DBOS write rejected");
					await sdk.recordStepOutput(workflowId, stepName, output);
				},
			},
			{ executorId: "pending-stage-rejection-writer" },
		);
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await backend.flush();
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		let notifications = 0;
		store.subscribeInvalidation(() => notifications++);
		rejectWrites = true;

		await assert.rejects(
			store.queueStageMessage(pendingMessage("rejected"), RUN_GROUP, RUN_GROUP, backend),
			/pending stage DBOS write rejected/,
		);
		assert.equal(notifications, 0);
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, STAGE_KEY), []);
		const reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-rejection-reader" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(reloaded.getWorkflow(RUN_ID)?.pendingStageMessages, []);
	});
});
