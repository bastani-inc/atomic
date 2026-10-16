import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { registerRunJournalConformance } from "../../packages/workflows/src/durable/journal/conformance.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

registerRunJournalConformance(test, "memory", () => new MemoryRunJournal());
registerRunJournalConformance(test, "sqlite", () => {
	const directory = makeTempDirectory("journal-conformance-");
	const journal = new SqliteRunJournal(join(directory, "journal.sqlite"));
	const close = journal.close.bind(journal);
	journal.close = async () => {
		await close();
		removeTempDirectory(directory);
	};
	return journal;
});

const borrowed: { database: DatabaseSync; directory: string }[] = [];
afterEach(() => {
	for (const { database, directory } of borrowed.splice(0)) {
		assert.equal(database.prepare("SELECT 1 AS alive").get()?.alive, 1);
		database.close();
		removeTempDirectory(directory);
	}
});
registerRunJournalConformance(test, "caller-owned sqlite", () => {
	const directory = makeTempDirectory("borrowed-journal-conformance-");
	const database = new DatabaseSync(join(directory, "journal.sqlite"));
	borrowed.push({ database, directory });
	return new SqliteRunJournal(database);
});
