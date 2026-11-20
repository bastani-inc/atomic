import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * A connection on a thread of its own taking or holding a file's write lock: open from the moment it sends
 * `BEGIN IMMEDIATE` until it learns that the attempt was refused or failed, or until its transaction let go of the
 * lock. While one is open, a statement a connection on the calling thread (`wrapNodeSqliteDatabase`) runs on the same
 * file could wait for that lock in SQLite's busy handler, which holds the calling thread, while the transaction needs
 * that thread to go on: it waits off the thread instead (see `waitForHolds`).
 *
 * `phase` is what this thread knows of the lock: `taking` until the answer to `BEGIN IMMEDIATE` arrives, `held` from
 * then until `COMMIT` or `ROLLBACK` is sent, `letting go` until its answer arrives. Only while `held` is the lock
 * known to be taken; in the other phases it may already, or still, be free.
 */
export interface FileHold {
	readonly file: string;
	open: boolean;
	phase: "taking" | "held" | "letting go";
}

/** The holds whose transaction callbacks an asynchronous context runs in, innermost first. */
export interface HoldScope {
	readonly hold: FileHold;
	readonly outer: HoldScope | undefined;
}

interface Waiter {
	readonly deadline: number;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly run: () => void;
	readonly fail: () => void;
}

/** Statements a calling-thread connection prepared to classify its calls while the file is held; see `planOf`. */
interface Plans {
	readonly explained: Map<string, StatementSync>;
	schemaVersion?: StatementSync;
	busyTimeout?: StatementSync;
}

/**
 * One file's open holds, the calls waiting for them to close, and what those calls' connections prepared meanwhile,
 * by the object that owns each connection (not the connection, which its own statements keep alive), so they are
 * kept no longer than it is.
 */
export interface FileGate {
	readonly holds: Set<FileHold>;
	readonly waiters: Waiter[];
	readonly plans: WeakMap<object, Plans>;
}

interface Registry {
	readonly files: Map<string, FileGate>;
	readonly scopes: AsyncLocalStorage<HoldScope | undefined>;
}

// Shared across module copies, as the transaction gates are: a copy that runs a transaction's callback and a copy whose
// wrapped connection is called from it must see the same holds and the same asynchronous context.
const REGISTRY = Symbol.for("atomic-storage/node-sqlite-file-holds@1");
const registryBag = globalThis as typeof globalThis & Record<symbol, Registry | undefined>;
const registry: Registry = registryBag[REGISTRY] ?? { files: new Map(), scopes: new AsyncLocalStorage() };
registryBag[REGISTRY] = registry;

/** Opens a hold on `file`, identified as `fileIdentity` identifies it. */
export function holdFile(file: string): FileHold {
	let gate = registry.files.get(file);
	if (gate === undefined) {
		gate = { holds: new Set(), waiters: [], plans: new WeakMap() };
		registry.files.set(file, gate);
	}
	const hold: FileHold = { file, open: true, phase: "taking" };
	gate.holds.add(hold);
	return hold;
}

/** The hold's `BEGIN IMMEDIATE` took the lock: calls past their deadline fail now, as the lock is taken. */
export function holdTaken(hold: FileHold | undefined): void {
	if (hold === undefined || !hold.open) return;
	hold.phase = "held";
	failOverdue(hold.file);
}

/** The hold's transaction sends `COMMIT` or `ROLLBACK`: calls whose deadline passed while it held the lock fail now. */
export function holdLettingGo(hold: FileHold | undefined): void {
	if (hold === undefined || !hold.open || hold.phase !== "held") return;
	failOverdue(hold.file);
	hold.phase = "letting go";
}

/**
 * Fails, with SQLITE_BUSY, the file's calls whose deadline has passed by now, once the event loop handled what it
 * already received: a call that a thread's exit, already reported, let run in the meantime has run.
 */
function failOverdue(file: string): void {
	const gate = registry.files.get(file);
	if (gate === undefined) return;
	const now = performance.now();
	const overdue = gate.waiters.filter((waiting) => now >= waiting.deadline);
	if (overdue.length === 0) return;
	setImmediate(() => {
		for (const waiter of overdue) {
			const index = gate.waiters.indexOf(waiter);
			if (index === -1) continue;
			gate.waiters.splice(index, 1);
			clearTimeout(waiter.timer);
			waiter.fail();
		}
		forgetIfIdle(file, gate);
	});
}

/**
 * Closes `hold`, once. When it was the file's last, the calls waiting for the file run now, oldest first, before
 * anything else can take the lock again. A call whose deadline passed while the lock was known to be taken has
 * already failed (see `holdLettingGo`); one whose deadline passed while it may have been free runs, as SQLite's busy
 * handler would then have found it free. A call that opens another hold stops the rest, which wait for it in turn.
 */
