import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { getAgentDir } from "@bastani/atomic";
import { test } from "vitest";
import { JournalDatabase } from "../../packages/workflows/src/durable/journal/node-sqlite.js";
import {
	SqliteRunJournal,
	workflowJournalPath,
} from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	JOURNAL_COLUMNS as c,
	RUN_EVENT_TYPES as e,
	JOURNAL_LEASE,
	JOURNAL_PAYLOAD_ENCODING,
	JOURNAL_SCHEMA_VERSION,
	JournalCasConflictError,
	JournalCounterRangeError,
	type JournalEntry,
	JournalSchemaVersionError,
	type Lease,
	type RunEvent,
	RunNotFoundError,
	StaleLeaseError,
	StorageUnavailableError,
	JOURNAL_TABLES as t,
} from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const header = { runId: "run", name: "workflow", cwd: " /raw/../cwd ", createdAt: 0, status: "running" };

async function withJournal(body: (journal: SqliteRunJournal) => Promise<void>): Promise<void> {
	const directory = makeTempDirectory("journal-unit-");
	const journal = new SqliteRunJournal(join(directory, "nested", "journal.sqlite"));
	try {
		await body(journal);
	} finally {
		await journal.close();
		removeTempDirectory(directory);
	}
}

async function acquire(journal: SqliteRunJournal, runId = header.runId, holderId = "holder"): Promise<Lease> {
	const outcome = await journal.acquire(runId, holderId);
	assert.equal(outcome.status, "acquired");
	if (outcome.status !== "acquired") assert.fail("lease not acquired");
	return outcome.lease;
}

async function read(journal: SqliteRunJournal, runId = header.runId, fromSeq?: number): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const entry of journal.read(runId, fromSeq)) entries.push(entry);
	return entries;
}

test("append is durable when it resolves and readable through a fresh connection", async () => {
	await withJournal(async (journal) => {
		assert.equal(await journal.createRun(header), "created");
		const lease = await acquire(journal);
		const event = { type: e.runStarted, payload: { text: "  raw\ntext  ", values: [2, 1, 2] } } as const;
		const appended = await journal.append(lease, event);
		const reader = new SqliteRunJournal(journal.path);
		try {
			assert.deepEqual(await read(reader), [appended.entry]);
			assert.deepEqual(appended.entry.event, event);
			assert.equal(appended.entry.seq, 1);
			assert.equal("key" in appended.entry, false);
		} finally {
			await reader.close();
		}
	});
});

test("key replay returns the first entry, permits empty keys and keeps dense per-run ordering", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		const first = await journal.append(lease, { type: e.summaryRecorded, payload: "first" }, { key: "" });
		const duplicate = await journal.append(lease, { type: e.summaryRecorded, payload: "replacement" }, { key: "" });
		assert.equal(duplicate.status, "exists");
		assert.deepEqual(duplicate.entry, first.entry);
		assert.deepEqual(await journal.readKey(header.runId, ""), first.entry);
		assert.equal(await journal.readKey(header.runId, "absent"), undefined);
		await journal.append(lease, { type: e.timerScheduled, payload: 0 });
		await journal.append(lease, { type: e.timerScheduled, payload: 0 });
		assert.deepEqual(
			(await read(journal)).map((entry) => entry.seq),
			[1, 2, 3],
		);
		assert.deepEqual(
			(await read(journal, header.runId, 2)).map((entry) => entry.seq),
			[2, 3],
		);
		await journal.createRun({ ...header, runId: "other" });
		const other = await journal.append(
			await acquire(journal, "other"),
			{ type: e.runStarted, payload: null },
			{ key: "" },
		);
		assert.equal(other.entry.seq, 1);
	});
});

