import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

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

/** A call waiting for its turn; one decided only at its turn (see `runDeferred`) is armed then. */
interface Waiter {
	deadline: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** The connection the call runs on: later calls on it wait behind this one (see `runDeferred`). */
	readonly connection: DatabaseSync;
	/** Runs the call if it can run now; whether it did. */
	tryRun: () => boolean;
	fail: () => void;
}

/** A waiter for a call on `connection` that is decided at its turn: no deadline until then. */
function undecidedWaiter(connection: DatabaseSync): Waiter {
	return {
		deadline: Number.POSITIVE_INFINITY,
		timer: undefined,
		connection,
		tryRun: () => false,
		fail: () => {},
	};
}

/** Statements a calling-thread connection prepared to decide how its calls run while the file is held; see `modeOf`. */
interface Plans {
	readonly explained: Map<string, StatementSync>;
	busyTimeout?: StatementSync;
	/** Whether the file is in WAL mode; see `inWriteAheadLog`. */
	writeAheadLog?: boolean;
	/** Whether the connection lets its busy timeout be set; see `triesAllowed`. */
	timeoutSettable?: boolean;
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
	polling: boolean;
}

interface Registry {
	readonly files: Map<string, FileGate>;
	readonly words: Map<string, FileWord>;
	readonly scopes: AsyncLocalStorage<HoldScope | undefined>;
	/** Wrapped connections to each file that are open: closed ones, and ones collected unclosed, no longer count. */
	readonly wrapped: Map<string, number>;
	readonly collected: FinalizationRegistry<{ readonly release: () => void }>;
	/** Connections that refused their busy timeout back after a try: never tried first again (see `attemptOnce`). */
	readonly untried: WeakSet<DatabaseSync>;
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
	untried: new WeakSet(),
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
		gate = {
			holds: new Set(),
			waiters: [],
			plans: new WeakMap(),
			watching: false,
			paced: false,
			pumping: false,
			polling: false,
		};
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
		failOverdue(file, gate);
		return;
	}
	gate.waiters.shift();
	clearTimeout(waiter.timer);
	ranThisTurn(file, gate);
}

/**
 * The oldest call could not run: calls waiting past their deadline fail now, having run nothing (or refused, see
 * `runTryingFirst`); the others keep their place.
 */
function failOverdue(file: string, gate: FileGate): void {
	const now = performance.now();
	const overdue = gate.waiters.filter((waiting) => now >= waiting.deadline);
	for (const waiter of overdue) {
		gate.waiters.splice(gate.waiters.indexOf(waiter), 1);
		clearTimeout(waiter.timer);
		waiter.fail();
	}
	// The calls behind them get their turn.
	if (overdue.length > 0) ranThisTurn(file, gate);
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
	if (
		gate.holds.size === 0 &&
		gate.waiters.length === 0 &&
		!gate.pumping &&
		!gate.polling &&
		registry.files.get(file) === gate
	)
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
		const waiter = undecidedWaiter(database);
		gate.waiters.push(waiter);
		armWhenFree(file, gate, waiter, state, timeoutMs, run, resolve, reject, busy);
	});
}

