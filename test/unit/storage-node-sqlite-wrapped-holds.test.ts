import assert from "node:assert/strict";
import type { AsyncLocalStorage } from "node:async_hooks";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, test, vi } from "vitest";
import type { SqliteDatabase, SqliteExecutor } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	StorageInvalidTextError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ThreadConnection } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { interceptConnectionRequests, isExec } from "../helpers/sqlite-connection-requests.js";

/**
 * The wrapped connection's busy timeout: how long a statement of 0.10.1 held the event loop for a lock the threaded
 * transaction kept, and how long one waits for the transaction here.
 */
const WRAPPED_BUSY_TIMEOUT_MS = 2_000;
/** How long the threaded transaction keeps the write lock across a timer, which needs the event loop. */
const HOLD_MS = 300;
/** The longest the event loop may go without running: half the busy timeout leaves room for a loaded machine. */
const MAX_EVENT_LOOP_STALL_MS = WRAPPED_BUSY_TIMEOUT_MS / 2;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function databasePath(): string {
	const directory = makeTempDirectory("atomic-wrapped-holds-");
	cleanups.push(() => removeTempDirectory(directory));
	return join(directory, "shared.sqlite");
}

async function openThreaded(path: string): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(() => database.close());
	return database;
}

/**
 * A connection of the caller's own on `path`, wrapped, with its busy timeout set through the wrapped handle, and the
 * statements the wrapped handle prepares on it from then on, in order.
 */
async function openWrapped(
	path: string,
	busyTimeoutMs = WRAPPED_BUSY_TIMEOUT_MS,
	wrap = wrapNodeSqliteDatabase,
): Promise<{ readonly raw: DatabaseSync; readonly wrapped: SqliteDatabase; readonly prepared: string[] }> {
	const raw = new DatabaseSync(path);
	const wrapped = wrap(raw);
	cleanups.push(async () => {
		await wrapped.close();
		raw.close();
	});
	await wrapped.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
	const prepared: string[] = [];
	const prepare = raw.prepare.bind(raw);
	raw.prepare = (sql: string) => {
		prepared.push(sql);
		return prepare(sql);
	};
	return { raw, wrapped, prepared };
}

/** The longest stretch the event loop did not run while `operation` ran, in milliseconds. */
async function longestStall<T>(operation: () => Promise<T>): Promise<{ value: T; stallMs: number }> {
	const tickMs = 10;
	let last = performance.now();
	let stallMs = 0;
	const tick = () => {
		const now = performance.now();
		stallMs = Math.max(stallMs, now - last);
		last = now;
	};
	const timer = setInterval(tick, tickMs);
	try {
		const value = await operation();
		await sleep(2 * tickMs);
		tick();
		return { value, stallMs };
	} finally {
		clearInterval(timer);
	}
}

/**
 * Starts a threaded transaction that writes `first` and lets `inside` run with the write lock held, then keeps the
 * lock across a `holdMs` timer, writes `last` and commits. Resolves once `first` is written, with the transaction, and a
 * flag that turns true once the transaction settled.
 */
async function holdLock(
	threaded: SqliteDatabase,
	holdMs = HOLD_MS,
	inside: (tx: SqliteExecutor) => Promise<void> = async () => {},
	first = "INSERT INTO items VALUES ('a')",
	last = "INSERT INTO items VALUES ('b')",
): Promise<{ readonly committed: Promise<void>; readonly settled: () => boolean }> {
	let held!: () => void;
	const lockHeld = new Promise<void>((resolve) => {
		held = resolve;
	});
	const committed = threaded.transaction(async (tx) => {
		await tx.run(first);
		held();
		await inside(tx);
		await sleep(holdMs);
		await tx.run(last);
	});
	let settled = false;
	void committed.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await lockHeld;
	return { committed, settled: () => settled };
}

async function values(database: SqliteDatabase): Promise<string[]> {
	return (await database.all<{ value: string }>("SELECT value FROM items ORDER BY rowid")).map((row) => row.value);
}

async function sharedFile(): Promise<{ readonly path: string; readonly threaded: SqliteDatabase }> {
	const path = databasePath();
	const threaded = await openThreaded(path);
	await threaded.exec("CREATE TABLE items (value TEXT)");
	return { path, threaded };
}

test("a wrapped write during a threaded transaction on its file waits off the event loop, then runs after it (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path);
	const { committed } = await holdLock(threaded);
	const { stallMs } = await longestStall(() =>
		Promise.all([wrapped.run("INSERT INTO items VALUES ('c')"), committed]),
	);
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
	assert.deepEqual(await values(threaded), ["a", "b", "c"]);
});

test("a wrapped script during a threaded transaction runs whole after it (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path);
	const { committed } = await holdLock(threaded);
	const { stallMs } = await longestStall(() =>
		Promise.all([wrapped.exec("INSERT INTO items VALUES ('c'); INSERT INTO items VALUES ('d')"), committed]),
	);
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
	assert.deepEqual(await values(threaded), ["a", "b", "c", "d"]);
});

