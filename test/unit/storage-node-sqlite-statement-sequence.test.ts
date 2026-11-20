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
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

/** Most statements one request to a connection's thread carries. */
const REQUEST_STATEMENTS = 256;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openFile(): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("atomic-statement-sequence-");
	cleanups.push(() => removeTempDirectory(directory));
	const database = await openNodeSqliteDatabase(join(directory, "sequence.sqlite"));
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

test("a sequence whose signal aborted before its statements ran runs none of them and rejects with the signal's reason (#6082)", async () => {
	const database = await openFile();
	const controller = new AbortController();
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
	const rows = await database.transaction(async (tx) => {
		await runnerOf(tx)({
			repeat: { statement: insert("first"), times: 1, minChanges: 1 },
			statements: expected.map(insert),
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
	await inMemory.transaction(async (tx) => assert.equal(sequenceRunner(tx), undefined));
	await wrapped.transaction(async (tx) => assert.equal(sequenceRunner(tx), undefined));
});
