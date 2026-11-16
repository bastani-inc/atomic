import assert from "node:assert/strict";
import { join } from "node:path";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JOURNAL_READ_PAGE_SIZE } from "../../packages/workflows/src/durable/journal/internal.js";
import { PoolCheckpointIndex } from "../../packages/workflows/src/durable/journal/pool-checkpoint-index.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { type Lease, RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { interceptingDatabase } from "../helpers/intercepting-database.js";
import { rowLimitedDatabase, SQLD_DEFAULT_LIMITS } from "../helpers/row-limited-database.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * A paged read of large events costs about what each page returns (#4954, #4768): each statement measures the
 * payloads of a batch of rows to cut its page, and the batch follows what the pages hold, so reading N large events
 * measures O(N) payloads instead of every remaining row for every page.
 */

/** The large payloads one statement measured with `length()`: each a row whose whole payload it read. */
const measuring = vi.hoisted(() => ({ texts: new Set<string>(), large: 100_000 }));

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class MeasuringDatabase extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			super(...args);
			// SQLite's own `length()`, noting each large text it measures.
			this.function("length", { deterministic: true }, (value) => {
				if (value === null) return null;
				if (value instanceof Uint8Array) return value.byteLength;
				const text = String(value);
				if (text.length >= measuring.large) measuring.texts.add(text);
				const end = text.indexOf("\0");
				const chars = end === -1 ? text : text.slice(0, end);
				return chars.length - (chars.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);
			});
		}
	}
	return { ...actual, DatabaseSync: MeasuringDatabase };
});

/** A page holds a handful of events this large. */
const EVENT_CHARS = 300_000;
const EVENTS = 128;

/** Each statement a read sent: how many large payloads it measured, and how many rows it returned. */
interface Statement {
	readonly measured: number;
	readonly returned: number;
}

async function withJournal(
	body: (journal: SqlRunJournal, lease: Lease, statements: Statement[], database: SqliteDatabase) => Promise<void>,
): Promise<void> {
	const directory = makeTempDirectory("journal-read-pages-");
	const statements: Statement[] = [];
	try {
		const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
		// What a libSQL server refuses for size is refused here too: the pages must still fit its limits.
		const limited = rowLimitedDatabase(database, SQLD_DEFAULT_LIMITS);
		const observed = interceptingDatabase(limited.wrapped, {
			all: async (sql, params, next) => {
				measuring.texts.clear();
				const rows = await next(sql, ...params);
				statements.push({ measured: measuring.texts.size, returned: rows.length });
				return rows;
			},
		});
		const journal = await SqlRunJournal.open(observed);
		try {
			await journal.createRun({ runId: "root", name: "root", cwd: "/cwd", createdAt: 0, status: "running" });
			const outcome = await journal.acquire("root", "holder");
			if (outcome.status !== "acquired") assert.fail("lease not acquired");
			await body(journal, outcome.lease, statements, observed);
			assert.deepEqual(limited.refused, []);
		} finally {
			await journal.close();
			await database.close();
		}
	} finally {
		removeTempDirectory(directory);
	}
}

/** The pages among `statements`: those that measured or returned anything. The first measures at most `firstBatch`. */
function assertPagesTrackReturnedRows(statements: readonly Statement[], firstBatch: number): void {
	const pages = statements.filter((statement) => statement.measured > 0);
	assert.ok(pages.length > 1, "the read took more than one page");
	assert.ok(pages[0]!.measured <= firstBatch, `the first page measured ${pages[0]!.measured} rows`);
	for (const [index, page] of pages.entries())
		if (index > 0)
			assert.ok(
				page.measured <= 4 * page.returned,
				`page ${index + 1} measured ${page.measured} rows to return ${page.returned}: ${JSON.stringify(pages)}`,
			);
	const measured = pages.reduce((sum, page) => sum + page.measured, 0);
	assert.ok(measured <= firstBatch + 4 * EVENTS, `the read measured ${measured} rows for ${EVENTS}`);
}

test("a journal read of large events measures rows in proportion to each page's", async () => {
	await withJournal(async (journal, lease, statements) => {
		const payloads = Array.from({ length: EVENTS }, (_, index) => `${index}:`.padEnd(EVENT_CHARS, "x"));
		for (const [index, payload] of payloads.entries())
			await journal.append(lease, { type: "SummaryRecorded", payload } as RunEvent, { key: `k-${index}` });
		statements.length = 0;
		const read = await Array.fromAsync(journal.read("root"));
		assert.deepEqual(
			read.map((entry) => entry.event.payload),
			payloads,
		);
		assertPagesTrackReturnedRows(statements, JOURNAL_READ_PAGE_SIZE);
		statements.length = 0;
		const keyed = await Array.fromAsync(SqlRunJournal.readKeyRange(journal, "root", "k-", "k-~"));
		assert.equal(keyed.length, EVENTS);
		assertPagesTrackReturnedRows(statements, JOURNAL_READ_PAGE_SIZE);
	});
});

test("a pool checkpoint index reads a root's large checkpoints in proportion to each page's", async () => {
	await withJournal(async (journal, lease, statements, database) => {
		const run = { runId: "child", runName: "child", parentRunId: "root", rootRunId: "root" };
		for (let index = 0; index < EVENTS; index++) {
			const checkpoint: DurableToolCheckpoint = {
				kind: "tool",
				workflowId: "root",
				checkpointId: `scope:tool:${index}`,
				name: "tool",
				argsHash: `scope:args:${index}`,
				output: `${index}:`.padEnd(EVENT_CHARS, "x"),
				completedAt: 1,
				topology: { version: 1, nodeId: `tool-${index}`, parentIds: [], ordinal: index, order: index, run },
			};
			await journal.append(
				lease,
				{ type: RUN_EVENT_TYPES.checkpointRecorded, payload: checkpoint } as unknown as RunEvent,
				{ key: `checkpoint-${index}` },
			);
		}
		statements.length = 0;
		const index = new PoolCheckpointIndex();
		const read = index.begin("root");
		const view = await database.transaction((tx) => read.read(tx, "wf_events"));
		read.commit();
		assert.equal(view.entries("byRun", "child").length, EVENTS);
		assertPagesTrackReturnedRows(statements, JOURNAL_READ_PAGE_SIZE);
	});
});
