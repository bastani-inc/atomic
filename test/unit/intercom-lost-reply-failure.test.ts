import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { failLostReply } from "../../packages/intercom/broker/ask-failures.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import type { BrokerConnectedSession } from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, SessionInfo } from "../../packages/intercom/types.js";

const info = (id: string, name?: string): SessionInfo => ({
	id,
	...(name === undefined ? {} : { name }),
	cwd: "/",
	model: "m",
	pid: 1,
	startedAt: 0,
	lastActivity: 0,
});

const question = { senderSessionId: "asker", targetSessionId: "recipient", messageId: "q" };

/** The failure prepared when the recipient ended with its reply on its way (#5095). */
function lostReply(recipient: SessionInfo) {
	const reason = `Session "${recipient.name ?? recipient.id}" ended before replying`;
	return {
		askerSessionId: "asker",
		from: recipient,
		message: { id: "ended:q", timestamp: 1, replyTo: "q", replyError: reason, content: { text: reason } },
	};
}

function fail(
	asker: BrokerConnectedSession | undefined,
	askerReturnAddress: string | undefined,
	recipient: SessionInfo,
) {
	const pending = new PendingQuestionIndex();
	const writes: BrokerMessage[] = [];
	failLostReply({
		question,
		held: lostReply(recipient),
		askerReturnAddress,
		asker,
		pending,
		write: (_socket, frame) => writes.push(frame),
	});
	return { writes, held: (address: string) => pending.heldForAsker(address).map((held) => held.message.id) };
}

test("a lost reply fails its connected asker's ask with a failure it saves, held until it does (#5095)", () => {
	const asker: BrokerConnectedSession = {
		socket: {} as net.Socket,
		info: info("asker"),
		acknowledgesReceipt: true,
		registrationReturnAddress: "asker-address",
	};
	const { writes, held } = fail(asker, "asker-address", info("recipient", "rec"));
	assert.deepEqual(
		writes.map((frame) =>
			frame.type === "message" ? [frame.type, frame.message.id, frame.message.replyError] : [frame.type],
		),
		[["message", "ended:q", 'Session "rec" ended before replying']],
	);
	assert.deepEqual(held("asker-address"), ["ended:q"]);
});

test("a lost reply tells a connected asker that does not confirm saves its recipient left, by name (#5095)", () => {
	const asker: BrokerConnectedSession = { socket: {} as net.Socket, info: info("asker") };
	assert.deepEqual(fail(asker, undefined, info("recipient", "rec")).writes, [
		{ type: "peer_disconnected", replyTo: "q", peerSessionId: "recipient", peerName: "rec" },
	]);
	assert.deepEqual(fail(asker, undefined, info("recipient")).writes, [
		{ type: "peer_disconnected", replyTo: "q", peerSessionId: "recipient" },
	]);
});

test("a lost reply fails an away asker's ask once it is back, when it can prove itself (#5095)", () => {
	const away = fail(undefined, "asker-address", info("recipient"));
	assert.deepEqual(away.writes, []);
	assert.deepEqual(away.held("asker-address"), ["ended:q"]);
	for (const unproven of [undefined, ""]) {
		const nobody = fail(undefined, unproven, info("recipient"));
		assert.deepEqual(nobody.writes, []);
		assert.deepEqual(nobody.held(""), []);
	}
});
