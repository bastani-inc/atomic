import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteStatement,
} from "../../packages/coding-agent/src/core/storage/database.js";
import {
	StorageInvalidTextError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { SequenceRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { type RunSequence, sequenceRunner } from "../../packages/coding-agent/src/core/storage/statement-sequence.js";
import { collectGarbage } from "../helpers/collect-garbage.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";

/** Most statements one request to a connection's thread carries. */
const REQUEST_STATEMENTS = 256;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openFile(options?: { readonly busyTimeoutMs?: number }): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("atomic-statement-sequence-");
	cleanups.push(() => removeTempDirectory(directory));
	const database = await openNodeSqliteDatabase(join(directory, "sequence.sqlite"), options);
	cleanups.push(() => database.close());
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	return database;
}

function insert(value: string): SqliteStatement {
	return { sql: "INSERT INTO items (value) VALUES (?)", params: [value] };
}

async function values(tx: SqliteExecutor): Promise<string[]> {
	return (await tx.all<{ value: string }>("SELECT value FROM items ORDER BY rowid")).map((row) => row.value);
}

function runnerOf(tx: SqliteExecutor): RunSequence {
	const run = sequenceRunner(tx);
	assert.ok(run, "a transaction of a file connection runs sequences");
	return run;
}

/** Sequence requests sent to connections' threads until the test ends, as they were sent. */
function watchSequences(onSequence?: (request: SequenceRequest, send: () => Promise<unknown>) => Promise<unknown>): {
	readonly sent: SequenceRequest[];
	readonly overlapping: () => number;
} {
	const sent: SequenceRequest[] = [];
	let inFlight = 0;
	let most = 0;
	const interception = interceptConnectionRequests(async (request, send) => {
		if (request.kind !== "sequence") return send(request);
		sent.push(request);
		most = Math.max(most, ++inFlight);
		try {
			return (await (onSequence?.(request, () => send(request)) ?? send(request))) as never;
		} finally {
			inFlight--;
		}
	});
	cleanups.push(() => interception.restore());
	return { sent, overlapping: () => most };
}

test("a transaction sends a sequence's statements to the connection's thread as one request and runs them in order (#6082)", async () => {
	const database = await openFile();
	const { sent } = watchSequences();
	const rows = await database.transaction(async (tx) => {
		await runnerOf(tx)({ statements: [insert("a"), insert("b"), insert("c")] });
		return values(tx);
	});
	assert.deepEqual(rows, ["a", "b", "c"]);
	assert.equal(sent.length, 1);
});

test("a sequence runs nothing after a statement that fails, and fails with the error that statement gives alone (#6082)", async () => {
	const database = await openFile();
	const failing: SqliteStatement = { sql: "INSERT INTO absent (value) VALUES (?)", params: ["b"] };
	const alone = await database
		.transaction((tx) => tx.run(failing.sql, ...failing.params))
		.then(
			() => assert.fail("the statement succeeded"),
			(error: unknown) => error,
		);
	const { failure, rows } = await database.transaction(async (tx) => {
		const failure = await runnerOf(tx)({ statements: [insert("a"), failing, insert("c")] }).then(
			() => assert.fail("the sequence succeeded"),
			(error: unknown) => error,
		);
		return { failure, rows: await values(tx) };
	});
	assert.deepEqual(rows, ["a"]);
	assert.ok(failure instanceof StorageUnavailableError && alone instanceof StorageUnavailableError);
	assert.equal(failure.message, alone.message);
	assert.deepEqual({ ...(failure.cause as object) }, { ...(alone.cause as object) });
	assert.equal(String(failure.cause), String(alone.cause));
});

test.each([
	["", () => {}],
	// A listener of the caller's own that keeps the abort event from listeners after it does not keep it from the thread.
	[
		" and a listener stops the abort event",
		(signal: AbortSignal) => signal.addEventListener("abort", (event) => event.stopImmediatePropagation()),
	],
])(
	"a sequence whose signal aborted before its statements ran runs none of them and rejects with the signal's reason%s (#6082)",
	async (_case, listen) => {
		const database = await openFile();
		const controller = new AbortController();
		listen(controller.signal);
		const reason = new Error("stopped");
		// Aborted after the caller's own check and before the request reaches the connection's thread: only the thread's
		// check can stop the statements.
		watchSequences((_request, send) => {
			controller.abort(reason);
			return send();
		});
		const { failure, rows } = await database.transaction(async (tx) => {
			const failure = await runnerOf(tx)({
				statements: [insert("a"), insert("b")],
				signal: controller.signal,
			}).then(
				() => assert.fail("the sequence succeeded"),
				(error: unknown) => error,
			);
			return { failure, rows: await values(tx) };
		});
		assert.equal(failure, reason);
		assert.deepEqual(rows, []);
	},
);

test("an abort event dispatched on a signal that did not abort stops nothing (#6082)", async () => {
	const database = await openFile();
	const controller = new AbortController();
	watchSequences((_request, send) => {
		controller.signal.dispatchEvent(new Event("abort"));
		return send();
	});
	const rows = await database.transaction(async (tx) => {
		await runnerOf(tx)({ statements: [insert("a"), insert("b")], signal: controller.signal });
		return values(tx);
	});
	assert.deepEqual(rows, ["a", "b"]);
});

test("a signal sent an abort event without aborting still stops the thread when it aborts later in the same sequence (#6106)", async () => {
	const database = await openFile();
	const controller = new AbortController();
	const reason = new Error("stopped");
	// Two requests: before the first reaches its thread the signal gets an abort event only; before the second, it aborts.
	const expected = Array.from({ length: REQUEST_STATEMENTS }, (_, index) => `v${index}`);
	watchSequences((request, send) => {
		if (request.statements[0]?.params[0] === "v0") controller.signal.dispatchEvent(new Event("abort"));
		else controller.abort(reason);
		return send();
	});
	const { failure, rows } = await database.transaction(async (tx) => {
		const failure = await runnerOf(tx)({
			statements: [...expected, "late", "later"].map(insert),
			signal: controller.signal,
		}).then(
			() => assert.fail("the sequence succeeded"),
			(error: unknown) => error,
		);
		return { failure, rows: await values(tx) };
	});
	assert.equal(failure, reason);
	assert.deepEqual(rows, expected);
});

/**
 * A database file with a table `t`, to attach to a database's connection with a page cache of 10 pages, and a reader of
 * the test's own. A statement that writes more of the file than the cache holds has to write the file before it ends,
 * which waits for every reader to finish: while the test's reader holds a transaction open, that statement waits in the
 * middle, and a new reader of the file is refused, which is how the test sees it waiting. Made before the database it
 * is attached to, so it is removed after that database closed.
 */
function gateFile() {
	const directory = makeTempDirectory("atomic-statement-sequence-gate-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "gate.sqlite");
	const reader = new DatabaseSync(path);
	const probe = new DatabaseSync(path);
	cleanups.push(() => {
		reader.close();
		probe.close();
	});
	reader.exec("PRAGMA busy_timeout=0; CREATE TABLE t (value TEXT NOT NULL)");
	probe.exec("PRAGMA busy_timeout=0");
	const count = () => Number(reader.prepare("SELECT count(*) AS rows FROM t").get()?.rows);
	let reading = false;
	const release = () => {
		if (!reading) return;
		reading = false;
		reader.exec("COMMIT");
	};
	return {
		async attachTo(database: SqliteDatabase, name: string): Promise<void> {
			await database.exec(`ATTACH DATABASE '${path.replaceAll("'", "''")}' AS ${name}`);
			await database.exec(`PRAGMA ${name}.cache_size=10`);
		},
		/** Holds a read transaction on the file open until `release`, or until the test ends, before its database closes. */
		hold(): void {
			reader.exec("BEGIN");
			count();
			reading = true;
			cleanups.push(release);
		},
		release,
		/** Whether a statement of another connection is waiting to write the file. */
		writerWaiting(): boolean {
			try {
				probe.prepare("SELECT count(*) FROM t").get();
				return false;
			} catch (error) {
				if ((error as { errcode?: number }).errcode === 5) return true;
				throw error;
			}
		},
		rows: count,
	};
}

test("a sequence whose signal aborts while one of its statements runs finishes that statement and runs none after it (#6106)", async () => {
	const gate = gateFile();
	const database = await openFile({ busyTimeoutMs: TEST_TIMEOUT_MS });
	await gate.attachTo(database, "gate");
	// 200 rows of 1,000 characters: far more than the gate's 10 cached pages.
	const fillGate: SqliteStatement = {
		sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) INSERT INTO gate.t (value) SELECT hex(randomblob(500)) FROM n",
		params: [],
	};
	gate.hold();
	const controller = new AbortController();
	const reason = new Error("stopped");
	const { sent } = watchSequences();
	const ran = database.transaction(async (tx) => {
		const failure = await runnerOf(tx)({
			statements: [insert("a"), fillGate, insert("c"), insert("d")],
			signal: controller.signal,
		}).then(
			() => assert.fail("the sequence succeeded"),
			(error: unknown) => error,
		);
		// What the statements before the abort, and the one it landed in, did stays in the transaction for the caller.
		const inTransaction = {
			items: await values(tx),
			gateRows: Number((await tx.get<{ rows: number }>("SELECT count(*) AS rows FROM gate.t"))?.rows),
		};
		throw Object.assign(new Error("rolled back"), { failure, inTransaction });
	});
	let ended = false;
	const outcome = ran.then(
		() => assert.fail("the transaction committed"),
		(error: unknown) => error as { failure: unknown; inTransaction: unknown },
	);
	const end = () => {
		ended = true;
	};
	outcome.then(end, end);
	cleanups.push(end);
	// The thread is in the middle of the second statement, which cannot end until the test's reader does.
	while (!ended && !gate.writerWaiting()) await new Promise((resolve) => setImmediate(resolve));
	controller.abort(reason);
	gate.release();
	const { failure, inTransaction } = await outcome;
	assert.equal(sent.length, 1, "the statements went as one request");
	assert.equal(failure, reason);
	assert.deepEqual(inTransaction, { items: ["a"], gateRows: 200 });
	// The caller's transaction ends as the caller decides: here it rolls back, the attached file's rows with it.
	assert.deepEqual(await database.all("SELECT value FROM items"), []);
	assert.equal(gate.rows(), 0);
});

/** Calls made in the memory tests below; on Node 22 a derived signal made per call kept about 200 bytes each. */
const MEASURED_CALLS = 10_000;

/**
 * How much more heap stays in use after `MEASURED_CALLS` sequences made with the signal `signalOf` gives for each
 * call, than after as many made before (the first calls also compile and cache what every later call uses). The
 * sequences hold no statements: each watches its signal as any sequence does, and none waits for the connection's
 * thread, so how busy the machine is changes only how long the calls take, not what they keep.
 */
async function heapGrownByCalls(signalOf: () => AbortSignal): Promise<number> {
	const database = await openFile();
	const { sent } = watchSequences();
	let ended = false;
	cleanups.push(() => {
		ended = true;
	});
	const callAll = () =>
		database.transaction(async (tx) => {
			const run = runnerOf(tx);
			for (let call = 0; call < MEASURED_CALLS && !ended; call++) await run({ statements: [], signal: signalOf() });
		});
	const heapInUse = async () => {
		await collectGarbage();
		return process.memoryUsage().heapUsed;
	};
	await callAll();
	const before = await heapInUse();
	await callAll();
	const grown = (await heapInUse()) - before;
	assert.equal(sent.length, 0, "no sequence went to the connection's thread");
	return grown;
}

test("sequences made with one signal keep nothing of each call once it returned (#6106)", async () => {
	// The signal outlives every call, as a history index build's does.
	const controller = new AbortController();
	const grown = await heapGrownByCalls(() => controller.signal);
	assert.equal(controller.signal.aborted, false);
	assert.ok(grown < MEASURED_CALLS * 64, `${grown} bytes retained after ${MEASURED_CALLS} calls`);
});

test("what a sequence keeps for its signal goes with the signal (#6106)", async () => {
	const grown = await heapGrownByCalls(() => new AbortController().signal);
	assert.ok(
		grown < MEASURED_CALLS * 64,
		`${grown} bytes retained after ${MEASURED_CALLS} calls with signals since released`,
	);
});

test("a signal shared by sequences running at once on several databases stops each of them after one returned (#6106)", async () => {
	const count = 3;
	const databases = await Promise.all(Array.from({ length: count }, () => openFile()));
	const controller = new AbortController();
	const reason = new Error("stopped");
	// Every request waits until all of them were sent, so every sequence watches the signal at once. The first one then
	// runs and returns; the signal aborts while the others' requests are on their way to their threads.
	let sent = 0;
	let allSent!: () => void;
	const everySent = new Promise<void>((resolve) => {
		allSent = resolve;
	});
	let firstReturned!: () => void;
	const firstDone = new Promise<void>((resolve) => {
		firstReturned = resolve;
	});
	// Before the databases close, so a request still held here goes on if the test ends early.
	cleanups.push(() => {
		allSent();
		firstReturned();
	});
	watchSequences(async (request, send) => {
		if (++sent === count) allSent();
		await everySent;
		if (request.statements[0]?.params[0] === "v0") return send();
		await firstDone;
		controller.abort(reason);
		return send();
	});
	const outcomes = await Promise.all(
		databases.map((database, index) =>
			database.transaction(async (tx) => {
				const failure = await runnerOf(tx)({ statements: [insert(`v${index}`)], signal: controller.signal }).then(
					() => undefined,
					(error: unknown) => error,
				);
				if (index === 0) firstReturned();
				return { failure, rows: await values(tx) };
			}),
		),
	);
	assert.deepEqual(outcomes, [
		{ failure: undefined, rows: ["v0"] },
		{ failure: reason, rows: [] },
		{ failure: reason, rows: [] },
	]);
});

test("a sequence reports the failing statement's error, not the abort, when its signal aborts after the statement failed (#6082)", async () => {
	const database = await openFile();
	const controller = new AbortController();
	watchSequences(async (_request, send) => {
		try {
			return await send();
		} finally {
			controller.abort(new Error("stopped"));
		}
	});
	const failure = await database
		.transaction((tx) =>
			runnerOf(tx)({
				statements: [insert("a"), { sql: "INSERT INTO absent (value) VALUES (?)", params: ["b"] }],
				signal: controller.signal,
			}),
		)
		.then(
			() => assert.fail("the sequence succeeded"),
			(error: unknown) => error,
		);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.match(failure.message, /no such table: absent/);
});

test("a sequence repeats its statement until a run changes fewer rows than asked, and counts the runs that did not (#6082)", async () => {
	const database = await openFile();
	const { repeated, rows } = await database.transaction(async (tx) => {
		const repeated = await runnerOf(tx)({
			// Inserts one row a run while there are fewer than two: two runs change a row, the third changes none.
			repeat: {
				statement: {
					sql: "INSERT INTO items (value) SELECT ? WHERE (SELECT count(*) FROM items) < 2",
					params: ["r"],
				},
				times: 5,
				minChanges: 1,
			},
			statements: [insert("s")],
		});
		return { repeated, rows: await values(tx) };
	});
	assert.equal(repeated, 2);
	assert.deepEqual(rows, ["r", "r", "s"]);
});

test("a sequence longer than one request goes in requests of 256 statements, each sent after the one before ran (#6082)", async () => {
	const database = await openFile();
	const { sent, overlapping } = watchSequences();
	const count = 2 * REQUEST_STATEMENTS + 88;
	const expected = Array.from({ length: count }, (_, index) => `v${index}`);
	// How many statements the sequence had taken from the caller when it sent each request.
	let taken = 0;
	const takenAtSend: number[] = [];
	watchSequences((_request, send) => {
		takenAtSend.push(taken);
		return send();
	});
	function* statements() {
		for (const value of expected) {
			taken++;
			yield insert(value);
		}
	}
	const rows = await database.transaction(async (tx) => {
		await runnerOf(tx)({
			repeat: { statement: insert("first"), times: 1, minChanges: 1 },
			statements: statements(),
		});
		return values(tx);
	});
	assert.deepEqual(rows, ["first", ...expected]);
	assert.deepEqual(
		sent.map((request) => [request.repeat !== undefined, request.statements.length]),
		[
			[true, REQUEST_STATEMENTS],
			[false, REQUEST_STATEMENTS],
			[false, 88],
		],
	);
	assert.equal(overlapping(), 1);
	assert.deepEqual(takenAtSend, [REQUEST_STATEMENTS, 2 * REQUEST_STATEMENTS, count]);
});

test("a sequence fails at a statement with NUL text as that statement fails alone, after the statements before it ran (#6082)", async () => {
	const database = await openFile();
	const { failure, rows } = await database.transaction(async (tx) => {
		const failure = await runnerOf(tx)({ statements: [insert("a"), insert("b\0"), insert("c")] }).then(
			() => assert.fail("the sequence succeeded"),
			(error: unknown) => error,
		);
		return { failure, rows: await values(tx) };
	});
	assert.ok(failure instanceof StorageInvalidTextError);
	assert.equal(failure.parameterIndex, 0);
	assert.deepEqual(rows, ["a"]);
});

test("only a transaction of a file connection on a thread of its own runs sequences: not a wrapper around it, nor a connection on the calling thread (#6082)", async () => {
	const file = await openFile();
	const inMemory = await openNodeSqliteDatabase(":memory:");
	cleanups.push(() => inMemory.close());
	const raw = new DatabaseSync(":memory:");
	const wrapped = wrapNodeSqliteDatabase(raw);
	cleanups.push(async () => {
		await wrapped.close();
		raw.close();
	});
	await file.transaction(async (tx) => {
		assert.ok(sequenceRunner(tx));
		// A wrapper that forwards what it does not change, whose own `run` must still see every statement.
		const decorated = new Proxy(tx, { get: (target, key) => Reflect.get(target, key) });
		assert.equal(sequenceRunner(decorated), undefined);
	});
	// A caller that replaces the handle's own `run` or `get` (with a function of its own) sees every statement through it.
	await file.transaction(async (tx) => {
		tx.run = tx.run.bind(tx);
		assert.equal(sequenceRunner(tx), undefined, "a transaction whose run was replaced");
	});
	await file.transaction(async (tx) => {
		tx.get = tx.get.bind(tx);
		assert.equal(sequenceRunner(tx), undefined, "a transaction whose get was replaced");
	});
	await inMemory.transaction(async (tx) => assert.equal(sequenceRunner(tx), undefined));
	await wrapped.transaction(async (tx) => assert.equal(sequenceRunner(tx), undefined));
});
