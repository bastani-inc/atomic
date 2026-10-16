import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { afterEach, test } from "vitest";
import { registerRunJournalConformance } from "../../packages/workflows/src/durable/journal/conformance.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { observeJournalRead } from "../helpers/journal-read-observation.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

registerRunJournalConformance(test, "memory", () => new MemoryRunJournal(), observeJournalRead);
registerRunJournalConformance(
	test,
	"sqlite",
	() => {
		const directory = makeTempDirectory("journal-conformance-");
		const journal = new SqliteRunJournal(join(directory, "journal.sqlite"));
		const close = journal.close.bind(journal);
		journal.close = async () => {
			await close();
			removeTempDirectory(directory);
		};
		return journal;
	},
	observeJournalRead,
);

const borrowed: { database: DatabaseSync; directory: string }[] = [];
afterEach(() => {
	for (const { database, directory } of borrowed.splice(0)) {
		assert.equal(database.prepare("SELECT 1 AS alive").get()?.alive, 1);
		database.close();
		removeTempDirectory(directory);
	}
});
registerRunJournalConformance(
	test,
	"caller-owned sqlite",
	() => {
		const directory = makeTempDirectory("borrowed-journal-conformance-");
		const database = new DatabaseSync(join(directory, "journal.sqlite"));
		borrowed.push({ database, directory });
		return new SqliteRunJournal(database);
	},
	observeJournalRead,
);

for (const method of ["getRun", "takeoverExpired", "leaseState"] as const) {
	test(`conformance accepts VM-native promises from ${method} individually`, async () => {
		const ForeignPromise = runInNewContext("Promise") as PromiseConstructor;
		function foreign<Value>(promise: Promise<Value>): Promise<Value> {
			const result = ForeignPromise.resolve(promise);
			assert.ok(result instanceof ForeignPromise);
			assert.equal(result instanceof Promise, false);
			return result;
		}
		const checks: (() => Promise<void>)[] = [];
		registerRunJournalConformance(
			(_name, body) => checks.push(body),
			`VM-native ${method}`,
			() => {
				const journal = new MemoryRunJournal();
				if (method === "getRun") {
					const original = journal.getRun.bind(journal);
					journal.getRun = (...args) => foreign(original(...args));
				} else if (method === "takeoverExpired") {
					const original = journal.takeoverExpired.bind(journal);
					journal.takeoverExpired = (...args) => foreign(original(...args));
				} else {
					const original = journal.leaseState.bind(journal);
					journal.leaseState = (...args) => foreign(original(...args));
				}
				return journal;
			},
			observeJournalRead,
		);
		for (const check of checks) await check();
	});
}
