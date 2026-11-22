import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { SessionNotFoundError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests, requestSql } from "../helpers/sqlite-connection-requests.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openStore(): Promise<{ readonly database: SqliteDatabase; readonly store: SqlSessionStore }> {
	const directory = makeTempDirectory("atomic-append-round-trips-");
	const database = await openNodeSqliteDatabase(join(directory, "store.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
		removeTempDirectory(directory);
	});
	return { database, store };
}

/** Counts the waits for a connection's thread: requests sent while none was in flight. */
function countWaits() {
	const sent: ConnectionRequest[] = [];
	let inFlight = 0;
	let waits = 0;
	const interception = interceptConnectionRequests((request, send) => {
		sent.push(request);
		if (inFlight === 0) waits += 1;
		inFlight += 1;
		return send(request).finally(() => {
			inFlight -= 1;
		});
	});
	cleanups.push(() => interception.restore());
	return {
		sent,
		take() {
			const counted = waits;
			waits = 0;
			sent.length = 0;
			return counted;
		},
	};
}

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-22T00:00:00.000Z" });
let nextId = 0;
function message(text: string, parentId: string | null): SessionEntry {
	nextId += 1;
	return {
		type: "message",
		id: `m${nextId}`,
		parentId,
		timestamp: "2026-11-22T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	} as SessionEntry;
}

test("creating a session and appending to it each wait for the connection's thread four times", async () => {
	const { store } = await openStore();
	const waits = countWaits();
	const created = await store.create(header("s1"), []);
	// The write lock, the version check with the session's lookup, the session's row, the commit.
	assert.equal(waits.take(), 4);
	const first = message("first", null);
	const appended = await store.append("s1", [first], { expectSeq: created.lastSeq, epoch: created.epoch });
	// The write lock, the version check with the session's row, its rows with their search texts, the commit.
	assert.equal(waits.take(), 4);
	await store.append("s1", [message("second", first.id), message("third", first.id)], {
		expectSeq: appended.lastSeq,
		epoch: created.epoch,
	});
	assert.equal(waits.take(), 4);
	const loaded = await store.load("s1");
	assert.deepEqual(
		loaded.entries.map((entry) =>
			entry.type === "message" && "content" in entry.message ? entry.message.content : "",
		),
		["first", "second", "third"],
	);
});

test("an append to a database a newer build upgraded fails as newer before anything is written, whatever else it meets", async () => {
	const { database, store } = await openStore();
	const created = await store.create(header("s1"), []);
	await database.run("UPDATE session_meta SET schema_version = 99");
	const waits = countWaits();
	await assert.rejects(
		store.append("s1", [message("lost", null)], { expectSeq: created.lastSeq, epoch: created.epoch }),
		StorageSchemaVersionError,
	);
	// The session the append names is gone too: still the version is what is reported.
	await database.run("DELETE FROM session_sessions WHERE id = 's1'");
	await assert.rejects(store.append("s1", [message("lost", null)], { expectSeq: 0 }), StorageSchemaVersionError);
	await assert.rejects(store.create(header("s2"), [message("lost", null)]), StorageSchemaVersionError);
	const writes = waits.sent.filter(
		(request) =>
			request.kind === "sequence" ||
			(/^\s*(INSERT|UPDATE|DELETE)/i.test(requestSql(request) ?? "") &&
				requestSql(request) !== "DELETE FROM session_sessions WHERE id = 's1'"),
	);
	assert.deepEqual(writes, [], "nothing was sent to be written once the version was known");
	await database.run("UPDATE session_meta SET schema_version = 1");
	const rows = await database.get<SqliteRow & { n: number }>("SELECT count(*) AS n FROM session_entries");
	assert.equal(rows?.n, 0);
	await assert.rejects(store.append("s1", [message("lost", null)], { expectSeq: 0 }), SessionNotFoundError);
});

/** The bytes a request to the connection's thread carries in its statements' text and parameters. */
function requestBytes(request: ConnectionRequest): number {
	const statements =
		request.kind === "sequence"
			? request.statements
			: request.kind === "run" || request.kind === "get" || request.kind === "all"
				? [request]
				: [];
	let bytes = 0;
	for (const { sql, params } of statements) {
		bytes += sql.length;
		for (const value of params)
			bytes += typeof value === "string" ? value.length : value instanceof Uint8Array ? value.byteLength : 8;
	}
	return bytes;
}

test("a large write sends its entries a few at a time as it makes them, not all in one request", async () => {
	const { store } = await openStore();
	let largest = 0;
	const interception = interceptConnectionRequests((request, send) => {
		largest = Math.max(largest, requestBytes(request));
		return send(request);
	});
	cleanups.push(() => interception.restore());
	const entries: SessionEntry[] = [];
	for (let index = 0; index < 24; index++)
		entries.push(message(`${index}`.padEnd(400 * 1024, "x"), entries.at(-1)?.id ?? null));
	const created = await store.create(header("bulk"), entries);
	assert.equal(created.lastSeq, 24);
	await store.append("bulk", [message("then one more", entries.at(-1)!.id)], {
		expectSeq: created.lastSeq,
		epoch: created.epoch,
	});
	// About 9.6 MiB of entries: no request carries more than one batch's worth and the entry that ended it.
	assert.ok(largest < 2 * 1024 * 1024, `the largest request carried ${largest} bytes`);
	assert.equal((await store.load("bulk")).entries.length, 25);
});
