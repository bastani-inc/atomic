import assert from "node:assert/strict";
import type { SessionEntry } from "@bastani/atomic";
import { describe, test } from "vitest";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { UNAUTHORIZED_REPLY_REASON } from "../../packages/intercom/broker/delivery-failure-reason.js";
import { closeFinishedChildAsks } from "../../packages/intercom/finished-asks.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import {
	INTERCOM_ASK_CLOSED_ENTRY,
	ReplyTracker,
	restorePendingInboundAsks,
} from "../../packages/intercom/reply-tracker.js";
import { type FinishedAsksRequest, SUBAGENT_FINISHED_ASKS_EVENT } from "../../packages/intercom/session-recovery.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const child: SessionInfo = {
	id: "child-intercom-id",
	name: "subagent-worker-run1-1",
	cwd: "/p",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

function question(id: string): Message {
	return {
		id,
		timestamp: 1,
		expectsReply: true,
		source: { subagentRunId: "run1", subagentIndex: 0 },
		content: { text: `question ${id}` },
	};
}

/** Subagents' answer to which asks came from an attempt that is over: those named in `finished`. */
function subagentsAnswering(finished: readonly string[]) {
	const asked: FinishedAsksRequest[] = [];
	return {
		asked,
		emit(eventName: string, payload: unknown) {
			if (eventName !== SUBAGENT_FINISHED_ASKS_EVENT) return;
			const request = payload as FinishedAsksRequest;
			asked.push(request);
			request.completion = Promise.resolve(
				request.asks.map((ask) => ask.messageId).filter((id) => finished.includes(id)),
			);
		},
	};
}

type ToolResult = { content: Array<{ text: string }>; isError: boolean; details?: Record<string, unknown> };
type Tool = {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

/** The owner's intercom tool holding `ask` from the child; its replies are refused as `refusal` says. */
function owner(refusal: { reason?: string; reasonCode?: string }, finished: readonly string[] = [], saves = true) {
	const tools = new Map<string, Tool>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const tracker = new ReplyTracker();
	tracker.recordIncomingMessage(child, question("ask-1"), 1);
	const sent: string[] = [];
	const client = {
		sessionId: "owner-intercom-id",
		async listSessions() {
			return [];
		},
		async send(to: string, message: { messageId?: string }) {
			sent.push(to);
			return { id: message.messageId ?? "sent", delivered: false, ...refusal };
		},
	};
	const pi = {
		registerTool(tool: Tool & { name: string }) {
			tools.set(tool.name, tool);
		},
		async appendEntry(customType: string, data: unknown) {
			if (!saves) throw new Error("disk full");
			appended.push({ customType, data });
		},
		events: subagentsAnswering(finished),
	};
	registerIntercomTool(
		pi as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			resolveSessionTarget: async (_client: object, target: string) => target,
			beginReplyWait: () => {
				throw new Error("a reply waits for nothing");
			},
			confirmSend: false,
			replyTracker: tracker,
		} as never,
	);
	const run = (params: Record<string, unknown>) => {
		const tool = tools.get("intercom");
		assert.ok(tool);
		return tool.execute("call", params, undefined, undefined, {
			sessionManager: { getSessionId: () => "owner-session" },
			hasUI: false,
		});
	};
	return {
		tracker,
		appended,
		sent,
		reply: () => run({ action: "reply", replyTo: "ask-1", message: "the answer" }),
		close: (replyTo: string) => run({ action: "cancel", replyTo }),
	};
}

const closedEntries = (appended: ReadonlyArray<{ customType: string; data: unknown }>) =>
	appended.filter((entry) => entry.customType === INTERCOM_ASK_CLOSED_ENTRY).map((entry) => entry.data);

