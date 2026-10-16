import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { afterEach, test } from "vitest";
import { registerRunJournalConformance } from "../../packages/workflows/src/durable/journal/conformance.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { assertLeaseStateUnchanged } from "../helpers/journal-lease-state.js";
import { observeJournalRead } from "../helpers/journal-read-observation.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

registerRunJournalConformance(test, "memory", () => new MemoryRunJournal(), observeJournalRead);
registerRunJournalConformance(
	test,
	"sqlite",
	async () => {
		const directory = makeTempDirectory("journal-conformance-");
		const journal = await openSqlRunJournal(join(directory, "journal.sqlite"));
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
	async () => {
		const directory = makeTempDirectory("borrowed-journal-conformance-");
		const database = new DatabaseSync(join(directory, "journal.sqlite"));
		borrowed.push({ database, directory });
		return await openSqlRunJournal(database);
	},
	observeJournalRead,
);

for (const source of ["node", "caller-owned"] as const) {
	test(`${source} reopens headers, keyed events, live leases and deletion tombstones`, async () => {
		const directory = makeTempDirectory("journal-reopen-");
		const path = join(directory, "journal.sqlite");
		const connection = source === "caller-owned" ? new DatabaseSync(path) : undefined;
		let journal = await openSqlRunJournal(connection ?? path);
		try {
			const header = { runId: "run", name: "name", cwd: " /raw/../cwd ", createdAt: 0, status: "running" };
			await journal.createRun(header);
			const acquired = await journal.acquire(header.runId, "first");
			assert.equal(acquired.status, "acquired");
			if (acquired.status !== "acquired") assert.fail("lease not acquired");
			const appended = await journal.append(
				acquired.lease,
				{ type: "StatusChanged", payload: { status: "paused", values: [2, 1, 2] } },
				{ key: "", expectSeq: 0 },
			);
			const state = await journal.leaseState(header.runId);
			await journal.close();
			journal = await openSqlRunJournal(connection ?? path);
			assert.deepEqual(await journal.getRun(header.runId), { ...header, status: "paused" });
			assertLeaseStateUnchanged(await journal.leaseState(header.runId), state);
			assert.deepEqual(
				await journal.append(acquired.lease, { type: "RunFinished", payload: null }, { key: "", expectSeq: 0 }),
				{ status: "exists", entry: appended.entry },
			);
			assert.deepEqual(await journal.readKey(header.runId, ""), appended.entry);
			await journal.deleteOwnedRun(acquired.lease, 1);
			await journal.close();
			journal = await openSqlRunJournal(connection ?? path);
			assert.equal(await journal.getRun(header.runId), undefined);
			assert.equal(await journal.readKey(header.runId, ""), undefined);
			await journal.createRun(header);
			const recreated = await journal.acquire(header.runId, "first");
			assert.equal(recreated.status, "acquired");
			if (recreated.status !== "acquired") assert.fail("lease not acquired");
			assert.equal(recreated.lease.epoch, acquired.lease.epoch + 1);
			await assert.rejects(journal.deleteOwnedRun(acquired.lease), StaleLeaseError);
		} finally {
			await journal.close();
			connection?.close();
			removeTempDirectory(directory);
		}
	});
}

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
