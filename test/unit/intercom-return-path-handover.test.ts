import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	RETURN_PATH_MESSAGE_LIMIT,
	ReturnPaths,
	returnPathClosedReason,
} from "../../packages/intercom/broker/return-paths.js";
import {
	type BrokerConnectedSession,
	createReturnPathAuthority,
	handleBrokerSend,
} from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import { createReachPolicy, type IntercomReachPolicy } from "../../packages/intercom/reach-policy.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";

function session(id: string, group: string, reach?: IntercomReachPolicy): BrokerConnectedSession {
	return {
		socket: { id } as unknown as net.Socket,
		info: {
			id,
			name: id,
			group,
			groups: [group],
			cwd: "/repo",
			model: "test",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
		},
		registrationGroup: group,
		registrationReturnAddress: `host:${id}`,
		...(reach === undefined ? {} : { reach }),
	};
}

/**
 * A broker's send path whose writes to `held` complete only when the test says so, as a socket write whose callback the
 * broker has not run yet. Every other write completes at once.
 */
function brokerHoldingWritesTo(held: string, ...members: BrokerConnectedSession[]) {
	const sessions = new Map(members.map((member) => [member.info.id, member]));
	const authority = createReturnPathAuthority(new ReturnPaths(), sessions);
	const delivered = new DeliveredMessageCache();
	const pending = new PendingQuestionIndex();
	const supervisor = new SupervisorChannelCache();
	const pendingWrites: Array<() => void> = [];
	const send = (from: string, to: string, id: string): BrokerMessage | undefined => {
		const sender = sessions.get(from)!;
		let outcome: BrokerMessage | undefined;
		handleBrokerSend(
			sender.socket,
			{ type: "send", to, message: { id, timestamp: 1, content: { text: id } } },
			from,
			sessions,
			delivered,
			(socket, frame) => {
				if (socket === sender.socket) outcome = frame;
				return true;
			},
			supervisor,
			pending,
			(socket, _frame, done) => {
				if (socket === sessions.get(held)?.socket) pendingWrites.push(() => done(true));
				else done(true);
			},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			authority,
		);
		return outcome;
	};
	return {
		send,
		/** The broker runs the callbacks of the writes it made to `held`. */
		completeWrites: () => {
			for (const complete of pendingWrites.splice(0)) complete();
		},
	};
}

test("an answer the broker reads before a newer message's delivery completes counts toward that message's budget", () => {
	const broker = brokerHoldingWritesTo(
		"stage",
		session("launcher", "launch", createReachPolicy("launch", ["stages"])),
		session("stage", "stages"),
	);
	broker.send("launcher", "stage", "first-note");
	broker.completeWrites();
	// The second note is handed to the stage, which reads it and answers before the broker runs the write's callback.
	broker.send("launcher", "stage", "second-note");
	assert.equal(broker.send("stage", "launcher", "answer-1")?.type, "delivered");
	broker.completeWrites();

	for (let index = 2; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `answer-${index}`)?.type, "delivered");
	const over = broker.send("stage", "launcher", "answer-over");
	assert.deepEqual(over?.type === "delivery_failed" ? [over.type, over.reason] : [over?.type], [
		"delivery_failed",
		returnPathClosedReason("launcher"),
	]);
});

test("answers counted before a newer message was handed over stay with the older message's budget", () => {
	const broker = brokerHoldingWritesTo(
		"stage",
		session("launcher", "launch", createReachPolicy("launch", ["stages"])),
		session("stage", "stages"),
	);
	broker.send("launcher", "stage", "first-note");
	broker.completeWrites();
	assert.equal(broker.send("stage", "launcher", "answer-to-first")?.type, "delivered");
	broker.send("launcher", "stage", "second-note");
	broker.completeWrites();

	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `answer-${index}`)?.type, "delivered");
	assert.equal(broker.send("stage", "launcher", "answer-over")?.type, "delivery_failed");
});
