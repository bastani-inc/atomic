import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * A connection on a thread of its own taking or holding a file's write lock: open from the moment it sends
 * `BEGIN IMMEDIATE` until it learns that the attempt was refused or failed, or until its transaction let go of the
 * lock. A call made inside its transaction's callback runs in its hold's asynchronous context (`runInHold`), and calls
 * that waited for the file run when the file's last hold closes (`releaseHold`).
 */
export interface FileHold {
	readonly file: string;
	open: boolean;
}

/** The holds whose transaction callbacks an asynchronous context runs in, innermost first. */
export interface HoldScope {
	readonly hold: FileHold;
	readonly outer: HoldScope | undefined;
}

/**
 * What the process's connections to one file are doing with its write lock, in one `Int32` they all share: `FREE`, a
 * statement of the calling thread running (`CALLER`), or a connection on a thread of its own taking it (`tag * 4 + 2`)
 * or holding it (`tag * 4 + 3`), by its `tag`. That thread moves it with compare-and-exchange as SQLite takes and lets
 * go of the lock: it takes the word before `BEGIN IMMEDIATE`, and gives it back once its transaction ended, before it
 * answers. A statement of the calling thread runs only while it has the word itself (`runAdmitted`), so neither can
 * take the lock from under the other.
 */
const FREE = 0;
const CALLER = 1;

/** A threaded connection's share of its file's word: the word, its tag, and how to stop using it. */
export interface FileLock {
	readonly buffer: SharedArrayBuffer;
	readonly tag: number;
	/** Gives the word back if this connection still takes or holds it, as when its thread exited. */
	clear(): void;
	/** This connection no longer uses the word; the file's word goes once no connection does. */
	release(): void;
}

interface Waiter {
	readonly deadline: number;
	readonly timer: ReturnType<typeof setTimeout>;
	/** Runs the call if the word is free now; whether it did. */
	readonly tryRun: () => boolean;
	readonly fail: () => void;
}

/** Statements a calling-thread connection prepared to classify its calls while the file is held; see `readsOnly`. */
interface Plans {
	readonly explained: Map<string, StatementSync>;
	schemaVersion?: StatementSync;
	busyTimeout?: StatementSync;
}

/**
 * One file's open holds, the calls waiting to run, and what those calls' connections prepared meanwhile, by the
 * object that owns each connection (not the connection, which its own statements keep alive), so they are kept no
 * longer than it is.
 */
export interface FileGate {
	readonly holds: Set<FileHold>;
	readonly waiters: Waiter[];
	readonly plans: WeakMap<object, Plans>;
	watching: boolean;
}

interface Registry {
	readonly files: Map<string, FileGate>;
	readonly words: Map<string, { readonly state: Int32Array; users: number }>;
	readonly scopes: AsyncLocalStorage<HoldScope | undefined>;
	nextTag: number;
}

// Shared across module copies, as the transaction gates are: a copy that runs a transaction's callback and a copy whose
// wrapped connection is called from it must see the same holds, words and asynchronous context.
const REGISTRY = Symbol.for("atomic-storage/node-sqlite-file-holds@1");
const registryBag = globalThis as typeof globalThis & Record<symbol, Registry | undefined>;
const registry: Registry = registryBag[REGISTRY] ?? {
	files: new Map(),
	words: new Map(),
	scopes: new AsyncLocalStorage(),
	nextTag: 1,
};
registryBag[REGISTRY] = registry;

/** A threaded connection to `file` starts using the file's word (see `FREE`). */
export function useFileLock(file: string): FileLock {
	let word = registry.words.get(file);
	if (word === undefined) {
		word = { state: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), users: 0 };
		registry.words.set(file, word);
	}
	word.users++;
	const { state } = word;
	const tag = registry.nextTag++;
	let released = false;
	return {
		buffer: state.buffer as SharedArrayBuffer,
		tag,
		clear: () => {
			if (
				Atomics.compareExchange(state, 0, tag * 4 + 3, FREE) === tag * 4 + 3 ||
				Atomics.compareExchange(state, 0, tag * 4 + 2, FREE) === tag * 4 + 2
			)
				Atomics.notify(state, 0);
		},
		release: () => {
			if (released) return;
			released = true;
			const current = registry.words.get(file);
			if (current !== undefined && --current.users === 0) registry.words.delete(file);
		},
	};
}

