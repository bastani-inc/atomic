import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const load = (name) => jiti.import(fileURLToPath(new URL(`../../packages/workflows/src/durable/journal/${name}.ts`, import.meta.url)));
const { SqliteRunJournal } = await load("sqlite-run-journal");
const { JournalDatabase } = await load("node-sqlite");
const { JOURNAL_COLUMNS: c, JOURNAL_TABLES: t, RUN_EVENT_TYPES: e, JournalInvalidTextError, StaleLeaseError } = await load("types");
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
		} else if (mode === "nul-rejection") {
			const { lease, nextHolder, key } = JSON.parse(argument);
			const invalid = field => error => error.constructor === JournalInvalidTextError && error.field === field && error.reason === "nul-character";
			const forged = { ...lease, holderId: `${lease.holderId}\u0000suffix` };
			await assert.rejects(() => journal.acquire(lease.runId, forged.holderId), invalid("holderId"));
			await assert.rejects(() => journal.takeover(lease.runId, forged.holderId, lease.holderId), invalid("holderId"));
			await assert.rejects(() => journal.takeover(lease.runId, nextHolder, forged.holderId), invalid("expectedHolder"));
			await assert.rejects(() => journal.append(forged, { type: e.runStarted, payload: null }), invalid("holderId"));
			await assert.rejects(() => journal.renew(forged), invalid("holderId"));
			await assert.rejects(() => journal.release(forged), invalid("holderId"));
			await assert.rejects(() => journal.append(lease, { type: e.runStarted, payload: null }, { key: `${key}\u0000suffix` }), invalid("key"));
			await assert.rejects(() => journal.append(lease, { type: e.statusChanged, payload: { status: "status\u0000suffix" } }), invalid("status"));
			for (const text of ["\ud800", "\udfff", "a\ud800b"]) {
				const malformed = field => error => error.constructor === JournalInvalidTextError && error.field === field && error.reason === "ill-formed-unicode";
				await assert.rejects(() => journal.acquire(lease.runId, text), malformed("holderId"));
				await assert.rejects(() => journal.takeover(lease.runId, text, lease.holderId), malformed("holderId"));
				await assert.rejects(() => journal.append({ ...lease, holderId: text }, { type: e.runStarted, payload: null }), malformed("holderId"));
			}
			assert.deepEqual(await journal.acquire(lease.runId, lease.holderId), { status: "acquired", lease });
			const event = { type: e.summaryRecorded, payload: { "text\u0000key": "é\u0000💡", "\u0000": "\u0000", "\ud800": "\ud800", "a\udfffb": "a\udfffb" } };
			const appended = await journal.append(lease, event, { key });
			assert.equal(appended.status, "appended");
			assert.deepEqual(appended.entry.event, event);
			assert.deepEqual(await journal.readKey(lease.runId, key), appended.entry);
			assert.deepEqual(await journal.append(lease, { type: e.runFinished, payload: "replacement\u0000JSON" }, { key }), { status: "exists", entry: appended.entry });
			const taken = await journal.takeover(lease.runId, nextHolder, lease.holderId);
			assert.deepEqual(taken, { status: "acquired", lease: { ...lease, holderId: nextHolder, epoch: lease.epoch + 1 } });
			for (const operation of [() => journal.append(lease, event), () => journal.renew(lease), () => journal.release(lease)]) {
				await assert.rejects(operation, error => error instanceof StaleLeaseError && error.runId === lease.runId && error.heldEpoch === lease.epoch && error.currentEpoch === taken.lease.epoch);
			}
			process.stdout.write("nul-rejection-json=ok\n");
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
