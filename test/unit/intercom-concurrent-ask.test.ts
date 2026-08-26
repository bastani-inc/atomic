import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import { registerContactSupervisorTool } from "../../packages/intercom/contact-supervisor-tool.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { routePeerDisconnect } from "../../packages/intercom/peer-disconnect-routing.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { type ReplyWaiterRecord, ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { SessionInfo } from "../../packages/intercom/types.js";
import { sleep } from "../helpers/runtime.js";

type ToolResult = { content: Array<{ text: string }>; isError: boolean };
type Tool = {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

interface SendBehavior {
	delayMs?: number;
	delivered?: boolean;
	reason?: string;
	throwError?: Error;
}

const from: SessionInfo = {
	id: "parent-id",
	name: "parent",
	cwd: "/tmp",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
	status: "idle",
};

/** Shared-runtime fixture: both blocking tools use one production-shaped registry. */
function fixture(
	options: {
		send?: SendBehavior;
		resolveGate?: Promise<void>;
		claimParent?: boolean | (() => boolean);
		childIndex?: number;
	} = {},
) {
	const tools = new Map<string, Tool>();
	const slot = new ReplyWaiterRegistry();
	const sent: Array<{ to: string; message: { messageId?: string; text: string } }> = [];
	const send = async (to: string, message: { messageId?: string; text: string }) => {
		if (options.send?.delayMs) await sleep(options.send.delayMs);
		if (options.send?.throwError) throw options.send.throwError;
		sent.push({ to, message });
		return {
			id: message.messageId ?? "sent",
			delivered: options.send?.delivered ?? true,
			reason: options.send?.reason,
		};
	};
	const client = {
		sessionId: "self-id",
		async listSessions() {
			return [];
		},
		send,
		sendToSupervisor: send,
	};
	const claimingEvents = {
		emit(_channel: string, payload: { claimed?: boolean }) {
			payload.claimed = typeof options.claimParent === "function" ? options.claimParent() : options.claimParent;
		},
	};
	const pi = {
		registerTool(tool: Tool & { name: string }) {
			tools.set(tool.name, tool);
		},
		appendEntry() {},
		events: options.claimParent ? claimingEvents : undefined,
	};
	const common = {
		ensureConnected: async () => client,
		syncPresenceIdentity() {},
		resolveSessionTarget: async (_client: object, target: string) => {
			await (options.resolveGate ?? Promise.resolve());
			return target === "parent" ? "parent-id" : target;
		},
		beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => slot.begin(from, replyTo, signal),
	};
	registerIntercomTool(pi as never, { ...common, confirmSend: false, replyTracker: new ReplyTracker() } as never);
	registerContactSupervisorTool(
		pi as never,
		{
			...common,
			childOrchestratorMetadata: {
				orchestratorTarget: "parent",
				runId: "run",
				agent: "worker",
				index: options.childIndex ?? 0,
				sessionName: `child-${options.childIndex ?? 0}`,
			},
		} as never,
	);
	const context = { sessionManager: { getSessionId: () => "self-session" }, hasUI: false };
	const reply = (waiter: ReplyWaiterRecord, sender = from) => {
		const routed = routeIncomingReply(waiter, sender, {
			id: `${sender.id}-reply`,
			timestamp: Date.now(),
			replyTo: waiter.replyTo,
			content: { text: "Approved" },
		});
		assert.equal(routed, true);
	};
	return {
		slot,
		sent,
		ask(signal?: AbortSignal, target = "parent") {
			const tool = tools.get("intercom");
			assert.ok(tool);
			const params = { action: "ask", to: target, message: "Choose" };
			return tool.execute("call", params, signal, undefined, context);
		},
		supervise(signal?: AbortSignal) {
			const tool = tools.get("contact_supervisor");
			assert.ok(tool);
			return tool.execute("call", { reason: "need_decision", message: "Choose" }, signal, undefined, context);
		},
		reply,
		replyToPending() {
			const waiter = slot.pending()[0];
			assert.ok(waiter, "a pending waiter is required to reply");
			reply(waiter);
		},
	};
}

const unhandledRejections: unknown[] = [];
const onUnhandled = (error: unknown) => {
	unhandledRejections.push(error);
};

beforeAll(() => {
	process.on("unhandledRejection", onUnhandled);
});

afterAll(() => {
	process.off("unhandledRejection", onUnhandled);
	assert.deepEqual(
		unhandledRejections,
		[],
		"concurrent blocking asks must never crash the process with an unhandled rejection",
	);
});

describe("concurrent blocking intercom requests", () => {
	test("two concurrent asks are both admitted and complete independently", async () => {
		let release!: () => void;
		const resolveGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const current = fixture({ send: { delayMs: 15 }, resolveGate });

		// Start both in the same tick, as parallel sibling tool calls do.
		const first = current.ask();
		const second = current.ask();
		await sleep(0);
		release();
		await sleep(20);
		assert.equal(current.sent.length, 2, "both asks send their questions");
		current.replyToPending();
		current.replyToPending();
		for (const result of await Promise.all([first, second])) {
			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Approved/);
		}
	});

	test("cross-tool concurrency admits a peer ask alongside one exclusive supervisor wait", async () => {
		let release!: () => void;
		const resolveGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const current = fixture({ send: { delayMs: 15 }, resolveGate });

		const askExecution = current.ask();
		const superviseExecution = current.supervise();
		await sleep(0);
		release();
		await sleep(20);
		assert.equal(current.slot.size(), 2);
		current.replyToPending();
		current.replyToPending();

		for (const result of await Promise.all([askExecution, superviseExecution])) {
			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Approved/);
		}
	});

	test("concurrent supervisor waits have one winner and a deterministic refusal", async () => {
		const current = fixture({ send: { delayMs: 10 } });
		const winner = current.supervise();
		const loser = await current.supervise();
		assert.equal(loser.isError, true);
		assert.match(loser.content[0]?.text ?? "", /Already waiting for a supervisor reply/);
		await sleep(15);
		assert.equal(current.slot.size(), 1);
		current.replyToPending();
		assert.equal((await winner).isError, false);
	});

	test("undelivered send cleans up only its own waiter and frees the slot", async () => {
		const current = fixture({ send: { delivered: false, reason: "Session not found" } });
		const result = await current.ask();
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /was not delivered: Session not found/);
		assert.equal(current.slot.has(), false, "a failed send releases the reservation");
	});

	test("a claimed parent handoff makes concurrent supervisor claims first-wins", async () => {
		const current = fixture({ claimParent: true });
		const [winner, loser] = await Promise.all([current.supervise(), current.supervise()]);
		assert.equal(winner.isError, false);
		assert.match(winner.content[0]?.text ?? "", /Parent ask claimed/);
		assert.equal(loser.isError, true);
		assert.match(loser.content[0]?.text ?? "", /Parent ask already claimed/);
		assert.equal(current.sent.length, 0);
	});

	test("parallel children use one parent handoff claim and preserve every loser waiter", async () => {
		let unclaimed = true;
		const claimOnce = () => {
			const claimed = unclaimed;
			unclaimed = false;
			return claimed;
		};
		const children = [0, 1, 2].map((childIndex) => fixture({ claimParent: claimOnce, childIndex }));
		const executions = children.map((child) => child.supervise());
		await sleep(5);
		assert.deepEqual(
			children.map((child) => child.slot.size()),
			[0, 1, 1],
		);
		assert.match((await executions[0]!).content[0]?.text ?? "", /Parent ask claimed/);
		const loserIds = children.slice(1).map((child) => child.slot.pending()[0]!.replyTo);
		assert.equal(new Set(loserIds).size, 2);
		assert.equal(children[1]!.sent.length + children[2]!.sent.length, 2);
		children[1]!.replyToPending();
		children[2]!.replyToPending();
		for (const result of await Promise.all(executions.slice(1))) assert.equal(result.isError, false);
	});

	test("a thrown send failure frees the slot for the next ask", async () => {
		const current = fixture({ send: { throwError: new Error("socket closed") } });
		const failed = await current.ask();
		assert.equal(failed.isError, true);
		assert.match(failed.content[0]?.text ?? "", /Failed: socket closed/);
		assert.equal(current.slot.has(), false);

		const retryable = fixture();
		const retried = retryable.ask();
		await sleep(5);
		retryable.replyToPending();
		assert.equal((await retried).isError, false);
	});

	test("cancellation rejects the pending ask and releases the reservation", async () => {
		const current = fixture();
		const controller = new AbortController();
		const execution = current.ask(controller.signal);
		await sleep(5);
		assert.ok(current.slot.has(), "the ask is waiting before cancellation");
		controller.abort();
		const result = await execution;
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Cancelled/);
		assert.equal(current.slot.has(), false);

		const next = current.ask();
		await sleep(5);
		current.replyToPending();
		assert.equal((await next).isError, false);
	});

	test("contact_supervisor cancellation also releases the shared reservation", async () => {
		const current = fixture();
		const controller = new AbortController();
		const execution = current.supervise(controller.signal);
		await sleep(5);
		controller.abort();
		const result = await execution;
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Cancelled/);
		assert.equal(current.slot.has(), false);
	});

	test("replies correlate by exact sender and thread id with concurrent asks", async () => {
		let release!: () => void;
		const resolveGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const current = fixture({ resolveGate });
		const winner = current.ask();
		const loser = current.ask();
		await sleep(0);
		release();
		await sleep(5);

		const waiter = current.slot.pending();
		assert.ok(waiter);
		const misrouted = routeIncomingReply(waiter, from, {
			id: "unrelated",
			timestamp: Date.now(),
			replyTo: "some-other-question",
			content: { text: "Wrong thread" },
		});
		assert.equal(misrouted, false, "replies to other threads never resolve the waiter");
		const wrongSender = routeIncomingReply(
			waiter,
			{ ...from, id: "parent-or-unrelated-session" },
			{
				id: "wrong-sender",
				timestamp: Date.now(),
				replyTo: waiter[0]!.replyTo,
				content: { text: "Right thread, wrong session" },
			},
		);
		assert.equal(wrongSender, false, "parent or unrelated sessions cannot resolve a child-to-child ask");
		current.replyToPending();
		assert.match((await winner).content[0]?.text ?? "", /Approved/);
		current.replyToPending();
		assert.match((await loser).content[0]?.text ?? "", /Approved/);
	});

	test("mixed-target fan-out settles out of order and disconnects only the matching peer", async () => {
		const current = fixture();
		const firstB = current.ask(undefined, "b");
		const secondB = current.ask(undefined, "b");
		const onlyC = current.ask(undefined, "c");
		await sleep(5);

		assert.equal(current.slot.size(), 3);
		const bWaiters = current.slot.pending().filter((waiter) => waiter.from === "b");
		const cWaiter = current.slot.pending().find((waiter) => waiter.from === "c");
		assert.equal(bWaiters.length, 2);
		assert.ok(cWaiter);
		current.reply(bWaiters[1]!, { ...from, id: "b", name: "b" });
		assert.equal((await secondB).isError, false);
		assert.equal(current.slot.size(), 2);

		const notice = { peerSessionId: "c", replyTo: cWaiter.replyTo };
		const released = routePeerDisconnect(current.slot.pending(), notice);
		assert.equal(released, true);
		const cResult = await onlyC;
		assert.equal(cResult.isError, true);
		assert.match(cResult.content[0]?.text ?? "", /Session "c" disconnected before replying/);
		assert.deepEqual(current.slot.pending(), [bWaiters[0]]);
		current.reply(bWaiters[0]!, { ...from, id: "b", name: "b" });
		assert.equal((await firstB).isError, false);
		assert.equal(current.slot.size(), 0);
	});

	test("mutual asks resolve only the exact waiter on each side", async () => {
		const waitsAtA = new ReplyWaiterRegistry();
		const waitsAtB = new ReplyWaiterRegistry();
		const aAdmission = waitsAtA.begin("b", "a-to-b");
		const bAdmission = waitsAtB.begin("a", "b-to-a");
		assert.equal(aAdmission.ok, true);
		assert.equal(bAdmission.ok, true);
		if (!aAdmission.ok || !bAdmission.ok) return;

		const aReply = { id: "reply-a", timestamp: 1, replyTo: "b-to-a", content: { text: "A replied" } };
		const bReply = { id: "reply-b", timestamp: 1, replyTo: "a-to-b", content: { text: "B replied" } };
		assert.equal(routeIncomingReply(waitsAtA.pending(), { ...from, id: "a", name: "a" }, aReply), false);
		assert.equal(routeIncomingReply(waitsAtA.pending(), { ...from, id: "b", name: "b" }, bReply), true);
		assert.equal(routeIncomingReply(waitsAtB.pending(), { ...from, id: "a", name: "a" }, aReply), true);
		assert.equal((await aAdmission.wait.promise).content.text, "B replied");
		assert.equal((await bAdmission.wait.promise).content.text, "A replied");
		assert.equal(waitsAtA.size(), 0);
		assert.equal(waitsAtB.size(), 0);
	});

	test("aborting a blocking ask mid-send frees the slot for a second ask, and the first call's late cleanup never disturbs the new reservation", async () => {
		// The send stays in flight long enough for the abort to fire while the
		// first ask still owns the slot. The abort must free the slot, a second
		// ask must be able to reserve it, and when the first ask's delayed send
		// finally resolves its trailing cleanup must not tear down the second
		// reservation.
		const current = fixture({ send: { delayMs: 40 } });
		const controller = new AbortController();

		const first = current.ask(controller.signal);
		await sleep(5);
		assert.ok(current.slot.has(), "the first ask reserves the slot before it is aborted");
		controller.abort();
		await sleep(0);
		assert.equal(current.slot.has(), false, "aborting mid-send releases the reservation");

		const second = current.ask();
		await sleep(5);
		assert.ok(current.slot.has(), "a second ask reserves the freed slot");

		const firstResult = await first;
		assert.equal(firstResult.isError, true);
		assert.match(firstResult.content[0]?.text ?? "", /Cancelled/);
		assert.ok(current.slot.has(), "the aborted ask's trailing cleanup must not tear down the second reservation");

		current.replyToPending();
		const secondResult = await second;
		assert.equal(secondResult.isError, false);
		assert.match(secondResult.content[0]?.text ?? "", /Approved/);
	});
});
