import { Worker } from "node:worker_threads";
import type { SqliteRow, SqliteValue } from "./database.js";
import { sqliteDialect } from "./dialect.js";

/**
 * A node:sqlite connection that runs on a worker thread of its own (#5376). The thread owns the `DatabaseSync`; the
 * calling thread sends it one request at a time and receives each answer as a message, so no statement, lock wait or
 * synced commit ever runs on the caller's event loop. SQLite's busy handler waits on the connection's own thread, so
 * a statement waiting for a lock another connection of the same process holds never stops that connection from
 * finishing: each connection gets a thread, and no two connections share one.
 */

/** How many prepared statements a connection keeps for reuse; the least recently used beyond it are finalized. */
const STATEMENT_CACHE_SIZE = 128;

const CONNECTION_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
process.emitWarning = () => {};
let DatabaseSync;
try {
	({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
	parentPort.postMessage({ id: 0, failure: failure(error), load: true });
}
const STATEMENT_CACHE_SIZE = workerData.statementCacheSize;
let database;

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

function normalize(row) {
	const out = {};
	for (const key of Object.keys(row)) {
		const value = row[key];
		out[key] = typeof value === "bigint" && value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
	}
	return out;
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

const handlers = {
	exec: (request) => { database.exec(request.sql); },
	run: (request) => ({ changes: Number(statement(request.sql).run(...request.params).changes) }),
	get: (request) => {
		const row = statement(request.sql).get(...request.params);
		return row === undefined ? undefined : normalize(row);
	},
	all: (request) => statement(request.sql).all(...request.params).map(normalize),
	begin: () => { begin(); },
	dataVersion: () => Number(database.prepare("PRAGMA data_version").get()?.data_version ?? 0),
	now: () => Number(database.prepare(workerData.nowSql).get().now),
	close: () => {
		prepared.clear();
		database.close();
		globalThis.Bun?.gc?.(true);
	},
};

if (DatabaseSync !== undefined) try {
	database = new DatabaseSync(workerData.path, { readOnly: workerData.readOnly });
	parentPort.postMessage({ id: 0, value: { location: database.location() } });
} catch (error) {
	try { database?.close(); } catch {}
	parentPort.postMessage({ id: 0, failure: failure(error) });
}

parentPort.on("message", (request) => {
	try {
		parentPort.postMessage({ id: request.id, value: handlers[request.kind](request) });
	} catch (error) {
		parentPort.postMessage({ id: request.id, failure: failure(error) });
	}
});
`;

/** What a connection thread is asked to do. */
export type ConnectionRequest =
	| { readonly kind: "exec"; readonly sql: string }
	| { readonly kind: "run" | "get" | "all"; readonly sql: string; readonly params: readonly SqliteValue[] }
	| { readonly kind: "begin" | "dataVersion" | "now" | "close" };

export type ConnectionValue = { readonly changes: number } | SqliteRow | SqliteRow[] | number | undefined;

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

	private constructor(path: string, options: ThreadConnectionOptions) {
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
		this.worker = new Worker(CONNECTION_SOURCE, {
			eval: true,
			execArgv: [],
			workerData: {
				path: options.openAs ?? path,
				readOnly: options.readOnly,
				nowSql: `SELECT ${sqliteDialect.nowMs} AS now`,
				statementCacheSize: STATEMENT_CACHE_SIZE,
			},
		});
		this.worker.on("message", (reply: ConnectionReply) => this.receive(reply));
		this.worker.on("error", (error: Error) => this.lose(error));
		this.worker.on("exit", (code: number) =>
			this.lose(new Error(`SQLite connection thread exited with code ${code}`)),
		);
	}

	/**
	 * Opens `path` on a new thread and resolves with the location the connection reports. Rejects with
	 * `ConnectionLoadError` when node:sqlite is unavailable there, and with the driver's error when opening fails; the
	 * thread is gone either way.
	 */
	static async open(
		path: string,
		options: ThreadConnectionOptions,
	): Promise<{ connection: ThreadConnection; location: string | null }> {
		const connection = new ThreadConnection(path, options);
		try {
			return { connection, location: await connection.opened };
		} catch (error) {
			await connection.worker.terminate();
			throw error;
		}
	}

	private receive(reply: ConnectionReply): void {
		if (reply.id === 0) {
			this.settleOpen?.(reply);
			if (this.ledger.size === 0) this.worker.unref();
			return;
		}
		this.ledger.answer(
			reply.id,
			reply.failure === undefined
				? { ok: true, value: reply.value as ConnectionValue }
				: { ok: false, error: connectionFailure(reply.failure) },
		);
		// An idle connection does not keep the process alive, as a connection on the calling thread would not.
		if (this.ledger.size === 0) this.worker.unref();
	}

	private lose(cause: Error): void {
		if (this.lost !== undefined) return;
		this.lost = cause;
		this.settleOpen?.({ id: 0, failure: { name: cause.name, message: cause.message } });
		this.ledger.end(cause);
		this.worker.unref();
	}

	/** Sends one request; resolves with the thread's answer or rejects with the driver's error. */
	request(request: ConnectionRequest): Promise<ConnectionValue> {
		return new Promise<ConnectionValue>((resolve, reject) => {
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
			}
		})();
		return this.closing;
	}
}
