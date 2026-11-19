import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { ReturnPaths } from "../../packages/intercom/broker/return-paths.js";
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

/** A broker's send path over these sessions, with its return paths. */
function brokerOf(...members: BrokerConnectedSession[]) {
	const sessions = new Map(members.map((member) => [member.info.id, member]));
	const authority = createReturnPathAuthority(new ReturnPaths(), sessions);
	const delivered = new DeliveredMessageCache();
	const pending = new PendingQuestionIndex();
	const supervisor = new SupervisorChannelCache();
	return (from: string, to: string, id: string): BrokerMessage | undefined => {
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
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			authority,
		);
		return outcome;
	};
}

test("a session with a reach policy sends only within it, and a session it wrote to can still answer it", () => {
	// A reaches team-b; B cannot reach A; D reaches team-a, which A cannot reach.
	const send = brokerOf(
		session("a", "team-a", createReachPolicy("team-a", ["team-b"])),
		session("b", "team-b"),
		session("d", "team-d", createReachPolicy("team-d", ["team-a"])),
	);
	assert.equal(send("a", "b", "a-to-b")?.type, "delivered");
	// B answers the session that wrote to it, outside B's groups.
	assert.equal(send("b", "a", "b-answers-a")?.type, "delivered");
	// D writes to A; A's policy stays authoritative: no return path takes A outside it.
	assert.equal(send("d", "a", "d-to-a")?.type, "delivered");
	const refused = send("a", "d", "a-answers-d");
	assert.equal(refused?.type, "delivery_failed");
});
