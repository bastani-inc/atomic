import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSessionAsyncDeliveryHandler } from "../../packages/coding-agent/src/core/async/session-manager.js";
import type { AsyncJobDeliveryMessage } from "../../packages/coding-agent/src/core/async/types.js";

const message: AsyncJobDeliveryMessage = {
	customType: "async-job-result",
	content: "finished",
	display: true,
	details: { jobId: "job-1", type: "bash", status: "completed", command: "echo done", exitCode: 0 },
};

test("async completion received during streaming is admitted immediately as a queued follow-up", async () => {
	const calls: Array<{ message: AsyncJobDeliveryMessage; options: object | undefined }> = [];
	const session = {
		isStreaming: true,
		async sendCustomMessage(delivery: AsyncJobDeliveryMessage, options?: object) {
			calls.push({ message: delivery, options });
		},
	};

	await createSessionAsyncDeliveryHandler(session)(message);

	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.message, message);
	assert.deepEqual(calls[0]?.options, {
		deliverAs: "followUp",
		triggerTurn: true,
		stageAdmissionKey: "async-job:job-1",
	});
});