test("a wrapped connection reaching the file through a linked directory waits too (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const linkParent = makeTempDirectory("atomic-wrapped-holds-link-");
	cleanups.push(() => removeTempDirectory(linkParent));
	const link = join(linkParent, "link");
	symlinkSync(join(path, ".."), link, "junction");
	const { wrapped } = await openWrapped(join(link, "shared.sqlite"));
	const { committed } = await holdLock(threaded);
	const { stallMs } = await longestStall(() =>
		Promise.all([wrapped.run("INSERT INTO items VALUES ('c')"), committed]),
	);
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
	assert.deepEqual(await values(threaded), ["a", "b", "c"]);
});

test("a wrapped write still waiting at its busy timeout fails as SQLite's busy handler does, off the event loop and having run nothing (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const busyTimeoutMs = 800;
	const { wrapped } = await openWrapped(path, busyTimeoutMs);
	// What node:sqlite throws for a statement the lock refuses at once.
	const reference = new DatabaseSync(path);
	cleanups.push(() => reference.close());
	reference.exec("PRAGMA busy_timeout=0");
	const { committed, settled } = await holdLock(threaded, 4 * busyTimeoutMs);
	let refused: unknown;
	try {
		reference.prepare("INSERT INTO items VALUES ('r')").run();
	} catch (error) {
		refused = error;
	}
	const started = performance.now();
	const { value: failure, stallMs } = await longestStall(() =>
		wrapped.run("INSERT INTO items VALUES ('c')").then(
			() => undefined,
			(error: unknown) => error,
		),
	);
	const waitedMs = performance.now() - started;
	const settledAtFailure = settled();
	await committed;
	assert.equal(settledAtFailure, false, "it waited for the transaction past its busy timeout");
	assert.ok(stallMs < busyTimeoutMs / 2, `the event loop stalled for ${Math.round(stallMs)} ms`);
	assert.ok(failure instanceof StorageUnavailableError, `expected a storage failure, got ${String(failure)}`);
	assert.ok(refused instanceof Error);
	const cause = failure.cause as Error;
	assert.equal(Object.getPrototypeOf(cause), Object.getPrototypeOf(refused));
	assert.deepEqual(Object.keys(cause), Object.keys(refused));
	assert.deepEqual({ ...cause, message: cause.message }, { ...refused, message: refused.message });
	assert.ok(waitedMs >= busyTimeoutMs - 5, `it failed after ${Math.round(waitedMs)} ms`);
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("a wrapped read during a threaded transaction runs at once and sees the file as last committed (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	await threaded.run("INSERT INTO items VALUES ('before')");
	const { wrapped } = await openWrapped(path);
	const { committed, settled } = await holdLock(threaded, 4 * HOLD_MS);
	assert.deepEqual(await values(wrapped), ["before"]);
	assert.equal(settled(), false, "the read waited for the transaction");
	await committed;
});

test("wrapped reads that call SQL functions run at once during a threaded transaction, as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	await threaded.run("INSERT INTO items VALUES ('Before')");
	const { raw, wrapped } = await openWrapped(path);
	const seen: string[] = [];
	raw.function("seen", (value) => {
		seen.push(String(value));
		return value;
	});
	const { committed, settled } = await holdLock(threaded, 4 * HOLD_MS);
	assert.deepEqual(await wrapped.all("SELECT lower(value) AS v FROM items"), [{ v: "before" }]);
	assert.deepEqual(await wrapped.get("SELECT max(rowid) AS n FROM items"), { n: 1 });
	assert.deepEqual(await wrapped.get(`SELECT json_extract('{"a":1}', '$.a') AS a`), { a: 1 });
	assert.deepEqual(await wrapped.all("SELECT seen(value) AS v FROM items"), [{ v: "Before" }]);
	assert.equal(settled(), false, "the reads waited for the transaction");
	assert.deepEqual(seen, ["Before"]);
	await committed;
});

test("repeated wrapped reads during a threaded transaction prepare their plan once (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped, prepared } = await openWrapped(path);
	const read = "SELECT value FROM items WHERE value = ?";
	const { committed } = await holdLock(threaded);
	assert.deepEqual(await wrapped.all(read, "x"), []);
	assert.deepEqual(await wrapped.all(read, "y"), []);
	await committed;
	assert.deepEqual(
		prepared.filter((sql) => sql.startsWith("EXPLAIN")),
		[`EXPLAIN ${read}`],
	);
	// Each call prepares its own statement once, as it always has.
	assert.deepEqual(
		prepared.filter((sql) => sql === read),
		[read, read],
	);
});

test("with no threaded transaction open, a wrapped call prepares only its own statement (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped, prepared } = await openWrapped(path);
	await threaded.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('a')");
	});
	assert.deepEqual(await values(wrapped), ["a"]);
	await wrapped.run("INSERT INTO items VALUES ('c')");
	assert.deepEqual(prepared, ["SELECT value FROM items ORDER BY rowid", "INSERT INTO items VALUES ('c')"]);
});

test("a statement the threaded transaction's callback awaits runs at once, as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	await threaded.run("INSERT INTO items VALUES ('before')");
	const { wrapped } = await openWrapped(path);
	// A script is never classified, so only the callback it is made in lets it through at once.
	let counted: number | undefined;
	const { committed } = await holdLock(threaded, 0, async () => {
		await wrapped.exec("SELECT 1");
		counted = Number((await wrapped.get<{ n: number }>("SELECT count(*) AS n FROM items"))?.n);
	});
	await committed;
	assert.equal(counted, 1);
	assert.deepEqual(await values(threaded), ["before", "a", "b"]);
});

