import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@bastani/atomic";
import { afterEach, describe, test } from "vitest";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { registerContactSupervisorTool } from "../../packages/intercom/contact-supervisor-tool.js";
import { unconsumedIntercomInbox } from "../../packages/intercom/durable-inbox.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { OutboundAsks, SETTLED_ASKS_PER_RECORD } from "../../packages/intercom/outbound-asks.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import { hasIntercomHistory } from "../../packages/intercom/session-recovery.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { sleep } from "../helpers/runtime.js";

/**
 * An ask this session sent stays in a reopened session until its outcome is recorded, with every message saved for it,
 * so a restart can tell its reply apart (#4751). Once its answer is recorded, a session reopened after a compaction keeps
 * neither, instead of carrying every answered ask's reply in every reopened session for good.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
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

const peer: SessionInfo = {
	id: "peer-session",
	name: "subagent-worker-1",
	cwd: "/p",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

interface Store {
	readonly manager: SessionManager;
	/** The session as a restart opens it again: its saved window. */
	reopen(): Promise<SessionManager>;
}

const stores: ReadonlyArray<readonly [string, () => Promise<Store>]> = [
	[
		"the live window",
		async () => {
			const manager = SessionManager.inMemory();
			return { manager, reopen: async () => manager };
		},
	],
	[
		"a SQLite session reopened",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "atomic-answered-ask-"));
			const database = await openNodeSqliteDatabase(join(directory, "sessions.db"));
			const store = await SqlSessionStore.open(database);
			cleanups.push(async () => {
				await store.close();
				await database.close();
				await rm(directory, { recursive: true, force: true });
			});
			const manager = await SessionManager.create(store, directory);
			return {
				manager,
				reopen: () => SessionManager.open(store, manager.getSessionId(), undefined, { history: "tail" }),
			};
		},
	],
];

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

/** This session's Intercom tools over `manager`, with replies saved on arrival as the durable inbox saves them. */
function tools(manager: SessionManager) {
	const registered = new Map<string, Tool>();
	const waiters = new ReplyWaiterRegistry();
	const asked: Array<{ to: string; messageId: string }> = [];
	const send = async (to: string, message: { messageId?: string }) => {
		asked.push({ to, messageId: message.messageId ?? "sent" });
		return { id: message.messageId ?? "sent", delivered: true };
	};
	const pi = {
		registerTool(tool: Tool & { name: string }) {
			registered.set(tool.name, tool);
		},
		async appendEntry(customType: string, data: unknown) {
			await manager.appendCustomEntry(customType, data);
		},
	};
	const common = {
		ensureConnected: async () => ({
			sessionId: "self-id",
			listSessions: async () => [peer],
			send,
			sendToSupervisor: send,
		}),
		syncPresenceIdentity() {},
		resolveSessionTarget: async () => peer.id,
		beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
	};
	registerIntercomTool(
		pi as never,
		{
			...common,
			confirmSend: false,
			replyTracker: new ReplyTracker(),
			outboundAsks: new OutboundAsks({
				entries: () => manager.getBranch(),
				append: (customType, data) => manager.appendCustomEntry(customType, data).then(() => {}),
				sessionId: () => manager.getSessionId(),
			}),
		} as never,
	);
	registerContactSupervisorTool(
		pi as never,
		{
			...common,
			childOrchestratorMetadata: {
				orchestratorTarget: peer.name,
				runId: "run",
				agent: "worker",
				index: 0,
				sessionName: "child-0",
			},
		} as never,
	);
	const context = { sessionManager: manager, hasUI: false };
	return {
		run(name: string, params: Record<string, unknown>) {
			const tool = registered.get(name);
			assert.ok(tool);
			return tool.execute("call", params, undefined, undefined, context);
		},
		/** The peer answers the question asked last: the reply is saved as it arrives, then reaches the waiting call. */
		async answer(text: string): Promise<Message> {
			for (let waited = 0; asked.length === 0 || waiters.pending().length === 0; waited += 1) {
				assert.ok(waited < 2_000, "the question was never asked");
				await sleep(1);
			}
			const question = asked.at(-1)!;
			const reply: Message = {
				id: `reply-${question.messageId}`,
				timestamp: 2,
				replyTo: question.messageId,
				content: { text },
			};
			await manager.appendCustomEntry("intercom_inbox", { message: reply, from: peer, receivedAt: 2 });
			assert.equal(routeIncomingReply(waiters.pending(), peer, reply), true);
			return reply;
		},
	};
}

