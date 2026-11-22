import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { statementBatch } from "../../packages/coding-agent/src/core/storage/statement-sequence.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests, requestSql } from "../helpers/sqlite-connection-requests.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function databaseFile(
	name = "store.sqlite",
): Promise<{ readonly path: string; readonly database: SqliteDatabase }> {
	const directory = makeTempDirectory("atomic-open-round-trips-");
	const path = join(directory, name);
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(async () => {
		await database.close();
		removeTempDirectory(directory);
	});
	return { path, database };
}

/**
 * Records every request sent to a connection's thread, in the order sent, and counts the waits: the requests sent while
 * none was in flight, each of which the caller waited a whole round trip to the thread for.
 */
function recordRequests() {
	const sent: ConnectionRequest[] = [];
	let inFlight = 0;
	let mostInFlight = 0;
	let waits = 0;
	const interception = interceptConnectionRequests((request, send) => {
		sent.push(request);
		if (inFlight === 0) waits += 1;
		inFlight += 1;
		mostInFlight = Math.max(mostInFlight, inFlight);
		return send(request).finally(() => {
			inFlight -= 1;
		});
	});
	cleanups.push(() => interception.restore());
	return {
		sent,
		get waits() {
			return waits;
		},
		get mostInFlight() {
			return mostInFlight;
		},
		reset() {
			sent.length = 0;
			waits = 0;
			mostInFlight = 0;
		},
		restore: () => interception.restore(),
	};
}

test("statements made without waiting go to the connection's thread together and run in the order they were made", async () => {
	const { database } = await databaseFile();
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const requests = recordRequests();
	const [, , counted, , rows] = await Promise.all([
		database.run("INSERT INTO items VALUES (?)", "a"),
		database.run("INSERT INTO items VALUES (?)", "b"),
		database.get<SqliteRow & { n: number }>("SELECT count(*) AS n FROM items"),
		database.run("INSERT INTO items VALUES (?)", "c"),
		database.all<SqliteRow & { value: string }>("SELECT value FROM items ORDER BY rowid"),
	]);
	assert.equal(counted?.n, 2);
	assert.deepEqual(
		rows.map((row) => row.value),
		["a", "b", "c"],
	);
	assert.equal(requests.mostInFlight, 5, "every statement was sent before the first was answered");
	assert.equal(requests.waits, 1);
});

test("a statement made after a transaction runs after its commit, and one made before it runs before it begins", async () => {
	const { database } = await databaseFile();
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const requests = recordRequests();
	const before = database.run("INSERT INTO items VALUES (?)", "before");
	const inside = database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES (?)", "inside");
		return tx.get<SqliteRow & { n: number }>("SELECT count(*) AS n FROM items");
	});
	const after = database.get<SqliteRow & { n: number }>("SELECT count(*) AS n FROM items");
	await before;
	assert.equal((await inside)?.n, 2);
	assert.equal((await after)?.n, 2);
	const order = requests.sent.map((request) =>
		request.kind === "begin" ? "BEGIN" : (requestSql(request) ?? request.kind),
	);
	const begin = order.indexOf("BEGIN");
	const commit = order.indexOf("COMMIT");
	assert.ok(begin > order.indexOf("INSERT INTO items VALUES (?)"), order.join(" | "));
	assert.ok(commit > begin, order.join(" | "));
	assert.equal(order.lastIndexOf("SELECT count(*) AS n FROM items"), order.length - 1, order.join(" | "));
	assert.ok(order.lastIndexOf("SELECT count(*) AS n FROM items") > commit, order.join(" | "));
});

test("a batch's writes stop at the first that fails, and nothing after it is written", async () => {
	const { database } = await databaseFile();
	let failure: unknown;
	await database.transaction(async (tx) => {
		await statementBatch(
			tx,
			["CREATE TABLE first (x INTEGER)", "CREATE TABLE first (x INTEGER)", "CREATE TABLE after_failure (x INTEGER)"],
			[],
		).catch((error: unknown) => {
			failure = error;
		});
	});
	assert.match(String(failure), /already exists/);
	const tables = await database.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
	);
	assert.deepEqual(
		tables.map((row) => row.name),
		["first"],
	);
});