test("lease transitions fence stale appends, renewals and releases while retaining monotonic epochs", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const first = await acquire(journal);
		assert.equal(first.epoch, JOURNAL_LEASE.initialEpoch);
		assert.deepEqual(await acquire(journal), first);
		assert.deepEqual(await journal.acquire(header.runId, "second"), {
			status: "held",
			holderId: first.holderId,
			epoch: first.epoch,
		});
		assert.deepEqual(await journal.takeover(header.runId, "second", "wrong"), {
			status: "held",
			holderId: first.holderId,
			epoch: first.epoch,
		});
		await journal.renew(first);
		const outcome = await journal.takeover(header.runId, "second", first.holderId);
		assert.equal(outcome.status, "acquired");
		if (outcome.status !== "acquired") assert.fail("lease not acquired");
		assert.equal(outcome.lease.epoch, first.epoch + 1);
		for (const operation of [
			() => journal.append(first, { type: e.runStarted, payload: null }),
			() => journal.renew(first),
			() => journal.release(first),
		]) {
			await assert.rejects(operation, (error: Error) => {
				assert.ok(error instanceof StaleLeaseError);
				assert.equal(error.runId, header.runId);
				assert.equal(error.heldEpoch, first.epoch);
				assert.equal(error.currentEpoch, outcome.lease.epoch);
				return true;
			});
		}
		assert.deepEqual(await read(journal), []);
		await journal.release(outcome.lease);
		await assert.rejects(() => journal.append(outcome.lease, { type: e.runStarted, payload: null }), StaleLeaseError);
		assert.deepEqual(await journal.takeover(header.runId, "third", "second"), {
			status: "held",
			holderId: null,
			epoch: outcome.lease.epoch,
		});
		assert.equal((await acquire(journal, header.runId, "second")).epoch, outcome.lease.epoch + 1);
	});
});

test("stale expectSeq writes nothing, including on a keyed duplicate", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		await journal.append(
			lease,
			{ type: e.statusChanged, payload: { status: "paused" } },
			{ expectSeq: 0, key: "status" },
		);
		for (const key of ["new", "status"]) {
			await assert.rejects(
				() =>
					journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } }, { expectSeq: 0, key }),
				(error: Error) => {
					assert.ok(error instanceof JournalCasConflictError);
					assert.equal(error.runId, header.runId);
					assert.equal(error.expectedSeq, 0);
					assert.equal(error.actualSeq, 1);
					return true;
				},
			);
		}
		assert.equal((await read(journal)).length, 1);
		assert.equal((await journal.listRuns())[0]?.status, "paused");
		assert.equal(await journal.readKey(header.runId, "new"), undefined);
		assert.equal(
			(await journal.append(lease, { type: e.runFinished, payload: null }, { expectSeq: 1 })).entry.seq,
			2,
		);
	});
});

test("create/list/delete preserve headers and exact cwd filters and remove all run-owned records", async () => {
	await withJournal(async (journal) => {
		assert.equal(await journal.createRun(header), "created");
		assert.equal(await journal.createRun({ ...header, name: "replacement" }), "exists");
		await journal.createRun({ ...header, runId: "other", cwd: "" });
		const lease = await acquire(journal);
		await journal.append(lease, { type: e.runStarted, payload: null }, { key: "key" });
		assert.deepEqual(await journal.listRuns({ cwd: header.cwd }), [header]);
		assert.deepEqual(await journal.listRuns({ cwd: "/cwd" }), []);
		assert.deepEqual(
			(await journal.listRuns({ cwd: "" })).map((run) => run.runId),
			["other"],
		);
		assert.equal((await journal.listRuns()).length, 2);
		await journal.deleteRun(header.runId);
		await journal.deleteRun("missing");
		assert.deepEqual(await read(journal), []);
		assert.equal(await journal.readKey(header.runId, "key"), undefined);
		assert.equal((await journal.listRuns()).length, 1);
		await assert.rejects(() => journal.append(lease, { type: e.runStarted, payload: null }), StaleLeaseError);
		for (const operation of [
			() => journal.acquire(header.runId, "holder"),
			() => journal.takeover(header.runId, "holder", "old"),
		]) {
			await assert.rejects(operation, (error: Error) => {
				assert.ok(error instanceof RunNotFoundError);
				assert.equal(error.runId, header.runId);
				return true;
			});
		}
	});
});