describe("an ask no reply can reach is closed (#6168)", () => {
	test("a reply Intercom refuses for good closes the ask, which stays closed (#6168)", async () => {
		const h = owner({ reason: UNAUTHORIZED_REPLY_REASON });

		const result = await h.reply();

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /not delivered: Pending question route does not authorize/);
		assert.match(result.content[0]!.text, /Ask ask-1 is closed/);
		assert.equal(result.details?.askClosed, true);
		assert.deepEqual(h.tracker.listPending(), []);
		assert.deepEqual(closedEntries(h.appended), [{ messageId: "ask-1", reason: "route-expired" }]);
	});

	test("a reply to a subagent whose asking attempt is over closes the ask (#6168)", async () => {
		const h = owner({ reason: "Session not found", reasonCode: "session_not_found" }, ["ask-1"]);

		const result = await h.reply();

		assert.match(result.content[0]!.text, /not delivered: Session not found/);
		assert.match(result.content[0]!.text, /Ask ask-1 is closed/);
		assert.deepEqual(h.tracker.listPending(), []);
		assert.deepEqual(closedEntries(h.appended), [{ messageId: "ask-1", reason: "sender-ended" }]);
		assert.deepEqual(h.appended.length, 1, "closing writes no reply: nothing is recorded as sent");
	});

	for (const [refusal, why] of [
		[{ reason: "Session not found", reasonCode: "session_not_found" }, "a sender Intercom cannot find right now"],
		[{ reason: "No route yet", reasonCode: "route_unavailable" }, "a route still being restored"],
		[{ reason: "Session not found" }, "a refusal with no code"],
	] as const) {
		test(`an ask stays pending when its reply is refused for ${why} (#6168)`, async () => {
			const h = owner(refusal);

			const result = await h.reply();

			assert.doesNotMatch(result.content[0]!.text, /is closed/);
			assert.deepEqual(
				h.tracker.listPending().map((context) => context.message.id),
				["ask-1"],
			);
			assert.deepEqual(closedEntries(h.appended), []);
		});
	}
});

describe("the owner closes an ask it will not answer (#6168)", () => {
	test("cancel with replyTo closes that ask sent to it, sends nothing, and keeps it closed (#6168)", async () => {
		const h = owner({});

		const result = await h.close("ask-1");

		assert.equal(result.isError, false);
		assert.match(result.content[0]!.text, /Closed ask ask-1 from subagent-worker-run1-1 without replying/);
		assert.deepEqual(h.tracker.listPending(), []);
		assert.deepEqual(closedEntries(h.appended), [{ messageId: "ask-1", reason: "closed" }]);
		assert.deepEqual(h.sent, []);
	});

	test("an ask whose close cannot be saved stays pending, to be closed again (#6168)", async () => {
		const closing = owner({}, [], false);
		const result = await closing.close("ask-1");
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /was not closed/);

		const refused = owner({ reason: UNAUTHORIZED_REPLY_REASON }, [], false);
		const reply = await refused.reply();
		assert.doesNotMatch(reply.content[0]!.text, /is closed/);

		for (const h of [closing, refused])
			assert.deepEqual(
				h.tracker.listPending().map((context) => context.message.id),
				["ask-1"],
			);
	});

	test("cancel with replyTo refuses an id that names no ask sent to it (#6168)", async () => {
		const h = owner({});

		const result = await h.close("not-an-ask");

		assert.equal(result.isError, true);
		assert.deepEqual(
			h.tracker.listPending().map((context) => context.message.id),
			["ask-1"],
		);
		assert.deepEqual(closedEntries(h.appended), []);
	});
});

const COMPACTION: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 7,
	parameters: { query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	form: "compacted",
};

/** An owner session that registered with Intercom and was then asked `ids` by its subagent. */
async function askedOwner(ids: readonly string[], protectedCards = false): Promise<SessionManager> {
	const manager = SessionManager.inMemory();
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "work" }], timestamp: 1 });
	await manager.appendCustomEntry("intercom_session_identity", {
		sessionId: manager.getSessionId(),
		intercomSessionId: "owner-intercom-id",
	});
	for (const id of ids)
		await manager.appendCustomMessageEntry(
			"intercom_message",
			`question ${id}`,
			true,
			{ from: child, message: question(id) },
			true,
			protectedCards ? { delivery: "steer" } : undefined,
		);
	return manager;
}

