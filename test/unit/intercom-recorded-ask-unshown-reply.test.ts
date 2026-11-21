import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { unconsumedIntercomInbox } from "../../packages/intercom/durable-inbox.js";

/**
 * A reopened session leaves out an ask whose outcome is recorded, and the replies that settled it. A message naming such
 * an ask that arrived later and was saved but not shown before the session stopped, such as a reply to an ask the
 * session had cancelled, is no such reply: it is still replayed after the restart (#3761).
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

const peer = { id: "peer-session", name: "subagent-worker-1", cwd: "/p", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

async function sqliteSession(): Promise<{ manager: SessionManager; reopen: () => Promise<SessionManager> }> {
	const directory = await mkdtemp(join(tmpdir(), "atomic-recorded-ask-"));
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
}

const records: ReadonlyArray<readonly [string, object]> = [
	["cancelled", { askId: "ask-1", state: "cancelled" }],
	["recorded answered in one entry with others", { askIds: ["ask-0", "ask-1"], state: "answered" }],
];

describe("a message naming an ask whose outcome is recorded", () => {
	for (const [how, record] of records)
		test(`is replayed after a restart when it was saved but not shown, for an ask ${how}`, async () => {
			const { manager, reopen } = await sqliteSession();
			await manager.appendCustomEntry("intercom_ask", {
				askId: "ask-1",
				sessionId: manager.getSessionId(),
				to: peer.name,
				recipientId: peer.id,
				question: "status?",
				askedAt: 1,
			});
			await manager.appendCustomEntry("intercom_ask_settled", record);
			await manager.appendCustomEntry("intercom_inbox", {
				message: { id: "late-1", timestamp: 2, replyTo: "ask-1", content: { text: "late answer" } },
				from: peer,
				receivedAt: 2,
			});
			await manager.appendCompaction("summary", null, 100, COMPACTION);
			await manager.appendMessage({ role: "user", content: [{ type: "text", text: "after" }], timestamp: 3 });

			const reopened = await reopen();

			assert.deepEqual(
				unconsumedIntercomInbox(reopened.getBranch(), reopened.getSessionRecoveryState().intercomTakenIds).map(
					(saved) => saved.message.id,
				),
				["late-1"],
			);
		});
});
