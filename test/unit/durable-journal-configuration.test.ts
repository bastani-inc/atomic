import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	JournalClosedError,
	JournalMetaCorruptError,
	JournalSchemaVersionError,
	StorageUnavailableError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const openConnection = (database: DatabaseSync) => openSqlRunJournal(database);

test("caller-owned connections receive schema and remain open after journal close", async () => {
	const directory = makeTempDirectory("journal-owned-");
	const path = join(directory, "journal.sqlite");
	const database = new DatabaseSync(path);
	try {
		const journal = await openConnection(database);
		assert.equal(journal.path, path);
		await journal.createRun({ runId: "run", name: "workflow", cwd: "/", createdAt: 0, status: "running" });
		await journal.close();
		await journal.close();
		await assert.rejects(journal.listRuns(), (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.ok(error.cause instanceof JournalClosedError);
			assert.equal(error.location, path);
			return true;
		});
		assert.equal(database.prepare("SELECT COUNT(*) AS count FROM wf_runs").get()?.count, 1);
		assert.equal(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
		assert.equal(database.prepare("PRAGMA synchronous").get()?.synchronous, 2);
		assert.equal(database.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
	} finally {
		database.close();
		removeTempDirectory(directory);
	}
});

test("caller-owned schema failures preserve the connection and typed version fields", async () => {
	const directory = makeTempDirectory("journal-version-");
	const database = new DatabaseSync(join(directory, "journal.sqlite"));
	try {
		database.exec("CREATE TABLE wf_meta(schema_version); INSERT INTO wf_meta VALUES (42)");
		await assert.rejects(
			() => openConnection(database),
			(error: Error) => {
				assert.ok(error instanceof JournalSchemaVersionError);
				assert.equal(error.found, 42);
				assert.equal(error.supported, 1);
				return true;
			},
		);
		assert.equal(database.prepare("SELECT schema_version FROM wf_meta").get()?.schema_version, 42);
	} finally {
		database.close();
		removeTempDirectory(directory);
	}
});

test("caller-owned corrupt metadata reports its file location", async () => {
	const directory = makeTempDirectory("journal-connection-");
	try {
		for (const path of [join(directory, "journal.sqlite")]) {
			const database = new DatabaseSync(path);
			try {
				database.exec("CREATE TABLE wf_meta(schema_version); INSERT INTO wf_meta VALUES (1), (1)");
				await assert.rejects(
					() => openConnection(database),
					(error: Error) => {
						assert.ok(error instanceof JournalMetaCorruptError);
						assert.equal(error.path, path);
						assert.equal(error.rowCount, 2);
						return true;
					},
				);
				assert.equal(database.prepare("SELECT COUNT(*) AS count FROM wf_meta").get()?.count, 2);
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
		const journal = await openConnection(database);
		assert.equal(journal.path, ":memory:");
		await journal.close();
		assert.equal(database.prepare("SELECT schema_version FROM wf_meta").get()?.schema_version, 1);
	} finally {
		database.close();
	}
});

test("caller-owned storage failures retain the file location and typed cause", async () => {
	const directory = makeTempDirectory("journal-unavailable-");
	const database = new DatabaseSync(join(directory, "journal.sqlite"));
	const path = database.location();
	const journal = await openConnection(database);
	database.close();
	try {
		await assert.rejects(journal.listRuns(), (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.location, path);
			assert.ok(error.cause instanceof Error);
			return true;
		});
		await journal.close();
	} finally {
		removeTempDirectory(directory);
	}
});