test("a second copy of the storage module sees the transactions of the first (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	vi.resetModules();
	const copy = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
	assert.notEqual(copy.wrapNodeSqliteDatabase, wrapNodeSqliteDatabase);
	const { wrapped } = await openWrapped(path, WRAPPED_BUSY_TIMEOUT_MS, copy.wrapNodeSqliteDatabase);
	let counted: number | undefined;
	const { committed } = await holdLock(threaded, HOLD_MS, async () => {
		// Both made before the write below is queued on the same handle.
		const [, row] = await Promise.all([
			wrapped.exec("SELECT 1"),
			wrapped.get<{ n: number }>("SELECT count(*) AS n FROM items"),
		]);
		counted = Number(row?.n);
	});
	const { stallMs } = await longestStall(() =>
		Promise.all([wrapped.run("INSERT INTO items VALUES ('c')"), committed]),
	);
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
	assert.equal(counted, 0);
	assert.deepEqual(await values(threaded), ["a", "b", "c"]);
});

test("a wrapped write to another file runs at once during a threaded transaction (#6081)", async () => {
	const { threaded } = await sharedFile();
	const { wrapped } = await openWrapped(databasePath());
	await wrapped.exec("CREATE TABLE items (value TEXT)");
	const { committed, settled } = await holdLock(threaded, 4 * HOLD_MS);
	await wrapped.run("INSERT INTO items VALUES ('c')");
	assert.equal(settled(), false, "the write waited for a transaction on another file");
	await committed;
	assert.deepEqual(await values(wrapped), ["c"]);
});

/**
 * Holds up the threaded transaction until the returned `go` is called: its BEGIN before the connection's thread runs
 * it (`begin`), or the answer to its BEGIN (`begin answer`) or COMMIT (`commit`) after the thread ran it. Resolves
 * once it got there, with the transaction.
 */
async function pauseRequest(
	threaded: SqliteDatabase,
	when: "begin" | "begin answer" | "commit",
): Promise<{ readonly go: () => void; readonly committed: Promise<void> }> {
	let reached!: () => void;
	const there = new Promise<void>((resolve) => {
		reached = resolve;
	});
	let go!: () => void;
	const released = new Promise<void>((resolve) => {
		go = resolve;
	});
	const interception = interceptConnectionRequests(async (request, send) => {
		if (when === "begin" && request.kind === "begin") {
			reached();
			await released;
		}
		const answer = await send(request);
		if ((when === "begin answer" && request.kind === "begin") || (when === "commit" && isExec(request, "COMMIT"))) {
			reached();
			await released;
		}
		return answer;
	});
	cleanups.push(() => interception.restore());
	const committed = threaded.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('a')");
	});
	await there;
	return { go, committed };
}

for (const when of ["begin", "commit"] as const) {
	test(`with a busy timeout of 0, a wrapped write while the threaded ${when === "begin" ? "BEGIN is on its way" : "COMMIT's answer is on its way"} runs at once on the free lock (#6081)`, async () => {
		const { path, threaded } = await sharedFile();
		const { wrapped } = await openWrapped(path, 0);
		const { go, committed } = await pauseRequest(threaded, when);
		try {
			assert.deepEqual(await wrapped.run("INSERT INTO items VALUES ('c')"), { changes: 1 });
		} finally {
			go();
		}
		await committed;
		assert.deepEqual(await values(threaded), when === "begin" ? ["c", "a"] : ["a", "c"]);
	});
}

test("a wrapped write whose busy timeout ends while the threaded COMMIT's answer is on its way runs once it arrives (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const busyTimeoutMs = 50;
	const { wrapped } = await openWrapped(path, busyTimeoutMs);
	const { go, committed } = await pauseRequest(threaded, "commit");
	const written = wrapped.run("INSERT INTO items VALUES ('c')");
	await sleep(4 * busyTimeoutMs);
	go();
	assert.deepEqual(await written, { changes: 1 });
	await committed;
	assert.deepEqual(await values(threaded), ["a", "c"]);
});

