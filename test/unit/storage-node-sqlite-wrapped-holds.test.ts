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

test("a wrapped read that calls a function of yours waits for the threaded transaction, then runs (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path);
	// A function of the caller's own can do anything, such as write the file through another connection.
	const seen: number[] = [];
	raw.function("seen", (count) => {
		seen.push(Number(count));
		return count;
	});
	const { committed } = await holdLock(threaded);
	const read = await wrapped.get<{ n: number }>("SELECT seen(count(*)) AS n FROM items");
	await committed;
	assert.equal(Number(read?.n), 2);
	assert.deepEqual(seen, [2]);
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

test("a wrapped read whose plan was made for an older schema of the file waits for the transaction (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { wrapped } = await openWrapped(path);
	// The wrapped connection reads the schema while `items` is a table; another connection then makes it a view that
	// calls a function, which the wrapped connection has not seen when the transaction starts.
	assert.deepEqual(await wrapped.all("SELECT value FROM items ORDER BY value"), []);
	await threaded.exec("CREATE TABLE stored (value TEXT); DROP TABLE items");
	await threaded.exec("CREATE VIEW items AS SELECT lower(value) AS value FROM stored");
	const { committed } = await holdLock(
		threaded,
		HOLD_MS,
		undefined,
		"INSERT INTO stored VALUES ('A')",
		"INSERT INTO stored VALUES ('B')",
	);
	const read = (await wrapped.all<{ value: string }>("SELECT value FROM items ORDER BY value")).map(
		(row) => row.value,
	);
	await committed;
	// Rows the transaction committed: the read ran once it let go of the lock, not against the file before it.
	assert.deepEqual(read, ["a", "b"]);
});

test("a statement the threaded transaction's callback awaits runs at once, as before (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	await threaded.run("INSERT INTO items VALUES ('before')");
	const { wrapped } = await openWrapped(path);
	// A read that calls a function cannot be proven to only read, so only the callback it runs in lets it through.
	let counted: number | undefined;
	const { committed } = await holdLock(threaded, 0, async () => {
		counted = Number((await wrapped.get<{ n: number }>("SELECT abs(count(*)) AS n FROM items"))?.n);
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
		counted = Number((await wrapped.get<{ n: number }>("SELECT abs(count(*)) AS n FROM items"))?.n);
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

test("with a busy timeout of 0, a wrapped read that calls a function of yours never runs while the threaded transaction may hold the lock (#6081)", async () => {
	const { path, threaded } = await sharedFile();
	const { raw, wrapped } = await openWrapped(path, 0);
	let calls = 0;
	raw.function("seen", () => {
		calls++;
		return 42;
	});
	// The connection's thread took the lock; the answer saying so is still on its way.
	const { go, committed } = await pauseRequest(threaded, "begin answer");
	const read = wrapped.get("SELECT seen() AS n").then(
		() => undefined,
		(error: unknown) => error,
	);
	await sleep(50);
	assert.equal(calls, 0);
	go();
	const failure = await read;
	await committed;
	assert.ok(failure instanceof StorageUnavailableError, `expected SQLITE_BUSY, got ${String(failure)}`);
	assert.equal((failure.cause as { errcode?: number }).errcode, 5);
	assert.equal(calls, 0);
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
			read = await wrapped.get("SELECT seen() AS n");
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
	cleanups.push(() => enters.mockRestore());
	const write = (value: string) =>
		threaded.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES (?)", value);
		});
	// A wrapped connection to another file does not count.
	await openWrapped(databasePath());
	await write("unwrapped");
	assert.equal(enters.mock.calls.length, 0);
	const { wrapped } = await openWrapped(path);
	await write("wrapped");
	assert.equal(enters.mock.calls.length, 1);
	await wrapped.close();
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
