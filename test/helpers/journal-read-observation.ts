import assert from "node:assert/strict";
import type { RunJournalReadObservation } from "../../packages/workflows/src/durable/journal/conformance.js";
import { JOURNAL_READ_PAGE_SIZE } from "../../packages/workflows/src/durable/journal/internal.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { JournalDatabase, SqliteValue } from "../../packages/workflows/src/durable/journal/node-sqlite.js";
import type { JournalEntry, RunJournal } from "../../packages/workflows/src/durable/journal/types.js";

export function observeJournalRead(journal: RunJournal): RunJournalReadObservation {
	const pageSizes: number[] = [];
	let entriesRead = 0;
	if (journal instanceof MemoryRunJournal) {
		const copy = Reflect.get(journal, "copyEntry") as (entry: JournalEntry) => JournalEntry;
		const page = Reflect.get(journal, "readPage") as (runId: string, fromSeq: number) => JournalEntry[];
		assert.equal(typeof copy, "function");
		assert.equal(typeof page, "function");
		Reflect.set(journal, "copyEntry", (entry: JournalEntry) => {
			entriesRead++;
			return copy.call(journal, entry);
		});
		Reflect.set(journal, "readPage", (runId: string, fromSeq: number) => {
			const rows = page.call(journal, runId, fromSeq);
			pageSizes.push(rows.length);
			return rows;
		});
		return {
			pageSize: JOURNAL_READ_PAGE_SIZE,
			pageSizes,
			get entriesRead() {
				return entriesRead;
			},
			reset() {
				pageSizes.length = 0;
				entriesRead = 0;
			},
			restore() {
				Reflect.set(journal, "copyEntry", copy);
				Reflect.set(journal, "readPage", page);
			},
		};
	}
	const database = Reflect.get(journal, "db") as JournalDatabase;
	const all = database.allCounters;
	database.allCounters = <Row>(runId: string, sql: string, ...values: SqliteValue[]): Row[] => {
		const rows = all.call(database, runId, sql, ...values) as Row[];
		pageSizes.push(rows.length);
		entriesRead += rows.length;
		return rows;
	};
	return {
		pageSizes,
		pageSize: JOURNAL_READ_PAGE_SIZE,
		get entriesRead() {
			return entriesRead;
		},
		reset() {
			pageSizes.length = 0;
			entriesRead = 0;
		},
		restore() {
			database.allCounters = all;
		},
	};
}