test("a wrapped write on a connection whose busy timeout cannot be read runs at once, as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path, 0);
	// The connection refuses to prepare PRAGMA busy_timeout, as it does under an authorizer that declines it.
	const prepare = raw.prepare;
	raw.prepare = (sql: string) => {
		if (sql === "PRAGMA busy_timeout")
			throw Object.assign(new Error("not authorized"), {
				code: "ERR_SQLITE_ERROR",
				errcode: 23,
				errstr: "authorization denied",
			});
		return prepare(sql);
	};
	const { committed } = await holdLock(threaded, 30);
	const failure = await wrapped.run("INSERT INTO items VALUES ('c')").then(
		() => undefined,
		(error: unknown) => error,
	);
	await committed;
	assert.ok(failure instanceof StorageUnavailableError, `expected a storage failure, got ${String(failure)}`);
	assert.equal((failure.cause as { errcode?: number }).errcode, 5);
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("a wrapped call with a NUL in a text parameter is refused at once during a threaded transaction (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path, 0);
	const { committed } = await holdLock(threaded);
	const failure = await wrapped.run("INSERT INTO items VALUES (?)", "x\0y").then(
		() => undefined,
		(error: unknown) => error,
	);
	await committed;
	assert.ok(failure instanceof StorageInvalidTextError, `expected the text to be refused, got ${String(failure)}`);
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("with a busy timeout of 0, a wrapped read that calls a function of yours runs at once while the threaded BEGIN is answered, as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path, 0);
	let calls = 0;
	raw.function("seen", () => {
		calls++;
		return 42;
	});
	// The connection's thread took the lock; the answer saying so is still on its way.
	const { go, committed } = await pauseRequest(threaded, "begin answer");
	try {
		assert.deepEqual(await wrapped.get("SELECT seen() AS n"), { n: 42 });
		assert.equal(calls, 1);
	} finally {
		go();
	}
	await committed;
});

test("with a busy timeout of 0, a wrapped write runs at once once the threaded transaction's thread is gone (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path, 0);
	let thread: ThreadConnection | undefined;
	const interception = interceptConnectionRequests((request, send, connection) => {
		thread ??= connection;
		return send(request);
	});
	cleanups.push(() => interception.restore());
	let held!: () => void;
	const lockHeld = new Promise<void>((resolve) => {
		held = resolve;
	});
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const committed = threaded
		.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('a')");
			held();
			await finished;
		})
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	await lockHeld;
	// The thread goes away while the callback still runs; SQLite let go of the lock with it.
	const worker = Reflect.get(thread!, "worker") as Worker;
	const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
	await worker.terminate();
	await exited;
	assert.deepEqual(await wrapped.run("INSERT INTO items VALUES ('c')"), { changes: 1 });
	finish();
	assert.ok((await committed) instanceof Error, "the transaction failed with its thread");
	assert.deepEqual(await values(wrapped), ["c"]);
});

test("a transaction requested inside a threaded transaction's callback keeps that callback's calls running at once when another's commit carries it (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path, 300);
	let calls = 0;
	raw.function("seen", () => {
		calls++;
		return 1;
	});
	const other = await openThreaded(databasePath());
	await other.exec("CREATE TABLE b (v)");
	const signal = () => {
		let fire!: () => void;
		const fired = new Promise<void>((resolve) => {
			fire = resolve;
		});
		return { fire, fired };
	};
	const [held, otherWaits, joined, letGo] = [signal(), signal(), signal(), signal()];
	let read: unknown;
	const outer = threaded.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('a')");
		held.fire();
		await otherWaits.fired;
		// Joins the other file's waiting transaction, whose commit then runs this callback.
		const inner = other.transaction(async (otherTx) => {
			await otherTx.run("INSERT INTO b VALUES (2)");
			await wrapped.exec("SELECT seen()");
			read = { n: 1 };
		});
		joined.fire();
		await inner;
	});
	await held.fired;
	let paused = false;
	const interception = interceptConnectionRequests(async (request, send) => {
		if (request.kind === "begin" && !paused) {
			paused = true;
			otherWaits.fire();
			await letGo.fired;
		}
		return send(request);
	});
	cleanups.push(() => interception.restore());
	const first = other.transaction(async (otherTx) => {
		await otherTx.run("INSERT INTO b VALUES (1)");
	});
	await joined.fired;
	letGo.fire();
	await Promise.all([first, outer]);
	assert.deepEqual(read, { n: 1 });
	assert.equal(calls, 1);
});

test("a threaded handle dropped without closing is not kept by its connection's thread (#6081)", async () => {
	const path = databasePath();
	let thread: ThreadConnection | undefined;
	const interception = interceptConnectionRequests((request, send, connection) => {
		thread ??= connection;
		return send(request);
	});
	cleanups.push(() => interception.restore());
	const handles = trackCollection();
	await (async () => {
		const database = await openNodeSqliteDatabase(path);
		await database.exec("CREATE TABLE items (value TEXT)");
		handles.track(database);
	})();
	// The thread stays until it is closed or collected with its connection.
	cleanups.push(() => (Reflect.get(thread!, "worker") as Worker).terminate().then(() => {}));
	await collectEverythingTracked(handles);
	assert.deepEqual(handles.uncollected(), [], "the connection's thread keeps the handle");
});

test("a wrapped write whose short busy timeout ends before the threaded BEGIN reaches its thread runs on the free lock (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path, 5);
	const { go, committed } = await pauseRequest(threaded, "begin");
	const written = wrapped.run("INSERT INTO items VALUES ('c')");
	const delayed = sleep(60).then(go);
	try {
		assert.deepEqual(await written, { changes: 1 });
	} finally {
		await delayed;
	}
	await committed;
	assert.deepEqual(await values(threaded), ["c", "a"]);
});