/** Makes `waiter` run `run` once the word is free, for `runWhenFree`. */
function armWhenFree<T>(
	file: string,
	gate: FileGate,
	waiter: Waiter,
	state: Int32Array,
	timeoutMs: number,
	run: () => Promise<T>,
	resolve: (value: T | PromiseLike<T>) => void,
	reject: (error: unknown) => void,
	busy: () => Error,
): void {
	waiter.deadline = performance.now() + timeoutMs;
	// Decided once the event loop handled what it already received, such as the exit of a connection's thread, which
	// a timer runs ahead of. At its deadline it fails if the word is taken. While the word is free it keeps its place:
	// a free lock is never reported busy, and its turn comes (see `runNextWaiter`), so its busy timeout bounds how long
	// it waits for the lock, not for its turn.
	waiter.timer = setTimeout(
		() =>
			setImmediate(() => {
				const index = gate.waiters.indexOf(waiter);
				if (index === -1 || Atomics.load(state, 0) === FREE) return;
				gate.waiters.splice(index, 1);
				waiter.fail();
				ranThisTurn(file, gate);
				forgetIfIdle(file, gate);
			}),
		timeoutMs,
	);
	waiter.tryRun = () => {
		const ran = runAdmitted(state, run);
		if (ran === undefined) return false;
		resolve(ran);
		return true;
	};
	waiter.fail = () => reject(busy());
	watchWord(file, gate, state);
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
			// Ran, or was refused a lock the word does not announce (another process's), which `pollWaiters` tries again.
			if (gate.paced || Atomics.load(state, 0) === FREE) return;
			continue;
		}
		// Until the last deadline: each waiter's own timer decides at its deadline, so a watch never runs past it.
		// Calls not decided yet (see `runDeferred`) need no watch: they are decided in their turn, whatever the word.
		const deadlines = gate.waiters.map((waiter) => waiter.deadline).filter(Number.isFinite);
		const untilMs = Math.max(...deadlines) - performance.now();
		if (deadlines.length === 0 || untilMs <= 0) return;
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
/**
 * A PRAGMA, alone or under EXPLAIN or EXPLAIN QUERY PLAN (on text without what `LEADING` matches): SQLite may carry it
 * out while it prepares it, so it is never prepared ahead.
 */
const PRAGMA_STATEMENT = new RegExp(`^(?:EXPLAIN${GAP}+(?:QUERY${GAP}+PLAN${GAP}+)?)?PRAGMA\\b`, "i");
/** A name as SQLite reads it, bare or quoted, with its quotes. */
const NAME = String.raw`(?:\w+|"(?:[^"]|"")*"|'(?:[^']|'')*'|\[[^\]]*\]|` + "`(?:[^`]|``)*`)";
/**
 * A PRAGMA's name, past an optional EXPLAIN or EXPLAIN QUERY PLAN, `PRAGMA` and an optional schema (`schema.`), on text
 * without what `LEADING` matches.
 */
const PRAGMA_NAME = new RegExp(
	`^(EXPLAIN${GAP}+(?:QUERY${GAP}+PLAN${GAP}+)?)?PRAGMA${GAP}+(?:(${NAME})${GAP}*\\.${GAP}*)?(${NAME})`,
	"i",
);
/** A name without its quotes, in lower case. */
function unquoted(name: string): string {
	const quote = name[0];
	if (quote === '"' || quote === "'" || quote === "`")
		return name.slice(1, -1).replaceAll(`${quote}${quote}`, quote).toLowerCase();
	if (quote === "[") return name.slice(1, -1).toLowerCase();
	return name.toLowerCase();
}

/**
 * PRAGMAs that write the file and are tried first: SQLite refuses each in its opening steps, before it changed
 * anything. Every other PRAGMA runs as it always has: one that reads or sets a setting of the connection or another
 * database needs no lock of the file in WAL mode, and runs at once anyway; and ones a try would change are among them:
 * those of the busy timeout, which the try sets, also under EXPLAIN, since SQLite sets it while it prepares the
 * statement; setters that change something before they meet the lock (`journal_mode`, `default_cache_size`,
 * `auto_vacuum`, and the ones that apply to every attached database when no schema is named); checks that run the
 * application's functions in the schema's constraints (`integrity_check`, `quick_check`); and ones that answer
 * differently when refused the lock at once (a checkpoint that waits, `optimize`).
 */
const TRIED_PRAGMAS = new Set(["user_version", "application_id", "schema_version", "incremental_vacuum"]);

/** Whether a PRAGMA (on text without what `LEADING` matches) is tried first; see `TRIED_PRAGMAS`. */
function pragmaTriedFirst(statement: string): boolean {
	const match = PRAGMA_NAME.exec(statement);
	if (match === null) return false;
	const [, explain, schema, name = ""] = match;
	return (
		explain === undefined &&
		(schema === undefined || unquoted(schema) === "main") &&
		TRIED_PRAGMAS.has(unquoted(name))
	);
}

/**
 * Built-in functions a try cannot run safely: ones that read the connection's change counters, which a refused try
 * changes; `load_extension`, which runs an extension's code; and `sqlite_attach` (ATTACH), which reads another file
 * with its own locks.
 */