async function compacted(manager: SessionManager): Promise<void> {
	await manager.appendCompaction("summary", null, 100, COMPACTION);
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "after" }], timestamp: 3 });
}

function kept(manager: SessionManager, customType: string): SessionEntry[] {
	return manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === customType);
}

describe.each(stores)("an answered ask in %s", (_name, open) => {
	test("a reopened session keeps neither an ask whose waiting call took its answer nor that answer", async () => {
		const { manager, reopen } = await open();
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "earlier work" }], timestamp: 1 });
		const intercom = tools(manager);

		const asking = intercom.run("intercom", { action: "ask", to: peer.name, message: "status?" });
		await intercom.answer("done");
		const result = await asking;
		assert.match(result.content[0]!.text, /done/);
		await compacted(manager);
		const reopened = await reopen();

		assert.deepEqual(kept(reopened, "intercom_ask"), []);
		assert.deepEqual(kept(reopened, "intercom_inbox"), []);
		assert.deepEqual(
			unconsumedIntercomInbox(reopened.getBranch(), reopened.getSessionRecoveryState().intercomTakenIds),
			[],
		);
	});

	test("a reopened subagent keeps no reply its supervisor gave to a question it asked", async () => {
		const { manager, reopen } = await open();
		const intercom = tools(manager);

		const asking = intercom.run("contact_supervisor", { reason: "need_decision", message: "which file?" });
		await intercom.answer("config.ts");
		assert.match((await asking).content[0]!.text, /config\.ts/);
		await compacted(manager);

		assert.deepEqual(kept(await reopen(), "intercom_inbox"), []);
	});
});

/** An ask this session sent to `peer`, saved as the ask action saves it once the question is delivered. */
async function asked(manager: SessionManager, askId: string): Promise<void> {
	await manager.appendCustomEntry("intercom_ask", {
		askId,
		sessionId: manager.getSessionId(),
		to: peer.name,
		recipientId: peer.id,
		question: `question ${askId}?`,
		askedAt: 1,
	});
}

function replyTo(askId: string, overrides: Partial<Message> = {}): Message {
	return { id: `reply-${askId}`, timestamp: 2, replyTo: askId, content: { text: `answer ${askId}` }, ...overrides };
}

/** A reply saved as it arrived, and, with `taken`, received by the ask's waiting call, as earlier versions saved it. */
async function arrived(manager: SessionManager, message: Message, from = peer, taken = true): Promise<void> {
	await manager.appendCustomEntry("intercom_inbox", { message, from, receivedAt: 2 });
	if (taken)
		await manager.appendCustomEntry("intercom_received", {
			from: from.name,
			message: { text: "x" },
			messageId: message.id,
			timestamp: 2,
		});
}

/** A reply shown to the model as a message, as a reply to an ask no call waits for is. */
async function shown(manager: SessionManager, message: Message, from = peer): Promise<void> {
	await manager.appendCustomMessageEntry(
		"intercom_message",
		message.content.text,
		true,
		{ from, message, bodyText: message.content.text },
		true,
	);
}

function asksOf(manager: SessionManager): OutboundAsks {
	return new OutboundAsks({
		entries: () => manager.getBranch(),
		append: (customType, data) => manager.appendCustomEntry(customType, data).then(() => {}),
		sessionId: () => manager.getSessionId(),
	});
}

/** What a restart does with the session it reopens: it records the answers taken without a record. */
async function restarted(store: Store): Promise<SessionManager> {
	const reopened = await store.reopen();
	await asksOf(reopened).recordTakenAnswers(reopened.getSessionRecoveryState().intercomTakenIds);
	return reopened;
}