function pendingAfterRestart(manager: SessionManager): string[] {
	const tracker = new ReplyTracker();
	restorePendingInboundAsks(
		tracker,
		manager.getBranch(),
		manager.getSessionId(),
		() => manager.getSessionRecoveryState().answeredInboundIds,
	);
	return tracker.listPending().map((context) => context.message.id);
}

function writer(manager: SessionManager, events: { emit(eventName: string, payload: unknown): void }) {
	return {
		events,
		appendEntry: async (customType: string, data: unknown) => {
			await manager.appendCustomEntry(customType, data);
		},
	};
}

describe("a restart closes the asks of subagent attempts that are over (#6168)", () => {
	test("closes, once, only the asks Subagents says no reply can reach (#6168)", async () => {
		const manager = await askedOwner(["ask-ended", "ask-live"]);
		const subagents = subagentsAnswering(["ask-ended"]);

		const notices = await closeFinishedChildAsks(writer(manager, subagents), { sessionManager: manager });

		assert.deepEqual(
			subagents.asked.flatMap((request) => request.asks.map((ask) => [ask.messageId, ask.from.name, ask.source])),
			[
				["ask-ended", child.name, { subagentRunId: "run1", subagentIndex: 0 }],
				["ask-live", child.name, { subagentRunId: "run1", subagentIndex: 0 }],
			],
		);
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /Closed 1 unanswered ask from subagents whose run that asked it has ended/);
		assert.match(notices[0]!, /ask-ended from `subagent-worker-run1-1`: question ask-ended/);
		assert.deepEqual(pendingAfterRestart(manager), ["ask-live"]);

		const again = subagentsAnswering(["ask-ended"]);
		assert.deepEqual(await closeFinishedChildAsks(writer(manager, again), { sessionManager: manager }), []);
		assert.deepEqual(
			again.asked.flatMap((request) => request.asks.map((ask) => ask.messageId)),
			["ask-live"],
			"a closed ask is not offered again",
		);
	});

	test("without Subagents nothing is closed (#6168)", async () => {
		const manager = await askedOwner(["ask-1"]);

		assert.deepEqual(await closeFinishedChildAsks(writer(manager, { emit() {} }), { sessionManager: manager }), []);
		assert.deepEqual(pendingAfterRestart(manager), ["ask-1"]);
	});

	test("a closed ask stays closed after a compaction keeps its card (#6168)", async () => {
		const manager = await askedOwner(["ask-1"], true);
		await closeFinishedChildAsks(writer(manager, subagentsAnswering(["ask-1"])), { sessionManager: manager });
		await manager.appendCompaction("summary", null, 100, COMPACTION);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "after" }], timestamp: 3 });
		// The window keeps the ask's card, whose turn never ran, but not the entry that closed it.
		const branch: SessionEntry[] = manager.getBranch();
		assert.ok(branch.some((entry) => entry.type === "custom_message" && entry.customType === "intercom_message"));
		assert.ok(!branch.some((entry) => entry.type === "custom" && entry.customType === INTERCOM_ASK_CLOSED_ENTRY));

		assert.deepEqual(pendingAfterRestart(manager), []);
	});

	test("a tracker that already held an ask lets it go once the ask is closed (#6168)", async () => {
		const manager = await askedOwner(["ask-1"]);
		const tracker = new ReplyTracker();
		restorePendingInboundAsks(tracker, manager.getBranch(), manager.getSessionId());
		assert.equal(tracker.listPending().length, 1);
		await closeFinishedChildAsks(writer(manager, subagentsAnswering(["ask-1"])), { sessionManager: manager });

		restorePendingInboundAsks(tracker, manager.getBranch(), manager.getSessionId());

		assert.deepEqual(tracker.listPending(), []);
	});
});
