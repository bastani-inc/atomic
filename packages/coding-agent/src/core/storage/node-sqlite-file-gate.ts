import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * A connection on a thread of its own taking or holding a file's write lock: open from the moment it sends
 * `BEGIN IMMEDIATE` until it learns that the attempt was refused or failed, or until its transaction let go of the
 * lock. Only a `scoped` hold, one opened while the process had a wrapped connection to the file, makes wrapped calls
 * wait: its transaction's callback runs in its asynchronous context (`runInHold`), so calls made inside it are told
 * apart. A process that wraps no connection to the file never enters that context, and wrapped calls made while an
 * unscoped hold is open run at once, as they always have.
 */
export interface FileHold {
	readonly file: string;
	readonly scoped: boolean;
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

/** Statements a calling-thread connection prepared to classify its calls while the file is held; see `classify`. */
interface Plans {
	readonly explained: Map<string, StatementSync>;
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
	/** A call ran on this file in the current turn of the event loop; the next one waits for the next turn. */
	paced: boolean;
	pumping: boolean;
}

interface Registry {
	readonly files: Map<string, FileGate>;
	readonly words: Map<string, FileWord>;
	readonly scopes: AsyncLocalStorage<HoldScope | undefined>;
	/** Wrapped connections to each file that are open: closed ones, and ones collected unclosed, no longer count. */
	readonly wrapped: Map<string, number>;
	readonly collected: FinalizationRegistry<{ readonly release: () => void }>;
}

/** One file's word and the tags of the connections that use it. */
interface FileWord {
	readonly state: Int32Array;
	readonly tags: Set<number>;
	lastTag: number;
}

/** Tags stay below this, so a mark (`tag * 4 + 3`) is a positive `Int32`. */
const TAG_LIMIT = 2 ** 28;

// Shared across module copies, as the transaction gates are: a copy that runs a transaction's callback and a copy whose
// wrapped connection is called from it must see the same holds, words and asynchronous context.
const REGISTRY = Symbol.for("atomic-storage/node-sqlite-file-holds@1");
const registryBag = globalThis as typeof globalThis & Record<symbol, Registry | undefined>;
const registry: Registry = registryBag[REGISTRY] ?? {
	files: new Map(),
	words: new Map(),
	scopes: new AsyncLocalStorage(),
	wrapped: new Map(),
	collected: new FinalizationRegistry((use) => use.release()),
};
registryBag[REGISTRY] = registry;

/** A threaded connection to `file` starts using the file's word (see `FREE`). */
export function useFileLock(file: string): FileLock {
	let word = registry.words.get(file);
	if (word === undefined) {
		word = {
			state: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
			tags: new Set(),
			lastTag: 0,
		};
		registry.words.set(file, word);
	}
	// The next tag no connection to the file uses, from 1 up, wrapping before the marks would leave the Int32 range.
	let tag = word.lastTag;
	do tag = (tag % (TAG_LIMIT - 1)) + 1;
	while (word.tags.has(tag));
	word.lastTag = tag;
	word.tags.add(tag);
	const { state, tags } = word;
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
			tags.delete(tag);
			if (tags.size === 0 && registry.words.get(file)?.tags === tags) registry.words.delete(file);
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

/**
 * A wrapped connection, `owner`, to `file` counts as open until `release` or until `owner` is collected, whichever
 * comes first; see `FileHold`.
 */
export function useWrappedFile(file: string, owner: object): { release(): void } {
	registry.wrapped.set(file, (registry.wrapped.get(file) ?? 0) + 1);
	let released = false;
	const use = {
		release: () => {
			if (released) return;
			released = true;
			const count = (registry.wrapped.get(file) ?? 1) - 1;
			if (count > 0) registry.wrapped.set(file, count);
			else registry.wrapped.delete(file);
			leaveScopesIfUnused();
		},
	};
	registry.collected.register(owner, use, use);
	return {
		release: () => {
			registry.collected.unregister(use);
			use.release();
		},
	};
}

/** Opens a hold on `file`, identified as `fileIdentity` identifies it, scoped if a wrapped connection to it is open. */
export function holdFile(file: string): FileHold {
	let gate = registry.files.get(file);
	if (gate === undefined) {
		gate = { holds: new Set(), waiters: [], plans: new WeakMap(), watching: false, paced: false, pumping: false };
		registry.files.set(file, gate);
	}
	const hold: FileHold = { file, scoped: registry.wrapped.has(file), open: true };
	gate.holds.add(hold);
	return hold;
}

/** Whether a scoped hold of the gate's file is open. */
function scopedHoldOpen(gate: FileGate): boolean {
	for (const hold of gate.holds) if (hold.scoped) return true;
	return false;
}

/**
 * Leaves the asynchronous context once no wrapped connection is open and no scoped hold is: nothing reads it then, and
 * on Node 22 an entered context keeps promise hooks on for every later await. It is entered again when needed.
 */
function leaveScopesIfUnused(): void {
	if (registry.wrapped.size > 0) return;
	for (const gate of registry.files.values()) if (scopedHoldOpen(gate)) return;
	registry.scopes.disable();
}

/**
 * Closes `hold`, once. When it was the file's last, the oldest call waiting for the file runs now, if the word is free
 * and no call ran in this turn; the others follow one per turn (see `runNextWaiter`).
 */
export function releaseHold(hold: FileHold | undefined): void {
	if (hold === undefined || !hold.open) return;
	hold.open = false;
	const gate = registry.files.get(hold.file);
	if (gate === undefined) return;
	gate.holds.delete(hold);
	if (!scopedHoldOpen(gate)) runNextWaiter(hold.file, gate);
	forgetIfIdle(hold.file, gate);
	if (hold.scoped) leaveScopesIfUnused();
}

/**
 * Runs the oldest waiting call if the word is free and no call ran on the file in this turn of the event loop, and
 * schedules the next one for the next turn: calls that queued up behind a long transaction run one per turn, so none
 * of them holds the event loop for the time of all of them. A call that finds the word taken waits again, still under
 * its own deadline.
 */
function runNextWaiter(file: string, gate: FileGate): void {
	if (gate.paced || gate.waiters.length === 0) return;
	const waiter = gate.waiters[0]!;
	if (!waiter.tryRun()) {
		failOverdue(gate);
		return;
	}
	gate.waiters.shift();
	clearTimeout(waiter.timer);
	ranThisTurn(file, gate);
}

/** The word is taken: calls waiting past their deadline fail now, having run nothing; the others keep their place. */
function failOverdue(gate: FileGate): void {
	const now = performance.now();
	for (const waiter of gate.waiters.filter((waiting) => now >= waiting.deadline)) {
		gate.waiters.splice(gate.waiters.indexOf(waiter), 1);
		clearTimeout(waiter.timer);
		waiter.fail();
	}
}

/** Notes that a call ran on the file in this turn; the next waiting one gets the next turn. */
function ranThisTurn(file: string, gate: FileGate): void {
	gate.paced = true;
	if (gate.pumping) return;
	gate.pumping = true;
	setImmediate(() => {
		gate.pumping = false;
		gate.paced = false;
		const state = registry.words.get(file)?.state;
		runNextWaiter(file, gate);
		if (state !== undefined) watchWord(file, gate, state);
		forgetIfIdle(file, gate);
	});
}

function forgetIfIdle(file: string, gate: FileGate): void {
	if (gate.holds.size === 0 && gate.waiters.length === 0 && !gate.pumping && registry.files.get(file) === gate)
		registry.files.delete(file);
}

/**
 * Runs a transaction's callback inside the transaction callbacks it was requested in (`scope`, captured when it was
 * requested, since a group commit runs it from another's request) and inside its own hold, so calls it makes can be
 * told apart.
 */
export function runInHold<T>(hold: FileHold | undefined, scope: HoldScope | undefined, callback: () => T): T {
	const store = hold?.scoped === true ? { hold, outer: scope } : scope;
	// Nothing to change, as always for a process that wraps no connection to a file: no context is entered.
	if (store === registry.scopes.getStore()) return callback();
	return registry.scopes.run(store, callback);
}

/** The holds whose callbacks the caller runs in; captured when a call is made, not when it runs. */
export function currentHoldScope(): HoldScope | undefined {
	return registry.scopes.getStore();
}

/**
 * Whether a call made now on a wrapped connection to `file` comes in behind a transaction: a scoped hold is open or
 * calls wait for their turn. Read when the call is made; one made once that is over runs as it always has, however
 * busy the file was before.
 */
export function inBacklog(file: string): boolean {
	const gate = registry.files.get(file);
	return gate !== undefined && (scopedHoldOpen(gate) || gate.waiters.length > 0);
}

/**
 * The gate of `file` when another context holds it open: some hold is open, and none of the callbacks `scope` runs in
 * belongs to an open hold of it. A call made inside an open hold's own callback cannot wait for it, since the
 * transaction waits for the call: it runs at once, as it always has. A call made in the backlog of a transaction
 * (`backlog`, see `inBacklog`) also takes its turn behind the calls queued before it, one per turn.
 */
export function heldElsewhere(file: string, scope: HoldScope | undefined, backlog: boolean): FileGate | undefined {
	const gate = registry.files.get(file);
	if (gate === undefined || (!scopedHoldOpen(gate) && gate.waiters.length === 0 && !(gate.paced && backlog)))
		return undefined;
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
	// Calls already waiting go first, and one runs per turn.
	runNextWaiter(file, gate);
	const now = gate.waiters.length === 0 && !gate.paced ? runAdmitted(state, run) : undefined;
	if (now !== undefined) {
		ranThisTurn(file, gate);
		return now;
	}
	const timeoutMs = busyTimeoutOf(gate, owner, database);
	if (timeoutMs === undefined) return run();
	return new Promise<T>((resolve, reject) => {
		const waiter: Waiter = {
			deadline: performance.now() + timeoutMs,
			// Decided once the event loop handled what it already received, such as the exit of a connection's thread,
			// which a timer runs ahead of.
			// At its deadline it fails if the word is taken. While the word is free it keeps its place: a free lock is
			// never reported busy, and its turn comes (see `runNextWaiter`), so its busy timeout bounds how long it waits
			// for the lock, not for its turn.
			timer: setTimeout(
				() =>
					setImmediate(() => {
						const index = gate.waiters.indexOf(waiter);
						if (index === -1 || Atomics.load(state, 0) === FREE) return;
						gate.waiters.splice(index, 1);
						waiter.fail();
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
			// Free: the oldest runs now or at the next turn (see `runNextWaiter`); nothing to watch for until then.
			runNextWaiter(file, gate);
			forgetIfIdle(file, gate);
			if (gate.paced) return;
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
			runNextWaiter(file, gate);
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

/** A blank or a comment, which SQLite skips between words. */
const GAP = String.raw`(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)`;
/** What SQLite skips before a statement's first word: blanks, comments and empty statements. */
const LEADING = new RegExp(`^(?:${GAP}|;)*`);
/** A statement whose first keyword reads (on text without what `LEADING` matches). */
const READ_STATEMENT = /^(?:SELECT|VALUES|WITH)\b/i;
/**
 * A PRAGMA, alone or under EXPLAIN or EXPLAIN QUERY PLAN (on text without what `LEADING` matches): SQLite may carry it
 * out while it prepares it, so it is never prepared ahead.
 */
const PRAGMA_STATEMENT = new RegExp(`^(?:EXPLAIN${GAP}+(?:QUERY${GAP}+PLAN${GAP}+)?)?PRAGMA\\b`, "i");
/** A statement that only lists a plan: it runs nothing, whatever it explains. */
const EXPLAIN_STATEMENT = /^EXPLAIN\b/i;
/**
 * Steps of SQLite's virtual machine that write a database file or change a connection's transaction or schema, as
 * opposed to the temporary tables and indexes a read sorts and deduplicates in. A write to a table opens it with
 * `OpenWrite` and starts a write `Transaction`; the rest are the steps of statements that are not reads.
 */
const WRITE_STEPS = new Set([
	"OpenWrite",
	"VUpdate",
	"VBegin",
	"VCreate",
	"VDestroy",
	"VRename",
	"Clear",
	"Destroy",
	"CreateBtree",
	"ParseSchema",
	"DropTable",
	"DropIndex",
	"DropTrigger",
	"SetCookie",
	"IncrVacuum",
	"Vacuum",
	"Checkpoint",
	"JournalMode",
	"AutoCommit",
	"Savepoint",
	"SqlExec",
	"Program",
]);

/**
 * What a wrapped call is, decided from the plan SQLite makes for its text on `database`, never by running it:
 *
 * - `invalid`: a single statement (`single`) SQLite cannot prepare now (a missing table, a syntax error), prepared as
 *   the call itself prepares it. It runs at once and fails with its own error, as it always has: a statement that
 *   cannot be prepared runs nothing and takes no lock.
 * - `read`: a single statement whose plan has no step that writes (see `WRITE_STEPS`) and starts no write
 *   transaction, whatever functions or virtual tables it calls, or one that only lists a plan (`EXPLAIN`). It runs at
 *   once: in WAL mode, which both kinds of connection put the file in, a read never waits for the write lock, and code
 *   of yours that writes from inside it meets the lock as it always did.
 * - `write`: any other single statement, a PRAGMA included, which SQLite may carry out while it prepares it and so
 *   is never prepared for its plan. It waits for the lock (see `runWhenFree`).
 * - `script`: a call that may be several statements (`exec`), never prepared: it waits like a write.
 *
 * The plan of a statement that prepares is made once while the file is held and listed again for later calls; whether a
 * statement writes does not change with the schema.
 */
export function classify(
	gate: FileGate,
	owner: object,
	database: DatabaseSync,
	sql: string,
	single: boolean,
): "read" | "write" | "script" | "invalid" {
	if (!single) return "script";
	// Decided on the text SQLite reads, past the blanks, comments and empty statements it skips.
	const statement = sql.replace(LEADING, "");
	if (PRAGMA_STATEMENT.test(statement)) return "write";
	// Prepared first, as the call itself prepares it: if that fails now, the call fails at once with its own error.
	try {
		database.prepare(sql);
	} catch {
		return "invalid";
	}
	if (EXPLAIN_STATEMENT.test(statement)) return "read";
	const steps = planSteps(gate, owner, database, statement);
	if (steps === undefined || !READ_STATEMENT.test(statement)) return "write";
	for (const step of steps) {
		const opcode = String(step.opcode);
		// Transaction p2: whether it is a write transaction.
		if (WRITE_STEPS.has(opcode) || (opcode === "Transaction" && Number(step.p2) !== 0)) return "write";
	}
	return "read";
}

/**
 * The steps of the plan of `sql`, listed now from the plan kept for it (SQLite prepares a kept plan again when this
 * connection changed its schema since, and fails it if the statement no longer prepares), or from a new one; undefined
 * when SQLite cannot make one.
 */
function planSteps(
	gate: FileGate,
	owner: object,
	database: DatabaseSync,
	sql: string,
): ReturnType<StatementSync["all"]> | undefined {
	const plans = plansOf(gate, owner);
	const kept = plans.explained.get(sql);
	if (kept !== undefined) {
		try {
			return kept.all();
		} catch {
			plans.explained.delete(sql);
		}
	}
	try {
		const explained = database.prepare(`EXPLAIN ${sql}`);
		const steps = explained.all();
		if (plans.explained.size >= MAX_PLANS) plans.explained.delete(plans.explained.keys().next().value!);
		plans.explained.set(sql, explained);
		return steps;
	} catch {
		return undefined;
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
