import assert from "node:assert/strict";
import {
	createSqliteDatabase,
	type FencedPathId,
	type SqliteDriver,
	type SqliteDriverTransactionOptions,
	type SqliteTransactionOptions,
} from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { transactionFinisher } from "../../packages/coding-agent/src/core/storage/statement-sequence.js";

const AUDITED = "test-path" as FencedPathId;
const RETRIED: SqliteTransactionOptions = {
	retryTransientFailures: true,
	concurrency: { kind: "serial", domain: "sessions:s1" },
};

class Refused extends Error {}
class Lost extends Error {}

/**
 * A pipelined driver like Postgres's: a statement listed in `failing` fails once its turn comes, and a commit behind a
 * failed statement comes back as a rollback. `gate` holds every answer until `release()`.
 */
function pipelinedDriver(failing: Map<string, () => Error> = new Map()) {
	const events: string[] = [];
	const begun: SqliteDriverTransactionOptions[] = [];
	let gate: Promise<void> = Promise.resolve();
	let open: () => void = () => {};
	const result = { columns: [], rows: [], changes: 1 };
	const driver: SqliteDriver = {
		descriptor: { adapter: "pipelined", location: "pipelined://database" },
		concurrentTransactions: true,
		pipelinedTransactions: true,
		transientFailure: (failure) =>
			failure instanceof Refused
				? { code: "lock-conflict", outcome: "not-applied" }
				: failure instanceof Lost
					? { code: "connection-lost", outcome: "unknown" }
					: undefined,
		execute: () => result,
		executeMultiple: () => {},
		beginTransaction(options) {
			if (options !== undefined) begun.push(options);
			events.push("begin");
			let aborted: Error | undefined;
			return {
				execute: async (sql) => {
					events.push(`tx ${sql}`);
					await gate;
					const failure = failing.get(sql);
					if (failure !== undefined) {
						failing.delete(sql);
						aborted = failure();
						throw aborted;
					}
					if (aborted !== undefined) throw new Error("current transaction is aborted");
					return result;
				},
				executeMultiple: () => {},
				commit: async () => {
					events.push("commit");
					await gate;
					if (aborted instanceof Lost) throw new Lost("connection lost");
					if (aborted !== undefined)
						throw new Error("The transaction was rolled back because a statement in it failed");
				},
				rollback: () => void events.push("rollback"),
			};
		},
		close: () => {},
	};
	return {
		driver,
		events,
		begun,
		hold() {
			gate = new Promise((resolve) => {
				open = resolve;
			});
		},
		release: () => open(),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a transaction's last writes go out with its commit, before any answer (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	pipelined.hold();
	const done = database.transaction(async (tx) => {
		const finish = transactionFinisher(tx);
		assert.ok(finish);
		assert.equal(
			finish([
				{ sql: "insert entry", params: [1] },
				{ sql: "update head", params: [1] },
			]),
			true,
		);
		return "appended";
	}, RETRIED);
	await settle();
	assert.deepEqual(pipelined.events, ["begin", "tx insert entry", "tx update head", "commit"]);
	pipelined.release();
	assert.equal(await done, "appended");
	await database.close();
});

test("a transaction takes no call after its last writes (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	await assert.rejects(
		database.transaction(async (tx) => {
			transactionFinisher(tx)?.([{ sql: "insert entry", params: [] }]);
			await tx.run("late");
		}),
		(error: Error) => error.name === "StorageTransactionClosedError",
	);
	assert.deepEqual(pipelined.events, ["begin", "tx insert entry", "rollback"]);
	await database.close();
});

test("last writes holding NUL are not sent that way, and the caller writes them as before (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	await database.transaction(async (tx) => {
		assert.equal(
			transactionFinisher(tx)?.([
				{ sql: "insert entry", params: [] },
				{ sql: "bad", params: ["a\0b"] },
			]),
			false,
		);
	});
	assert.deepEqual(pipelined.events, ["begin", "commit"]);
	await database.close();
});

test("a non-pipelined transaction offers no way to send its last writes with its commit (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase({ ...pipelined.driver, pipelinedTransactions: false });
	await database.transaction(async (tx) => assert.equal(transactionFinisher(tx), undefined));
	await database.close();
});

test("a last write the server refused fails the transaction with its own error, and it runs again (#6560)", async () => {
	const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	try {
		const pipelined = pipelinedDriver(new Map([["insert entry", () => new Refused("deadlock detected")]]));
		const database = createSqliteDatabase(pipelined.driver);
		let runs = 0;
		const done = await database.transaction(async (tx) => {
			runs++;
			transactionFinisher(tx)?.([{ sql: "insert entry", params: [] }]);
			return runs;
		}, RETRIED);
		assert.equal(done, 2);
		assert.deepEqual(pipelined.events, [
			"begin",
			"tx insert entry",
			"commit",
			"rollback",
			"begin",
			"tx insert entry",
			"commit",
		]);
		await database.close();
	} finally {
		warn.mockRestore();
	}
});

