import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test, vi } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";

function connectedClient() {
	const client = new IntercomClient();
	const frames: Array<Record<string, unknown> & { requestId: string }> = [];
	const socket = new Socket();
	vi.spyOn(socket, "write").mockImplementation((data) => {
		assert.ok(Buffer.isBuffer(data));
		frames.push(JSON.parse(data.subarray(4).toString("utf8")));
		return true;
	});
	client["socket"] = socket;
	client["_sessionId"] = "supervisor";
	const receive = (message: BrokerMessage) => client["handleBrokerMessage"](message);
	return { client, frames, receive };
}

test.each([
	[undefined, true],
	[true, true],
	[false, false],
] as const)(
	"a reservation acknowledged with published %s is reserved, published %s (#5352)",
	async (published, expected) => {
		const { client, frames, receive } = connectedClient();
		const reserved = client.reserveRestoringRecipient("capability-1", { group: "crew" });
		assert.equal(frames[0]?.type, "reserve_restoring_recipient");
		receive({
			type: "restoring_recipient_ack",
			requestId: frames[0]!.requestId,
			...(published === undefined ? {} : { published }),
		});
		assert.deepEqual(await reserved, { published: expected });
	},
);
