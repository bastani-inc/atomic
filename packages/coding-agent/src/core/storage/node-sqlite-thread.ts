import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { SqliteRow, SqliteValue } from "./database.js";
import { sqliteDialect } from "./dialect.js";

/**
 * A node:sqlite connection that runs on a worker thread of its own (#5376). The thread owns the `DatabaseSync`; the
 * calling thread sends it requests, which it runs one at a time in the order they arrived, and receives each answer as
 * a message, so no statement, lock wait or synced commit ever runs on the caller's event loop. SQLite's busy handler waits on the connection's own thread, so
 * a statement waiting for a lock another connection of the same process holds never stops that connection from
 * finishing: each connection gets a thread, and no two connections share one.
 */

/** How many prepared statements a connection keeps for reuse; the least recently used beyond it are finalized. */
const STATEMENT_CACHE_SIZE = 128;

const CONNECTION_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const BOOTED = -1;
process.emitWarning = () => {};
if (workerData.nativeBinding !== undefined) {
	try {
		require(workerData.nativeBinding).raiseCurrentThreadPriority();
	} catch {}
}
let DatabaseSync;
try {
	({ DatabaseSync } = require("node:sqlite"));
	parentPort.postMessage({ id: BOOTED });
} catch (error) {
	parentPort.postMessage({ id: BOOTED, failure: failure(error), load: true });
}
const STATEMENT_CACHE_SIZE = workerData.statementCacheSize;
let database;
// Requests sent in this epoch or an earlier one are refused, running nothing: a transaction sent before them found
// the write lock busy, and they must not run ahead of it.
let refusedEpoch = 0;

function failure(error) {
	return {
		name: typeof error?.name === "string" ? error.name : "Error",
		message: String(error?.message ?? error),
		code: typeof error?.code === "string" ? error.code : undefined,
		errcode: typeof error?.errcode === "number" ? error.errcode : undefined,
		errstr: typeof error?.errstr === "string" ? error.errstr : undefined,
	};
}

const prepared = new Map();

function statement(sql) {
	let cached = prepared.get(sql);
	if (cached === undefined) {
		cached = database.prepare(sql);
		cached.setReadBigInts(true);
		if (prepared.size >= STATEMENT_CACHE_SIZE) prepared.delete(prepared.keys().next().value);
	} else {
		prepared.delete(sql);
	}
	prepared.set(sql, cached);
	return cached;
}

// Node 22 binds an empty Uint8Array that arrived in a message as NULL; a new empty one binds as a zero-length blob.
function bind(params) {
	return params.map((value) => (value instanceof Uint8Array && value.byteLength === 0 ? new Uint8Array(0) : value));
}