test("delete/recreate cycles durably fence every old handle without affecting other runs", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		await journal.createRun({ ...header, runId: "other" });
		const other = await acquire(journal, "other");
		const old: Lease[] = [];
		for (let cycle = 0; cycle < 3; cycle++) {
			old.push(await acquire(journal));
			await journal.deleteRun(header.runId);
			const reopened = new SqliteRunJournal(journal.path);
			try {
				assert.equal(await reopened.createRun(header), "created");
				const current = await acquire(reopened);
				assert.equal(current.epoch, cycle + 2);
				for (const stale of old) {
					for (const operation of [
						() => reopened.append(stale, { type: e.runStarted, payload: null }),
						() => reopened.renew(stale),
						() => reopened.release(stale),
					])
						await assert.rejects(operation, (error: Error) => {
							assert.ok(error instanceof StaleLeaseError);
							assert.equal(error.runId, header.runId);
							assert.equal(error.heldEpoch, stale.epoch);
							assert.equal(error.currentEpoch, current.epoch);
							return true;
						});
				}
				await reopened.renew(current);
				assert.equal((await reopened.append(current, { type: e.runStarted, payload: null })).entry.seq, 1);
				if (cycle === 2) await reopened.release(current);
			} finally {
				await reopened.close();
			}
		}
		assert.deepEqual(await acquire(journal, "other"), other);
		assert.equal((await journal.append(other, { type: e.runStarted, payload: null })).entry.seq, 1);
	});
});

test("schema v1 exports stable names and stores event payloads as JSON text with required SQLite pragmas", async () => {
	assert.equal(JOURNAL_SCHEMA_VERSION, 1);
	assert.equal(JOURNAL_PAYLOAD_ENCODING, "json-text");
	assert.deepEqual(Object.values(t), ["meta", "runs", "events", "leases"]);
	assert.deepEqual(Object.values(c), [
		"schema_version",
		"run_id",
		"name",
		"cwd",
		"created_at",
		"status",
		"header_json",
		"seq",
		"epoch",
		"key",
		"type",
		"payload",
		"at",
		"holder_id",
		"renewed_at",
	]);
	assert.deepEqual(Object.values(e), [
		"RunStarted",
		"RunFinished",
		"StatusChanged",
		"CheckpointRecorded",
		"PromptAsked",
		"PromptReleased",
		"ControlRequested",
		"MessageQueued",
		"MessageDelivered",
		"MessageSettled",
		"TimerScheduled",
		"SummaryRecorded",
	]);
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		const events: RunEvent[] = Object.values(e)
			.filter((type) => type !== e.checkpointRecorded && type !== e.statusChanged)
			.map((type) => ({ type, payload: "  verbatim\ntext " }));
		events.push({ type: e.statusChanged, payload: { status: "unusual status" } });
		for (const kind of ["tool", "ui", "stage", "task", "boundary"] as const)
			events.push({ type: e.checkpointRecorded, payload: { kind, values: [2, 1, 2], zero: 0, empty: "" } });
		for (const event of events) await journal.append(lease, event);
		assert.deepEqual(
			(await read(journal)).map((entry) => entry.event),
			events,
		);
		const db = new JournalDatabase(journal.path);
		try {
			for (const [pragma, value] of [
				["journal_mode", "wal"],
				["synchronous", 2],
				["busy_timeout", 5000],
				["foreign_keys", 1],
			] as const)
				assert.equal(Object.values(db.get<Record<string, string | number>>(`PRAGMA ${pragma}`) ?? {})[0], value);
			assert.equal(db.get<{ [c.schemaVersion]: number }>(`SELECT * FROM ${t.meta}`)?.[c.schemaVersion], 1);
			assert.equal(
				db.get<{ [c.payload]: string }>(`SELECT ${c.payload} FROM ${t.events} WHERE ${c.seq} = 1`)?.[c.payload],
				JSON.stringify(events[0]?.payload),
			);
			for (const [table, columns] of [
				[t.meta, [c.schemaVersion]],
				[t.runs, [c.runId, c.name, c.cwd, c.createdAt, c.status, c.headerJson]],
				[t.events, [c.runId, c.seq, c.epoch, c.key, c.type, c.payload, c.at]],
				[t.leases, [c.runId, c.holderId, c.epoch, c.renewedAt]],
			] as const)
				assert.deepEqual(
					db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name),
					columns,
				);
		} finally {
			db.close();
		}
	});
});

