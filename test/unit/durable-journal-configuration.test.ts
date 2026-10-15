import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	JournalMetaCorruptError,
	JournalSchemaVersionError,
	StorageUnavailableError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const openConnection = (database: DatabaseSync) => new SqliteRunJournal(database);

test("caller-owned memory connections receive schema and remain open after journal close", async () => {
	const database = new DatabaseSync(":memory:");
	try {
		const journal = openConnection(database);
		assert.equal(journal.path, ":memory:");
		await journal.createRun({ runId: "run", name: "workflow", cwd: "/", createdAt: 0, status: "running" });
		await journal.close();
		await journal.close();
		assert.equal((await journal.listRuns()).length, 1);
		assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count, 1);
		assert.equal(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
		assert.equal(database.prepare("PRAGMA synchronous").get()?.synchronous, 2);
		assert.equal(database.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
	} finally {
		database.close();
	}
});

test("caller-owned schema failures preserve the connection and typed version fields", () => {
	const database = new DatabaseSync(":memory:");
	try {
		database.exec("CREATE TABLE meta(schema_version); INSERT INTO meta VALUES (42)");
		assert.throws(
			() => openConnection(database),
			(error: Error) => {
				assert.ok(error instanceof JournalSchemaVersionError);
				assert.equal(error.found, 42);
				assert.equal(error.supported, 1);
				return true;
			},
		);
		assert.equal(database.prepare("SELECT schema_version FROM meta").get()?.schema_version, 42);
	} finally {
		database.close();
	}
});

test("caller-owned corrupt metadata reports memory fallback or absolute file location", () => {
	const directory = makeTempDirectory("journal-connection-");
	try {
		for (const path of [":memory:", join(directory, "journal.sqlite")]) {
			const database = new DatabaseSync(path);
			try {
				database.exec("CREATE TABLE meta(schema_version); INSERT INTO meta VALUES (1), (1)");
				assert.throws(
					() => openConnection(database),
					(error: Error) => {
						assert.ok(error instanceof JournalMetaCorruptError);
						assert.equal(error.path, database.location() || ":memory:");
						assert.equal(error.path, path);
						assert.equal(error.rowCount, 2);
						return true;
					},
				);
				assert.equal(database.prepare("SELECT COUNT(*) AS count FROM meta").get()?.count, 2);
			} finally {
				database.close();
			}
		}
	} finally {
		removeTempDirectory(directory);
	}
});

test("caller-owned temporary connections are accepted without taking ownership", async () => {
	const database = new DatabaseSync("");
	try {
		const journal = openConnection(database);
		assert.equal(journal.path, ":memory:");
		await journal.close();
		assert.equal(database.prepare("SELECT schema_version FROM meta").get()?.schema_version, 1);
	} finally {
		database.close();
	}
});

test("caller-owned storage failures retain the file location and typed cause", async () => {
	const directory = makeTempDirectory("journal-unavailable-");
	const database = new DatabaseSync(join(directory, "journal.sqlite"));
	const path = database.location();
	const journal = openConnection(database);
	database.close();
	try {
		await assert.rejects(journal.listRuns(), (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.path, path);
			assert.ok(error.cause instanceof Error);
			return true;
		});
		await journal.close();
	} finally {
		removeTempDirectory(directory);
	}
});
