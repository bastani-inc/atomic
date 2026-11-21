import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { unconsumedIntercomInbox } from "../../packages/intercom/durable-inbox.ts";
import { OutboundAsks } from "../../packages/intercom/outbound-asks.ts";

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

const peer = {
	id: "peer-session",
	name: "subagent-worker-1",
	cwd: "/p",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

type Opened = (write: (manager: SessionManager) => Promise<void>) => Promise<SessionManager>;

/** The session as a restart opens it again: its saved window after a compaction. */
const stores: ReadonlyArray<readonly [string, Opened]> = [
	[
		"the live window after a compaction",
		async (write) => {
			const manager = SessionManager.inMemory();
			await write(manager);
			return manager;
		},
	],
	[
		"a SQLite session reopened after a compaction",
		async (write) => {
			const directory = await mkdtemp(join(tmpdir(), "atomic-6168-"));
			const database = await openNodeSqliteDatabase(join(directory, "sessions.db"));
			const store = await SqlSessionStore.open(database);
			cleanups.push(async () => {
				await store.close();
				await database.close();
				await rm(directory, { recursive: true, force: true });
			});
			const manager = await SessionManager.create(store, directory);
			await write(manager);
			return SessionManager.open(store, manager.getSessionId(), undefined, { history: "tail" });
		},
	],
];

/** The owner asks `ask-1`, and the reply arrives; `received` says whether the waiting ask took it. */
async function askAnswered(manager: SessionManager, received: boolean): Promise<void> {
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "earlier work" }], timestamp: 1 });
	await manager.appendCustomEntry("intercom_sent", {
		to: peer.name,
		message: { text: "status?" },
		messageId: "ask-1",
		timestamp: 1,
	});
	await manager.appendCustomEntry("intercom_ask", {
		askId: "ask-1",
		sessionId: manager.getSessionId(),
		to: peer.name,
		recipientId: peer.id,
		question: "status?",
		askedAt: 1,
	});
	await manager.appendCustomEntry("intercom_inbox", {
		message: { id: "reply-1", timestamp: 2, replyTo: "ask-1", content: { text: "done" } },
		from: peer,
		receivedAt: 2,
	});
	if (received)
		await manager.appendCustomEntry("intercom_received", {
			from: peer.name,
			message: { text: "done" },
			messageId: "reply-1",
			timestamp: 2,
		});
	await manager.appendCompaction("summary", null, 100, COMPACTION);
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "after" }], timestamp: 3 });
}

function inboxAfterRestart(manager: SessionManager): string[] {
	return unconsumedIntercomInbox(manager.getBranch(), manager.getSessionRecoveryState().intercomTakenIds).map(
		(record) => record.message.id,
	);
}

function askState(manager: SessionManager): string | undefined {
	return new OutboundAsks({
		entries: () => manager.getBranch(),
		sessionId: () => manager.getSessionId(),
		append: async () => {},
	}).find("ask-1")?.state;
}

describe.each(stores)("Intercom restart recovery from %s (#6168)", (_name, open) => {
	test("a reply its waiting ask received is not shown again (#6168)", async () => {
		const manager = await open((written) => askAnswered(written, true));
		// The window keeps the reply's saved arrival, which tells the ask was answered, without the entry that took it.
		assert.ok(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "intercom_inbox"));

		assert.deepEqual(inboxAfterRestart(manager), []);
		assert.equal(askState(manager), "answered");
	});

	test("a saved reply nothing took is still shown (#6168)", async () => {
		const manager = await open((written) => askAnswered(written, false));

		assert.deepEqual(inboxAfterRestart(manager), ["reply-1"]);
		assert.equal(askState(manager), "answered");
	});
});

test("what a resumed window reports it already took names only entries the window holds (#6168)", async () => {
	const manager = SessionManager.inMemory();
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "earlier work" }], timestamp: 1 });
	for (let index = 0; index < 200; index++) {
		const id = await manager.appendCustomMessageEntry(
			"intercom_message",
			"note",
			true,
			{
				from: peer,
				message: { id: `note-${index}`, timestamp: 1, content: { text: "note" } },
			},
			true,
			{ delivery: "steer" },
		);
		await manager.appendCustomMessageEntry(
			"atomic:protected-streaming-reconciliation",
			"note",
			false,
			{
				protectedReconciliationOf: id,
			},
			true,
		);
	}
	await askAnswered(manager, true);

	const recovery = manager.getSessionRecoveryState();

	assert.equal(recovery.reconciledCardIds, undefined, "settled cards the window left out are not listed");
	assert.deepEqual(recovery.intercomTakenIds, ["reply-1"]);
	assert.equal(recovery.answeredInboundIds, undefined);
});