test("unknown schema versions fail with typed fields and are not migrated", async () => {
	await withJournal(async (journal) => {
		await journal.close();
		const db = new JournalDatabase(journal.path);
		try {
			for (const version of [0, 2, 999]) {
				db.run(`UPDATE ${t.meta} SET ${c.schemaVersion} = ?`, version);
				assert.throws(
					() => new SqliteRunJournal(journal.path),
					(error: Error) => {
						assert.ok(error instanceof JournalSchemaVersionError);
						assert.equal(error.found, version);
						assert.equal(error.supported, 1);
						return true;
					},
				);
				assert.equal(db.get<{ [c.schemaVersion]: number }>(`SELECT * FROM ${t.meta}`)?.[c.schemaVersion], version);
			}
		} finally {
			db.close();
		}
	});
});

test("storage failures and access after idempotent close retain typed path and cause", async () => {
	await withJournal(async (journal) => {
		await journal.close();
		await journal.close();
		await assert.rejects(
			() => journal.listRuns(),
			(error: Error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.path, journal.path);
				assert.ok(error.cause instanceof Error);
				return true;
			},
		);
		const invalid = join(dirname(journal.path), "file");
		writeTextSync(invalid, "not a directory");
		assert.throws(
			() => new SqliteRunJournal(join(invalid, "journal.sqlite")),
			(error: Error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.path, join(invalid, "journal.sqlite"));
				assert.ok(error.cause instanceof Error);
				return true;
			},
		);
	});
});