test("wrapped writes queued behind a threaded transaction run one per turn of the event loop, in order (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path);
	// Turns of the event loop, counted by an immediate that schedules itself; calls that complete in one turn share a
	// count.
	let turn = 0;
	let counting = true;
	const count = () => {
		turn++;
		if (counting) setImmediate(count);
	};
	setImmediate(count);
	const { committed } = await holdLock(threaded);
	const completedIn: number[] = [];
	const writes = Array.from({ length: 50 }, (_, index) =>
		wrapped.run("INSERT INTO items VALUES (?)", `w${index}`).then(() => {
			completedIn.push(turn);
		}),
	);
	await Promise.all([committed, ...writes]);
	counting = false;
	const perTurn = new Map<number, number>();
	for (const each of completedIn) perTurn.set(each, (perTurn.get(each) ?? 0) + 1);
	assert.ok(Math.max(...perTurn.values()) <= 2, `${Math.max(...perTurn.values())} writes ran in one turn`);
	assert.deepEqual(await values(threaded), ["a", "b", ...Array.from({ length: 50 }, (_, index) => `w${index}`)]);
});

/** The asynchronous context the storage layer runs threaded transactions' callbacks in, shared by its module copies. */
function holdScopes(): AsyncLocalStorage<object | undefined> {
	const bag = globalThis as typeof globalThis &
		Record<symbol, { readonly scopes: AsyncLocalStorage<object | undefined> } | undefined>;
	return bag[Symbol.for("atomic-storage/node-sqlite-file-holds@1")]!.scopes;
}

test("a threaded transaction enters no asynchronous context unless a wrapped connection to its file is open (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const enters = vi.spyOn(holdScopes(), "run");
	const leaves = vi.spyOn(holdScopes(), "disable");
	cleanups.push(() => {
		enters.mockRestore();
		leaves.mockRestore();
	});
	const write = (value: string) =>
		threaded.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES (?)", value);
		});
	// A wrapped connection to another file does not count.
	const { wrapped: elsewhere } = await openWrapped(databasePath());
	await write("unwrapped");
	assert.equal(enters.mock.calls.length, 0);
	const { wrapped } = await openWrapped(path);
	await write("wrapped");
	assert.equal(enters.mock.calls.length, 1);
	leaves.mockClear();
	await wrapped.close();
	await elsewhere.close();
	// Once no wrapped connection is open the context is left, so it no longer costs every later await.
	assert.ok(leaves.mock.calls.length >= 1, "the context was not left once the last wrapped connection closed");
	enters.mockClear();
	await write("closed");
	assert.equal(enters.mock.calls.length, 0);
	assert.deepEqual(await values(threaded), ["unwrapped", "wrapped", "closed"]);
});

test("a wrapped connection opened inside a running threaded transaction's callback behaves as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	await threaded.run("INSERT INTO items VALUES ('before')");
	const busyTimeoutMs = 200;
	let read: string[] | undefined;
	let failure: unknown;
	let waitedMs = 0;
	await threaded.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('a')");
		const { wrapped } = await openWrapped(path, busyTimeoutMs);
		read = await values(wrapped);
		const started = performance.now();
		failure = await wrapped.run("INSERT INTO items VALUES ('c')").then(
			() => undefined,
			(error: unknown) => error,
		);
		waitedMs = performance.now() - started;
	});
	assert.deepEqual(read, ["before"]);
	assert.ok(failure instanceof StorageUnavailableError, `expected SQLITE_BUSY, got ${String(failure)}`);
	assert.equal((failure.cause as { errcode?: number }).errcode, 5);
	assert.ok(waitedMs >= busyTimeoutMs - 5, `it failed after ${Math.round(waitedMs)} ms`);
	assert.deepEqual(await values(threaded), ["before", "a"]);
});

test("wrapped calls made once the queue behind a threaded transaction is empty run without waiting for turns (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path);
	let turn = 0;
	let counting = true;
	const count = () => {
		turn++;
		if (counting) setImmediate(count);
	};
	setImmediate(count);
	const { committed } = await holdLock(threaded);
	// One call queued behind the transaction; then, as a client that awaits each write, twenty more.
	const turns: number[] = [];
	const writes = wrapped.run("INSERT INTO items VALUES ('queued')").then(async () => {
		for (let index = 0; index < 20; index++) {
			await wrapped.run("INSERT INTO items VALUES (?)", `next${index}`);
			turns.push(turn);
		}
	});
	await Promise.all([committed, writes]);
	counting = false;
	assert.ok(new Set(turns).size <= 2, `the writes made after the queue emptied took ${new Set(turns).size} turns`);
	assert.equal((await values(threaded)).length, 2 + 1 + 20);
});