test("a batch that fails reports its first failing write, though a read sent behind it fails too", async () => {
	const { database } = await databaseFile();
	await database.exec("CREATE TABLE present (x INTEGER)");
	await assert.rejects(
		database.transaction((tx) =>
			statementBatch(
				tx,
				["CREATE TABLE present (x INTEGER)"],
				[() => tx.get("SELECT x FROM missing"), () => tx.get("SELECT 1 AS one")],
			),
		),
		/table present already exists/,
	);
});

test("a batch's reads see what its writes did, and wait for the thread once with them", async () => {
	const { database } = await databaseFile();
	const requests = recordRequests();
	let waits = 0;
	const [count, columns] = await database.transaction(async (tx) => {
		requests.reset();
		const values = await statementBatch(
			tx,
			[
				"CREATE TABLE items (value TEXT); CREATE TABLE other (x INTEGER)",
				{ sql: "INSERT INTO items VALUES (?)", params: ["v"] },
			],
			[
				() => tx.get<SqliteRow & { n: number }>("SELECT count(*) AS n FROM items"),
				() => tx.all<SqliteRow & { name: string }>("SELECT name FROM pragma_table_info('other')"),
			],
		);
		waits = requests.waits;
		return values;
	});
	assert.equal(count?.n, 1);
	assert.deepEqual(
		columns.map((row) => row.name),
		["x"],
	);
	assert.equal(waits, 1);
});

test("a session store opened on a database already set up waits for the connection's thread three times", async () => {
	const { database } = await databaseFile();
	await (await SqlSessionStore.open(database)).close();
	const requests = recordRequests();
	await (await SqlSessionStore.open(database)).close();
	// The schema probes together, then the versions with the leftover chunks check, then the snapshot index and the
	// search index probes together; main waited for each of 39 statements.
	assert.equal(requests.waits, 3);
});

test("a session store opened on a new file sets its schema up in a few dozen waits for the thread, not one per statement", async () => {
	const { database } = await databaseFile();
	const requests = recordRequests();
	await (await SqlSessionStore.open(database)).close();
	// 95 statements, each its own wait, on main: four transactions now, each statement batch one wait.
	assert.ok(requests.waits <= 30, `${requests.waits} waits for ${requests.sent.length} requests`);
});

test("a schema set up in batches on the connection's thread is the one set up a statement at a time", async () => {
	const schemaOf = async (database: SqliteDatabase) =>
		database.all<SqliteRow & { type: string; name: string; sql: string | null }>(
			"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
		);
	const legacy = (database: SqliteDatabase) =>
		database.exec(`
			CREATE TABLE session_meta (schema_version INTEGER NOT NULL);
			INSERT INTO session_meta VALUES (1);
			CREATE TABLE session_sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
			CREATE TABLE session_entries (session_id TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT NOT NULL, entry_json TEXT NOT NULL, PRIMARY KEY(session_id, seq));
			CREATE TABLE session_blobs (session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(session_id, hash));
			CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL);
			CREATE TABLE snapshot_session_refs (session_id TEXT NOT NULL, seq INTEGER NOT NULL, root TEXT NOT NULL, snapshot_id TEXT NOT NULL, PRIMARY KEY (session_id, seq)) WITHOUT ROWID;
		`);
	for (const start of ["new", "older"] as const) {
		const threaded = await databaseFile(`${start}-threaded.sqlite`);
		const directory = makeTempDirectory("atomic-open-round-trips-");
		const connection = new DatabaseSync(join(directory, `${start}-caller.sqlite`));
		const oneAtATime = wrapNodeSqliteDatabase(connection);
		cleanups.push(async () => {
			await oneAtATime.close();
			removeTempDirectory(directory);
		});
		if (start === "older") {
			await legacy(threaded.database);
			await legacy(oneAtATime);
		}
		await (await SqlSessionStore.open(threaded.database)).close();
		await (await SqlSessionStore.open(oneAtATime)).close();
		const batched = await schemaOf(threaded.database);
		assert.ok(batched.length > 20, `${start}: ${batched.length} schema objects`);
		assert.deepEqual(batched, await schemaOf(oneAtATime), start);
	}
});