test("seq at MAX_SAFE_INTEGER rejects its successor before changing any rows", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		const db = new JournalDatabase(journal.path);
		try {
			db.run(
				`INSERT INTO ${t.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				header.runId,
				Number.MAX_SAFE_INTEGER,
				1,
				"seed",
				e.summaryRecorded,
				"null",
				0,
			);
			const before = snapshot(db);
			await assert.rejects(
				() => journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } }),
				(error: Error) => {
					assert.ok(error instanceof JournalCounterRangeError);
					assert.equal(error.runId, header.runId);
					assert.equal(error.field, "seq");
					assert.equal(error.value, Number.MAX_SAFE_INTEGER + 1);
					assert.equal(error.reason, "overflow");
					return true;
				},
			);
			assert.deepEqual(snapshot(db), before);
		} finally {
			db.close();
		}
	});
});

test.each(["takeover", "reacquire"] as const)(
	"epoch at MAX_SAFE_INTEGER rejects %s before changing any rows",
	async (operation) => {
		await withJournal(async (journal) => {
			await journal.createRun(header);
			await acquire(journal);
			const db = new JournalDatabase(journal.path);
			try {
				db.run(
					`UPDATE ${t.leases} SET ${c.epoch} = ?, ${c.holderId} = ?, ${c.renewedAt} = 0`,
					Number.MAX_SAFE_INTEGER,
					operation === "reacquire" ? null : "holder",
				);
				const before = snapshot(db);
				await assert.rejects(
					() =>
						operation === "takeover"
							? journal.takeover(header.runId, "next", "holder")
							: journal.acquire(header.runId, "next"),
					(error: Error) => {
						assert.ok(error instanceof JournalCounterRangeError);
						assert.equal(error.runId, header.runId);
						assert.equal(error.field, "epoch");
						assert.equal(error.value, Number.MAX_SAFE_INTEGER + 1);
						assert.equal(error.reason, "overflow");
						return true;
					},
				);
				assert.deepEqual(snapshot(db), before);
			} finally {
				db.close();
			}
		});
	},
);

test.each([-1, 1.5, 2 ** 53 + 2])(
	"out-of-range lease epoch %s rejects every lease access without writes",
	async (seed) => {
		await withJournal(async (journal) => {
			await journal.createRun(header);
			const lease = await acquire(journal);
			const db = new JournalDatabase(journal.path);
			try {
				db.run(`UPDATE ${t.leases} SET ${c.epoch} = ?, ${c.renewedAt} = 0`, seed);
				const before = snapshot(db);
				for (const operation of [
					() => journal.acquire(header.runId, "holder"),
					() => journal.acquire(header.runId, "other"),
					() => journal.takeover(header.runId, "next", "holder"),
					() => journal.takeover(header.runId, "next", "wrong"),
					() => journal.renew({ ...lease, epoch: seed }),
					() => journal.release({ ...lease, epoch: seed }),
					() =>
						journal.append({ ...lease, epoch: seed }, { type: e.statusChanged, payload: { status: "failed" } }),
					() => journal.deleteRun(header.runId),
				]) {
					await assert.rejects(operation, (error: Error) => {
						assert.ok(error instanceof JournalCounterRangeError);
						assert.equal(error.runId, header.runId);
						assert.equal(error.field, "epoch");
						assert.equal(error.value, seed);
						assert.equal(error.reason, seed < 0 ? "negative" : "unsafe-integer");
						return true;
					});
					assert.deepEqual(snapshot(db), before);
				}
			} finally {
				db.close();
			}
		});
	},
);

test.each([
	["seq", -1],
	["seq", 1.5],
	["seq", 2 ** 53 + 2],
	["epoch", -1],
	["epoch", 1.5],
	["epoch", 2 ** 53 + 2],
] as const)("out-of-range event %s %s rejects reads and keyed replay without writes", async (field, seed) => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		const lease = await acquire(journal);
		const db = new JournalDatabase(journal.path);
		try {
			db.run(
				`INSERT INTO ${t.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				header.runId,
				field === "seq" ? seed : 1,
				field === "epoch" ? seed : 1,
				"seed",
				e.summaryRecorded,
				"null",
				0,
			);
			const before = snapshot(db);
			for (const operation of [
				() => read(journal, header.runId, field === "seq" ? Math.min(seed, 1) : 1),
				() => journal.readKey(header.runId, "seed"),
				() => journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } }, { key: "seed" }),
				...(field === "seq"
					? [() => journal.append(lease, { type: e.statusChanged, payload: { status: "failed" } })]
					: []),
			]) {
				await assert.rejects(operation, (error: Error) => {
					assert.ok(error instanceof JournalCounterRangeError);
					assert.equal(error.runId, header.runId);
					assert.equal(error.field, field);
					assert.equal(error.value, seed);
					assert.equal(error.reason, seed < 0 ? "negative" : "unsafe-integer");
					return true;
				});
				assert.deepEqual(snapshot(db), before);
			}
		} finally {
			db.close();
		}
	});
});