const UNSAFE_FUNCTIONS = new Set(["changes", "total_changes", "last_insert_rowid", "load_extension", "sqlite_attach"]);
/** Steps of a plan that call a function or an aggregate, named in their P4 as `name(arguments)`. */
const FUNCTION_STEPS = new Set([
	"Function",
	"Function0",
	"PureFunc",
	"PureFunc0",
	"AggStep",
	"AggStep0",
	"AggStep1",
	"AggFinal",
	"AggValue",
	"AggInverse",
]);
/** The collating sequences SQLite builds in; `B` is how a plan's key lists `BINARY`. */
const BUILT_IN_COLLATIONS = new Set(["", "B", "BINARY", "NOCASE", "RTRIM"]);
/** Steps of a plan that compare with a collating sequence named in their P4 as `name-encoding`. */
const COLLATING_STEPS = new Set(["CollSeq", "Eq", "Ne", "Lt", "Le", "Gt", "Ge"]);
const COLLATION = /^(.*)-(?:8|16le|16be|16)$/;
/** A plan's key, `k(fields,collation,…)`, each collation after its `-` (descending) and `N.` (nulls last) marks. */
const KEY = /^k\(\d+((?:,[^,)]*)*)\)$/;

/** Whether a step of a plan compares with a collating sequence SQLite does not build in, an extension's code. */
function usesOtherCollation(opcode: string, p4: string): boolean {
	const key = KEY.exec(p4);
	if (key !== null)
		return key[1]!
			.split(",")
			.slice(1)
			.some((field) => !BUILT_IN_COLLATIONS.has(field.replace(/^-?(?:N\.)?/, "")));
	if (!COLLATING_STEPS.has(opcode)) return false;
	const name = COLLATION.exec(p4)?.[1];
	return name !== undefined && !BUILT_IN_COLLATIONS.has(name);
}

/** A VACUUM, which may create the file it writes into before it is refused. */
const VACUUM_STATEMENT = /^VACUUM\b/i;
/** `UNSAFE_FUNCTIONS` but `sqlite_attach`, whose statement, ATTACH, names it otherwise. */
const UNSAFE_NAMES = ["changes", "total_changes", "last_insert_rowid", "load_extension"];
/** An INSERT, UPDATE or DELETE, possibly after a WITH clause: listing its plan resets `changes()`. */
const CHANGING_STATEMENT = /^(?:INSERT|REPLACE|UPDATE|DELETE|WITH)\b/i;
/**
 * A string literal or a comment, which names nothing; or a name, bare (SQLite reads any character past ASCII as part of
 * one) or quoted.
 */
const WORD =
	/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"((?:[^"]|"")*)"|\[([^\]]*)\]|`((?:[^`]|``)*)`|([A-Za-z_\u0080-\u{10FFFF}][\w$\u0080-\u{10FFFF}]*)/gu;

/** The names `sql` uses, bare or quoted, in lower case: outside its string literals and comments. */
function namesIn(sql: string): Set<string> {
	const names = new Set<string>();
	for (const [, double, bracket, backtick, bare] of sql.matchAll(WORD)) {
		const name = double?.replaceAll('""', '"') ?? bracket ?? backtick?.replaceAll("``", "`") ?? bare;
		if (name !== undefined) names.add(name.toLowerCase());
	}
	return names;
}

/**
 * Whether `statement` names a function whose result a listing of its plan could change, which resets `changes()`
 * for an INSERT, UPDATE or DELETE: one of `UNSAFE_NAMES`, or, for such a statement, a function SQLite does not build
 * in, which could read the counters itself. When the connection cannot list its functions, every INSERT, UPDATE or
 * DELETE counts.
 */
function namesUnsafeFunction(statement: string, database: DatabaseSync): boolean {
	const names = namesIn(statement);
	if (UNSAFE_NAMES.some((name) => names.has(name))) return true;
	if (!CHANGING_STATEMENT.test(statement)) return false;
	const userFunctions = functionsNotBuiltIn(database);
	if (userFunctions === undefined) return true;
	for (const name of userFunctions) if (names.has(name)) return true;
	return false;
}