export function releaseHold(hold: FileHold | undefined): void {
	if (hold === undefined || !hold.open) return;
	holdLettingGo(hold);
	hold.open = false;
	const gate = registry.files.get(hold.file);
	if (gate === undefined) return;
	gate.holds.delete(hold);
	while (gate.holds.size === 0 && gate.waiters.length > 0) {
		const waiter = gate.waiters.shift()!;
		clearTimeout(waiter.timer);
		waiter.run();
	}
	forgetIfIdle(hold.file, gate);
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

/** Whether a hold of the gate's file is known to have its write lock (see `FileHold`). */
export function lockTaken(gate: FileGate): boolean {
	for (const hold of gate.holds) if (hold.phase === "held") return true;
	return false;
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
 * Runs `run` once the file's last hold closes, or fails it with `busy()`, without running it, when `timeoutMs` passes
 * while a hold has the lock. Past its deadline while every hold is taking or letting go the lock, it waits for that to
 * resolve: a hold that takes the lock fails it then, one that closes lets it run. Nothing of it runs while it waits.
 */
export function waitForHolds<T>(
	file: string,
	gate: FileGate,
	timeoutMs: number,
	run: () => Promise<T>,
	busy: () => Error,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const waiter: Waiter = {
			deadline: performance.now() + timeoutMs,
			// Decided once the event loop handled what it already received, such as the answer to a COMMIT or the exit
			// of a connection's thread, which a timer runs ahead of.
			timer: setTimeout(
				() =>
					setImmediate(() => {
						const index = gate.waiters.indexOf(waiter);
						if (index === -1 || !lockTaken(gate)) return;
						gate.waiters.splice(index, 1);
						forgetIfIdle(file, gate);
						reject(busy());
					}),
				timeoutMs,
			),
			run: () => resolve(run()),
			fail: () => reject(busy()),
		};
		gate.waiters.push(waiter);
	});
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
export function busyTimeoutOf(gate: FileGate, owner: object, database: DatabaseSync): number | undefined {
	const plans = plansOf(gate, owner);
	try {
		plans.busyTimeout ??= database.prepare("PRAGMA busy_timeout");
		const timeout = Number(plans.busyTimeout.get()?.timeout);
		return Number.isFinite(timeout) && timeout >= 0 ? timeout : undefined;
	} catch {
		return undefined;
	}
}

/** A statement that starts as a read, or as one of the writes whose plan `planOf` reads; no other is prepared. */
const READ_STATEMENT = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:SELECT|VALUES|WITH)\b/i;
const WRITE_STATEMENT = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i;
/** Steps that run code of the application's or of an extension, or a trigger: functions, aggregates, virtual tables. */
const CALLS_CODE = /^(?:Function|PureFunc|Agg[A-Z]\w*|V[A-Z]\w*|Program)$/;

/**
 * What one statement does, proven from the plan SQLite makes for it on `database`, never by running it: `reads` when
 * it only reads, so it never waits for the write lock in WAL mode, which both kinds of connection put the file in;
 * `writes` when it takes the file's write lock before anything else and calls no function, virtual table or trigger;
 * `not proven` otherwise. Either proof needs a plan that calls no function, virtual table or trigger (whose code could
 * wait for a lock or write), uses no attached database, and was made for the schema the file has now. A collating
 * sequence an extension registered still runs: it compares values and is not told apart. `writes` is only asked for
 * when `forWrite`.
 *
 * The plan of a text is prepared once while the file is held and run again for later calls: SQLite makes it again when
 * this connection changed its schema since. A kept plan made for an older schema of the file is made afresh, so the
 * answer is always the one a fresh plan gives.
 */
export function planOf(
	gate: FileGate,
	owner: object,
	database: DatabaseSync,
	sql: string,
	forWrite: boolean,
): "reads" | "writes" | "not proven" {
	if (!READ_STATEMENT.test(sql) && !(forWrite && WRITE_STATEMENT.test(sql))) return "not proven";
	const plans = plansOf(gate, owner);
	const kept = plans.explained.has(sql);
	let verdict = planVerdict(plans, database, sql);
	if (verdict === "older schema" && kept) verdict = planVerdict(plans, database, sql);
	return verdict === "older schema" ? "not proven" : verdict;
}

function planVerdict(
	plans: Plans,
	database: DatabaseSync,
	sql: string,
): "reads" | "writes" | "older schema" | "not proven" {
	try {
		let explained = plans.explained.get(sql);
		if (explained === undefined) {
			explained = database.prepare(`EXPLAIN ${sql}`);
			if (plans.explained.size >= MAX_PLANS) plans.explained.delete(plans.explained.keys().next().value!);
			plans.explained.set(sql, explained);
		}
		let fileSchema: number | undefined;
		let writes = false;
		for (const step of explained.all()) {
			const opcode = String(step.opcode);
			if (CALLS_CODE.test(opcode)) return "not proven";
			if (opcode === "OpenWrite") writes = true;
			if (opcode !== "Transaction") continue;
			// p1: the database (0 the file, 1 temp), p2: a write transaction, p3: the schema version it was made for,
			// p5: whether it checks that version.
			const schema = Number(step.p1);
			if (schema > 1 || (schema === 0 && Number(step.p5) === 0)) return "not proven";
			if (Number(step.p2) !== 0) {
				// Only a write of the file itself takes its lock first; one of temp alone does not wait for it.
				if (schema !== 0) return "not proven";
				writes = true;
			}
			if (schema === 1) continue;
			plans.schemaVersion ??= database.prepare("PRAGMA schema_version");
			fileSchema ??= Number(plans.schemaVersion.get()?.schema_version);
			if (Number(step.p3) !== fileSchema) {
				plans.explained.delete(sql);
				return "older schema";
			}
		}
		return writes ? "writes" : "reads";
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