test("safe integer boundary counters remain usable without an overflowing successor", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		await acquire(journal);
		const db = new JournalDatabase(journal.path);
		try {
			db.run(`UPDATE ${t.leases} SET ${c.epoch} = ?`, Number.MAX_SAFE_INTEGER - 1);
			db.run(
				`INSERT INTO ${t.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				header.runId,
				Number.MAX_SAFE_INTEGER - 1,
				Number.MAX_SAFE_INTEGER - 1,
				"seed",
				e.summaryRecorded,
				"null",
				0,
			);
			const outcome = await journal.takeover(header.runId, "next", "holder");
			assert.equal(outcome.status, "acquired");
			if (outcome.status !== "acquired") assert.fail("lease not acquired");
			assert.equal(outcome.lease.epoch, Number.MAX_SAFE_INTEGER);
			assert.deepEqual(await acquire(journal, header.runId, "next"), outcome.lease);
			const appended = await journal.append(
				outcome.lease,
				{ type: e.summaryRecorded, payload: null },
				{ key: "max" },
			);
			assert.equal(appended.entry.seq, Number.MAX_SAFE_INTEGER);
			assert.equal(appended.entry.epoch, Number.MAX_SAFE_INTEGER);
			assert.deepEqual(
				(await read(journal)).map(({ seq }) => seq),
				[Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
			);
			assert.deepEqual(await journal.readKey(header.runId, "max"), appended.entry);
			assert.deepEqual(await journal.append(outcome.lease, { type: e.runStarted, payload: null }, { key: "max" }), {
				status: "exists",
				entry: appended.entry,
			});
			await journal.renew(outcome.lease);
			await journal.release(outcome.lease);
		} finally {
			db.close();
		}
	});
});

test("zero database counters are valid for reads, replay and lease operations", async () => {
	await withJournal(async (journal) => {
		await journal.createRun(header);
		await acquire(journal);
		const db = new JournalDatabase(journal.path);
		try {
			db.run(`UPDATE ${t.leases} SET ${c.epoch} = 0`);
			db.run(
				`INSERT INTO ${t.events} VALUES (?, 0, 0, ?, ?, ?, 0)`,
				header.runId,
				"zero",
				e.summaryRecorded,
				"null",
			);
			const lease = await acquire(journal);
			assert.equal(lease.epoch, 0);
			await journal.renew(lease);
			const entries = await read(journal, header.runId, 0);
			assert.equal(entries[0]?.seq, 0);
			assert.equal(entries[0]?.epoch, 0);
			assert.deepEqual(await journal.readKey(header.runId, "zero"), entries[0]);
			assert.deepEqual(await journal.append(lease, { type: e.runStarted, payload: null }, { key: "zero" }), {
				status: "exists",
				entry: entries[0],
			});
			assert.equal((await journal.append(lease, { type: e.runStarted, payload: null })).entry.seq, 1);
			await journal.release(lease);
			assert.equal((await acquire(journal)).epoch, 1);
		} finally {
			db.close();
		}
	});
});

function snapshot(db: JournalDatabase): Record<string, string>[][] {
	return Object.values(t).map((table) => {
		const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
		return db.all<Record<string, string>>(
			`SELECT ${columns.map(({ name }) => `quote(${name}) AS ${name}`).join(", ")} FROM ${table} ORDER BY rowid`,
		);
	});
}

test("journal path defaults to the user workflow root and preserves an explicit environment override", () => {
	const previousPi = process.env.PI_WORKFLOW_JOURNAL_PATH;
	const previous = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	try {
		delete process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
		delete process.env.PI_WORKFLOW_JOURNAL_PATH;
		assert.equal(workflowJournalPath(), join(dirname(getAgentDir()), "workflows", "journal.sqlite"));
		process.env.PI_WORKFLOW_JOURNAL_PATH = "/tmp/ignored-journal.sqlite";
		assert.equal(workflowJournalPath(), join(dirname(getAgentDir()), "workflows", "journal.sqlite"));
		for (const value of ["", " ./verbatim/../journal.sqlite ", "relative.sqlite"]) {
			process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = value;
			assert.equal(workflowJournalPath(), value);
		}
	} finally {
		if (previous === undefined) delete process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
		else process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = previous;
		if (previousPi === undefined) delete process.env.PI_WORKFLOW_JOURNAL_PATH;
		else process.env.PI_WORKFLOW_JOURNAL_PATH = previousPi;
	}
});
