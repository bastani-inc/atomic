import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	PENDING_STAGE_MESSAGE_LIMIT,
	PENDING_STAGE_RUN_MESSAGE_BYTES,
	PENDING_STAGE_RUN_MESSAGE_LIMIT,
	pendingStageQueueRefusal,
	queueStageMessage,
	queueStickyStageMessage,
} from "../../packages/workflows/src/shared/pending-stage-delivery.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";

const ROOT_RUN_ID = testRunId("run-cap-root");
const GROUP = `workflow:${ROOT_RUN_ID}`;
const from = { id: "flooder", name: "flooder", group: GROUP };

function sticky(id: string, targetPath: string, text = `message ${id}`) {
	return {
		runId: ROOT_RUN_ID,
		stageKey: targetPath,
		targetPath,
		from,
		message: { id, timestamp: 1, content: { text } },
		queuedAt: "2026-11-15T00:00:00.000Z",
	};
}

function exact(id: string, stageKey: string, text = `message ${id}`) {
	return {
		runId: ROOT_RUN_ID,
		stageKey,
		from,
		message: { id, timestamp: 1, content: { text } },
		queuedAt: "2026-11-15T00:00:00.000Z",
	};
}

function queuedBytes(messages: readonly PendingStageMessage[]): number {
	return messages.reduce((total, entry) => total + Buffer.byteLength(entry.message.content.text, "utf8"), 0);
}

describe("run-wide pending stage message cap (#4896)", () => {
	test("flooding workflow:<root>/future-<i> stops at the run-wide count cap with bounded memory (#4896)", () => {
		let messages: readonly PendingStageMessage[] = [];
		let refusedAt: number | undefined;
		for (let index = 0; index < PENDING_STAGE_RUN_MESSAGE_LIMIT + 200; index += 1) {
			const result = queueStickyStageMessage(
				messages,
				sticky(`m-${index}`, `${GROUP}/future-${index}`),
				GROUP,
				GROUP,
			);
			if (!result.ok) {
				refusedAt ??= index;
				assert.equal(result.reason, "run_capacity");
				continue;
			}
			messages = result.messages;
		}
		assert.equal(refusedAt, PENDING_STAGE_RUN_MESSAGE_LIMIT);
		assert.equal(messages.length, PENDING_STAGE_RUN_MESSAGE_LIMIT);

		// Exact sends to a materialized stage share the run's budget, and a same-id retry still deduplicates.
		const exactSend = queueStageMessage(messages, exact("exact-1", "reviewer"), GROUP, GROUP);
		assert.equal(exactSend.ok, false);
		const retry = queueStickyStageMessage(messages, sticky("m-0", `${GROUP}/future-0`), GROUP, GROUP);
		assert.equal(retry.ok && retry.deduplicated, true);

		// Settled entries no longer count against the cap.
		const settled = messages.map((entry, index) =>
			index === 0 ? { ...entry, status: "delivered" as const, deliveredAt: "2026-11-15T00:00:01.000Z" } : entry,
		);
		assert.equal(queueStickyStageMessage(settled, sticky("after", `${GROUP}/future-x`), GROUP, GROUP).ok, true);
	});

	test("the run-wide byte cap refuses a send that would exceed it, with a clear reason (#4896)", () => {
		const big = "x".repeat(4 * 1024 * 1024 - 1);
		let messages: readonly PendingStageMessage[] = [];
		let refusal: ReturnType<typeof queueStickyStageMessage> | undefined;
		for (let index = 0; index < 64; index += 1) {
			const result = queueStickyStageMessage(
				messages,
				sticky(`b-${index}`, `${GROUP}/future-${index}`, big),
				GROUP,
				GROUP,
			);
			if (!result.ok) {
				refusal = result;
				break;
			}
			messages = result.messages;
		}
		assert.ok(queuedBytes(messages) <= PENDING_STAGE_RUN_MESSAGE_BYTES);
		assert.ok(queuedBytes(messages) + big.length > PENDING_STAGE_RUN_MESSAGE_BYTES);
		assert.ok(refusal !== undefined && !refusal.ok);
		assert.equal(
			pendingStageQueueRefusal(refusal, `${GROUP}/future-next`),
			`Workflow run ${ROOT_RUN_ID} already holds the most queued stage messages it accepts (${PENDING_STAGE_RUN_MESSAGE_LIMIT} messages or 64 MiB); the message to ${GROUP}/future-next was not queued. Wait for queued messages to be delivered, or send to a running stage.`,
		);
		// A small message still fits until the byte budget is used up.
		assert.equal(queueStickyStageMessage(messages, sticky("small", `${GROUP}/future-small`), GROUP, GROUP).ok, true);
	});

	test("the per-target cap is unchanged and reported as before (#4896)", () => {
		let messages: readonly PendingStageMessage[] = [];
		for (let index = 0; index < PENDING_STAGE_MESSAGE_LIMIT; index += 1) {
			const result = queueStickyStageMessage(messages, sticky(`t-${index}`, `${GROUP}/same`), GROUP, GROUP);
			assert.equal(result.ok, true);
			if (result.ok) messages = result.messages;
		}
		const full = queueStickyStageMessage(messages, sticky("over", `${GROUP}/same`), GROUP, GROUP);
		assert.ok(!full.ok);
		assert.equal(
			pendingStageQueueRefusal(full, `${GROUP}/same`),
			`Pending stage message queue is full (limit ${PENDING_STAGE_MESSAGE_LIMIT}) for ${GROUP}/same`,
		);
	});

	test("attachment names, languages and contents count toward the run-wide byte cap (#4896)", () => {
		const half = PENDING_STAGE_RUN_MESSAGE_BYTES / 2;
		const withAttachment = (id: string, content: string, language?: string) => ({
			...sticky(id, `${GROUP}/future-${id}`, "t"),
			message: {
				id,
				timestamp: 1,
				content: {
					text: "t",
					attachments: [
						{ type: "file" as const, name: "n", content, ...(language === undefined ? {} : { language }) },
					],
				},
			},
		});
		const first = queueStickyStageMessage([], withAttachment("a", "x".repeat(half - 2)), GROUP, GROUP);
		assert.ok(first.ok);
		// 1 + 1 + (half - 4) + 2 bytes fills the cap exactly.
		const fits = queueStickyStageMessage(
			first.messages,
			withAttachment("b", "y".repeat(half - 4), "ts"),
			GROUP,
			GROUP,
		);
		assert.ok(fits.ok);
		const tooLong = queueStickyStageMessage(
			first.messages,
			withAttachment("c", "y".repeat(half - 4), "tsx"),
			GROUP,
			GROUP,
		);
		assert.equal(tooLong.ok, false);
		assert.equal(
			queueStickyStageMessage(fits.messages, sticky("d", `${GROUP}/future-d`, "z"), GROUP, GROUP).ok,
			false,
		);
	});
});
