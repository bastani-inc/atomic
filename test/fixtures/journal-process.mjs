import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const load = (name) => jiti.import(fileURLToPath(new URL(`../../packages/workflows/src/durable/journal/${name}.ts`, import.meta.url)));
const { SqliteRunJournal } = await load("sqlite-run-journal");
const { JournalDatabase } = await load("node-sqlite");
const { JOURNAL_COLUMNS: c, JOURNAL_TABLES: t, RUN_EVENT_TYPES: e } = await load("types");
const [mode, path, argument] = process.argv.slice(2);
if (mode === "crash") {
	const db = new JournalDatabase(path);
	db.exec("BEGIN IMMEDIATE");
	db.run(`UPDATE ${t.runs} SET ${c.status} = ? WHERE ${c.runId} = ?`, "partial", "run");
	db.run(`INSERT INTO ${t.events} VALUES (?, ?, ?, ?, ?, ?, ?)`, "run", 2, 1, "partial", e.summaryRecorded, JSON.stringify(null), 0);
	process.stdout.write("transaction-open\n");
	await new Promise(() => setInterval(() => {}, 1000));
} else {
	const journal = new SqliteRunJournal(path);
	try {
		if (mode === "append") {
			const { lease, prefix } = JSON.parse(argument);
			process.stdout.write("ready\n");
			await new Promise((resolve) => process.stdin.once("data", resolve));
			for (let index = 0; index < 200; index++) {
				const result = await journal.append(lease, { type: e.summaryRecorded, payload: { prefix, index } }, { key: `${prefix}:${index}` });
				assert.equal(result.status, "appended");
			}
			process.stdout.write("appended=200\n");
		} else {
			assert.equal(mode, "bun");
			assert.equal(await journal.createRun({ runId: "bun", name: "bun", cwd: "", createdAt: 0, status: "running" }), "created");
			const outcome = await journal.acquire("bun", "bun-holder");
			assert.equal(outcome.status, "acquired");
			const appended = await journal.append(outcome.lease, { type: e.runStarted, payload: ["bun", 0] }, { key: "" });
			const entries = [];
			for await (const entry of journal.read("bun")) entries.push(entry);
			assert.deepEqual(entries, [appended.entry]);
			process.stdout.write("bun-open-append-read=ok\n");
		}
	} finally {
		await journal.close();
	}
}
