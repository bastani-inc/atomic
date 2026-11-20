import { Worker } from "node:worker_threads";
import type { SqliteRow, SqliteValue } from "./database.js";
import { sqliteDialect } from "./dialect.js";

/**
 * A node:sqlite connection that runs on a worker thread of its own (#5376). The thread owns the `DatabaseSync`; the
 * calling thread sends it one request at a time and receives each answer as a message, so no statement, lock wait or
 * synced commit runs on the caller's event loop. SQLite's busy handler waits on the connection's own thread, so a
 * statement waiting for a lock that another connection of the same process holds never stops that connection from
 * finishing.
 */
const CONNECTION_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
let database;

const STANDARD_ERRORS = [Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError];
// Bun stamps every error with where it was thrown; the caller's copy gets its own.
const LOCATION_FIELDS = new Set(["stack", "message", "line", "column", "originalLine", "originalColumn", "sourceURL"]);

// An object's own fields that hold plain values, with their enumerability.
function fieldsOf(object, skip) {
	const fields = [];
	for (const key of Object.getOwnPropertyNames(object)) {
		if (skip.has(key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		const value = descriptor?.value;
		if (value === null || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && typeof value !== "bigint")) continue;
		fields.push([key, value, descriptor.enumerable === true]);
	}
	return fields;
}

// A thrown error as it crosses to the caller: the standard constructor it descends from, its message, and its own
// fields with their enumerability. A runtime's error class of its own between the error and that constructor (Bun's
// node:sqlite errors have one holding name, code and toString) is described by its fields and whether it has a
// toString of its own, and how it shows.
function failure(error) {
	if (!(error instanceof Error)) return { constructor: "Error", message: String(error), fields: [] };
	let standard = Object.getPrototypeOf(error);
	let between;
	while (standard !== null && !STANDARD_ERRORS.some((each) => each.prototype === standard)) {
		if (between === undefined) {
			const toString = Object.getOwnPropertyDescriptor(standard, "toString");
			between = {
				fields: fieldsOf(standard, new Set(["constructor", "message"])),
				...(typeof toString?.value === "function" ? { toString: { enumerable: toString.enumerable === true } } : {}),
			};
		}
		standard = Object.getPrototypeOf(standard);
	}
	return {
		constructor: standard === null ? "Error" : standard.constructor.name,
		message: String(error.message),
		fields: fieldsOf(error, LOCATION_FIELDS),
		...(between === undefined ? {} : { between }),
	};
}

function statement(sql) {
	const prepared = database.prepare(sql);
	prepared.setReadBigInts(true);
	return prepared;
}

// Node 22 binds an empty Uint8Array that arrived in a message as NULL; a new empty one binds as a zero-length blob.
function bind(params) {
	return params.map((value) => (value instanceof Uint8Array && value.byteLength === 0 ? new Uint8Array(0) : value));
}

function value(each) {
	if (typeof each === "bigint") return each >= -BigInt(Number.MAX_SAFE_INTEGER) && each <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(each) : each;
	// A copy of its own: a view of a larger buffer would send the whole buffer.
	return each instanceof Uint8Array ? new Uint8Array(each) : each;
}

// Rows cross as their column names and one array of values each, in the order the driver gives a row's fields.
function table(rows) {
	if (rows.length === 0) return { columns: [], values: [] };
	const columns = Object.keys(rows[0]);
	return { columns, values: rows.map((row) => columns.map((column) => value(row[column]))) };
}

const handlers = {
	open: (request) => {
		database = new DatabaseSync(request.path, { readOnly: request.readOnly });
		return database.location();
	},
	exec: (request) => {
		database.exec(request.sql);
	},
	run: (request) => ({ changes: Number(statement(request.sql).run(...bind(request.params)).changes) }),
	get: (request) => {
		const row = statement(request.sql).get(...bind(request.params));
		return row === undefined ? undefined : table([row]);
	},
	all: (request) => table(statement(request.sql).all(...bind(request.params))),
	// One non-blocking BEGIN IMMEDIATE, the connection's busy timeout restored before answering.
	begin: () => {
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
	},
	dataVersion: () => Number(database.prepare("PRAGMA data_version").get()?.data_version ?? 0),
	now: () => Number(database.prepare(workerData.nowSql).get().now),
	jsonbExtract: () => {
		try {
			statement("SELECT jsonb_extract('[]', '$')");
			return true;
		} catch (error) {
			if (error instanceof Error && error.message === "no such function: jsonb_extract") return false;
			throw error;
		}
	},
	close: () => {
		database?.close();
		globalThis.Bun?.gc?.(true);
	},
};

parentPort.on("message", (request) => {
	try {
		parentPort.postMessage({ id: request.id, value: handlers[request.kind](request) });
	} catch (error) {
		parentPort.postMessage({ id: request.id, failure: failure(error) });
	}
});
`;

/** What a connection's thread is asked to do; each request is answered once, in the order it was sent. */
export type ConnectionRequest =
	| { readonly kind: "open"; readonly path: string; readonly readOnly: boolean }
	| { readonly kind: "exec"; readonly sql: string }
	| { readonly kind: "run" | "get" | "all"; readonly sql: string; readonly params: readonly SqliteValue[] }
	| { readonly kind: "begin" | "dataVersion" | "now" | "jsonbExtract" | "close" };

/** Rows as they cross from a connection's thread: the column names, then each row's values in their order. */
interface RowTable {
	readonly columns: readonly string[];
	readonly values: readonly (readonly SqliteValue[])[];
}

/** What a request's answer carries as it crosses, before rows are rebuilt. */
type ConnectionValue = RowTable | { readonly changes: number } | string | number | boolean | null | undefined;

/**
 * What a request is answered with: `get` a row or undefined, `all` rows, `run` the changes, `open` the location,
 * `dataVersion` and `now` a number, `jsonbExtract` a boolean, the others undefined.
 */
export type ConnectionAnswer =
	| SqliteRow
	| SqliteRow[]
	| { readonly changes: number }
	| string
	| number
	| boolean
	| null
	| undefined;

/** An own field that holds a plain value: its key, value and enumerability. */
type ConnectionField = readonly [string, string | number | boolean | bigint, boolean];

/** A failure as it crosses from a connection's thread; see `failure` in the thread's source. */
interface ConnectionFailure {
	readonly constructor: string;
	readonly message: string;
	readonly fields: readonly ConnectionField[];
	readonly between?: {
		readonly fields: readonly ConnectionField[];
		readonly toString?: { readonly enumerable: boolean };
	};
}

interface ConnectionReply {
	readonly id: number;
	readonly value?: ConnectionValue;
	readonly failure?: ConnectionFailure;
}

const STANDARD_ERRORS: Readonly<Record<string, ErrorConstructor>> = {
	Error,
	TypeError,
	RangeError,
	SyntaxError,
	ReferenceError,
	EvalError,
	URIError,
};

/** One prototype per runtime error class seen, by what it holds: see `connectionError`. */
const betweenPrototypes = new Map<string, object>();

/** How a runtime's error class of its own shows an error, as Bun's do: `TypeError [ERR_INVALID_ARG_VALUE]: …`. */
function showWithCode(this: Error & { readonly code?: unknown }): string {
	return `${this.name} [${String(this.code)}]: ${this.message}`;
}

function betweenPrototype(base: ErrorConstructor, between: NonNullable<ConnectionFailure["between"]>): object {
	const key = JSON.stringify([
		base.name,
		between.fields.map(([field, value, enumerable]) => [field, String(value), enumerable]),
		between.toString,
	]);
	let prototype = betweenPrototypes.get(key);
	if (prototype === undefined) {
		const created: object = Object.create(base.prototype);
		for (const [field, value, enumerable] of between.fields)
			Object.defineProperty(created, field, { value, enumerable, writable: true, configurable: true });
		if (between.toString !== undefined)
			Object.defineProperty(created, "toString", {
				value: showWithCode,
				enumerable: between.toString.enumerable,
				writable: true,
				configurable: true,
			});
		betweenPrototypes.set(key, created);
		prototype = created;
	}
	return prototype;
}

/**
 * The driver's error, rebuilt on the calling thread as the driver threw it: an instance of the same standard error
 * class with the same message, and the same own fields (`code`, `errcode`, `errstr` for SQLite's errors) with the same
 * enumerability. A runtime's own error class between them is stood in for by a prototype that holds the same fields and
 * shows the error the same way.
 */
function connectionError(failure: ConnectionFailure): Error {
	const base = STANDARD_ERRORS[failure.constructor] ?? Error;
	const error = new base(failure.message);
	if (failure.between !== undefined) Object.setPrototypeOf(error, betweenPrototype(base, failure.between));
	for (const [key, value, enumerable] of failure.fields)
		Object.defineProperty(error, key, { value, enumerable, writable: true, configurable: true });
	return error;
}

/** The rows of `table`, each a plain object built the way the calling-thread connection builds them. */
function rowsOf(table: RowTable): SqliteRow[] {
	const { columns, values } = table;
	return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] as SqliteValue])));
}

interface Waiter {
	readonly resolve: (value: ConnectionValue) => void;
	readonly reject: (error: unknown) => void;
}

/** Thrown for a request to a connection whose thread is gone: closed, or lost to an error or an exit. */
export class ConnectionThreadEndedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectionThreadEndedError";
	}
}

/** A node:sqlite connection running on its own worker thread. */
export class ThreadConnection {
	private readonly worker: Worker;
	private readonly waiting = new Map<number, Waiter>();
	private nextId = 1;
	private ended?: Error;
	private closing?: Promise<undefined>;

	private constructor() {
		// None of the process's own flags: an `--input-type=module` would make this CommonJS source a module, and the
		// caller's preloads would run again for every connection. Whether node:sqlite is available was settled by the
		// open before it started the thread.
		this.worker = new Worker(CONNECTION_SOURCE, {
			eval: true,
			execArgv: [],
			workerData: { nowSql: `SELECT ${sqliteDialect.nowMs} AS now` },
		});
		this.worker.on("message", (reply: ConnectionReply) => this.receive(reply));
		this.worker.on("error", (error: Error) => this.end(error));
		this.worker.on("exit", (code: number) =>
			this.end(new ConnectionThreadEndedError(`SQLite connection thread exited with code ${code}`)),
		);
	}

	/**
	 * Opens `openAs` (or `path`) on a thread of its own and resolves with the location SQLite reports for it. A failure
	 * to start the thread or to open the database rejects with its cause; the thread is gone then.
	 */
	static async open(
		path: string,
		options: { readonly readOnly: boolean; readonly openAs?: string },
	): Promise<{ readonly connection: ThreadConnection; readonly location: string | null }> {
		const connection = new ThreadConnection();
		try {
			const location = await connection.request({
				kind: "open",
				path: options.openAs ?? path,
				readOnly: options.readOnly,
			});
			return { connection, location: typeof location === "string" ? location : null };
		} catch (error) {
			await connection.stop();
			throw error;
		}
	}

	/**
	 * Sends one request; resolves with the thread's answer or rejects with the driver's error, rebuilt. While a request
	 * waits for its answer the thread keeps the process alive; an idle connection does not, as a connection on the
	 * calling thread would not.
	 */
	request(request: ConnectionRequest): Promise<ConnectionAnswer> {
		if (request.kind === "close") return this.close();
		const answer = this.send(request);
		if (request.kind === "get")
			return answer.then((value) => (value === undefined ? undefined : rowsOf(value as RowTable)[0]));
		if (request.kind === "all") return answer.then((value) => rowsOf(value as RowTable));
		return answer as Promise<ConnectionAnswer>;
	}

	private send(request: ConnectionRequest): Promise<ConnectionValue> {
		return new Promise<ConnectionValue>((resolve, reject) => {
			if (this.ended !== undefined) {
				reject(this.ended);
				return;
			}
			const id = this.nextId++;
			try {
				this.worker.postMessage({ id, ...request });
			} catch (error) {
				// A value the thread cannot receive.
				reject(error);
				return;
			}
			this.waiting.set(id, { resolve, reject });
			if (this.waiting.size === 1) this.worker.ref();
		});
	}

	/**
	 * Closes the database on its thread, then ends the thread: a `close` request. Requests sent after it are rejected. A
	 * thread already lost has nothing to close.
	 */
	private close(): Promise<undefined> {
		this.closing ??= (async () => {
			try {
				if (this.ended === undefined) await this.send({ kind: "close" });
			} finally {
				await this.stop();
			}
			return undefined;
		})();
		return this.closing;
	}

	private receive(reply: ConnectionReply): void {
		const waiter = this.waiting.get(reply.id);
		if (waiter === undefined) return;
		this.waiting.delete(reply.id);
		if (this.waiting.size === 0) this.worker.unref();
		if (reply.failure === undefined) waiter.resolve(reply.value);
		else waiter.reject(connectionError(reply.failure));
	}

	/** Rejects every request still waiting, oldest first, and every later one. Ending again does nothing. */
	private end(cause: Error): void {
		if (this.ended !== undefined) return;
		// Kept for as long as the connection is: an error's stack, until formatted, keeps the functions of the frames it
		// names, and so whatever they hold, such as a session that closed its store.
		void cause.stack;
		this.ended = cause;
		const waiting = [...this.waiting.values()];
		this.waiting.clear();
		this.worker.unref();
		for (const waiter of waiting) waiter.reject(cause);
	}

	private async stop(): Promise<void> {
		this.end(new ConnectionThreadEndedError("SQLite connection closed"));
		await this.worker.terminate();
	}
}