// A restart reopens a saved session; a live session's window changes only at its next compaction.
describe.each(stores.filter(([name]) => name.startsWith("a SQLite")))("a restart of %s", (_name, open) => {
	test("records the answers an earlier version took without a record, so the next reopened session keeps none of them", async () => {
		const store = await open();
		const { manager } = store;
		await asked(manager, "ask-inline");
		await arrived(manager, replyTo("ask-inline"));
		await asked(manager, "ask-shown");
		await arrived(manager, replyTo("ask-shown"), peer, false);
		await shown(manager, replyTo("ask-shown"));
		await compacted(manager);

		const first = await restarted(store);
		assert.equal(kept(first, "intercom_ask").length, 2, "the first reopened session still holds what was saved");
		const second = await store.reopen();

		assert.deepEqual(kept(second, "intercom_ask"), []);
		assert.deepEqual(kept(second, "intercom_inbox"), []);
		assert.deepEqual(
			second
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "intercom_message"),
			[],
		);
	});

	test("keeps an ask whose saved reply was never shown, and replays that reply as its answer", async () => {
		const store = await open();
		const { manager } = store;
		await asked(manager, "ask-1");
		await arrived(manager, replyTo("ask-1"), peer, false);
		await compacted(manager);

		await restarted(store);
		const reopened = await restarted(store);

		const unshown = unconsumedIntercomInbox(
			reopened.getBranch(),
			reopened.getSessionRecoveryState().intercomTakenIds,
		);
		assert.deepEqual(
			unshown.map((record) => record.message.id),
			["reply-ask-1"],
		);
		assert.equal(asksOf(reopened).answeredBy(peer, unshown[0]!.message)?.ask.question, "question ask-1?");
	});

	test("keeps a failed ask, whose later answer is still shown as its answer, and an ask only another session replied to", async () => {
		const store = await open();
		const { manager } = store;
		await asked(manager, "ask-failed");
		await arrived(manager, replyTo("ask-failed", { id: "failure", replyError: "Session ended before replying" }));
		await asksOf(manager).recordAnswered("ask-failed");
		await arrived(manager, replyTo("ask-failed"), peer, false);
		await asked(manager, "ask-stranger");
		const stranger: SessionInfo = { ...peer, id: "stranger", name: "stranger" };
		await arrived(manager, replyTo("ask-stranger"), stranger);
		await compacted(manager);

		const reopened = await restarted(store);
		const again = await restarted(store);

		assert.deepEqual(
			kept(again, "intercom_ask").map((entry) => (entry as { data: { askId: string } }).data.askId),
			["ask-failed", "ask-stranger"],
		);
		assert.equal(asksOf(again).find("ask-stranger")?.state, "pending");
		assert.equal(asksOf(again).answeredBy(peer, replyTo("ask-failed"))?.ask.question, "question ask-failed?");
		assert.deepEqual(kept(reopened, "intercom_ask_settled"), []);
	});

	test("still replays unconsumed inbox arrivals whose ask is already settled or closed after compaction", async () => {
		const store = await open();
		const { manager } = store;
		const stranger: SessionInfo = { ...peer, id: "stranger", name: "stranger" };

		// Unconsumed arrival saved before an outbound ask is settled as answered (single askId).
		await asked(manager, "ask-answered-before");
		await arrived(manager, replyTo("ask-answered-before"));
		await arrived(manager, replyTo("ask-answered-before", { id: "unshown-before-answered" }), stranger, false);
		await asksOf(manager).recordAnswered("ask-answered-before");

		// Unconsumed arrival saved before an outbound ask is cancelled (single askId).
		await asked(manager, "ask-cancelled-before");
		await arrived(manager, replyTo("ask-cancelled-before", { id: "unshown-before-cancelled" }), stranger, false);
		assert.equal(await asksOf(manager).settle("ask-cancelled-before", "cancelled"), true);

		// Unconsumed arrival saved after an outbound ask is settled as answered (single askId).
		await asked(manager, "ask-answered-after");
		await arrived(manager, replyTo("ask-answered-after"));
		await asksOf(manager).recordAnswered("ask-answered-after");
		await arrived(manager, replyTo("ask-answered-after", { id: "unshown-after-answered" }), peer, false);

		// Unconsumed arrival saved after an outbound ask is cancelled (single askId).
		await asked(manager, "ask-cancelled-after");
		assert.equal(await asksOf(manager).settle("ask-cancelled-after", "cancelled"), true);
		await arrived(manager, replyTo("ask-cancelled-after", { id: "unshown-after-cancelled" }), peer, false);

		// Unconsumed arrivals saved before and after a batched settle record (askIds).
		await asked(manager, "ask-batch");
		await arrived(manager, replyTo("ask-batch"));
		await arrived(manager, replyTo("ask-batch", { id: "unshown-before-batch" }), stranger, false);
		await manager.appendCustomEntry("intercom_ask_settled", { askIds: ["ask-batch"], state: "answered" });
		await arrived(manager, replyTo("ask-batch", { id: "unshown-after-batch" }), peer, false);

		// Unconsumed inbound ask arrivals whose ask is closed (single messageId and batched messageIds).
		await arrived(
			manager,
			{ id: "inbound-closed-single", timestamp: 2, expectsReply: true, content: { text: "single?" } },
			peer,
			false,
		);
		await manager.appendCustomEntry("intercom_ask_closed", {
			messageId: "inbound-closed-single",
			reason: "sender-ended",
		});
		await arrived(
			manager,
			{ id: "inbound-closed-batch", timestamp: 2, expectsReply: true, content: { text: "batch?" } },
			peer,
			false,
		);
		await manager.appendCustomEntry("intercom_ask_closed", {
			messageIds: ["inbound-closed-batch"],
			reason: "closed",
		});

		await compacted(manager);

		const expectedIds = [
			"unshown-before-answered",
			"unshown-before-cancelled",
			"unshown-after-answered",
			"unshown-after-cancelled",
			"unshown-before-batch",
			"unshown-after-batch",
			"inbound-closed-single",
			"inbound-closed-batch",
		];
		for (const reopened of [await restarted(store), await restarted(store)]) {
			assert.deepEqual(kept(reopened, "intercom_ask"), []);
			assert.deepEqual(
				unconsumedIntercomInbox(reopened.getBranch(), reopened.getSessionRecoveryState().intercomTakenIds).map(
					(record) => record.message.id,
				),
				expectedIds,
			);
			assert.deepEqual(
				kept(reopened, "intercom_inbox").map(
					(entry) => (entry as { data: { message: { id: string } } }).data.message.id,
				),
				expectedIds,
			);
		}
	});
});

