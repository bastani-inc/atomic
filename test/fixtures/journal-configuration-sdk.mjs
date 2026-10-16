import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import {
	JournalConfigurationError,
	JournalError,
	JournalMetaCorruptError,
	MemoryRunJournal,
	registerRunJournalConformance,
	resolveRunJournal,
	SqlRunJournal,
	openSqlRunJournal,
	StaleLeaseError,
} from "@bastani/atomic/workflows";

const root = process.argv[2];
process.env.ATOMIC_CODING_AGENT_DIR = join(root, "agent");
process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = "";
const header = { runId: "sdk", name: "workflow", cwd: root, createdAt: 0, status: "running" };
const memory = await resolveRunJournal({ journal: { memory: true } });
assert.ok(memory instanceof MemoryRunJournal);
assert.equal(await resolveRunJournal({ journal: memory }), memory);
await memory.createRun(header);
const first = await memory.acquire(header.runId, "first");
assert.equal(first.status, "acquired");
await memory.append(first.lease, { type: "RunStarted", payload: { text: "\u0000\ud800" } }, { key: "" });
const next = await memory.takeover(header.runId, "second", "first");
assert.equal(next.status, "acquired");
await assert.rejects(memory.append(first.lease, { type: "RunFinished", payload: null }), StaleLeaseError);
await memory.close();
const file = await resolveRunJournal({ journal: { path: join(root, "sdk.sqlite") } });
assert.ok(file instanceof SqlRunJournal);
await file.createRun(header);
const held = await file.acquire(header.runId, "serializer");
assert.equal(held.status, "acquired");
const leaseBefore = await file.leaseState(header.runId);
const cause = new Error("serializer failure");
const inputs = {};
Object.defineProperty(inputs, "toJSON", {
	value: () => {
		throw cause;
	},
});
const serializationError = (error) => {
	assert.ok(error instanceof StorageUnavailableError);
	assert.equal(error.adapter, file.descriptor.adapter);
	assert.equal(error.location, file.descriptor.location);
	assert.equal(error.cause, cause);
	return true;
};
await assert.rejects(file.createRun({ ...header, runId: "rejected", inputs }), serializationError);
await assert.rejects(
	file.append(held.lease, { type: "StatusChanged", payload: { status: "failed", inputs } }),
	serializationError,
);
assert.deepEqual(await file.listRuns(), [header]);
assert.deepEqual(await file.leaseState(header.runId), leaseBefore);
const entries = [];
for await (const entry of file.read(header.runId)) entries.push(entry);
assert.deepEqual(entries, []);
await file.close();
const reopened = await openSqlRunJournal(join(root, "sdk.sqlite"));
assert.deepEqual(await reopened.listRuns(), [header]);
await reopened.close();
const database = new DatabaseSync(join(root, "caller.sqlite"));
const borrowed = await resolveRunJournal({ journal: { database } });
await borrowed.close();
assert.equal(database.prepare("SELECT schema_version FROM wf_meta").get().schema_version, 1);
database.exec("INSERT INTO wf_meta VALUES (1)");
await assert.rejects(
	async () => await openSqlRunJournal(database),
	(error) => {
		assert.ok(error instanceof JournalMetaCorruptError);
		assert.ok(error instanceof JournalError);
		assert.equal(error.path, database.location());
		return true;
	},
);
database.close();
await assert.rejects(
	() => resolveRunJournal({ settings: { workflows: { journal: { path: "x", memory: true } } } }),
	JournalConfigurationError,
);
const checks = [];
registerRunJournalConformance(
	(name, body) => checks.push({ name, body }),
	"public SDK memory",
	() => new MemoryRunJournal(),
	(journal) => {
		const pageSizes = [];
		let entriesRead = 0;
		const copy = journal.copyEntry;
		const page = journal.readPage;
		journal.copyEntry = (entry) => {
			entriesRead++;
			return copy.call(journal, entry);
		};
		journal.readPage = (...args) => {
			const rows = page.apply(journal, args);
			pageSizes.push(rows.length);
			return rows;
		};
		return {
			pageSize: 256,
			pageSizes,
			get entriesRead() {
				return entriesRead;
			},
			reset() {
				pageSizes.length = 0;
				entriesRead = 0;
			},
			restore() {
				journal.copyEntry = copy;
				journal.readPage = page;
			},
		};
	},
);
for (const check of checks) await check.body();
console.log(
	JSON.stringify({
		runtime: process.versions.bun ? "bun" : "node",
		publicConformance: checks.length,
		status: "passed",
	}),
);
