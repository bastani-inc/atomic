import { join } from "node:path";
import { test } from "vitest";
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