/** The database numbers of a connection's main database, the file itself, and of its temporary database. */
const MAIN_DATABASE = 0;
const TEMP_DATABASE = 1;

/**
 * How a wrapped call runs while a threaded transaction of this thread holds its file:
 *
 * - `try first`: once at once with a busy timeout of 0 (see `runTryingFirst`), refused the lock, tried again. Only a
 *   statement whose plan proves that a refusal comes from its opening steps, before it did anything: the only
 *   databases it writes are the file and the temporary one, and the file is in WAL mode, where a commit needs no
 *   further lock; it calls no code but SQLite's own (no function or collating sequence SQLite does not build in, no
 *   virtual table, no `UNSAFE_FUNCTIONS`); it is no VACUUM, which may create the file it writes into before it is
 *   refused. A PRAGMA, which is never prepared ahead since SQLite may carry one out while preparing it, is tried first
 *   only if it is one of `TRIED_PRAGMAS`.
 * - `as before`: every other single statement, an `exec` of no statement, and every call while the connection is
 *   inside a transaction of its own or the file is not in WAL mode. It runs exactly as it always has, with the
 *   connection's own busy timeout.
 * - `script`: an `exec` of more than one statement (see `splitStatements`). It waits until no transaction of this
 *   thread holds the lock (see `runWhenFree`), so no part of it runs while the lock is held. An `exec` of exactly one
 *   statement runs as that statement.
 *
 * At a busy timeout of 0 every single statement runs as before: it never waits for the lock, and setting the timeout,
 * as a try does, would remove a busy handler an extension installed, which reads as a timeout of 0. A script still
 * waits (for no time), which sets no timeout.
 *
 * The plan of a statement is made once while the file is held and listed again for later calls. Listing the plan of
 * an INSERT, UPDATE or DELETE resets the connection's `changes()`, which the statement's own run sets again; so a
 * statement that names a function that reads the change counters or may (see `namesUnsafeFunction`) runs as before
 * without its plan being listed.
 */
export function modeOf(
	gate: FileGate,
	owner: object,
	database: DatabaseSync,
	sql: string,
	params: readonly SQLInputValue[],
	single: boolean,
): "try first" | "as before" | "script" {
	if (!single) {
		const statements = splitStatements(sql);
		if (statements.length > 1) return "script";
		// Nothing to run, nor to wait for.
		if (statements.length === 0) return "as before";
		return modeOf(gate, owner, database, statements[0]!, params, true);
	}
	if (busyTimeoutOf(gate, owner, database) === 0) return "as before";
	// Inside a transaction of its own, a write's upgrade of the connection's read is refused at once, with no busy
	// handler, and a try again could succeed or be refused otherwise.
	if (
		database.isTransaction !== false ||
		!inWriteAheadLog(gate, owner, database) ||
		!triesAllowed(gate, owner, database)
	)
		return "as before";
	// Decided on the text SQLite reads, past the blanks, comments and empty statements it skips.
	const statement = sql.replace(LEADING, "");
	if (PRAGMA_STATEMENT.test(statement)) return pragmaTriedFirst(statement) ? "try first" : "as before";
	// Decided without its plan: listing the plan of an INSERT, UPDATE or DELETE resets the connection's changes().
	if (VACUUM_STATEMENT.test(statement) || namesUnsafeFunction(statement, database)) return "as before";
	const steps = planSteps(gate, owner, database, statement, params);
	return steps !== undefined && triesSafely(steps, database) ? "try first" : "as before";
}

/**
 * Whether calls on `database`, which `owner` owns, may be tried first: it never refused its busy timeout back after a
 * try, and, checked once while the file is held, before anything is tried, the timeout can be read and set to the
 * value it has. An authorizer you set can refuse either; then every call runs as before, and the timeout is never set.
 */
function triesAllowed(gate: FileGate, owner: object, database: DatabaseSync): boolean {
	if (registry.untried.has(database)) return false;
	const plans = plansOf(gate, owner);
	if (plans.timeoutSettable === undefined) {
		const timeoutMs = busyTimeoutOf(gate, owner, database);
		try {
			if (timeoutMs !== undefined) setBusyTimeout(database, timeoutMs);
			plans.timeoutSettable = timeoutMs !== undefined;
		} catch {
			plans.timeoutSettable = false;
		}
	}
	return plans.timeoutSettable;
}