test("a wrapped call SQLite cannot prepare fails at once with its own error during a threaded transaction, as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path, 150);
	// What node:sqlite reports for each, from a connection of the test's own.
	const reference = new DatabaseSync(path);
	cleanups.push(() => reference.close());
	const calls: readonly [string, (database: SqliteDatabase) => Promise<unknown>][] = [
		["SELECT * FROM nosuch", (database) => database.all("SELECT * FROM nosuch")],
		["SELEC 1", (database) => database.get("SELEC 1")],
		["INSERT INTO nosuch VALUES (1)", (database) => database.run("INSERT INTO nosuch VALUES (1)")],
	];
	const { committed, settled } = await holdLock(threaded, 600);
	for (const [sql, call] of calls) {
		let expected: unknown;
		try {
			reference.exec(sql);
		} catch (error) {
			expected = error;
		}
		const failure = await call(wrapped).then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.ok(
			failure instanceof StorageUnavailableError,
			`${sql}: expected a storage failure, got ${String(failure)}`,
		);
		const cause = failure.cause as Error & { errcode?: number };
		assert.equal(cause.message, (expected as Error).message, sql);
		assert.equal(cause.errcode, (expected as { errcode?: number }).errcode, sql);
		assert.equal(settled(), false, `${sql}: it waited for the transaction`);
	}
	await committed;
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("a read or a call SQLite cannot prepare does not wait behind calls still queued after a threaded transaction (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped: writer } = await openWrapped(path);
	const { wrapped: other } = await openWrapped(path);
	const { committed } = await holdLock(threaded);
	let written = 0;
	const writes = Array.from({ length: 10 }, (_, index) =>
		writer.run("INSERT INTO items VALUES (?)", `w${index}`).then(() => {
			written++;
		}),
	);
	await committed;
	// The queued writes now run one per turn; calls made meanwhile that need no lock do not wait for them.
	const read = await other.get<{ n: number }>("SELECT count(*) AS n FROM items");
	const failure = await other.all("SELECT * FROM nosuch").then(
		() => undefined,
		(error: unknown) => error,
	);
	const writtenMeanwhile = written;
	await Promise.all(writes);
	assert.ok(writtenMeanwhile < 10, "the read and the failing call waited for the queued writes");
	assert.ok(Number(read?.n) >= 2 && Number(read?.n) <= 2 + writtenMeanwhile, `it read ${read?.n} rows`);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.match((failure.cause as Error).message, /no such table: nosuch/);
});

test("a wrapped script, or a statement that only lists a plan, during a threaded transaction runs as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path, 150);
	const { committed, settled } = await holdLock(threaded, 600);
	// A statement that only lists a plan runs at once.
	assert.ok((await wrapped.all("EXPLAIN SELECT 1")).length > 0);
	assert.equal(settled(), false);
	// Scripts SQLite reads past a leading empty statement or a leading EXPLAIN are never prepared ahead: they wait, and
	// fail with SQLITE_BUSY at the busy timeout having run nothing.
	for (const script of ["; INSERT INTO items VALUES ('c')", "EXPLAIN SELECT 1; INSERT INTO items VALUES ('d')"]) {
		const failure = await wrapped.exec(script).then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.ok(failure instanceof StorageUnavailableError, `${script}: expected SQLITE_BUSY, got ${String(failure)}`);
		assert.equal((failure.cause as { errcode?: number }).errcode, 5);
	}
	await committed;
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("a wrapped call whose statement no longer prepares fails at once with its own error, also after it was planned (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path, 150);
	raw.exec("CREATE TEMP TABLE scratch (x)");
	const { committed, settled } = await holdLock(threaded, 1_200);
	// Planned while the file is held: both leave the held file alone, so both run at once.
	assert.deepEqual(await wrapped.all("SELECT x FROM scratch"), []);
	assert.deepEqual(await wrapped.run("INSERT INTO scratch VALUES (1)"), { changes: 1 });
	raw.exec("DROP TABLE temp.scratch");
	for (const call of [
		() => wrapped.all("SELECT x FROM scratch"),
		() => wrapped.run("INSERT INTO scratch VALUES (1)"),
	]) {
		const failure = await call().then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.ok(failure instanceof StorageUnavailableError, `expected a storage failure, got ${String(failure)}`);
		assert.match((failure.cause as Error).message, /no such table: scratch/);
		assert.equal((failure.cause as { errcode?: number }).errcode, 1);
	}
	assert.equal(settled(), false, "a call waited for the transaction");
	await committed;
});

test("a wrapped PRAGMA during a threaded transaction gives what it gave before: one of the busy timeout, also under EXPLAIN or behind empty statements, runs at once, and one that writes the file waits for the lock (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path, 2);
	const timeout = () => Number(raw.prepare("PRAGMA busy_timeout").get()?.timeout);
	// What SQLite does with each on a connection of the test's own.
	const reference = new DatabaseSync(":memory:");
	cleanups.push(() => reference.close());
	reference.exec("PRAGMA busy_timeout=2");
	const { committed, settled } = await holdLock(threaded, 600);
	assert.deepEqual(await wrapped.get("; PRAGMA busy_timeout"), { timeout: 2 });
	assert.deepEqual(await wrapped.get("; PRAGMA busy_timeout=7"), { timeout: 7 });
	assert.equal(timeout(), 7);
	await wrapped.all(" ;; /* x */ EXPLAIN PRAGMA busy_timeout=9");
	reference.prepare("EXPLAIN PRAGMA busy_timeout=9").all();
	assert.equal(timeout(), Number(reference.prepare("PRAGMA busy_timeout").get()?.timeout));
	assert.deepEqual(await wrapped.get("; -- before\n SELECT count(*) AS n FROM items"), { n: 0 });
	assert.equal(settled(), false, "a call waited for the transaction");
	await wrapped.exec(`PRAGMA busy_timeout=${WRAPPED_BUSY_TIMEOUT_MS}`);
	const { stallMs } = await longestStall(() => wrapped.exec("PRAGMA user_version=5"));
	assert.equal(settled(), true, "the PRAGMA that writes the file ran before the transaction ended");
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
	await committed;
	assert.deepEqual(await wrapped.get("PRAGMA user_version"), { user_version: 5 });
});

