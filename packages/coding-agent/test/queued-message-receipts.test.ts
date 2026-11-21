/**
 * A replacement engine finds which queued messages the lost one saved by their receipts: a message found is saved,
 * wherever it is in the session; one not found is provably unsaved only on a store whose writes end with its writer, of
 * the generation the receipt names, read whole after the receipt's anchor.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { removeTestDirectory } from "../../../test/helpers/test-directory-removal.js";
import { findQueuedMessages } from "../src/core/queued-message-receipts.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";

const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	while (directories.length > 0) removeTestDirectory(directories.pop()!, { retries: 10, retryDelayMs: 100 });
});

async function storeOf(kind: "jsonl" | "node-sqlite"): Promise<SessionStore> {
	const directory = mkdtempSync(join(tmpdir(), "queued-message-receipts-"));
	directories.push(directory);
	if (kind === "jsonl") return JsonlSessionStore.open(directory, { exactDirectory: true });
	const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	closers.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/**
 * A lost engine's session: an earlier exchange, then queued message `saved` taken after it and saved, then the session
 * moved back to the earlier message and went on there, so the saved message is on a branch the session no longer shows.
 */
async function lostEngineSession(writer: SessionManager) {
	const earlier = await writer.appendMessage(user("earlier"));
	const anchor = { after: writer.getLastSeq(), epoch: writer.getHistoryEpoch() };
	await writer.appendMessage(user("queued and saved"), { queuedMessageId: "saved" });
	await writer.branch(earlier);
	await writer.appendMessage(user("went on elsewhere"));
	return anchor;
}

describe.each(["jsonl", "node-sqlite"] as const)("on a %s store", (kind) => {
	test("a saved message is found off the current branch, and one never saved is provably absent", async () => {
		const store = await storeOf(kind);
		const writer = await SessionManager.create(store, tmpdir());
		const anchor = await lostEngineSession(writer);
		const replacement = await SessionManager.open(store, writer.getSessionId());
		assert.equal(
			replacement.getBranch().some((entry) => entry.type === "message" && entry.queuedMessageId === "saved"),
			false,
			"the saved message is not on the branch the replacement shows",
		);

		const found = await findQueuedMessages(replacement, { ids: ["saved", "never saved"], ...anchor });

		assert.deepEqual(found, { saved: ["saved"], absent: ["never saved"] });
	});

	test("nothing is provably absent in another generation of the session than the one the receipt names", async () => {
		const store = await storeOf(kind);
		const writer = await SessionManager.create(store, tmpdir());
		const anchor = await lostEngineSession(writer);
		const replacement = await SessionManager.open(store, writer.getSessionId());

		const found = await findQueuedMessages(replacement, {
			ids: ["saved", "never saved"],
			after: anchor.after,
			epoch: "another generation",
		});

		assert.deepEqual(found.absent, []);
	});
});

test("a store a lost writer may still write to proves nothing absent, though it finds what is saved", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage(user("earlier"));
	const anchor = { after: session.getLastSeq(), epoch: session.getHistoryEpoch() };
	await session.appendMessage(user("queued and saved"), { queuedMessageId: "saved" });

	const found = await findQueuedMessages(session, { ids: ["saved", "never saved"], ...anchor });

	assert.deepEqual(found, { saved: ["saved"], absent: [] });
});