/**
 * Whether the file of `database`, which `owner` owns, is in WAL mode, read once while the file is held. A connection
 * of this process on a thread of its own is open on the file, so it stays in WAL mode meanwhile.
 */
function inWriteAheadLog(gate: FileGate, owner: object, database: DatabaseSync): boolean {
	const plans = plansOf(gate, owner);
	if (plans.writeAheadLog === undefined) {
		try {
			plans.writeAheadLog = String(database.prepare("PRAGMA main.journal_mode").get()?.journal_mode) === "wal";
		} catch {
			plans.writeAheadLog = false;
		}
	}
	return plans.writeAheadLog;
}

/**
 * Whether a plan, with the programs of the triggers it fires, can be refused the lock only in its opening steps, before
 * it did anything (see `modeOf`). When the connection cannot list its functions, every function counts as one SQLite
 * does not build in.
 */
function triesSafely(steps: ReturnType<StatementSync["all"]>, database: DatabaseSync): boolean {
	let userFunctions: Set<string> | undefined | null = null;
	for (const step of steps) {
		const opcode = String(step.opcode);
		if (opcode === "Transaction") {
			const written = Number(step.p1);
			if (Number(step.p2) !== 0 && written !== MAIN_DATABASE && written !== TEMP_DATABASE) return false;
			continue;
		}
		if (opcode === "Vacuum" || /^V[A-Z]/.test(opcode)) return false;
		if (typeof step.p4 === "string" && usesOtherCollation(opcode, step.p4)) return false;
		if (!FUNCTION_STEPS.has(opcode)) continue;
		const name = /^([^(]+)\(/.exec(String(step.p4 ?? ""))?.[1]?.toLowerCase();
		if (name === undefined || UNSAFE_FUNCTIONS.has(name)) return false;
		if (userFunctions === null) userFunctions = functionsNotBuiltIn(database);
		if (userFunctions === undefined || userFunctions.has(name)) return false;
	}
	return true;
}

/** The names of the functions `database` has that SQLite does not build in; undefined when it cannot list them. */
function functionsNotBuiltIn(database: DatabaseSync): Set<string> | undefined {
	try {
		const names = new Set<string>();
		let listed = 0;
		for (const row of database.prepare("PRAGMA function_list").all()) {
			listed++;
			if (Number(row.builtin) === 0) names.add(String(row.name).toLowerCase());
		}
		return listed === 0 ? undefined : names;
	} catch {
		return undefined;
	}
}

/** Whether `error` is SQLITE_BUSY itself (not one of its extended codes, such as SQLITE_BUSY_SNAPSHOT). */
function plainBusy(error: unknown): boolean {
	for (let cause = error; typeof cause === "object" && cause !== null; ) {
		const { errcode } = cause as { errcode?: unknown };
		if (typeof errcode === "number") return errcode === 5;
		cause = (cause as { cause?: unknown }).cause;
	}
	return false;
}

/** One attempt: done, with a value or an error of its own, or refused the lock (SQLITE_BUSY), having done nothing. */
type Attempt<T> =
	| { readonly kind: "done"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "busy"; readonly error: unknown };

/**
 * Runs `attempt`, a call that runs synchronously on `database`, once with a busy timeout of 0, then gives the
 * connection back `timeoutMs`. Undefined, having run nothing, when the connection no longer tries calls first or does
 * not take the busy timeout of 0, as read back (an authorizer you set can refuse or ignore it, though it allowed the
 * value it had; see `triesAllowed`): the call is to run as before, and the connection is not tried first again. When
 * the connection does not take the value back after the try, twice, the try's outcome is final, a refusal of the lock
 * included, and the connection is never tried first again: its busy timeout can stay 0.
 */
function attemptOnce<T>(database: DatabaseSync, timeoutMs: number, attempt: () => T): Attempt<T> | undefined {
	if (registry.untried.has(database)) return undefined;
	let zero = false;
	try {
		setBusyTimeout(database, 0);
		zero = readBusyTimeout(database) === 0;
	} catch {
		// Refused: the timeout is unchanged.
	}
	if (!zero) {
		registry.untried.add(database);
		timeoutRestored(database, timeoutMs);
		return undefined;
	}
	let outcome: Attempt<T>;
	try {
		outcome = { kind: "done", value: attempt() };
	} catch (error) {
		outcome = plainBusy(error) ? { kind: "busy", error } : { kind: "failed", error };
	}
	if (!timeoutRestored(database, timeoutMs)) {
		registry.untried.add(database);
		if (outcome.kind === "busy") return { kind: "failed", error: outcome.error };
	}
	return outcome;
}

/** Gives `database` back its busy timeout after a try, trying twice; whether it took it, as read back. */
function timeoutRestored(database: DatabaseSync, timeoutMs: number): boolean {
	for (let tries = 0; tries < 2; tries++) {
		try {
			setBusyTimeout(database, timeoutMs);
			if (readBusyTimeout(database) === timeoutMs) return true;
		} catch {
			// Tried again once, then given up.
		}
	}
	return false;
}

/** The busy timeout of `database` as it reads it now; undefined when it cannot be read. */
function readBusyTimeout(database: DatabaseSync): number | undefined {
	try {
		const timeout = Number(database.prepare("PRAGMA busy_timeout").get()?.timeout);
		return Number.isFinite(timeout) ? timeout : undefined;
	} catch {
		return undefined;
	}
}

/** Sets the connection's busy timeout: a setting of the connection, which touches no file. */
function setBusyTimeout(database: DatabaseSync, timeoutMs: number): void {
	database.exec(`PRAGMA busy_timeout=${timeoutMs}`);
}

/**
 * Runs a single statement, `attempt` (synchronous on `database`, the connection `owner` owns), the way SQLite's busy
 * handler would, without holding this thread: once at once with a busy timeout of 0; refused the lock, it waits off
 * this thread and is tried again once a threaded transaction gives the lock back, or on a short poll for a lock another
 * process holds, oldest first and one call per turn of the event loop; still refused at the end of the connection's
 * busy timeout, it fails with that SQLITE_BUSY. Calls already waiting go first. When the busy timeout cannot be read,
 * `asBefore` runs it as it always has.
 */
export function runTryingFirst<T>(
	file: string,
	gate: FileGate,
	owner: object,
	database: DatabaseSync,
	attempt: () => T,
	asBefore: () => Promise<T>,
	busy: () => Error,
): Promise<T> {
	const timeoutMs = busyTimeoutOf(gate, owner, database);
	if (timeoutMs === undefined) return asBefore();
	runNextWaiter(file, gate);
	let refusal: unknown;
	if (gate.waiters.length === 0 && !gate.paced) {
		const first = attemptOnce(database, timeoutMs, attempt);
		if (first === undefined) return asBefore();
		if (first.kind !== "busy") {
			ranThisTurn(file, gate);
			return first.kind === "done" ? Promise.resolve(first.value) : Promise.reject(first.error);
		}
		refusal = first.error;
	}
	return new Promise<T>((resolve, reject) => {
		const waiter = undecidedWaiter(database);
		gate.waiters.push(waiter);
		armTry(file, gate, waiter, database, timeoutMs, attempt, asBefore, refusal, resolve, reject, busy);
	});
}

/**
 * Makes `waiter` try `attempt` again on each wake until its deadline, `timeoutMs` from now, for `runTryingFirst`;
 * `refusal` is the SQLITE_BUSY of its last try, if any.
 */
function armTry<T>(
	file: string,
	gate: FileGate,
	waiter: Waiter,
	database: DatabaseSync,
	timeoutMs: number,
	attempt: () => T,
	asBefore: () => Promise<T>,
	refusal: unknown,
	resolve: (value: T | PromiseLike<T>) => void,
	reject: (error: unknown) => void,
	busy: () => Error,
): void {
	let lastRefusal = refusal;
	// A try the connection does not allow runs the call as before (see `attemptOnce`).
	const settle = (outcome: Attempt<T> | undefined): boolean => {
		if (outcome === undefined) {
			resolve(asBefore());
			return true;
		}
		if (outcome.kind === "busy") {
			lastRefusal = outcome.error;
			return false;
		}
		if (outcome.kind === "done") resolve(outcome.value);
		else reject(outcome.error);
		return true;
	};
	waiter.deadline = performance.now() + timeoutMs;
	// At its deadline it is tried once more if it is the oldest; refused, or behind others while the lock is taken, it
	// fails with the refusal. Behind others while the lock is free, it keeps its place.
	waiter.timer = setTimeout(
		() =>
			setImmediate(() => {
				const index = gate.waiters.indexOf(waiter);
				if (index === -1) return;
				if (index === 0 && settle(attemptOnce(database, timeoutMs, attempt))) {
					gate.waiters.shift();
					ranThisTurn(file, gate);
				} else if (index === 0 || wordTaken(file)) {
					gate.waiters.splice(index, 1);
					waiter.fail();
					ranThisTurn(file, gate);
				}
				forgetIfIdle(file, gate);
			}),
		timeoutMs,
	);
	waiter.tryRun = () => settle(attemptOnce(database, timeoutMs, attempt));
	// Refused at its last try, it fails with that refusal; never tried, with SQLITE_BUSY as the runtime reports it.
	waiter.fail = () => reject(lastRefusal ?? busy());
	const state = registry.words.get(file)?.state;
	if (state !== undefined) watchWord(file, gate, state);
	pollWaiters(file, gate);
}

/** Whether a call on `database` waits for its turn. */
export function connectionWaits(gate: FileGate, database: DatabaseSync): boolean {
	return gate.waiters.some((waiter) => waiter.connection === database);
}

/**
 * Runs a call on `database`, which `owner` owns, behind an earlier call on the same connection that waits, from this
 * or another wrapped handle, so no call runs on a connection between a refused try of an earlier call and the try that
 * follows, as none could while SQLite's busy handler waited. It is decided (see `modeOf`) only at its turn,
 * since listing the plan of an INSERT, UPDATE or DELETE resets the connection's `changes()`, which a call before it
 * could read; then it runs as `runTryingFirst` or `runWhenFree` would, or as before, with `call`. Once no threaded
 * transaction holds the file, it runs as before.
 */
export function runDeferred<T>(
	file: string,
	gate: FileGate,
	owner: object,
	database: DatabaseSync,
	statement: { readonly sql: string; readonly params: readonly SQLInputValue[]; readonly single: boolean },
	attempt: () => T,
	call: () => Promise<T>,
	busy: () => Error,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const waiter = undecidedWaiter(database);
		waiter.tryRun = () => {
			const mode = scopedHoldOpen(gate)
				? modeOf(gate, owner, database, statement.sql, statement.params, statement.single)
				: "as before";
			const state = registry.words.get(file)?.state;
			const timeoutMs = mode === "as before" ? undefined : busyTimeoutOf(gate, owner, database);
			if (timeoutMs === undefined || (mode === "script" && state === undefined)) {
				resolve(call());
				return true;
			}
			if (mode === "script") {
				const ran = runAdmitted(state!, call);
				if (ran !== undefined) {
					resolve(ran);
					return true;
				}
				armWhenFree(file, gate, waiter, state!, timeoutMs, call, resolve, reject, busy);
				return false;
			}
			const first = attemptOnce(database, timeoutMs, attempt);
			if (first === undefined) resolve(call());
			else if (first.kind === "done") resolve(first.value);
			else if (first.kind === "failed") reject(first.error);
			else {
				armTry(file, gate, waiter, database, timeoutMs, attempt, call, first.error, resolve, reject, busy);
				return false;
			}
			return true;
		};
		gate.waiters.push(waiter);
	});
}