test("a wrapped write of a temporary table or of another attached file runs at once during a threaded transaction, and one of the same file under another name fails as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	// Created before the connection that attaches it, so it is removed only after that connection closed.
	const otherPath = databasePath();
	const { raw, wrapped } = await openWrapped(path, 150);
	raw.exec("CREATE TEMP TABLE scratch (x)");
	raw.exec(`ATTACH '${otherPath}' AS other`);
	raw.exec("CREATE TABLE other.t (x)");
	raw.exec(`ATTACH '${path}' AS alias`);
	cleanups.push(() => raw.exec("DETACH other; DETACH alias"));
	const { committed, settled } = await holdLock(threaded, 600);
	for (const sql of [
		"CREATE TEMP TABLE scratch2 (x)",
		"INSERT INTO scratch VALUES (1)",
		"INSERT INTO scratch SELECT 2",
		"INSERT INTO other.t VALUES (1)",
	])
		await wrapped.run(sql);
	assert.equal(settled(), false, "a write of another file waited for the transaction");
	const failure = await wrapped.run("INSERT INTO alias.items VALUES ('x')").then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError, `expected SQLITE_BUSY, got ${String(failure)}`);
	assert.equal((failure.cause as { errcode?: number }).errcode, 5);
	await committed;
	assert.deepEqual(await wrapped.all("SELECT x FROM scratch ORDER BY x"), [{ x: 1 }, { x: 2 }]);
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("a wrapped exec of no statement or of one statement runs as that statement, and a longer script waits (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path, 150);
	raw.exec("CREATE TEMP TABLE scratch (x)");
	const { committed, settled } = await holdLock(threaded, 600);
	for (const sql of [
		"",
		"SELECT 1",
		"SELECT 1;",
		"  -- c\n",
		"INSERT INTO scratch VALUES (1);",
		"CREATE TEMP TRIGGER kept AFTER INSERT ON scratch BEGIN INSERT INTO scratch VALUES (2); END",
	])
		await wrapped.exec(sql);
	assert.equal(settled(), false, "a single-statement exec waited for the transaction");
	for (const sql of ["SELECT 1; SELECT 2", "INSERT INTO items VALUES ('c')"]) {
		const failure = await wrapped.exec(sql).then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.ok(failure instanceof StorageUnavailableError, `${sql}: expected SQLITE_BUSY, got ${String(failure)}`);
		assert.equal((failure.cause as { errcode?: number }).errcode, 5);
	}
	await committed;
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("a wrapped deferred transaction or savepoint runs at once during a threaded transaction, as before, and BEGIN IMMEDIATE waits (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path, 150);
	const { committed, settled } = await holdLock(threaded, 600);
	await wrapped.exec("BEGIN");
	assert.deepEqual(await values(wrapped), []);
	await wrapped.exec("COMMIT");
	await wrapped.exec("SAVEPOINT s");
	await wrapped.exec("RELEASE s");
	assert.equal(settled(), false, "a transaction statement waited for the threaded transaction");
	const failure = await wrapped.exec("BEGIN IMMEDIATE").then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError, `expected SQLITE_BUSY, got ${String(failure)}`);
	assert.equal((failure.cause as { errcode?: number }).errcode, 5);
	await committed;
});

/** What a call settled with: its value, or the error it failed with. */
function outcome<T>(call: Promise<T>): Promise<{ readonly value?: T; readonly error?: unknown }> {
	return call.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
}

function assertBusy(failure: unknown, sql: string): void {
	assert.ok(failure instanceof StorageUnavailableError, `${sql}: expected SQLITE_BUSY, got ${String(failure)}`);
	assert.equal((failure.cause as { errcode?: number }).errcode, 5, sql);
}

