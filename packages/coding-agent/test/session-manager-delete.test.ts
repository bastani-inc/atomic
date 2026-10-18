import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SessionNotFoundError } from "../src/core/storage/session/errors.js";
import type { SessionStore } from "../src/core/storage/session/types.js";

const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

async function countRows(databasePath: string, sessionId: string): Promise<{ entries: number; sessions: number }> {
	const database = await openNodeSqliteDatabase(databasePath);
	try {
		const entries = await database.all<{ count: number }>(
			"SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
			sessionId,
		);
		const sessions = await database.all<{ count: number }>(
			"SELECT COUNT(*) AS count FROM session_sessions WHERE id = ?",
			sessionId,
		);
		return { entries: entries[0]!.count, sessions: sessions[0]!.count };
	} finally {
		await database.close();
	}
}

describe("SessionManager.deleteSession", () => {
	let root: string;
	let store: SessionStore | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "session-manager-delete-"));
	});

	afterEach(async () => {
		await store?.close();
		store = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	it("deletes another SQLite session with its entries and refuses the open one (#3740)", async () => {
		const databasePath = join(root, "sessions.sqlite");
		store = await resolveSessionStore(root, { sessionStore: { kind: "sqlite", path: databasePath, prefix: "" } });
		const other = await SessionManager.create(store, root);
		await other.appendMessage(message("to be deleted"));
		const current = await SessionManager.create(store, root);
		await current.appendMessage(message("keep me"));
		assert.deepEqual(await countRows(databasePath, other.getSessionId()), { entries: 1, sessions: 1 });

		await current.deleteSession(other.getSessionId());

		await assert.rejects(store.load(other.getSessionId()), SessionNotFoundError);
		assert.deepEqual(
			(await SessionManager.list(root, store)).map((info) => info.id),
			[current.getSessionId()],
		);
		assert.deepEqual(await countRows(databasePath, other.getSessionId()), { entries: 0, sessions: 0 });

		await assert.rejects(current.deleteSession(current.getSessionId()), /currently open/);
		assert.equal((await store.load(current.getSessionId())).entries.length, 1);
		assert.deepEqual(await countRows(databasePath, current.getSessionId()), { entries: 1, sessions: 1 });
	});

	it("deletes through the default SQLite store and ignores unknown ids (#3740)", async () => {
		store = await resolveSessionStore(root, { agentDir: join(root, "agent") });
		const other = await SessionManager.create(store, root);
		await other.appendMessage(message("old"));
		const current = await SessionManager.create(store, root);
		await current.appendMessage(message("new"));

		await current.deleteSession(other.getSessionId());
		await current.deleteSession("does-not-exist");

		await assert.rejects(store.load(other.getSessionId()), SessionNotFoundError);
		await assert.rejects(current.deleteSession(current.getSessionId()), /currently open/);
		assert.equal((await store.load(current.getSessionId())).entries.length, 1);
	});

	it("keeps deleting JSONL sessions (#3740)", async () => {
		const sessionDir = join(root, "sessions");
		const other = await SessionManager.create(root, sessionDir);
		await other.appendMessage(message("old"));
		const current = await SessionManager.create(root, sessionDir);
		await current.appendMessage(message("new"));
		const otherFile = other.getSessionFile()!;
		assert.equal(existsSync(otherFile), true);

		await current.deleteSession(other.getSessionId());

		assert.equal(existsSync(otherFile), false);
		await assert.rejects(current.deleteSession(current.getSessionId()), /currently open/);
		assert.equal(existsSync(current.getSessionFile()!), true);
		assert.deepEqual(
			(await SessionManager.list(root, sessionDir)).map((info) => info.id),
			[current.getSessionId()],
		);
		await current.getSessionStore().close();
		await other.getSessionStore().close();
	});
});
