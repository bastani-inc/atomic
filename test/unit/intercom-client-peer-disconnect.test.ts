import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";

function clientInternals(client: IntercomClient) {
	return client as unknown as {
		_sessionId: string;
		handleBrokerMessage(message: unknown): void;
	};
}

describe("IntercomClient peer_disconnected frames", () => {
	test("emits a validated notice naming the departed peer", () => {
		const client = new IntercomClient();
		const internals = clientInternals(client);
		internals._sessionId = "asker-id";
		let received: object | undefined;
		client.on("peer_disconnected", (notice: object) => {
			received = notice;
		});

		internals.handleBrokerMessage({
			type: "peer_disconnected",
			replyTo: "question-1",
			peerSessionId: "peer-id",
			peerName: "reviewer",
		});

		assert.deepEqual(received, { replyTo: "question-1", peerSessionId: "peer-id", peerName: "reviewer" });
	});

	test("preserves an absent peerName as absent", () => {
		const client = new IntercomClient();
		const internals = clientInternals(client);
		internals._sessionId = "asker-id";
		let received: object | undefined;
		client.on("peer_disconnected", (notice: object) => {
			received = notice;
		});

		internals.handleBrokerMessage({
			type: "peer_disconnected",
			replyTo: "question-1",
			peerSessionId: "peer-id",
		});

		assert.deepEqual(received, { replyTo: "question-1", peerSessionId: "peer-id" });
		assert.equal(Object.hasOwn(received!, "peerName"), false);
	});

	test("rejects malformed peer_disconnected frames", () => {
		const client = new IntercomClient();
		const internals = clientInternals(client);
		internals._sessionId = "asker-id";

		for (const malformed of [
			{ type: "peer_disconnected", peerSessionId: "peer-id" },
			{ type: "peer_disconnected", replyTo: "question-1" },
			{ type: "peer_disconnected", replyTo: "question-1", peerSessionId: "peer-id", peerName: 1 },
		]) {
			assert.throws(() => internals.handleBrokerMessage(malformed), /Invalid peer_disconnected message/);
		}
	});
});
