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
import { CLOSED_ASKS_LISTED, closeFinishedChildAsks } from "../../packages/intercom/finished-asks.js";
import {
	INTERCOM_ASK_CLOSED_ENTRY,
	ReplyTracker,
	restorePendingInboundAsks,
} from "../../packages/intercom/reply-tracker.js";
import { SUBAGENT_FINISHED_ASKS_EVENT } from "../../packages/intercom/session-recovery.js";

/**
 * A restart closes the asks of subagents that ended (#6168). It records them in a few entries, not one per ask, so a
 * session holding many does not wait for a write each before its recovery notice, and the notice names a bounded
 * number of them.
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

const child = {
	id: "child-intercom-id",
	name: "subagent-worker-run1-1",
	cwd: "/p",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

async function sqliteSession(): Promise<{ manager: SessionManager; reopen: () => Promise<SessionManager> }> {
	const directory = await mkdtemp(join(tmpdir(), "atomic-batched-closes-"));
	const database = await openNodeSqliteDatabase(join(directory, "sessions.db"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
		await rm(directory, { recursive: true, force: true });
	});
	const manager = await SessionManager.create(store, directory);
	return { manager, reopen: () => SessionManager.open(store, manager.getSessionId(), undefined, { history: "tail" }) };
}

/** An owner holding `count` unanswered asks of a subagent that ended, with ids `ask-<n>` padded to `idLength`. */
async function ownerHolding(manager: SessionManager, count: number, idLength = 0): Promise<string[]> {
	await manager.appendCustomEntry("intercom_session_identity", {
		sessionId: manager.getSessionId(),
		intercomSessionId: "owner-intercom-id",
	});
	const ids: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const id = `ask-${index}`.padEnd(idLength, "x");
		ids.push(id);
		const message = {
			id,
			timestamp: 1,
			expectsReply: true,
			source: { subagentRunId: "run1", subagentIndex: 0 },
			content: { text: `question ${index}` },
		};
		await manager.appendCustomMessageEntry(
			"intercom_message",
			message.content.text,
			true,
			{ from: child, message },
			true,
		);
	}
	return ids;
}

/** Subagents, answering that every ask came from a subagent that ended; and the session's writes, failing as `fails` says. */
function closer(manager: SessionManager, fails: (call: number) => boolean = () => false) {
	let calls = 0;
	return {
		events: {
			emit(eventName: string, payload: unknown) {
				if (eventName !== SUBAGENT_FINISHED_ASKS_EVENT) return;
				const request = payload as { asks: { messageId: string }[]; completion?: Promise<readonly string[]> };
				request.completion = Promise.resolve(request.asks.map((ask) => ask.messageId));
			},
		},
		async appendEntry(customType: string, data: unknown) {
			calls += 1;
			if (fails(calls)) throw new Error("disk full");
			await manager.appendCustomEntry(customType, data);
		},
	};
}

function closedEntries(manager: SessionManager): SessionEntry[] {
	return manager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === INTERCOM_ASK_CLOSED_ENTRY);
}

function pendingIds(manager: SessionManager): string[] {
	const tracker = new ReplyTracker();
	restorePendingInboundAsks(tracker, manager.getBranch(), manager.getSessionId());
	return tracker.listPending().map((context) => context.message.id);
}