/** Whether a threaded transaction of this thread takes or holds the file's lock now, as its word says. */
function wordTaken(file: string): boolean {
	const state = registry.words.get(file)?.state;
	return state !== undefined && Atomics.load(state, 0) !== FREE;
}

/** How often calls refused a lock that no transaction of this thread holds (another process's) are tried again. */
const POLL_MS = 20;

/**
 * Tries the oldest waiting call again every `POLL_MS` while calls wait, for locks no word announces. While the word is
 * taken, the watch on it (`watchWord`) wakes the calls instead.
 */
function pollWaiters(file: string, gate: FileGate): void {
	if (gate.polling || gate.waiters.length === 0) return;
	gate.polling = true;
	setTimeout(() => {
		gate.polling = false;
		if (!wordTaken(file)) runNextWaiter(file, gate);
		forgetIfIdle(file, gate);
		pollWaiters(file, gate);
	}, POLL_MS);
}

/**
 * The statements of an `exec` text, split as SQLite reads them: past quoted strings and names (`'…'`, `"…"`, `` `…` ``,
 * `[…]`) and comments, with a trigger's body (`CREATE TRIGGER … BEGIN … END`) kept in its statement. Empty statements
 * are dropped. A comment left open runs to the end of the text; past a quote left open, or in a trigger's body without
 * its END, the rest of the text is one statement, which SQLite fails.
 */
