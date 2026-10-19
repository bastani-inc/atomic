import assert from "node:assert/strict";
import { Socket } from "node:net";
import { afterEach, test, vi } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";

afterEach(() => {
	vi.useRealTimers();
});

function connectedClient() {
	const client = new IntercomClient();
	const frames: Array<Record<string, unknown> & { attemptId: string }> = [];
	const socket = new Socket();
	vi.spyOn(socket, "write").mockImplementation((data) => {
		assert.ok(Buffer.isBuffer(data));
		frames.push(JSON.parse(data.subarray(4).toString("utf8")));
		return true;
	});
	client["socket"] = socket;
	client["_sessionId"] = "sender";
	const receive = (message: BrokerMessage) => client["handleBrokerMessage"](message);
	return { client, frames, receive };
}

test("a send the broker holds for a subagent being restored waits past the ordinary acknowledgement timeout (#3760)", async () => {
	vi.useFakeTimers();
	const { client, frames, receive } = connectedClient();
	let settled = false;
	const sent = client.send("subagent-worker-run1-1", { text: "continue", messageId: "held-1" }).finally(() => {
		settled = true;
	});
	assert.equal(frames[0]?.awaitRestoringRecipient, true, "the sender tells the broker it can wait for a held send");

	receive({ type: "send_held", messageId: "held-1", attemptId: frames[0]!.attemptId, timeoutMs: 20_000 });
	await vi.advanceTimersByTimeAsync(15_000);
	assert.equal(settled, false, "a held send must not fail with the ordinary 10 second send timeout");

	receive({ type: "delivered", messageId: "held-1", attemptId: frames[0]!.attemptId });
	assert.deepEqual(await sent, { id: "held-1", delivered: true });
});

test("a held send still times out when the broker never answers it (#3760)", async () => {
	vi.useFakeTimers();
	const { client, frames, receive } = connectedClient();
	const sent = client.send("subagent-worker-run1-1", { text: "continue", messageId: "held-2" });
	const outcome = sent.then(
		() => "resolved",
		(error: Error) => error.message,
	);
	receive({ type: "send_held", messageId: "held-2", attemptId: frames[0]!.attemptId, timeoutMs: 20_000 });
	await vi.advanceTimersByTimeAsync(60_000);
	assert.equal(await outcome, "Send timeout");
});