test("a wrapped statement that calls a function of yours during a threaded transaction runs once, as before, also when the function writes the file (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path, 150);
	raw.exec("CREATE TEMP TABLE marks (x)");
	raw.function("write_marker", () => {
		raw.prepare("INSERT INTO temp.marks VALUES (1)").run();
		raw.prepare("INSERT INTO items VALUES ('m')").run();
		return 1;
	});
	const { committed, settled } = await holdLock(threaded, 1_000);
	const { error } = await outcome(wrapped.get("SELECT write_marker() AS m"));
	assertBusy(error, "SELECT write_marker()");
	assert.equal(settled(), false, "the call waited for the transaction");
	await committed;
	assert.deepEqual({ ...raw.prepare("SELECT count(*) AS n FROM temp.marks").get() }, { n: 1 });
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("a wrapped write that reads the change counters during a threaded transaction runs once, as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped, prepared } = await openWrapped(path, 150);
	raw.exec("CREATE TEMP TABLE scratch (x)");
	await wrapped.run("INSERT INTO scratch VALUES (1), (2), (3)");
	const { committed, settled } = await holdLock(threaded, 2_000);
	for (const sql of [
		"INSERT INTO items VALUES (changes())",
		"INSERT INTO items VALUES (total_changes())",
		"INSERT INTO items VALUES (last_insert_rowid())",
	]) {
		const { error } = await outcome(wrapped.run(sql));
		assertBusy(error, sql);
		assert.equal(prepared.filter((prepared) => prepared === sql).length, 1, `${sql} ran more than once`);
	}
	assert.equal(settled(), false, "a call waited for the transaction");
	await committed;
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("a call on another wrapped handle of the same connection waits behind its write that waits for the lock, and sees what the write did (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path);
	const second = wrapNodeSqliteDatabase(raw);
	cleanups.push(() => second.close());
	const { committed, settled } = await holdLock(threaded);
	const written = wrapped.run("INSERT INTO items VALUES ('c')");
	await sleep(0);
	const { value: counted, stallMs } = await longestStall(() =>
		second.get<{ n: number; total: number }>("SELECT changes() AS n, total_changes() AS total"),
	);
	assert.equal(settled(), true, "the count ran before the write it queued behind");
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
	assert.deepEqual(counted, { n: 1, total: 1 });
	assert.deepEqual(await written, { changes: 1 });
	await committed;
	assert.deepEqual(await values(threaded), ["a", "b", "c"]);
});

test("a wrapped journal_mode setter during a threaded transaction runs once, as before, after it changed the attached files (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const otherPath = databasePath();
	const { raw, wrapped, prepared } = await openWrapped(path, 150);
	raw.exec(`ATTACH '${otherPath}' AS other`);
	raw.exec("PRAGMA other.journal_mode=WAL");
	cleanups.push(() => raw.exec("DETACH other"));
	const { committed, settled } = await holdLock(threaded, 1_000);
	const sql = "PRAGMA journal_mode=DELETE";
	const { error } = await outcome(wrapped.get(sql));
	assertBusy(error, sql);
	assert.equal(settled(), false, "the call waited for the transaction");
	assert.equal(prepared.filter((prepared) => prepared === sql).length, 1, `${sql} ran more than once`);
	assert.deepEqual({ ...raw.prepare("PRAGMA other.journal_mode").get() }, { journal_mode: "delete" });
	await committed;
});

test("a wrapped write that also writes another attached file, here from a trigger, runs once, as before, during a threaded transaction (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const otherPath = databasePath();
	const { raw, wrapped, prepared } = await openWrapped(path, 150);
	raw.exec(`ATTACH '${otherPath}' AS other`);
	raw.exec("CREATE TABLE other.copies (x)");
	raw.exec("CREATE TEMP TABLE originals (x)");
	raw.exec("CREATE TEMP TRIGGER copy AFTER INSERT ON originals BEGIN INSERT INTO other.copies VALUES (new.x); END");
	cleanups.push(() => raw.exec("DETACH other"));
	// A reader of the other file, in its rollback journal: a commit there waits for the reader's lock.
	const reader = new DatabaseSync(otherPath);
	cleanups.push(() => reader.close());
	reader.exec("BEGIN");
	reader.prepare("SELECT count(*) FROM copies").get();
	const { committed, settled } = await holdLock(threaded, 1_000);
	const sql = "INSERT INTO originals VALUES (1)";
	const { error } = await outcome(wrapped.run(sql));
	assertBusy(error, sql);
	assert.equal(settled(), false, "the call waited for the transaction");
	assert.equal(prepared.filter((prepared) => prepared === sql).length, 1, `${sql} ran more than once`);
	reader.exec("COMMIT");
	await committed;
	assert.deepEqual(await wrapped.all("SELECT x FROM other.copies"), []);
});

test("a wrapped VACUUM during a threaded transaction runs once, as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped, prepared } = await openWrapped(path, 150);
	const { committed, settled } = await holdLock(threaded, 1_000);
	const { error } = await outcome(wrapped.run("VACUUM"));
	assertBusy(error, "VACUUM");
	assert.equal(settled(), false, "the call waited for the transaction");
	assert.equal(prepared.filter((prepared) => prepared === "VACUUM").length, 1, "VACUUM ran more than once");
	await committed;
});

test("a wrapped write inside a transaction of its connection's own during a threaded transaction runs once, as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped, prepared } = await openWrapped(path);
	const { committed, settled } = await holdLock(threaded, 1_000);
	await wrapped.exec("BEGIN");
	assert.deepEqual(await values(wrapped), []);
	// The connection reads the file as it was before the threaded transaction: its write would have to upgrade that
	// read, which SQLite refuses at once.
	const sql = "INSERT INTO items VALUES ('c')";
	const { error } = await outcome(wrapped.run(sql));
	assertBusy(error, sql);
	assert.equal(settled(), false, "the write waited for the transaction");
	assert.equal(prepared.filter((prepared) => prepared === sql).length, 1, `${sql} ran more than once`);
	await wrapped.exec("ROLLBACK");
	await committed;
	assert.deepEqual(await values(threaded), ["a", "b"]);
});

test("a wrapped statement that reads the change counters during a threaded transaction reads what it read before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path);
	raw.exec("CREATE TEMP TABLE scratch (x)");
	await wrapped.run("INSERT INTO scratch VALUES (1), (2), (3)");
	const { committed, settled } = await holdLock(threaded);
	assert.deepEqual(await wrapped.get("INSERT INTO scratch VALUES (changes()) RETURNING x"), { x: 3 });
	assert.deepEqual(await wrapped.get("SELECT changes() AS n, total_changes() AS total"), { n: 1, total: 4 });
	assert.equal(settled(), false, "a call waited for the transaction");
	await committed;
});