/**
 * Runs `call`, a statement of the calling thread, if the file's word is free, holding the word while it runs, which is
 * synchronous; undefined, running nothing, if a threaded connection takes or holds the lock.
 */
function runAdmitted<T>(state: Int32Array, call: () => Promise<T>): Promise<T> | undefined {
	if (Atomics.compareExchange(state, 0, FREE, CALLER) !== FREE) return undefined;
	try {
		return call();
	} finally {
		Atomics.store(state, 0, FREE);
		Atomics.notify(state, 0);
	}
}

/** Opens a hold on `file`, identified as `fileIdentity` identifies it. */
export function holdFile(file: string): FileHold {
	let gate = registry.files.get(file);
	if (gate === undefined) {
		gate = { holds: new Set(), waiters: [], plans: new WeakMap(), watching: false };
		registry.files.set(file, gate);
	}
	const hold: FileHold = { file, open: true };
	gate.holds.add(hold);
	return hold;
}

/**
 * Closes `hold`, once. When it was the file's last, the calls waiting for the file run now, oldest first, before
 * anything else can take the lock again; one that finds the word taken (a call before it began a transaction) stops
 * the rest, which go on waiting.
 */
export function releaseHold(hold: FileHold | undefined): void {
	if (hold === undefined || !hold.open) return;
	hold.open = false;
	const gate = registry.files.get(hold.file);
	if (gate === undefined) return;
	gate.holds.delete(hold);
	if (gate.holds.size === 0) runWaiters(gate);
	forgetIfIdle(hold.file, gate);
}

/** Runs the gate's waiting calls, oldest first, while the word is free. */
function runWaiters(gate: FileGate): void {
	while (gate.waiters.length > 0) {
		const waiter = gate.waiters[0]!;
		if (!waiter.tryRun()) return;
		gate.waiters.shift();
		clearTimeout(waiter.timer);
	}
}

function forgetIfIdle(file: string, gate: FileGate): void {
	if (gate.holds.size === 0 && gate.waiters.length === 0 && registry.files.get(file) === gate)
		registry.files.delete(file);
}

/**
 * Runs a transaction's callback inside the transaction callbacks it was requested in (`scope`, captured when it was
 * requested, since a group commit runs it from another's request) and inside its own hold, so calls it makes can be
 * told apart.
 */
export function runInHold<T>(hold: FileHold | undefined, scope: HoldScope | undefined, callback: () => T): T {
	return registry.scopes.run(hold === undefined ? scope : { hold, outer: scope }, callback);
}

/** The holds whose callbacks the caller runs in; captured when a call is made, not when it runs. */
export function currentHoldScope(): HoldScope | undefined {
	return registry.scopes.getStore();
}

/**
 * The gate of `file` when another context holds it open: some hold is open, and none of the callbacks `scope` runs in
 * belongs to an open hold of it. A call made inside an open hold's own callback cannot wait for it, since the
 * transaction waits for the call: it runs at once, as it always has.
 */
export function heldElsewhere(file: string, scope: HoldScope | undefined): FileGate | undefined {
	const gate = registry.files.get(file);
	if (gate === undefined || gate.holds.size === 0) return undefined;
	for (let inner = scope; inner !== undefined; inner = inner.outer) {
		if (inner.hold.open && inner.hold.file === file) return undefined;
	}
	return gate;
}

/**
 * Runs `run` as soon as the file's word is free: at once if it is, as SQLite's busy handler would find the lock free;
 * otherwise once a threaded connection gives the word back, or the file's last hold closes. Fails it with `busy()`,
 * having run nothing, if the word is still taken at the end of the busy timeout of `database`, which `owner` owns
 * (read only when the call has to wait). When that cannot be read, `run` runs at once, as it always has.
 */
