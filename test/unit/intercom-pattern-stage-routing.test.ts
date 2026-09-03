import assert from "node:assert/strict";
import type net from "node:net";
import { describe, test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	PENDING_STAGE_ASK_REFUSAL,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, Message } from "../../packages/intercom/types.js";
import {
	matchStagePathSegments,
	splitStagePathSegments,
	targetSegmentsInPossibleStages,
} from "../../packages/intercom/workflow-stage-path-matching.js";

const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const GROUP = `workflow:${RUN_ID}`;

function sender(socket: net.Socket): BrokerConnectedSession {
	return {
		socket,
		info: {
			id: "sender-id",
			name: "planner",
			cwd: "/repo",
			model: "test-model",
			pid: 10,
			startedAt: 11,
			lastActivity: 12,
			group: GROUP,
		},
	};
}

function message(id: string, expectsReply = false): Message {
	return { id, timestamp: 100, content: { text: `scope ${id}` }, ...(expectsReply ? { expectsReply: true } : {}) };
}

describe("intercom workflow-stage path matching", () => {
	test("applies the shared fixture table", () => {
		assert.equal(matchStagePathSegments(splitStagePathSegments("orchestrator-*"), ["orchestrator-3"]), true);
		assert.equal(matchStagePathSegments(splitStagePathSegments("orchestrator-*"), ["orchestrator"]), false);
		assert.equal(matchStagePathSegments(splitStagePathSegments("review-*-*"), ["review-slice-1-2"]), true);
		assert.equal(matchStagePathSegments(["**"], ["a", "b", "c"]), true);
		assert.equal(matchStagePathSegments(["a", "**", "b"], ["a", "b"]), true);
		assert.equal(matchStagePathSegments(["a", "**", "b"], ["a", "x", "y", "b"]), true);
		assert.equal(matchStagePathSegments(["a", "**"], ["a"]), true);
		assert.equal(matchStagePathSegments(["**", "b"], ["b"]), true);
		assert.equal(matchStagePathSegments(["orchestrator-*"], ["orchestrator-*"]), true);
		assert.equal(matchStagePathSegments(["reviewer-*"], ["reviewer-a"]), true);
		// Raw matching is one-directional (pattern, candidate); the reverse direction is
		// `targetSegmentsInPossibleStages`'s bidirectional membership rule.
		assert.equal(matchStagePathSegments(["reviewer-a"], ["reviewer-*"]), false);
		assert.equal(matchStagePathSegments(["a*"], ["ab"]), true);
		assert.equal(matchStagePathSegments(["Orchestrator-*"], ["orchestrator-3"]), false);
		assert.equal(matchStagePathSegments([], []), true);
		assert.equal(matchStagePathSegments([], ["a"]), false);
		assert.equal(
			targetSegmentsInPossibleStages(["orchestrator-3"], ["implement-slice-2/reviewer-a", "orchestrator-*"]),
			true,
		);
		assert.equal(targetSegmentsInPossibleStages(["ghost"], ["orchestrator-*"]), false);
		assert.equal(targetSegmentsInPossibleStages(["x"], []), false);
	});
});

describe("pattern stage targets route through the pending-stage bridge", () => {
	test("routes a pattern send to the router instead of refusing it at parse time", () => {
		const socket = {} as net.Socket;
		const sessions = new Map([["sender-id", sender(socket)]]);
		const routed: string[] = [];
		const writes: BrokerMessage[] = [];
		handleBrokerSend(
			socket,
			{ type: "send", to: `workflow:${RUN_ID}/reviewer-*`, message: message("pattern") },
			"sender-id",
			sessions,
			new DeliveredMessageCache(),
			(_target, value) => {
				writes.push(value);
				return true;
			},
			undefined,
			undefined,
			(input) => {
				routed.push(input.target);
				return true;
			},
		);
		assert.deepEqual(routed, [`workflow:${RUN_ID}/reviewer-*`]);
		assert.deepEqual(writes, []);
	});

	test("routes a deep-pattern broadcast to the router", () => {
		const socket = {} as net.Socket;
		const sessions = new Map([["sender-id", sender(socket)]]);
		const routed: string[] = [];
		handleBrokerSend(
			socket,
			{ type: "send", to: `workflow:${RUN_ID}/**`, message: message("broadcast") },
			"sender-id",
			sessions,
			new DeliveredMessageCache(),
			() => true,
			undefined,
			undefined,
			(input) => {
				routed.push(input.target);
				return true;
			},
		);
		assert.deepEqual(routed, [`workflow:${RUN_ID}/**`]);
	});

	test("refuses an ask to a pattern target before any routing or delivery", () => {
		const socket = {} as net.Socket;
		const sessions = new Map([["sender-id", sender(socket)]]);
		const routed: string[] = [];
		const writes: BrokerMessage[] = [];
		handleBrokerSend(
			socket,
			{ type: "ask", to: `workflow:${RUN_ID}/reviewer-*`, message: message("ask", true) },
			"sender-id",
			sessions,
			new DeliveredMessageCache(),
			(_target, value) => {
				writes.push(value);
				return true;
			},
			undefined,
			undefined,
			(input) => {
				routed.push(input.target);
				return true;
			},
		);
		assert.deepEqual(routed, []);
		assert.deepEqual(writes, [
			{
				type: "delivery_failed",
				messageId: "ask",
				reason: PENDING_STAGE_ASK_REFUSAL,
			},
		]);
	});

	test("keeps the ordinary unknown-target failure when no route owner claims a pattern target", () => {
		const socket = {} as net.Socket;
		const senderSession = sender(socket);
		const sessions = new Map<string, BrokerConnectedSession>([["sender-id", senderSession]]);
		const writes: BrokerMessage[] = [];
		handleBrokerSend(
			socket,
			{ type: "send", to: `workflow:${RUN_ID}/ghost-*`, message: message("ghost") },
			"sender-id",
			sessions,
			new DeliveredMessageCache(),
			(_target, value) => {
				writes.push(value);
				return true;
			},
			undefined,
			undefined,
			() => false,
		);
		assert.deepEqual(writes, [
			{
				type: "delivery_failed",
				messageId: "ghost",
				attemptId: undefined,
				reason: "Session not found",
			},
		]);
	});

	test("an exact session id keeps precedence over the pending-stage router", () => {
		// Routing order: an exact session id (even one whose spelling contains `*`) is
		// ordinary exact addressing and never reaches the sticky bridge.
		const socket = {} as net.Socket;
		const targetSession: BrokerConnectedSession = {
			socket,
			info: { ...sender(socket).info, id: `workflow:${RUN_ID}/reviewer-*`, name: "reviewer-*" },
		};
		const sessions = new Map<string, BrokerConnectedSession>([
			["sender-id", sender(socket)],
			[targetSession.info.id, targetSession],
		]);
		const routed: string[] = [];
		const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
		handleBrokerSend(
			socket,
			{ type: "send", to: `workflow:${RUN_ID}/reviewer-*`, message: message("alias") },
			"sender-id",
			sessions,
			new DeliveredMessageCache(),
			(target, value) => {
				writes.push({ socket: target, message: value });
				return true;
			},
			undefined,
			undefined,
			(input) => {
				routed.push(input.target);
				return true;
			},
		);
		assert.deepEqual(routed, []);
		assert.deepEqual(writes, [
			{ socket, message: { type: "message", from: sender(socket).info, message: message("alias") } },
			{ socket, message: { type: "delivered", messageId: "alias", attemptId: undefined } },
		]);
	});
});
