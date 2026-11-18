import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	JOURNAL_COLUMNS as c,
	RUN_EVENT_TYPES as e,
	JournalCounterRangeError,
	type JournalEntry,
	type Lease,
	JOURNAL_TABLES as tableNames,
} from "../../packages/workflows/src/durable/journal/types.js";
import { countRows, type FakeLibsqlFault, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * A run journal on libSQL, which sends batches, renews a lease and appends events in one request each. Those requests
 * refuse what the journal's transactions refuse, before writing anything, and wait for a busy write lock as long as
 * they do. The cases are the local driver's own counter-range cases, run on libSQL.
 */

const t = Object.fromEntries(Object.entries(tableNames).map(([key, name]) => [key, `wf_${name}`])) as Record<
	keyof typeof tableNames,
	string
>;
const header = { runId: "run", name: "workflow", cwd: "", createdAt: 0, status: "running" };

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function libsqlJournal(): Promise<{ journal: SqlRunJournal; database: SqliteDatabase }> {
	const directory = makeTempDirectory("journal-libsql-one-request-");
	cleanups.push(() => removeTempDirectory(directory));
	const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "journal.sqlite")).href });
	cleanups.push(() => database.close());
	assert.equal(typeof database.batch, "function", "libSQL sends batches");
	const journal = await SqlRunJournal.open(database);
	cleanups.push(() => journal.close());
	await journal.createRun(header);
	return { journal, database };
}

async function acquire(journal: SqlRunJournal): Promise<Lease> {
	const outcome = await journal.acquire(header.runId, "holder");
	if (outcome.status !== "acquired") return assert.fail("lease not acquired");
	return outcome.lease;
}

async function read(journal: SqlRunJournal, fromSeq?: number): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const entry of journal.read(header.runId, fromSeq)) entries.push(entry);
	return entries;
}

/** Every row of every journal table, each value as SQL quotes it. */
async function snapshot(database: SqliteDatabase): Promise<unknown[][]> {
	const tables: unknown[][] = [];
	for (const table of Object.values(t)) {
		const columns = await database.all<{ name: string }>(`PRAGMA table_info(${table})`);
		tables.push(
			await database.all(
				`SELECT ${columns.map(({ name }) => `quote(${name}) AS ${name}`).join(", ")} FROM ${table} ORDER BY rowid`,
			),
		);
	}
	return tables;
}

test.each([-1, 1.5, 2 ** 53 + 2])(
	"on libSQL, an out-of-range lease epoch %s rejects every lease access without writes",
	async (seed) => {
		const { journal, database } = await libsqlJournal();
		const lease = await acquire(journal);
		await database.run(`UPDATE ${t.leases} SET ${c.epoch} = ?, ${c.renewedAt} = 0`, seed);
		const before = await snapshot(database);
		for (const operation of [
			() => journal.acquire(header.runId, "holder"),
			() => journal.acquire(header.runId, "other"),
			() => journal.takeover(header.runId, "next", "holder"),
			() => journal.renew({ ...lease, epoch: seed }),
			() => journal.release({ ...lease, epoch: seed }),
			() => journal.append({ ...lease, epoch: seed }, { type: e.statusChanged, payload: { status: "failed" } }),
			() => journal.deleteRun(header.runId),
		]) {
			await assert.rejects(operation, (error: Error) => {
				assert.ok(error instanceof JournalCounterRangeError, String(error));
				assert.equal(error.field, "epoch");
				assert.equal(error.value, seed);
				return true;
			});
			assert.deepEqual(await snapshot(database), before, String(operation));
		}
	},
);

test.each([
	["seq", -1],
	["seq", 1.5],
	["seq", 2 ** 53 + 2],
	["epoch", -1],
	["epoch", 1.5],
	["epoch", 2 ** 53 + 2],
] as const)("on libSQL, an out-of-range event %s %s rejects reads and appends without writes", async (field, seed) => {
	const { journal, database } = await libsqlJournal();
	const lease = await acquire(journal);
	await database.run(
		`INSERT INTO ${t.events}(run_id, seq, epoch, key, type, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		header.runId,
		field === "seq" ? seed : 1,
		field === "epoch" ? seed : 1,
		"seed",
		e.summaryRecorded,
		"null",
		0,
	);
	const before = await snapshot(database);
	for (const operation of [
		() => read(journal, field === "seq" ? Math.min(seed, 1) : 1),
		() => journal.readKey(header.runId, "seed"),
		() => journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } }, { key: "seed" }),
		...(field === "seq"
			? [() => journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } })]
			: []),
	]) {
		await assert.rejects(operation, (error: Error) => {
			assert.ok(error instanceof JournalCounterRangeError, String(error));
			assert.equal(error.field, field);
			assert.equal(error.value, seed);
			return true;
		});
		assert.deepEqual(await snapshot(database), before, String(operation));
	}
});

const { server, open } = useFakeLibsqlServers();

/**
 * How many times the server answers busy: more than its busy timeout's waits (10, 20, 40, 80 and 160 ms, then 200 ms
 * each) can fit in the adapter's 5 s, however fast each answer comes, so the adapter gives up on the request at least
 * once. A writer that waits for the journal's lock wait sends it again and gets through.
 */
const BUSY_ANSWERS = 40;
const BUSY: FakeLibsqlFault = { kind: "busy" };

test("on a libSQL server, several events appended at once wait out a write lock busy past the server's busy timeout, as one event does", async () => {
	const fake = await server();
	const database = await open(fake.url);
	const journal = await SqlRunJournal.open(database);
	cleanups.push(() => journal.close());
	await journal.createRun(header);
	const lease = await acquire(journal);
	fake.fail(...Array.from({ length: BUSY_ANSWERS }, () => BUSY));
	const appended = await journal.appendMany(lease, [
		{ event: { type: e.statusChanged, payload: { status: "paused" } }, context: (action) => action() },
		{ event: { type: e.statusChanged, payload: { status: "running" } }, context: (action) => action() },
	]);
	assert.deepEqual(
		appended.map((outcome) =>
			outcome.status === "fulfilled"
				? outcome.value.status
				: `${outcome.reason instanceof StorageUnavailableError ? "unavailable" : "rejected"}: ${outcome.reason}`,
		),
		["appended", "appended"],
	);
	assert.equal(countRows(fake, `SELECT COUNT(*) AS count FROM ${t.events}`), 2);
});
