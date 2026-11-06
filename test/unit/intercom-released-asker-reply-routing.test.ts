import assert from "node:assert/strict";
import type net from "node:net";
import { describe, test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	type ReleasedAskerReplyRouter,
	type RemoteSendRouter,
	type RestoringRecipientHold,
} from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import {
	appendEntryUnlessReleased,
	contactSupervisorCallMayDetach,
	heavyToolCallMayDetach,
	intercomCallMayDetach,
} from "../../packages/intercom/detachable-calls.js";
import { executeHeavyTool } from "../../packages/intercom/lazy-tool-execution.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

const REPLIER = "22222222-2222-4222-8222-222222222222";
const RELEASED_ASKER = "11111111-1111-4111-8111-111111111111";

interface Offered {
	readonly target: string;
	readonly replyTo: string;
	readonly expectedRecipientId?: string;
}

function harness(answer: boolean) {
	const socket = {} as net.Socket;
	const info: SessionInfo = {
		id: REPLIER,
		name: "replier",
		cwd: "/tmp",
		model: "m",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
		group: "default",
	};
	const sessions = new Map<string, BrokerConnectedSession>([[REPLIER, { socket, info }]]);
	const writes: BrokerMessage[] = [];
	const offered: Offered[] = [];
	const counts = { held: 0, remote: 0 };
	const router: ReleasedAskerReplyRouter = ({ message, target, expectedRecipientId }) => {
		offered.push({
			target,
			replyTo: message.replyTo,
			...(expectedRecipientId === undefined ? {} : { expectedRecipientId }),
		});
		return answer;
	};
	const hold: RestoringRecipientHold = () => {
		counts.held += 1;
		return false;
	};
	const remote: RemoteSendRouter = (request) => {
		counts.remote += 1;
		request.notFound();
	};
	const send = (frame: Record<string, unknown>, withRemote = false): void =>
		handleBrokerSend(
			socket,
			frame as never,
			REPLIER,
			sessions,
			new DeliveredMessageCache(),
			(_target, value) => {
				writes.push(value);
				return true;
			},
			new SupervisorChannelCache(),
			new PendingQuestionIndex(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			hold,
			undefined,
			withRemote ? remote : undefined,
			undefined,
			router,
		);
	return { send, writes, offered, counts };
}

function message(id: string, extra: Partial<Message> = {}): Message {
	return { id, timestamp: 1, content: { text: "answer" }, ...extra };
}

describe("broker send routing for a released asker's reply (#4326)", () => {
	test("a reply the released-asker router takes is answered by it alone: no hold, no remote route, no failure (#4326)", () => {
		const h = harness(true);
		h.send({
			type: "send",
			to: RELEASED_ASKER,
			requirePendingReply: true,
			expectedRecipientId: RELEASED_ASKER,
			message: message("r1", { replyTo: "q1" }),
		});
		h.send({ type: "send", to: RELEASED_ASKER, message: message("r2", { replyTo: "q2" }) }, true);
		assert.deepEqual(h.offered, [
			{ target: RELEASED_ASKER, replyTo: "q1", expectedRecipientId: RELEASED_ASKER },
			{ target: RELEASED_ASKER, replyTo: "q2" },
		]);
		assert.deepEqual(h.counts, { held: 0, remote: 0 });
		assert.deepEqual(h.writes, []);
	});

	test("only replies are offered: asks, plain sends and supervisor sends route as before (#4326)", () => {
		const h = harness(true);
		h.send({ type: "send", to: "subagent-a", message: message("a1", { expectsReply: true }) });
		h.send({ type: "send", to: "subagent-a", message: message("s1") });
		h.send({ type: "supervisor_send", to: "nobody", message: message("v1", { replyTo: "q1" }) });
		assert.deepEqual(h.offered, []);
		assert.equal(h.counts.held, 2);
		assert.deepEqual(
			h.writes.map((frame) => frame.type),
			["delivery_failed", "delivery_failed", "delivery_failed"],
		);
	});

	test("a reply the router declines continues on the ordinary path and fails as before (#4326)", () => {
		const h = harness(false);
		h.send({
			type: "send",
			to: RELEASED_ASKER,
			requirePendingReply: true,
			message: message("r1", { replyTo: "q1" }),
		});
		assert.equal(h.offered.length, 1);
		const [failure] = h.writes;
		assert.equal(failure?.type, "delivery_failed");
		assert.equal(failure?.type === "delivery_failed" ? failure.reasonCode : undefined, "session_not_found");
	});
});

describe("which Intercom calls may outlive a released subagent's session (#4326)", () => {
	test("only an ask, and a supervisor decision or interview, may detach (#4326)", () => {
		for (const action of ["ask"]) assert.equal(intercomCallMayDetach({ action }), true, action);
		for (const action of ["send", "reply", "list", "pending", "status", "join", "leave", undefined]) {
			assert.equal(intercomCallMayDetach(action === undefined ? {} : { action }), false, String(action));
		}
		for (const reason of ["need_decision", "interview_request"]) {
			assert.equal(contactSupervisorCallMayDetach({ reason }), true, reason);
		}
		assert.equal(contactSupervisorCallMayDetach({ reason: "progress_update" }), false);
		assert.equal(heavyToolCallMayDetach("intercom", { action: "ask" }), true);
		assert.equal(heavyToolCallMayDetach("contact_supervisor", { reason: "need_decision" }), true);
		assert.equal(heavyToolCallMayDetach("contact_supervisor", { action: "ask" }), false);
		assert.equal(heavyToolCallMayDetach("other", { action: "ask", reason: "need_decision" }), false);
	});

	test("recording a reply after the session was released is skipped; any other failure still surfaces (#4326)", async () => {
		const appended: string[] = [];
		const live = {
			async appendEntry(customType: string) {
				appended.push(customType);
			},
		};
		const released = {
			async appendEntry() {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		};
		const broken = {
			async appendEntry() {
				throw new Error("disk full");
			},
		};
		assert.equal(await appendEntryUnlessReleased(live, "intercom_received", {}), "appended");
		assert.equal(await appendEntryUnlessReleased(released, "intercom_received", {}), "released");
		await assert.rejects(appendEntryUnlessReleased(broken, "intercom_received", {}), /disk full/);
		assert.deepEqual(appended, ["intercom_received"]);
	});
});

describe("a detached Intercom call outliving its session's lease (#4326)", () => {
	function heavyWithLeaseEndingDuringCall(name: string) {
		const lease = { current: true, checks: 0 };
		const result = { content: [{ type: "text" as const, text: "**Reply from peer:**\nyes" }], details: {} };
		const heavy = {
			tools: new Map([
				[
					name,
					{
						async execute() {
							lease.current = false;
							return result;
						},
					},
				],
			]),
			commands: new Map(),
		};
		const loadHeavy = async () => ({
			heavy: heavy as never,
			assertCurrent: () => {
				lease.checks += 1;
				if (!lease.current) throw new Error("Intercom lifecycle lease is no longer current");
			},
		});
		return { loadHeavy, result, lease };
	}

	test("an ask or a blocking supervisor request returns its result although its session ended while it waited (#4326)", async () => {
		for (const [name, params] of [
			["intercom", { action: "ask" }],
			["contact_supervisor", { reason: "need_decision" }],
		] as const) {
			const { loadHeavy, result, lease } = heavyWithLeaseEndingDuringCall(name);
			const returned = await executeHeavyTool(loadHeavy, name, [
				"call-1",
				params,
				undefined,
				undefined,
				{} as never,
			]);
			assert.equal(returned, result);
			assert.equal(lease.checks, 1, "checked before the call, not after it");
		}
	});

	test("any other call still fails when its session ended during the call (#4326)", async () => {
		const { loadHeavy } = heavyWithLeaseEndingDuringCall("intercom");
		await assert.rejects(
			executeHeavyTool(loadHeavy, "intercom", ["call-1", { action: "send" }, undefined, undefined, {} as never]),
			/no longer current/,
		);
	});
});
