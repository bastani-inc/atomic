import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { registerContactSupervisorTool } from "../../packages/intercom/contact-supervisor-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

type ToolResult = { content: Array<{ text: string }>; isError: boolean };
type Tool = { execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined, ctx: object): Promise<ToolResult> };

interface SendBehavior {
	delayMs?: number;
	delivered?: boolean;
	reason?: string;
	throwError?: Error;
}

/**
 * Shared-runtime fixture: both blocking tools are registered against ONE
 * reply-waiter slot, exactly like the production runtime, so same-tool and
 * cross-tool concurrency exercise the real reservation seam.
 */
function fixture(options: { send?: SendBehavior; resolveGate?: Promise<void> } = {}) {
	const tools = new Map<string, Tool>();
	const slot = new ReplyWaiterSlot();
	const sent: Array<{ to: string; message: { messageId?: string; text: string } }> = [];
	const client = {
		sessionId: "self-id",
		async listSessions() { return []; },
		async send(to: string, message: { messageId?: string; text: string }) {
			if (options.send?.delayMs) await Bun.sleep(options.send.delayMs);
			if (options.send?.throwError) throw options.send.throwError;
			sent.push({ to, message });
			return {
				id: message.messageId ?? "sent",
				delivered: options.send?.delivered ?? true,
				reason: options.send?.reason,
			};
		},
	};
	const pi = {
		registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
		appendEntry() {},
	};
	const common = {
		ensureConnected: async () => client,
		syncPresenceIdentity() {},
		resolveSessionTarget: async (_client: object, target: string) => {
			await (options.resolveGate ?? Promise.resolve());
			return target === "parent" ? "parent-id" : target;
		},
		beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => slot.begin(from, replyTo, signal),
		hasReplyWaiter: () => slot.has(),
	};
	registerIntercomTool(pi as never, { ...common, confirmSend: false, replyTracker: new ReplyTracker() } as never);
	registerContactSupervisorTool(pi as never, {
		...common,
		childOrchestratorMetadata: { orchestratorTarget: "parent", runId: "run", agent: "worker", index: 0 },
	} as never);
	const context = { sessionManager: { getSessionId: () => "self-session" }, hasUI: false };
	const from: SessionInfo = { id: "parent-id", name: "parent", cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, status: "idle" };
	return {
		slot,
		sent,
		ask(signal?: AbortSignal) {
			const tool = tools.get("intercom");
			assert.ok(tool);
			return tool.execute("call", { action: "ask", to: "parent", message: "Choose" }, signal, undefined, context);
		},
		supervise(signal?: AbortSignal) {
			const tool = tools.get("contact_supervisor");
			assert.ok(tool);
			return tool.execute("call", { reason: "need_decision", message: "Choose" }, signal, undefined, context);
		},
		replyToPending() {
			const waiter = slot.current();
			assert.ok(waiter, "a pending waiter is required to reply");
			const routed = routeIncomingReply(waiter, from, {
				id: "parent-reply",
				timestamp: Date.now(),
				replyTo: waiter.replyTo,
				content: { text: "Approved" },
			});
			assert.equal(routed, true);
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
	assert.deepEqual(unhandledRejections, [], "concurrent blocking asks must never crash the process with an unhandled rejection");
});

describe("concurrent blocking intercom requests", () => {
	test("two concurrent asks: the loser gets a structured error and the winner still completes", async () => {
		let release!: () => void;
		const resolveGate = new Promise<void>((resolve) => { release = resolve; });
		const current = fixture({ send: { delayMs: 15 }, resolveGate });

		// Start both in the same tick so both pass the advisory pre-check
		// before either reserves the waiter slot — the exact interleaving that
		// used to surface a pre-rejected promise.
		const first = current.ask();
		const second = current.ask();
		await Bun.sleep(0);
		release();
		await Bun.sleep(5);

		const loser = await second;
		assert.equal(loser.isError, true);
		assert.match(loser.content[0]?.text ?? "", /Already waiting for a reply/);

		await Bun.sleep(15);
		assert.equal(current.sent.length, 1, "only the winning ask sends its question");
		current.replyToPending();
		const winner = await first;
		assert.equal(winner.isError, false);
		assert.match(winner.content[0]?.text ?? "", /Approved/);
	});

	test("cross-tool concurrency: ask and contact_supervisor share one reservation without interference", async () => {
		let release!: () => void;
		const resolveGate = new Promise<void>((resolve) => { release = resolve; });
		const current = fixture({ send: { delayMs: 15 }, resolveGate });

		const askExecution = current.ask();
		const superviseExecution = current.supervise();
		await Bun.sleep(0);
		release();
		await Bun.sleep(5);

		const superviseResult = await superviseExecution;
		assert.equal(superviseResult.isError, true);
		assert.match(superviseResult.content[0]?.text ?? "", /Already waiting for a reply/);
		assert.ok(current.slot.has(), "the losing tool call must not tear down the winner's waiter");

		await Bun.sleep(15);
		current.replyToPending();
		const askResult = await askExecution;
		assert.equal(askResult.isError, false);
		assert.match(askResult.content[0]?.text ?? "", /Approved/);
	});

	test("undelivered send cleans up only its own waiter and frees the slot", async () => {
		const current = fixture({ send: { delivered: false, reason: "Session not found" } });
		const result = await current.ask();
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /was not delivered: Session not found/);
		assert.equal(current.slot.has(), false, "a failed send releases the reservation");
	});

	test("a thrown send failure frees the slot for the next ask", async () => {
		const current = fixture({ send: { throwError: new Error("socket closed") } });
		const failed = await current.ask();
		assert.equal(failed.isError, true);
		assert.match(failed.content[0]?.text ?? "", /Failed: socket closed/);
		assert.equal(current.slot.has(), false);

		const retryable = fixture();
		const retried = retryable.ask();
		await Bun.sleep(5);
		retryable.replyToPending();
		assert.equal((await retried).isError, false);
	});

	test("cancellation rejects the pending ask and releases the reservation", async () => {
		const current = fixture();
		const controller = new AbortController();
		const execution = current.ask(controller.signal);
		await Bun.sleep(5);
		assert.ok(current.slot.has(), "the ask is waiting before cancellation");
		controller.abort();
		const result = await execution;
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Cancelled/);
		assert.equal(current.slot.has(), false);

		const next = current.ask();
		await Bun.sleep(5);
		current.replyToPending();
		assert.equal((await next).isError, false);
	});

	test("contact_supervisor cancellation also releases the shared reservation", async () => {
		const current = fixture();
		const controller = new AbortController();
		const execution = current.supervise(controller.signal);
		await Bun.sleep(5);
		controller.abort();
		const result = await execution;
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Cancelled/);
		assert.equal(current.slot.has(), false);
	});

	test("replies correlate by exact sender and thread id even after a losing concurrent attempt", async () => {
		let release!: () => void;
		const resolveGate = new Promise<void>((resolve) => { release = resolve; });
		const current = fixture({ resolveGate });
		const winner = current.ask();
		const loser = current.ask();
		await Bun.sleep(0);
		release();
		await Bun.sleep(5);
		assert.equal((await loser).isError, true);

		const waiter = current.slot.current();
		assert.ok(waiter);
		const from: SessionInfo = { id: "parent-id", name: "parent", cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, status: "idle" };
		const misrouted = routeIncomingReply(waiter, from, {
			id: "unrelated",
			timestamp: Date.now(),
			replyTo: "some-other-question",
			content: { text: "Wrong thread" },
		});
		assert.equal(misrouted, false, "replies to other threads never resolve the waiter");
    const wrongSender = routeIncomingReply(waiter, { ...from, id: "parent-or-unrelated-session" }, {
      id: "wrong-sender",
      timestamp: Date.now(),
      replyTo: waiter.replyTo,
      content: { text: "Right thread, wrong session" },
    });
    assert.equal(wrongSender, false, "parent or unrelated sessions cannot resolve a child-to-child ask");
		current.replyToPending();
		assert.match((await winner).content[0]?.text ?? "", /Approved/);
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
		await Bun.sleep(5);
		assert.ok(current.slot.has(), "the first ask reserves the slot before it is aborted");
		controller.abort();
		await Bun.sleep(0);
		assert.equal(current.slot.has(), false, "aborting mid-send releases the reservation");

		const second = current.ask();
		await Bun.sleep(5);
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