export function runWhenFree<T>(
	file: string,
	gate: FileGate,
	owner: object,
	database: DatabaseSync,
	run: () => Promise<T>,
	busy: () => Error,
): Promise<T> {
	const state = registry.words.get(file)?.state;
	if (state === undefined) return run();
	// Calls already waiting go first.
	runWaiters(gate);
	const now = gate.waiters.length === 0 ? runAdmitted(state, run) : undefined;
	if (now !== undefined) return now;
	const timeoutMs = busyTimeoutOf(gate, owner, database);
	if (timeoutMs === undefined) return run();
	return new Promise<T>((resolve, reject) => {
		const waiter: Waiter = {
			deadline: performance.now() + timeoutMs,
			// Decided once the event loop handled what it already received, such as the exit of a connection's thread,
			// which a timer runs ahead of.
			timer: setTimeout(
				() =>
					setImmediate(() => {
						const index = gate.waiters.indexOf(waiter);
						if (index === -1) return;
						gate.waiters.splice(index, 1);
						if (!waiter.tryRun()) waiter.fail();
						forgetIfIdle(file, gate);
					}),
				timeoutMs,
			),
			tryRun: () => {
				const ran = runAdmitted(state, run);
				if (ran === undefined) return false;
				resolve(ran);
				return true;
			},
			fail: () => reject(busy()),
		};
		gate.waiters.push(waiter);
		watchWord(file, gate, state);
	});
}

/**
 * Wakes the gate's waiting calls whenever the file's word changes, so a call runs the moment a threaded connection
 * gives the lock back, before its answer reaches this thread. One watch per gate, for as long as calls wait.
 */
function watchWord(file: string, gate: FileGate, state: Int32Array): void {
	for (;;) {
		if (gate.watching || gate.waiters.length === 0) return;
		const observed = Atomics.load(state, 0);
		// Freed since the caller found it taken: run what waits now rather than wait for a change that already came.
		if (observed === FREE) {
			runWaiters(gate);
			forgetIfIdle(file, gate);
			continue;
		}
		// Until the last deadline: each waiter's own timer decides at its deadline, so a watch never runs past it.
		const untilMs = Math.max(...gate.waiters.map((waiter) => waiter.deadline)) - performance.now();
		if (untilMs <= 0) return;
		const result = Atomics.waitAsync(state, 0, observed, untilMs);
		if (!result.async) {
			if (result.value === "not-equal") continue;
			return;
		}
		gate.watching = true;
		void result.value.then(() => {
			gate.watching = false;
			runWaiters(gate);
			forgetIfIdle(file, gate);
			watchWord(file, gate, state);
		});
		return;
	}
}

/** Most plans one connection keeps while a file is held. */
const MAX_PLANS = 32;

function plansOf(gate: FileGate, owner: object): Plans {
	let plans = gate.plans.get(owner);
	if (plans === undefined) {
		plans = { explained: new Map() };
		gate.plans.set(owner, plans);
	}
	return plans;
}

/** Drops what the connection of `owner` prepared while `file` was held, as it closes. */
export function forgetPlans(file: string, owner: object): void {
	registry.files.get(file)?.plans.delete(owner);
}

/** The busy timeout `database` waits for a lock now, in milliseconds; undefined when it cannot be read. */
function busyTimeoutOf(gate: FileGate, owner: object, database: DatabaseSync): number | undefined {
	const plans = plansOf(gate, owner);
	try {
		plans.busyTimeout ??= database.prepare("PRAGMA busy_timeout");
		const timeout = Number(plans.busyTimeout.get()?.timeout);
		return Number.isFinite(timeout) && timeout >= 0 ? timeout : undefined;
	} catch {
		return undefined;
	}
}

/** A statement whose first keyword reads: anything else is never prepared for its plan. */
const READ_STATEMENT = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:SELECT|VALUES|WITH)\b/i;
/** Steps that run code of the application's or of an extension, or a trigger: functions, aggregates, virtual tables. */
const CALLS_CODE = /^(?:Function|PureFunc|Agg[A-Z]\w*|V[A-Z]\w*|Program)$/;