export function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let start = 0;
	let words: string[] = [];
	let lastWord = "";
	let tokens = false;
	const trigger = () =>
		words[0] === "CREATE" &&
		(words[1] === "TRIGGER" || ((words[1] === "TEMP" || words[1] === "TEMPORARY") && words[2] === "TRIGGER"));
	for (let index = 0; index < sql.length; ) {
		const char = sql[index]!;
		if (char === "'" || char === '"' || char === "`" || char === "[") {
			const close = char === "[" ? "]" : char;
			let end = sql.indexOf(close, index + 1);
			// A doubled quote stands for the quote itself, except in a bracketed name.
			while (end !== -1 && close !== "]" && sql[end + 1] === close) end = sql.indexOf(close, end + 2);
			tokens = true;
			// Unterminated: SQLite fails the statement there, after the ones before it ran.
			if (end === -1) break;
			index = end + 1;
			lastWord = "";
		} else if (char === "-" && sql[index + 1] === "-") {
			const end = sql.indexOf("\n", index + 2);
			index = end === -1 ? sql.length : end + 1;
		} else if (char === "/" && sql[index + 1] === "*") {
			// Unterminated, the comment runs to the end of the text.
			const end = sql.indexOf("*/", index + 2);
			index = end === -1 ? sql.length : end + 2;
		} else if (char === ";") {
			index += 1;
			// Inside a trigger's body, only the semicolon after its END ends the statement.
			if (trigger() && lastWord !== "END") continue;
			if (tokens) statements.push(sql.slice(start, index - 1));
			start = index;
			words = [];
			lastWord = "";
			tokens = false;
		} else if (/[A-Za-z_]/.test(char)) {
			let end = index + 1;
			while (end < sql.length && /[\w$]/.test(sql[end]!)) end += 1;
			const word = sql.slice(index, end).toUpperCase();
			if (words.length < 3) words.push(word);
			lastWord = word;
			tokens = true;
			index = end;
		} else {
			if (!/\s/.test(char)) {
				tokens = true;
				lastWord = "";
			}
			index += 1;
		}
	}
	// Past an unterminated quote, or in a trigger's body without its END, SQLite fails the rest as one statement.
	if (tokens) statements.push(sql.slice(start));
	return statements;
}

/**
 * The steps of the plan of `sql`, listed now from the plan kept for it (SQLite prepares a kept plan again when this
 * connection changed its schema since, and fails it if the statement no longer prepares), or from a new one; undefined
 * when SQLite cannot make one. The plan is bound to the call's `params` first, so parameters the statement cannot
 * bind fail before the plan is listed, which resets `changes()` (see `modeOf`), as the statement fails before it runs.
 */
function planSteps(
	gate: FileGate,
	owner: object,
	database: DatabaseSync,
	sql: string,
	params: readonly SQLInputValue[],
): ReturnType<StatementSync["all"]> | undefined {
	const plans = plansOf(gate, owner);
	const kept = plans.explained.get(sql);
	if (kept !== undefined) {
		try {
			return kept.all(...params);
		} catch {
			plans.explained.delete(sql);
		}
	}
	try {
		const explained = database.prepare(`EXPLAIN ${sql}`);
		const steps = explained.all(...params);
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