describe("closing the asks of subagents that ended at a restart", () => {
	test("records many asks in a few entries, and its notice names a bounded number of them", async () => {
		const manager = SessionManager.inMemory("/repo");
		await ownerHolding(manager, 1_000);

		const notices = await closeFinishedChildAsks(closer(manager), { sessionManager: manager });

		assert.equal(closedEntries(manager).length, 2);
		assert.deepEqual(pendingIds(manager), []);
		assert.equal(notices.length, 1);
		const listed = notices[0]!.split("\n").filter((line) => line.startsWith("- ask-"));
		assert.equal(listed.length, CLOSED_ASKS_LISTED);
		assert.match(notices[0]!, /^Closed 1000 unanswered asks/);
		assert.match(notices[0]!, new RegExp(`- and ${1_000 - CLOSED_ASKS_LISTED} more$`));
	});

	test("keeps each entry small when the asks' ids are long", async () => {
		const manager = SessionManager.inMemory("/repo");
		await ownerHolding(manager, 10, 5_000);

		await closeFinishedChildAsks(closer(manager), { sessionManager: manager });

		assert.ok(closedEntries(manager).length >= 2);
		for (const entry of closedEntries(manager))
			assert.ok(JSON.stringify((entry as { data: unknown }).data).length < 40_000);
		assert.deepEqual(pendingIds(manager), []);
	});

	test("asks closed together stay closed in the session reopened after a compaction", async () => {
		const { manager, reopen } = await sqliteSession();
		await ownerHolding(manager, 30);
		await closeFinishedChildAsks(closer(manager), { sessionManager: manager });
		await manager.appendCompaction("summary", null, 100, COMPACTION);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "after" }], timestamp: 3 });

		const reopened = await reopen();

		assert.deepEqual(pendingIds(reopened), []);
		assert.equal(
			reopened
				.getBranch()
				.some((entry) => entry.type === "custom_message" && entry.customType === "intercom_message"),
			false,
			"the reopened session still holds the closed asks",
		);
	});

	test("asks whose record was not saved stay pending, and the notice names only those closed", async () => {
		const manager = SessionManager.inMemory("/repo");
		const ids = await ownerHolding(manager, 600);

		const notices = await closeFinishedChildAsks(
			closer(manager, (call) => call === 1),
			{ sessionManager: manager },
		);

		assert.match(notices[0]!, /^Closed 100 unanswered asks/);
		assert.deepEqual(pendingIds(manager), ids.slice(0, 500));
	});

	test("a single ask is recorded as before", async () => {
		const manager = SessionManager.inMemory("/repo");
		await ownerHolding(manager, 1);

		await closeFinishedChildAsks(closer(manager), { sessionManager: manager });

		assert.deepEqual(
			closedEntries(manager).map((entry) => (entry as { data: unknown }).data),
			[{ messageId: "ask-0", reason: "sender-ended" }],
		);
	});
});

test("a reopened session reads asks closed one at a time and asks closed together alike", async () => {
	const { manager, reopen } = await sqliteSession();
	await ownerHolding(manager, 4);
	await manager.appendCustomEntry(INTERCOM_ASK_CLOSED_ENTRY, { messageId: "ask-0", reason: "closed" });
	await manager.appendCustomEntry(INTERCOM_ASK_CLOSED_ENTRY, {
		messageIds: ["ask-1", "ask-2"],
		reason: "sender-ended",
	});

	assert.deepEqual(pendingIds(manager), ["ask-3"]);
	await manager.appendCompaction("summary", null, 100, COMPACTION);
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "after" }], timestamp: 3 });
	assert.deepEqual(pendingIds(await reopen()), ["ask-3"]);
});

/**
 * Moving back to an entry before the latest compaction reopens the session from a resume index rebuilt from its saved
 * entries. Asks recorded together, closed or answered, stay out of that rebuilt window too.
 */
test("asks recorded together stay out of a window rebuilt for an entry before the latest compaction", async () => {
	const { manager, reopen } = await sqliteSession();
	await ownerHolding(manager, 3);
	await closeFinishedChildAsks(closer(manager), { sessionManager: manager });
	await manager.appendCustomEntry("intercom_ask", {
		askId: "outbound-1",
		sessionId: manager.getSessionId(),
		to: child.name,
		recipientId: child.id,
		question: "status?",
		askedAt: 1,
	});
	await manager.appendCustomEntry("intercom_ask_settled", { askIds: ["outbound-1"], state: "answered" });
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "A" }], timestamp: 2 });
	await manager.appendCompaction("summary", null, 100, COMPACTION);
	const kept = await manager.appendMessage({ role: "user", content: [{ type: "text", text: "B" }], timestamp: 3 });
	await manager.appendCompaction("summary 2", null, 100, COMPACTION);
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "D" }], timestamp: 4 });

	const moved = await reopen();
	await moved.recordBranch(kept);
	const reopened = await reopen();

	for (const session of [moved, reopened]) {
		assert.deepEqual(pendingIds(session), []);
		assert.equal(
			session
				.getBranch()
				.some((entry) => entry.type === "custom_message" && entry.customType === "intercom_message"),
			false,
		);
		assert.equal(
			session.getBranch().some((entry) => entry.type === "custom" && entry.customType === "intercom_ask"),
			false,
		);
	}
});