test("a restart records many taken answers in one bounded entry, and the rest at the next restart", async () => {
	const manager = SessionManager.inMemory();
	const total = SETTLED_ASKS_PER_RECORD + 20;
	for (let index = 0; index < total; index += 1) {
		await asked(manager, `ask-${index}`);
		await arrived(manager, replyTo(`ask-${index}`));
	}
	const store = { manager, reopen: async () => manager };

	await restarted(store);
	await restarted(store);
	await restarted(store);

	const records = kept(manager, "intercom_ask_settled").map(
		(entry) => (entry as { data: { askIds: string[] } }).data.askIds.length,
	);
	assert.deepEqual(records, [SETTLED_ASKS_PER_RECORD, 20]);
});

test("a reopened session with a pending ask still joins Intercom at recovery after its answered asks are recorded", async () => {
	const [, open] = stores.find(([name]) => name.startsWith("a SQLite"))!;
	const store = await open();
	const { manager } = store;
	await asked(manager, "ask-answered");
	await arrived(manager, replyTo("ask-answered"));
	await asksOf(manager).recordAnswered("ask-answered");
	await asked(manager, "ask-pending");
	await compacted(manager);

	const reopened = await restarted(store);

	assert.deepEqual(
		kept(reopened, "intercom_ask").map((entry) => (entry as { data: { askId: string } }).data.askId),
		["ask-pending"],
	);
	// Its reply may be held for it at the broker: a restart connects to Intercom to take it.
	assert.equal(hasIntercomHistory(reopened.getEntries()), true);
});
