import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

/**
 * A node-sqlite connection reads against one snapshot in one request, without the write lock (#5376), and a session
 * store loads a session that way when its entries fit one page.
 */

/** How long another connection holds the write lock: far longer than a load that does not wait for it takes. */
const HOLD_MS = 2_000;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function store(): Promise<{ store: SqlSessionStore; database: SqliteDatabase; path: string }> {
	const directory = makeTempDirectory("node-sqlite-snapshot-reads-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "sessions.sqlite");
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(() => database.close());
	return { store: await SqlSessionStore.open(database), database, path };
}

function entries(sessionId: string, count: number): SessionEntry[] {
	let parentId: string | null = null;
	return Array.from({ length: count }, (_, index) => {
		const id = `${sessionId}-${index}`;
		const entry = {
			type: "message",
			id,
			parentId,
			timestamp: "2026-11-18T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: `entry ${index}` }], timestamp: index },
		} as SessionEntry;
		parentId = id;
		return entry;
	});
}

async function create(sessions: SqlSessionStore, id: string, count: number): Promise<void> {
	await sessions.create(
		{ id, version: SESSION_FORMAT_VERSION, cwd: "/project", createdAt: "2026-11-18T00:00:00.000Z" },
		entries(id, count),
	);
}

test("loading a session whose entries fit one page is one snapshot read, with no write lock (#5376)", async () => {
	const { store: sessions } = await store();
	await create(sessions, "small", 40);
	const kinds: string[] = [];
	const interception = interceptConnectionRequests((request, send) => {
		kinds.push(request.kind);
		return send(request);
	});
	cleanups.push(interception.restore);
	const loaded = await sessions.load("small");
	interception.restore();
	assert.deepEqual(kinds, ["read"]);
	assert.equal(loaded.entries.length, 40);
	assert.equal(loaded.lastSeq, 40);
});

test("a session loads while another connection holds the write lock (#5376)", async () => {
	const { store: sessions, path } = await store();
	await create(sessions, "held", 10);
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	cleanups.push(() => {
		if (other.isTransaction) other.exec("COMMIT");
		other.close();
	});
	const outcome = await Promise.race([
		sessions.load("held").then((snapshot) => `loaded ${snapshot.entries.length}`),
		realSleep(HOLD_MS).then(() => "waited for the write lock"),
	]);
	other.exec("COMMIT");
	assert.equal(outcome, "loaded 10");
});

test("a session larger than one page loads as it always did, every entry in order (#5376)", async () => {
	const { store: sessions } = await store();
	await create(sessions, "large", 1_500);
	const loaded = await sessions.load("large");
	assert.equal(loaded.entries.length, 1_500);
	assert.deepEqual(
		loaded.entries.map((entry) => entry.id),
		entries("large", 1_500).map((entry) => entry.id),
	);
});

test("a session changed between the snapshot read of its first page and the rest of its load is read again from its first entry (#5376)", async () => {
	const { store: sessions, path } = await store();
	await create(sessions, "changing", 1_500);
	const changed = { ...entries("changing", 1)[0]!, id: "changing-0", timestamp: "2026-11-18T01:00:00.000Z" };
	const interception = interceptConnectionRequests(async (request, send) => {
		const answer = await send(request);
		if (request.kind === "read") {
			// Another process rewrites the first entry, as a write does, with a new revision.
			const other = new DatabaseSync(path);
			try {
				other.prepare("UPDATE session_entries SET entry_json = ? WHERE seq = 1").run(JSON.stringify(changed));
				other.prepare("UPDATE session_sessions SET revision = 'rewritten' WHERE id = ?").run("changing");
			} finally {
				other.close();
			}
		}
		return answer;
	});
	cleanups.push(interception.restore);
	const loaded = await sessions.load("changing");
	interception.restore();
	assert.equal(loaded.entries.length, 1_500);
	assert.equal(loaded.entries[0]!.timestamp, changed.timestamp, "the first entry as it is now, not as first read");
});

test("a snapshot read refuses a statement that would write, and writes nothing (#5376)", async () => {
	const { database } = await store();
	await database.exec("CREATE TABLE items (n INTEGER NOT NULL)");
	await assert.rejects(
		database.readStatements!([{ sql: "INSERT INTO items VALUES (1)", params: [] }]),
		/readonly|read-only|attempt to write/i,
	);
	await database.run("INSERT INTO items VALUES (2)");
	assert.deepEqual(await database.all("SELECT n FROM items"), [{ n: 2 }], "the connection writes again after it");
});
