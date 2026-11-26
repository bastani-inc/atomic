import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";

interface LibsqlStatement {
	run(...params: unknown[]): unknown;
}
interface LibsqlDatabaseClass {
	prototype: { prepare(this: object, sql: string): LibsqlStatement };
	SqliteError: new (message: string, code: string, rawCode: number) => Error;
}

/** The native driver class `@libsql/client` opens `file:` connections with, as the adapter resolves it. */
const Database = createRequire(createRequire(import.meta.url).resolve("@libsql/client"))(
	"libsql",
) as LibsqlDatabaseClass;

const INSERT = "INSERT INTO entries (id, body) VALUES (?, ?)";

/**
 * Runs `body` with every prepare of the driver counted by connection and SQL text, and a libSQL file database the
 * shipped adapter opened on a table with a trigger, which SQLite compiles into each prepare of an INSERT on it.
 */
async function withCountedPrepares(
	body: (database: SqliteDatabase, prepares: (sql: string) => number[], url: string) => Promise<void>,
): Promise<void> {
	const counts = new Map<object, Map<string, number>>();
	const prepare = Database.prototype.prepare;
	Database.prototype.prepare = function (sql) {
		const connection = counts.get(this) ?? new Map<string, number>();
		counts.set(this, connection);
		connection.set(sql, (connection.get(sql) ?? 0) + 1);
		return prepare.call(this, sql);
	};
	const directory = makeLibsqlDirectory();
	const url = pathToFileURL(join(directory, "database.sqlite")).href;
	try {
		const database = await openLibsqlDatabase({ url });
		try {
			await database.exec(`
				CREATE TABLE entries (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
				CREATE TABLE audit (id INTEGER NOT NULL);
				CREATE TRIGGER entries_audit AFTER INSERT ON entries BEGIN INSERT INTO audit VALUES (NEW.id); END;
			`);
			await body(
				database,
				(sql) => [...counts.values()].map((each) => each.get(sql) ?? 0).filter((n) => n > 0),
				url,
			);
		} finally {
			await database.close();
		}
	} finally {
		Database.prototype.prepare = prepare;
		await removeLibsqlDirectory(directory);
	}
}

test("a libSQL file database prepares the same statement once per connection", async () => {
	await withCountedPrepares(async (database, prepares) => {
		for (let id = 1; id <= 20; id++) await database.run(INSERT, id, `outside ${id}`);
		await database.transaction(async (transaction) => {
			for (let id = 21; id <= 40; id++) await transaction.run(INSERT, id, `inside ${id}`);
		});
		assert.ok(database.batch);
		await database.batch(Array.from({ length: 20 }, (_, at) => ({ sql: INSERT, params: [41 + at, `batch ${at}`] })));
		for (let read = 0; read < 10; read++)
			assert.deepEqual(await database.get("SELECT count(*) AS n FROM audit"), { n: 60 });
		// 60 INSERTs and 10 reads, each prepared once on each connection that ran it.
		assert.ok(prepares(INSERT).length > 0);
		assert.deepEqual(
			prepares(INSERT),
			prepares(INSERT).map(() => 1),
		);
		assert.deepEqual(
			prepares("SELECT count(*) AS n FROM audit"),
			prepares("SELECT count(*) AS n FROM audit").map(() => 1),
		);
		assert.deepEqual(
			await database.all("SELECT id, body FROM entries WHERE id IN (?, ?, ?) ORDER BY id", 1, 21, 60),
			[
				{ id: 1, body: "outside 1" },
				{ id: 21, body: "inside 21" },
				{ id: 60, body: "batch 19" },
			],
		);
	});
});

test("a libSQL file database's kept statements follow another connection's schema changes", async () => {
	await withCountedPrepares(async (database, _prepares, url) => {
		await database.run(INSERT, 1, "before");
		assert.deepEqual(await database.all("SELECT * FROM entries ORDER BY id"), [{ id: 1, body: "before" }]);
		assert.deepEqual(await database.all("SELECT id, body FROM entries ORDER BY id"), [{ id: 1, body: "before" }]);
		const other = await openLibsqlDatabase({ url });
		try {
			await other.exec(`
				ALTER TABLE entries ADD COLUMN tag TEXT NOT NULL DEFAULT 'added';
				CREATE TABLE seen (id INTEGER NOT NULL);
				CREATE TRIGGER entries_seen AFTER INSERT ON entries BEGIN INSERT INTO seen VALUES (NEW.id); END;
			`);
		} finally {
			await other.close();
		}
		// The INSERT kept from before fires the trigger added since, and a read of every column sees the new one.
		await database.run(INSERT, 2, "after");
		assert.deepEqual(await database.all("SELECT id FROM seen"), [{ id: 2 }]);
		assert.deepEqual(await database.all("SELECT * FROM entries ORDER BY id"), [
			{ id: 1, body: "before", tag: "added" },
			{ id: 2, body: "after", tag: "added" },
		]);
		assert.deepEqual(await database.all("SELECT id, body FROM entries ORDER BY id"), [
			{ id: 1, body: "before" },
			{ id: 2, body: "after" },
		]);
	});
});

test("a libSQL file connection answered SQLITE_SCHEMA prepares its statements again", async () => {
	await withCountedPrepares(async (database, prepares) => {
		const READ = "SELECT body FROM entries WHERE id = ?";
		// A statement's run that SQLite answers SQLITE_SCHEMA: the schema changed under every statement kept so far.
		const probe = new (Database as unknown as new (path: string) => { close(): void })(":memory:");
		const statement = Object.getPrototypeOf(Database.prototype.prepare.call(probe, "SELECT 1")) as LibsqlStatement;
		probe.close();
		const run = statement.run;
		await database.transaction(async (transaction) => {
			await transaction.run(INSERT, 1, "first");
			assert.deepEqual(await transaction.get(READ, 1), { body: "first" });
			statement.run = () => {
				statement.run = run;
				throw new Database.SqliteError("database schema has changed", "SQLITE_SCHEMA", 17);
			};
			await assert.rejects(transaction.run(INSERT, 2, "refused"), (error: Error) => {
				assert.equal((error.cause as { code?: unknown }).code, "SQLITE_SCHEMA");
				return true;
			});
			await transaction.run(INSERT, 3, "third");
			assert.deepEqual(await transaction.get(READ, 3), { body: "third" });
		});
		// The connection prepared both statements again after the refusal, the read too, though it never failed.
		assert.deepEqual(prepares(INSERT), [2]);
		assert.deepEqual(prepares(READ), [2]);
		assert.deepEqual(await database.all("SELECT id FROM entries ORDER BY id"), [{ id: 1 }, { id: 3 }]);
	});
});