test("a last write whose connection broke after the commit went out is not run again: it may have committed (#6560)", async () => {
	const pipelined = pipelinedDriver(new Map([["insert entry", () => new Lost("connection lost")]]));
	const database = createSqliteDatabase(pipelined.driver);
	let runs = 0;
	await assert.rejects(
		database.transaction(async (tx) => {
			runs++;
			transactionFinisher(tx)?.([{ sql: "insert entry", params: [] }]);
		}, RETRIED),
		(error: Error & { outcome?: string }) => error.name === "StorageTransientError" && error.outcome === "unknown",
	);
	assert.equal(runs, 1);
	await database.close();
});

test("an unawaited statement the server refused before the commit went out still lets the transaction run again (#6560)", async () => {
	const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	try {
		const pipelined = pipelinedDriver(new Map([["update", () => new Refused("could not serialize access")]]));
		const database = createSqliteDatabase(pipelined.driver);
		let runs = 0;
		const done = await database.transaction(async (tx) => {
			runs++;
			void tx.run("update").catch(() => {});
			// Its failure arrives before the callback returns and the commit is sent.
			await tx.get("read").catch(() => undefined);
			return runs;
		}, RETRIED);
		assert.equal(done, 2);
		await database.close();
	} finally {
		warn.mockRestore();
	}
});

test("a commit that came back as a rollback fails with the statement that failed, not a reasonless rollback (#6560)", async () => {
	const pipelined = pipelinedDriver(new Map([["insert entry", () => new Error("duplicate key value")]]));
	const database = createSqliteDatabase(pipelined.driver);
	await assert.rejects(
		database.transaction(async (tx) => {
			transactionFinisher(tx)?.([{ sql: "insert entry", params: [] }]);
		}),
		(error: Error) => (error.cause as Error | undefined)?.message === "duplicate key value",
	);
	await database.close();
});

test("a pipelined driver is told a transaction's leading reads, snapshotted and up to one holding NUL (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	const bytes = new Uint8Array([1, 2]);
	const leading = [
		{ sql: "SELECT schema_version FROM meta", params: [] },
		{ sql: "SELECT last_seq FROM sessions WHERE id = ?", params: ["s1", bytes] },
		{ sql: "bad", params: ["a\0b"] },
		{ sql: "after", params: [] },
	];
	await database.transaction(async () => {}, { ...RETRIED, leading });
	bytes[0] = 9;
	assert.deepEqual(
		pipelined.begun.map((begin) => begin.leading),
		[
			[
				{ sql: "SELECT schema_version FROM meta", params: [] },
				{ sql: "SELECT last_seq FROM sessions WHERE id = ?", params: ["s1", new Uint8Array([1, 2])] },
			],
		],
	);
	const serial = pipelinedDriver();
	const unpipelined = createSqliteDatabase({ ...serial.driver, pipelinedTransactions: false });
	await unpipelined.transaction(async () => {}, { concurrency: { kind: "fenced", audit: AUDITED }, leading });
	assert.equal(serial.begun[0]?.leading, undefined);
	await Promise.all([database.close(), unpipelined.close()]);
});

test("a read-only transaction answers once its reads are answered, before its commit is, and closing waits for it (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	let committed = false;
	const commitGate = Promise.withResolvers<void>();
	const begin = pipelined.driver.beginTransaction.bind(pipelined.driver);
	pipelined.driver.beginTransaction = async (options) => {
		const transaction = await begin(options);
		return {
			...transaction,
			commit: async () => {
				await commitGate.promise;
				committed = true;
			},
		};
	};
	const rows = await database.transaction(async (tx) => tx.all("SELECT entries"), { readOnly: true });
	assert.deepEqual(rows, []);
	assert.equal(committed, false);
	const closed = database.close();
	await settle();
	assert.equal(committed, false);
	commitGate.resolve();
	await closed;
	assert.equal(committed, true);
});

test("a read-only transaction waits for its commit where transactions share the connection (#6560)", async () => {
	const pipelined = pipelinedDriver();
	let committed = false;
	const database = createSqliteDatabase({
		...pipelined.driver,
		concurrentTransactions: false,
		pipelinedTransactions: false,
		async beginTransaction(options) {
			const transaction = await pipelined.driver.beginTransaction(options);
			return {
				...transaction,
				commit: async () => {
					await settle();
					committed = true;
				},
			};
		},
	});
	await database.transaction(async (tx) => tx.all("SELECT entries"), { readOnly: true });
	assert.equal(committed, true);
	await database.close();
});
