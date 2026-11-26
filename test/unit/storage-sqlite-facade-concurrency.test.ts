import assert from "node:assert/strict";
import {
	createSqliteDatabase,
	type FencedPathId,
	inMemorySecret,
	postgresDialect,
	resolveAdapterOptions,
	type SqliteDriver,
	type SqliteDriverTransactionOptions,
	type SqliteTransactionOptions,
	StorageConfigError,
	sqliteDialect,
} from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { sequenceRunner, statementBatch } from "../../packages/coding-agent/src/core/storage/statement-sequence.js";

/** Stands in for `fencedPath(name)`, whose registry is empty until a path is audited. */
const AUDITED = "test-path" as FencedPathId;

/** A driver whose transactions stay open until `release()`; it records how each one was begun and when it ended. */
function gatedDriver(overrides: Partial<SqliteDriver> = {}) {
	const events: string[] = [];
	const begun: (SqliteDriverTransactionOptions | undefined)[] = [];
	const gates: (() => void)[] = [];
	const result = { columns: [], rows: [], changes: 0 };
	const driver: SqliteDriver = {
		descriptor: { adapter: "gated", location: "gated://database" },
		execute: (sql) => {
			events.push(`execute ${sql}`);
			return result;
		},
		executeMultiple: () => {},
		beginTransaction(options) {
			begun.push(options);
			const kind = options?.concurrency.kind ?? "none";
			events.push(`begin ${kind}`);
			return {
				execute: async (sql) => {
					events.push(`tx ${sql}`);
					if (sql === "wait") await new Promise<void>((resolve) => gates.push(resolve));
					return result;
				},
				executeMultiple: () => {},
				commit: () => void events.push(`commit ${kind}`),
				rollback: () => void events.push(`rollback ${kind}`),
			};
		},
		close: () => void events.push("close"),
		...overrides,
	};
	return {
		driver,
		events,
		begun,
		release: () => {
			for (const gate of gates.splice(0)) gate();
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("transactions tell the driver their concurrency and lock wait, serial by default (#4793)", async () => {
	const { driver, begun } = gatedDriver();
	const database = createSqliteDatabase(driver);
	await database.transaction(async () => {});
	await database.transaction(async () => {}, { lockWaitMs: 1234 });
	await database.transaction(async () => {}, { concurrency: { kind: "serial" } });
	await database.transaction(async () => {}, { concurrency: { kind: "serial", domain: "team_sessions" } });
	await database.transaction(async () => {}, { concurrency: { kind: "fenced", audit: AUDITED } });
	assert.deepEqual(begun, [
		{ concurrency: { kind: "serial" } },
		{ concurrency: { kind: "serial" }, lockWaitMs: 1234 },
		{ concurrency: { kind: "serial" } },
		{ concurrency: { kind: "serial", domain: "team_sessions" } },
		{ concurrency: { kind: "fenced", audit: "test-path" } },
	]);
	await database.close();
});

test("a malformed concurrency is refused before the transaction begins (#4793)", async () => {
	const { driver, begun } = gatedDriver();
	const database = createSqliteDatabase(driver);
	const malformed = [
		{ kind: "parallel" },
		{ kind: "parallel", audit: "test-path" },
		{ kind: "serial", domain: 7 },
		{ kind: "fenced" },
		{ kind: "fenced", audit: "" },
		{ kind: "fenced", audit: 1 },
		null,
		"serial",
	];
	for (const concurrency of malformed) {
		await assert.rejects(
			database.transaction(async () => {}, { concurrency } as unknown as SqliteTransactionOptions),
			(error: StorageConfigError) =>
				error instanceof StorageConfigError &&
				error.source === "sdk" &&
				error.field === "concurrency" &&
				error.reason === "kind-required" &&
				error.hint ===
					'Pass { kind: "serial" }, { kind: "serial", domain }, or { kind: "fenced", audit: fencedPath(name) }, or omit it',
		);
	}
	assert.deepEqual(begun, []);
	await database.close();
});

test("the facade exposes the driver's dialect, or SQLite's (#4793)", async () => {
	const sqlite = createSqliteDatabase(gatedDriver().driver);
	const postgres = createSqliteDatabase(gatedDriver({ dialect: postgresDialect }).driver);
	assert.equal(sqlite.dialect, sqliteDialect);
	assert.equal(postgres.dialect, postgresDialect);
	await Promise.all([sqlite.close(), postgres.close()]);
});

test("fenced transactions wait their turn unless the driver runs transactions concurrently (#4793)", async () => {
	const serialOnly = gatedDriver();
	const database = createSqliteDatabase(serialOnly.driver);
	const first = database.transaction((tx) => tx.run("wait"));
	const fenced = database.transaction(async () => {}, { concurrency: { kind: "fenced", audit: AUDITED } });
	await settle();
	assert.deepEqual(serialOnly.events, ["begin serial", "tx wait"]);
	serialOnly.release();
	await Promise.all([first, fenced]);
	assert.deepEqual(serialOnly.events, ["begin serial", "tx wait", "commit serial", "begin fenced", "commit fenced"]);
	await database.close();
});

test("a concurrent driver runs fenced transactions beside queued calls, and closing waits for them (#4793)", async () => {
	const concurrent = gatedDriver({ concurrentTransactions: true });
	const database = createSqliteDatabase(concurrent.driver);
	const serial = database.transaction((tx) => tx.run("wait"));
	const fenced = database.transaction((tx) => tx.run("wait"), { concurrency: { kind: "fenced", audit: AUDITED } });
	const queuedSerial = database.transaction(async () => {});
	await settle();
	// Both transactions are open at once; the queued serial one has not begun.
	assert.deepEqual([...concurrent.events].sort(), ["begin fenced", "begin serial", "tx wait", "tx wait"]);
	const failing = database.transaction(
		async () => {
			throw new Error("body failed");
		},
		{ concurrency: { kind: "fenced", audit: AUDITED } },
	);
	await assert.rejects(failing, /body failed/);
	const closed = database.close();
	await settle();
	assert.equal(concurrent.events.includes("close"), false);
	concurrent.release();
	await Promise.all([serial, fenced, queuedSerial, closed]);
	assert.equal(concurrent.events.at(-1), "close");
	assert.equal(concurrent.events.filter((event) => event.startsWith("commit")).length, 3);
});

test("closing ends every concurrent transaction's retry wait at once (#4793)", async () => {
	vi.useFakeTimers();
	const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	try {
		const refused = new Error("connection refused");
		const { driver } = gatedDriver({
			concurrentTransactions: true,
			beginTransaction: () => {
				throw refused;
			},
			transientFailure: (failure) =>
				failure === refused ? { code: "connection-refused", outcome: "not-applied" } : undefined,
		});
		const database = createSqliteDatabase(driver);
		const fenced = { concurrency: { kind: "fenced", audit: AUDITED }, retryTransientFailures: true } as const;
		const settled: string[] = [];
		const transactions = [1, 2].map((index) =>
			database.transaction(async () => {}, fenced).catch(() => void settled.push(`transaction ${index}`)),
		);
		await vi.advanceTimersByTimeAsync(0);
		const closed = database.close().then(() => void settled.push("closed"));
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(settled.sort(), ["closed", "transaction 1", "transaction 2"]);
		await Promise.all([...transactions, closed]);
	} finally {
		warn.mockRestore();
		vi.useRealTimers();
	}
});

test("a pipelined driver gets a transaction's calls before their answers, and its commit behind them (#5102)", async () => {
	const { driver, events, release } = gatedDriver({ concurrentTransactions: true, pipelinedTransactions: true });
	const database = createSqliteDatabase(driver);
	let answers: Promise<unknown[]> | undefined;
	const done = database.transaction(
		async (tx) => {
			answers = Promise.all([tx.all("wait"), tx.all("second")]);
		},
		{ concurrency: { kind: "fenced", audit: AUDITED } },
	);
	await settle();
	// Both statements and the commit went out while the first still waits for its answer.
	assert.deepEqual(events, ["begin fenced", "tx wait", "tx second", "commit fenced"]);
	release();
	await done;
	assert.equal((await answers!).length, 2);
	await database.close();
});

test("without pipelining, each call of a transaction waits for the one before, and the commit for all (#5102)", async () => {
	const { driver, events, release } = gatedDriver({ concurrentTransactions: true });
	const database = createSqliteDatabase(driver);
	const done = database.transaction(
		async (tx) => {
			void Promise.all([tx.all("wait"), tx.all("second")]);
		},
		{ concurrency: { kind: "fenced", audit: AUDITED } },
	);
	await settle();
	assert.deepEqual(events, ["begin fenced", "tx wait"]);
	release();
	await done;
	assert.deepEqual(events, ["begin fenced", "tx wait", "tx second", "commit fenced"]);
	await database.close();
});

test("a pipelined transaction whose callback fails rolls back once its calls settle (#5102)", async () => {
	const { driver, events, release } = gatedDriver({ concurrentTransactions: true, pipelinedTransactions: true });
	const database = createSqliteDatabase(driver);
	const done = database.transaction(
		async (tx) => {
			void tx.all("wait").catch(() => {});
			throw new Error("refused");
		},
		{ concurrency: { kind: "fenced", audit: AUDITED } },
	);
	await settle();
	assert.deepEqual(events, ["begin fenced", "tx wait"]);
	release();
	await assert.rejects(done, /refused/);
	assert.deepEqual(events, ["begin fenced", "tx wait", "rollback fenced"]);
	await database.close();
});

test("a live secret's name is left out of options even when an option shares it (#4793)", async () => {
	const selection = {
		kind: "adapter",
		module: "unused",
		options: { password: "from-options", url: "postgres://example" },
		secrets: { password: inMemorySecret("from-secret") },
	} as const;
	const context = { agentDir: "/unused", domain: "sessions" } as const;
	assert.deepEqual(await resolveAdapterOptions(selection, context, ["password"]), { url: "postgres://example" });
	assert.deepEqual(await resolveAdapterOptions(selection, context), {
		password: "from-secret",
		url: "postgres://example",
	});
});

test("a pipelined transaction sends a statement batch's writes and reads before their answers (#6560)", async () => {
	const { driver, events, release } = gatedDriver({ concurrentTransactions: true, pipelinedTransactions: true });
	const database = createSqliteDatabase(driver);
	const done = database.transaction(
		async (tx) => {
			assert.ok(sequenceRunner(tx));
			await statementBatch(
				tx,
				[{ sql: "wait", params: [] }, { sql: "second", params: [1] }, false, { sql: "third", params: [] }],
				[() => tx.get("read")],
			);
		},
		{ concurrency: { kind: "serial", domain: "sessions:s1" } },
	);
	await settle();
	assert.deepEqual(events, ["begin serial", "tx wait", "tx second", "tx third", "tx read"]);
	release();
	await done;
	assert.deepEqual(events.at(-1), "commit serial");
	await database.close();
});

test("a pipelined statement batch fails with its first failed statement, and the transaction commits nothing (#6560)", async () => {
	const { driver, events } = gatedDriver({ concurrentTransactions: true, pipelinedTransactions: true });
	const failing = driver.beginTransaction;
	driver.beginTransaction = async (options) => {
		const transaction = await failing.call(driver, options);
		return {
			...transaction,
			execute: async (sql, params) => {
				const result = await transaction.execute(sql, params);
				if (sql === "refused" || sql === "after") throw new Error(`${sql} failed`);
				return result;
			},
		};
	};
	const database = createSqliteDatabase(driver);
	await assert.rejects(
		database.transaction(async (tx) => {
			await statementBatch(
				tx,
				[
					{ sql: "first", params: [] },
					{ sql: "refused", params: [] },
					{ sql: "after", params: [] },
				],
				[],
			);
		}),
		(error: Error) => (error.cause as Error | undefined)?.message === "refused failed",
	);
	assert.deepEqual(events, ["begin serial", "tx first", "tx refused", "tx after", "rollback serial"]);
	await database.close();
});

test("a pipelined statement batch sends nothing after a statement whose text holds NUL (#6560)", async () => {
	const { driver, events } = gatedDriver({ concurrentTransactions: true, pipelinedTransactions: true });
	const database = createSqliteDatabase(driver);
	await assert.rejects(
		database.transaction(async (tx) => {
			await statementBatch(
				tx,
				[
					{ sql: "first", params: [] },
					{ sql: "bad", params: ["a\0b"] },
					{ sql: "after", params: [] },
				],
				[],
			);
		}),
		(error: Error) => error.name === "StorageInvalidTextError",
	);
	assert.deepEqual(events, ["begin serial", "tx first", "rollback serial"]);
	await database.close();
});
