import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	JournalConfigurationError,
	JournalError,
	JournalMetaCorruptError,
	MemoryRunJournal,
	registerRunJournalConformance,
	resolveRunJournal,
	SqliteRunJournal,
	StaleLeaseError,
} from "@bastani/atomic/workflows";

const root = process.argv[2];
process.env.ATOMIC_CODING_AGENT_DIR = join(root, "agent");
process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = "";
const header = { runId: "sdk", name: "workflow", cwd: root, createdAt: 0, status: "running" };
const memory = resolveRunJournal({ journal: { memory: true } });
assert.ok(memory instanceof MemoryRunJournal);
assert.equal(resolveRunJournal({ journal: memory }), memory);
await memory.createRun(header);
const first = await memory.acquire(header.runId, "first");
assert.equal(first.status, "acquired");
await memory.append(first.lease, { type: "RunStarted", payload: { text: "\u0000\ud800" } }, { key: "" });
const next = await memory.takeover(header.runId, "second", "first");
assert.equal(next.status, "acquired");
await assert.rejects(memory.append(first.lease, { type: "RunFinished", payload: null }), StaleLeaseError);
await memory.close();
const file = resolveRunJournal({ journal: { path: join(root, "sdk.sqlite") } });
assert.ok(file instanceof SqliteRunJournal);
await file.createRun(header);
await file.close();
const reopened = new SqliteRunJournal(join(root, "sdk.sqlite"));
assert.deepEqual(await reopened.listRuns(), [header]);
await reopened.close();
const database = new DatabaseSync(join(root, "caller.sqlite"));
const borrowed = resolveRunJournal({ journal: { database } });
await borrowed.close();
assert.equal(database.prepare("SELECT schema_version FROM meta").get().schema_version, 1);
database.exec("INSERT INTO meta VALUES (1)");
assert.throws(() => new SqliteRunJournal(database), (error) => {
	assert.ok(error instanceof JournalMetaCorruptError);
	assert.ok(error instanceof JournalError);
	assert.equal(error.path, database.location());
	return true;
});
database.close();
assert.throws(
	() => resolveRunJournal({ settings: { workflows: { journal: { path: "x", memory: true } } } }),
	JournalConfigurationError,
);
const checks = [];
registerRunJournalConformance(
	(name, body) => checks.push({ name, body }),
	"public SDK memory",
	() => new MemoryRunJournal(),
);
for (const check of checks) await check.body();
console.log(
	JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", publicConformance: checks.length, status: "passed" }),
);