function integer(value) {
	return typeof value === "bigint" && value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

// Rows cross as their column names and one array of values each: cheaper to copy than an object per row, whose
// field names would be copied with every row. A row's own fields come in column order, a later column of a name it
// repeats replacing an earlier one, as the driver gives them.
function table(rows) {
	if (rows.length === 0) return { columns: [], values: [] };
	const columns = Object.keys(rows[0]);
	return { columns, values: rows.map((row) => columns.map((column) => integer(row[column]))) };
}

function rows(statements) {
	return statements.map((each) => table(statement(each.sql).all(...bind(each.params))));
}

function begin() {
	const configured = Number(database.prepare("PRAGMA busy_timeout").get()?.timeout ?? 0);
	database.exec("PRAGMA busy_timeout=0");
	let began = false;
	try {
		database.exec("BEGIN IMMEDIATE");
		began = true;
	} finally {
		try {
			database.exec("PRAGMA busy_timeout=" + configured);
		} catch (restoreFailure) {
			if (began) database.exec("ROLLBACK");
			throw restoreFailure;
		}
	}
}

function refuseAfter(request) {
	if (request.epoch !== undefined) refusedEpoch = Math.max(refusedEpoch, request.epoch);
}

const handlers = {
	exec: (request) => { database.exec(request.sql); },
	run: (request) => ({ changes: Number(statement(request.sql).run(...bind(request.params)).changes) }),
	get: (request) => {
		const row = statement(request.sql).get(...bind(request.params));
		return row === undefined ? undefined : table([row]);
	},
	all: (request) => table(statement(request.sql).all(...bind(request.params))),
	begin: () => { begin(); },
	statements: (request) => rows(request.statements),
	read: (request) => {
		// One snapshot, and no write: a deferred transaction that is only allowed to read never takes the write lock.
		database.exec("PRAGMA query_only=1");
		try {
			database.exec("BEGIN");
			try {
				const result = rows(request.statements);
				database.exec("COMMIT");
				return result;
			} catch (error) {
				try { database.exec("ROLLBACK"); } catch {}
				throw error;
			}
		} finally {
			database.exec("PRAGMA query_only=0");
		}
	},
	transaction: (request) => {
		if (request.begin) {
			try {
				begin();
			} catch (error) {
				if (((error?.errcode ?? 0) & 0xff) === 5) {
					refuseAfter(request);
					return { busy: failure(error) };
				}
				throw error;
			}
		}
		const outcomes = [];
		for (let index = 0; index < request.members.length; index++) {
			const savepoint = "atomic_group_" + index;
			try {
				database.exec("SAVEPOINT " + savepoint);
			} catch (error) {
				// Nothing of the group can run: a lock this request took is let go, and the caller hears why.
				if (request.begin) {
					try {
						database.exec("ROLLBACK");
					} catch {}
				}
				throw error;
			}
			try {
				const ran = rows(request.members[index]);
				// A member ran only once its savepoint was released: a release that fails is that member's failure.
				database.exec("RELEASE " + savepoint);
				outcomes.push({ rows: ran });
			} catch (error) {
				try {
					database.exec("ROLLBACK TO " + savepoint);
					database.exec("RELEASE " + savepoint);
				} catch (rollbackError) {
					// A lock this request took is let go, and nothing sent behind it runs before its other members ran again.
					if (request.begin) {
						try {
							database.exec("ROLLBACK");
						} catch {}
						refuseAfter(request);
					}
					return { outcomes, abandoned: { failure: failure(error), rollbackFailure: failure(rollbackError) } };
				}
				outcomes.push({ failure: failure(error) });
			}
		}
		try {
			database.exec("COMMIT");
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {}
			return { outcomes, commitFailure: failure(error) };
		}
		return { outcomes };
	},
	dataVersion: () => Number(database.prepare("PRAGMA data_version").get()?.data_version ?? 0),
	now: () => Number(database.prepare(workerData.nowSql).get().now),
	close: () => {
		prepared.clear();
		database.close();
		globalThis.Bun?.gc?.(true);
	},
};

// Started ahead of need, the thread opens its database when asked; nothing else comes before that.
function open(request) {
	try {
		database = new DatabaseSync(request.path, { readOnly: request.readOnly });
		parentPort.postMessage({ id: 0, value: { location: database.location() } });
	} catch (error) {
		try { database?.close(); } catch {}
		parentPort.postMessage({ id: 0, failure: failure(error) });
	}
}

parentPort.on("message", (request) => {
	if (request.kind === "open") {
		open(request);
		return;
	}
	if (request.epoch !== undefined && request.epoch <= refusedEpoch) {
		parentPort.postMessage({ id: request.id, refused: true });
		return;
	}
	try {
		parentPort.postMessage({ id: request.id, value: handlers[request.kind](request) });
	} catch (error) {
		parentPort.postMessage({ id: request.id, failure: failure(error) });
	}
});
`;

/**
 * What a connection thread is asked to do. `statements` runs statements in order and answers each one's rows; `read`
 * does so for read-only statements against one snapshot, in a deferred transaction that may not write.
 * `transaction` commits a group of members as one request: with `begin`, it first takes the write lock as `begin`
 * does, and answers `busy` with nothing run when the lock was busy; without it, the caller holds the lock already.
 * Each member runs in a savepoint of its own: a member whose statement fails is rolled back alone and answers its
 * failure, and the others commit together. A failed commit is rolled back and answered with the members' outcomes, so
 * every member fails with it. A savepoint that cannot be rolled back stops the group: the answer names the members
 * that ran, and the caller rolls the transaction back.
 *
 * `epoch` lets a caller send requests without waiting for the answers before them: once a `transaction` with `begin`
 * is answered `busy`, or stopped by a savepoint that could not be rolled back (it then rolls back itself), the thread
 * refuses every request of its epoch or an earlier one, running nothing, and the caller sends them again in a later
 * epoch, once the transaction committed. A request without an epoch is never refused.
 */
export type ConnectionRequest = ConnectionCall & { readonly epoch?: number };

type ConnectionCall =
	| { readonly kind: "exec"; readonly sql: string }
	| { readonly kind: "run" | "get" | "all"; readonly sql: string; readonly params: readonly SqliteValue[] }
	| { readonly kind: "statements" | "read"; readonly statements: readonly ConnectionStatement[] }
	| {
			readonly kind: "transaction";
			readonly members: readonly (readonly ConnectionStatement[])[];
			readonly begin: boolean;
	  }
	| { readonly kind: "begin" | "dataVersion" | "now" | "close" };

export interface ConnectionStatement {
	readonly sql: string;
	readonly params: readonly SqliteValue[];
}

/** One member's outcome in a `transaction` request: each statement's rows, or the failure it was rolled back for. */
export type ConnectionMemberOutcome = { readonly rows: SqliteRow[][] } | { readonly failure: ConnectionFailure };

/**
 * A `transaction` request's answer: the busy lock that ran nothing; or the outcome of each member that ran, with the
 * commit's failure when the commit failed, or the failure whose savepoint could not be rolled back when the group
 * stopped there (the members after it did not run).
 */
export type ConnectionTransactionValue =
	| { readonly busy: ConnectionFailure }
	| {
			readonly outcomes: readonly ConnectionMemberOutcome[];
			readonly commitFailure?: ConnectionFailure;
			readonly abandoned?: { readonly failure: ConnectionFailure; readonly rollbackFailure: ConnectionFailure };
	  };

export type ConnectionValue =
	| { readonly changes: number }
	| SqliteRow
	| SqliteRow[]
	| SqliteRow[][]
	| ConnectionTransactionValue
	| number
	| undefined;

/** A failure as it crosses from the connection thread: the driver's error fields, kept for callers that read them. */
export interface ConnectionFailure {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly errcode?: number;
	readonly errstr?: string;
}

interface ConnectionReply {
	readonly id: number;
	readonly value?: ConnectionValue | { readonly location: string | null };
	readonly failure?: ConnectionFailure;
	readonly load?: boolean;
	readonly refused?: boolean;
}

/** A request the thread refused, running nothing, because one sent before it in its epoch found the lock busy. */
export class ConnectionRefusedError extends Error {
	constructor() {
		super("The SQLite connection refused a request sent behind a transaction that found the write lock busy");
		this.name = "ConnectionRefusedError";
	}
}

/** The driver's error, rebuilt with the fields callers read (`errcode` for SQLITE_BUSY, `code`, `errstr`). */
export function connectionFailure(failure: ConnectionFailure): Error {
	const cause = new Error(failure.message);
	cause.name = failure.name;
	return Object.assign(cause, {
		...(failure.code === undefined ? {} : { code: failure.code }),
		...(failure.errcode === undefined ? {} : { errcode: failure.errcode }),
		...(failure.errstr === undefined ? {} : { errstr: failure.errstr }),
	});
}

interface Waiter<V> {
	readonly resolve: (value: V) => void;
	readonly reject: (error: unknown) => void;
}

/**
 * The bookkeeping between a connection and its thread: which requests await an answer. Every request settles exactly
 * once: by its answer, or, when the thread is lost or the ledger has ended, by rejection. An answer for a request that
 * already settled is ignored. Once the ledger ends, every request still waiting is rejected in the order it was sent,
 * and every later one is rejected at once without being sent.
 */
export class RequestLedger<V> {
	private next = 1;
	private readonly waiting = new Map<number, Waiter<V>>();
	private ended?: { readonly cause: unknown };

	/** Requests sent and not answered yet. */
	get size(): number {
		return this.waiting.size;
	}

	/** The id to send a new request under, or the cause it is rejected with once the ledger has ended. */
	open(waiter: Waiter<V>): number | { readonly rejected: unknown } {
		if (this.ended !== undefined) {
			waiter.reject(this.ended.cause);
			return { rejected: this.ended.cause };
		}
		const id = this.next++;
		this.waiting.set(id, waiter);
		return id;
	}

	/** Settles the request `id` with its answer; returns false for one that already settled. */
	answer(
		id: number,
		outcome: { readonly ok: true; readonly value: V } | { readonly ok: false; readonly error: unknown },
	): boolean {
		const waiter = this.waiting.get(id);
		if (waiter === undefined) return false;
		this.waiting.delete(id);
		if (outcome.ok) waiter.resolve(outcome.value);
		else waiter.reject(outcome.error);
		return true;
	}

	/** Withdraws the request `id` before it was sent (it could not be posted), rejecting it with `error`. */
	withdraw(id: number, error: unknown): void {
		this.answer(id, { ok: false, error });
	}

	/** Ends the ledger: rejects every waiting request, oldest first, and every later one. Ending again does nothing. */
	end(cause: unknown): void {
		if (this.ended !== undefined) return;
		// Kept for as long as the connection is: an error's stack, until formatted, keeps the functions of the frames it
		// names, and so whatever they hold, such as a session that closed its store and ended.
		if (cause instanceof Error) void cause.stack;
		this.ended = { cause };
		const waiting = [...this.waiting.values()];
		this.waiting.clear();
		for (const waiter of waiting) waiter.reject(cause);
	}
}

export interface ThreadConnectionOptions {
	readonly readOnly: boolean;
	/** The form SQLite opens the path by, when it differs from the path (the long-path form on Windows). */
	readonly openAs?: string;
}

/** Thrown when node:sqlite cannot be loaded on the connection thread: Node before 22.13, Bun before 1.4.2. */
export class ConnectionLoadError extends Error {
	readonly driverCause: Error;
	constructor(cause: Error) {
		super(cause.message);
		this.name = "ConnectionLoadError";
		this.driverCause = cause;
	}
}

let nativeBinding: string | null | undefined;

/**
 * Where the native binding loads from, for a connection thread on Windows to raise its own priority with. Woken for
 * each request, a thread at normal priority waits behind every busy thread for a scheduler quantum once the CPUs are
 * oversubscribed, up to 190 ms a request on Windows Server; above normal it runs as soon as it is woken (#5376). The
 * binding is found as the storage adapter's open lock finds it: from this module, or beside the standalone binary.
 * Undefined on other platforms and when it cannot be found: the thread then runs at normal priority.
 */
function threadPriorityBinding(): string | undefined {
	if (process.platform !== "win32") return undefined;
	if (nativeBinding === undefined) {
		nativeBinding = null;
		for (const base of [import.meta.url, pathToFileURL(process.execPath).href]) {
			try {
				nativeBinding = createRequire(base).resolve("@bastani/atomic-natives");
				break;
			} catch {
				// Not found from here; the next base, or normal priority.
			}
		}
	}
	return nativeBinding ?? undefined;
}

/** Rows as they cross from a connection's thread: the column names, then each row's values in their order. */
interface RowTable {
	readonly columns: readonly string[];
	readonly values: readonly (readonly SqliteValue[])[];
}

/** The rows of `table`, one object each, every column an own field, a column named `__proto__` included. */
function rowsOf(table: RowTable): SqliteRow[] {
	const { columns, values } = table;
	if (columns.includes("__proto__"))
		return values.map((row) =>
			Object.fromEntries(columns.map((column, index) => [column, row[index] as SqliteValue])),
		);
	return values.map((row) => {
		const record: Record<string, SqliteValue> = {};
		for (let index = 0; index < columns.length; index++) record[columns[index]!] = row[index] as SqliteValue;
		return record;
	});
}

/** The id of the message a connection thread sends once it loaded node:sqlite, or failed to. */
const BOOTED = -1;

/** A connection thread started before it opened a database, and how its start ends. */
interface StartedThread {
	readonly worker: Worker;
	/** The thread's boot message; a failure when it could not load node:sqlite or was lost before it booted. */
	readonly booted: Promise<ConnectionReply>;
}

function startThread(): StartedThread {
	const worker = new Worker(CONNECTION_SOURCE, {
		eval: true,
		execArgv: [],
		workerData: {
			nowSql: `SELECT ${sqliteDialect.nowMs} AS now`,
			statementCacheSize: STATEMENT_CACHE_SIZE,
			nativeBinding: threadPriorityBinding(),
		},
	});
	const booted = new Promise<ConnectionReply>((resolve) => {
		const settle = (reply: ConnectionReply) => {
			worker.off("message", onMessage);
			worker.off("error", onError);
			worker.off("exit", onExit);
			resolve(reply);
		};
		const onMessage = (reply: ConnectionReply) => {
			if (reply.id === BOOTED) settle(reply);
		};
		const onError = (error: Error) => settle({ id: BOOTED, failure: { name: error.name, message: error.message } });
		const onExit = (code: number) =>
			settle({
				id: BOOTED,
				failure: { name: "Error", message: `SQLite connection thread exited with code ${code}` },
			});
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
	});
	return { worker, booted };
}

/**
 * A thread started ahead of the next open, so that open does not wait for a thread to start (#5376): starting one
 * takes about 20 ms on an idle machine and several times that on a busy one. There is at most one, it is started once a
 * connection opened, it does not keep the process alive, and it is stopped once no connection is open.
 */
let spare: StartedThread | undefined;
let openConnections = 0;

function takeThread(): StartedThread {
	const taken = spare;
	spare = undefined;
	return taken ?? startThread();
}

function startSpare(): void {
	if (spare !== undefined || openConnections === 0) return;
	spare = startThread();
	spare.worker.unref();
}

async function stopSpare(): Promise<void> {
	const stopping = spare;
	spare = undefined;
	await stopping?.worker.terminate();
}

/** A connection running on its own worker thread. */
export class ThreadConnection {
	/** The path the connection was opened with, as its caller gave it. */
	readonly path: string;
	private readonly worker: Worker;
	private readonly ledger = new RequestLedger<ConnectionValue>();
	private readonly opened: Promise<string | null>;
	private settleOpen?: (outcome: ConnectionReply) => void;
	private closing?: Promise<void>;
	private lost?: Error;
	/** Counted among the open connections, which keep the spare thread. */
	private counted = false;
	private released?: Promise<void>;

	private constructor(path: string, worker: Worker) {
		this.path = path;
		this.opened = new Promise((resolve, reject) => {
			this.settleOpen = (reply) => {
				this.settleOpen = undefined;
				if (reply.failure === undefined)
					resolve((reply.value as { readonly location: string | null } | undefined)?.location ?? null);
				else if (reply.load === true) reject(new ConnectionLoadError(connectionFailure(reply.failure)));
				else reject(connectionFailure(reply.failure));
			};
		});
		this.worker = worker;
		this.worker.on("message", (reply: ConnectionReply) => this.receive(reply));
		this.worker.on("error", (error: Error) => this.lose(error));
		this.worker.on("exit", (code: number) =>
			this.lose(new Error(`SQLite connection thread exited with code ${code}`)),
		);
	}

	/**
	 * Opens `path` on a thread of its own, the spare one when it is ready, and resolves with the location the connection
	 * reports. Rejects with `ConnectionLoadError` when node:sqlite is unavailable there, and with the driver's error when
	 * opening fails; the thread is gone either way.
	 */
	static async open(
		path: string,
		options: ThreadConnectionOptions,
	): Promise<{ connection: ThreadConnection; location: string | null }> {
		let thread = takeThread();
		let booted = await thread.booted;
		// A spare lost before it was needed is replaced; a thread that cannot load node:sqlite fails as any would.
		if (booted.failure !== undefined && booted.load !== true) {
			thread = startThread();
			booted = await thread.booted;
		}
		if (booted.failure !== undefined) {
			await thread.worker.terminate();
			throw booted.load === true
				? new ConnectionLoadError(connectionFailure(booted.failure))
				: connectionFailure(booted.failure);
		}
		const connection = new ThreadConnection(path, thread.worker);
		thread.worker.ref();
		thread.worker.postMessage({ kind: "open", path: options.openAs ?? path, readOnly: options.readOnly });
		let location: string | null;
		try {
			location = await connection.opened;
		} catch (error) {
			await thread.worker.terminate();
			throw error;
		}
		connection.counted = true;
		openConnections += 1;
		startSpare();
		return { connection, location };
	}

	/** No longer counted among the open connections; the last one to go stops the spare thread. Once. */
	private release(): Promise<void> {
		if (!this.counted) return Promise.resolve();
		this.released ??= (() => {
			openConnections -= 1;
			return openConnections === 0 ? stopSpare() : Promise.resolve();
		})();
		return this.released;
	}

	private receive(reply: ConnectionReply): void {
		if (reply.id === 0) {
			this.settleOpen?.(reply);
			if (this.ledger.size === 0) this.worker.unref();
			return;
		}
		this.ledger.answer(
			reply.id,
			reply.refused === true
				? { ok: false, error: new ConnectionRefusedError() }
				: reply.failure === undefined
					? { ok: true, value: reply.value as ConnectionValue }
					: { ok: false, error: connectionFailure(reply.failure) },
		);
		// An idle connection does not keep the process alive, as a connection on the calling thread would not.
		if (this.ledger.size === 0) this.worker.unref();
	}

	private lose(cause: Error): void {
		if (this.lost !== undefined) return;
		this.lost = cause;
		void this.release();
		this.settleOpen?.({ id: 0, failure: { name: cause.name, message: cause.message } });
		this.ledger.end(cause);
		this.worker.unref();
	}

	/** Sends one request; resolves with the thread's answer or rejects with the driver's error. */
	request(request: ConnectionRequest): Promise<ConnectionValue> {
		const answer = this.send(request);
		if (request.kind === "all") return answer.then((value) => rowsOf(value as RowTable));
		if (request.kind === "get")
			return answer.then((value) => (value === undefined ? undefined : rowsOf(value as RowTable)[0]));
		if (request.kind === "statements" || request.kind === "read")
			return answer.then((value) => (value as RowTable[]).map(rowsOf));
		if (request.kind === "transaction")
			return answer.then((value) => {
				type Answered =
					| { readonly busy: ConnectionFailure }
					| (Omit<Extract<ConnectionTransactionValue, { outcomes: unknown }>, "outcomes"> & {
							readonly outcomes: readonly (
								| { readonly rows: RowTable[] }
								| { readonly failure: ConnectionFailure }
							)[];
					  });
				const answered = value as Answered;
				if ("busy" in answered) return answered;
				return {
					...answered,
					outcomes: answered.outcomes.map((outcome) =>
						"rows" in outcome ? { rows: outcome.rows.map(rowsOf) } : outcome,
					),
				};
			});
		return answer as Promise<ConnectionValue>;
	}

	private send(request: ConnectionRequest): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			const id = this.ledger.open({ resolve, reject });
			if (typeof id !== "number") return;
			try {
				this.worker.postMessage({ id, ...request });
			} catch (error) {
				// A value the thread cannot receive, as the driver refuses one it cannot bind.
				this.ledger.withdraw(id, error);
				return;
			}
			if (this.ledger.size === 1) this.worker.ref();
		});
	}

	/**
	 * Closes the connection on its thread, then ends the thread. A thread already lost has nothing to close. Requests
	 * sent after this are rejected.
	 */
	close(): Promise<void> {
		this.closing ??= (async () => {
			try {
				if (this.lost === undefined) await this.request({ kind: "close" });
			} finally {
				this.ledger.end(new Error("SQLite connection closed"));
				await this.worker.terminate();
				await this.release();
			}
		})();
		return this.closing;
	}
}