/**
 * Whether `sql`, run as one statement on `database`, only reads, so it never waits for the write lock in WAL mode,
 * which both kinds of connection put the file in. Proven from the plan SQLite makes for it, never by running it: the
 * plan writes nothing, calls no function, virtual table or trigger (whose code could wait for a lock or write), uses
 * no attached database, and was made for the schema the file has now. A collating sequence an extension registered
 * still runs: it compares values and is not told apart.
 *
 * The plan of a text is prepared once while the file is held and run again for later calls: SQLite makes it again when
 * this connection changed its schema since. A kept plan made for an older schema of the file is made afresh, so the
 * answer is always the one a fresh plan gives.
 */
export function readsOnly(gate: FileGate, owner: object, database: DatabaseSync, sql: string): boolean {
	if (!READ_STATEMENT.test(sql)) return false;
	const plans = plansOf(gate, owner);
	const kept = plans.explained.has(sql);
	let verdict = planVerdict(plans, database, sql);
	if (verdict === "older schema" && kept) verdict = planVerdict(plans, database, sql);
	return verdict === "reads";
}

function planVerdict(plans: Plans, database: DatabaseSync, sql: string): "reads" | "older schema" | "not proven" {
	try {
		let explained = plans.explained.get(sql);
		if (explained === undefined) {
			explained = database.prepare(`EXPLAIN ${sql}`);
			if (plans.explained.size >= MAX_PLANS) plans.explained.delete(plans.explained.keys().next().value!);
			plans.explained.set(sql, explained);
		}
		let fileSchema: number | undefined;
		for (const step of explained.all()) {
			const opcode = String(step.opcode);
			if (opcode === "OpenWrite" || CALLS_CODE.test(opcode)) return "not proven";
			if (opcode !== "Transaction") continue;
			// p1: the database (0 the file, 1 temp), p2: a write transaction, p3: the schema version it was made for,
			// p5: whether it checks that version.
			const schema = Number(step.p1);
			if (Number(step.p2) !== 0 || schema > 1 || (schema === 0 && Number(step.p5) === 0)) return "not proven";
			if (schema === 1) continue;
			plans.schemaVersion ??= database.prepare("PRAGMA schema_version");
			fileSchema ??= Number(plans.schemaVersion.get()?.schema_version);
			if (Number(step.p3) !== fileSchema) {
				plans.explained.delete(sql);
				return "older schema";
			}
		}
		return "reads";
	} catch {
		plans.explained.delete(sql);
		return "not proven";
	}
}

let sqliteErrorShape: { readonly prototype: object; readonly ownCode: boolean } | undefined;

/**
 * How the runtime's node:sqlite builds its errors: their class (Bun has one of its own) and whether `code` is a field
 * of each error, read once from a failure of a connection of this module's own. Plain `Error` fields when it cannot
 * be read.
 */
function errorShape(): { readonly prototype: object; readonly ownCode: boolean } {
	if (sqliteErrorShape !== undefined) return sqliteErrorShape;
	sqliteErrorShape = { prototype: Error.prototype, ownCode: true };
	try {
		const { DatabaseSync: Database } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
		const probe = new Database(":memory:");
		try {
			probe.exec("SELECT");
		} catch (error) {
			if (error instanceof Error)
				sqliteErrorShape = {
					prototype: Object.getPrototypeOf(error) as object,
					ownCode: Object.hasOwn(error, "code"),
				};
		} finally {
			probe.close();
		}
	} catch {
		// The plain shape stands.
	}
	return sqliteErrorShape;
}

/**
 * SQLITE_BUSY as the runtime's node:sqlite reports it, for a call that waited out its busy timeout without running:
 * the runtime's own error class with the fields a refused statement carries.
 */
export function sqliteBusyError(): Error {
	const shape = errorShape();
	const error = Object.setPrototypeOf(new Error("database is locked"), shape.prototype) as Error;
	const fields: Record<string, unknown> = { errcode: 5, errstr: "database is locked" };
	return Object.assign(error, shape.ownCode ? { code: "ERR_SQLITE_ERROR", ...fields } : fields);
}
