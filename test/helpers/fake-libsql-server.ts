import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

/**
 * A loopback stand-in for a libSQL server (sqld) speaking Hrana 2 over HTTP, the protocol `@libsql/client` uses for
 * `http:` and `libsql:` URLs: one in-memory SQLite database, streams addressed by batons, and stream expiry answered as
 * sqld answers it (HTTP 400 with code `STREAM_EXPIRED`). As in sqld, each request a stream takes gives it a new baton,
 * and a baton already used is refused (HTTP 400, "Received a baton that has already been used") without running
 * anything, so a client that lost the answer to a request cannot reach the stream again. Faults a test plans are applied to the next pipeline
 * requests in order.
 */

type HranaValue =
	| { readonly type: "null" }
	| { readonly type: "integer"; readonly value: string }
	| { readonly type: "float"; readonly value: number }
	| { readonly type: "text"; readonly value: string }
	| { readonly type: "blob"; readonly base64: string };

interface HranaStmt {
	readonly sql?: string;
	readonly sql_id?: number;
	readonly args?: readonly HranaValue[];
}

interface HranaCondition {
	readonly type: "ok" | "error" | "not" | "and" | "or" | "is_autocommit";
	readonly step?: number;
	readonly cond?: HranaCondition;
	readonly conds?: readonly HranaCondition[];
}

type StreamRequest =
	| { readonly type: "execute"; readonly stmt: HranaStmt }
	| {
			readonly type: "batch";
			readonly batch: {
				readonly steps: readonly { readonly condition?: HranaCondition; readonly stmt: HranaStmt }[];
			};
	  }
	| { readonly type: "sequence"; readonly sql?: string; readonly sql_id?: number }
	| { readonly type: "store_sql"; readonly sql_id: number; readonly sql: string }
	| { readonly type: "close_sql"; readonly sql_id: number }
	| { readonly type: "get_autocommit" }
	| { readonly type: "close" };

interface HranaError {
	readonly message: string;
	readonly code: string;
}

interface StmtResult {
	readonly cols: readonly { readonly name: string; readonly decltype: string | null }[];
	readonly rows: readonly (readonly HranaValue[])[];
	readonly affected_row_count: number;
	readonly last_insert_rowid: null;
}

interface Stream {
	readonly id: number;
	/** The baton the stream's next request must carry. */
	baton: string;
	readonly sqls: Map<number, string>;
	lastActive: number;
}

/**
 * What the next pipeline request meets. `expired`: its stream expired, as sqld expires an idle one, so the request
 * fails with `STREAM_EXPIRED` and the stream's open transaction rolls back. `result-error`: each of its requests
 * answers this error, and the stream's open transaction rolls back, as sqld rolls back a transaction it times out.
 * `reset-before` / `reset-after`: the connection is reset before the request runs, or after it ran and committed.
 * `closed-before`: the connection is closed without an answer before the request runs. `gateway-after`: the request
 * runs and commits, and a gateway in front of the server then answers HTTP `status` (502 by default) with an HTML
 * page instead. `busy`: the request's first
 * statement other than a kept stream's read of `sqlite_schema` fails with `SQLITE_BUSY` without running, as sqld answers a writer that meets its checkpoint; the rest of
 * a batch runs as its conditions say. `stream-busy`: the request fails as a whole with `SQLITE_BUSY`, which ends its
 * stream and rolls back the stream's open transaction. `schema-changed`: as `busy`, but the statement fails with
 * `SQLITE_SCHEMA`, as sqld answers a statement whose schema another connection kept changing while it was prepared;
 * with `statement`, the first statement of the request whose SQL holds that text fails so instead, after the
 * statements before it ran, also inside a sequence.
 * `missing-table`: as `busy`, but the statement fails with `no such table: <table>`, as sqld answers, without running
 * it, a statement it prepared while other connections changed the schema, though the table exists.
 */
export type FakeLibsqlFault =
	| { readonly kind: "expired" }
	| { readonly kind: "busy" }
	| { readonly kind: "schema-changed"; readonly statement?: string }
	| { readonly kind: "missing-table"; readonly table: string }
	/** A connection's schema predates a concurrent change; taking the write lock does not refresh it, a schema read does. */
	| { readonly kind: "stale-schema"; readonly table: string }
	| { readonly kind: "stream-busy" }
	| { readonly kind: "result-error"; readonly code: string }
	| { readonly kind: "timed-out-mid-batch" }
	| { readonly kind: "rolled-back-before-commit" }
	| { readonly kind: "reset-before" }
	| { readonly kind: "reset-after" }
	| { readonly kind: "closed-before" }
	| { readonly kind: "gateway-after"; readonly status?: number }
	/** A plain-text HTTP 400 sent before anything runs, as sqld answers a request it refuses as a protocol error. */
	| { readonly kind: "bad-request"; readonly message: string }
	/**
	 * HTTP 429 sent before anything runs, as sqld answers a request it could not open a database connection for in time
	 * (`DbCreateTimeout`) because open streams hold all of its connections.
	 */
	| { readonly kind: "no-connection" };

export interface FakeLibsqlPipeline {
	/** The SQL texts the request runs, in order. */
	readonly sql: readonly string[];
	/** Whether the request continues a stream, so it may run inside a transaction an earlier request began. */
	readonly continuesStream: boolean;
	/** The request's headers, as the server received them. */
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface FakeLibsqlServerOptions {
	/** How long a stream may stay idle before the server expires it and rolls back its transaction. */
	readonly streamTtlMs?: number;
	/** The port to listen on; 0, the default, picks a free one. */
	readonly port?: number;
	/**
	 * Drops, unanswered and with a reset, a request that arrives on a connection idle this long since its last answer:
	 * what a client meets when it reuses a connection just as the server closes it for idling, as Turso closes one
	 * 5 seconds after its last response. Unset keeps idle connections open.
	 */
	readonly idleCloseMs?: number;
}

export interface FakeLibsqlServer {
	readonly url: string;
	readonly port: number;
	/** The server's database, for reading what was committed. */
	readonly database: DatabaseSync;
	/** Every pipeline request the server received, faulted ones included. */
	readonly pipelines: FakeLibsqlPipeline[];
	/** The connections the server accepted so far. */
	readonly connections: number;
	/** The connections still open. */
	readonly openConnections: number;
	/** The pipeline requests carrying SQL that were answered with `STREAM_EXPIRED` (a stream's closing is not counted). */
	readonly expiredStatements: number;
	/** Applies `faults` to the next pipeline requests, one each, in order. */
	fail(...faults: FakeLibsqlFault[]): void;
	/**
	 * Calls `hook` after a pipeline request ran and left its stream inside an open transaction, before the answer is
	 * sent; the answer waits for the hook. Replaces any hook set before; `undefined` removes it.
	 */
	onOpenTransaction(hook: ((pipeline: FakeLibsqlPipeline) => Promise<void> | void) | undefined): void;
	/**
	 * Calls `hook` after a pipeline request carrying a batch ran, before the answer is sent; the answer waits for the
	 * hook. A batch is a write transaction in one request, so it never leaves one open. `undefined` removes it.
	 */
	onBatch(hook: ((pipeline: FakeLibsqlPipeline) => Promise<void> | void) | undefined): void;
	/**
	 * Calls `hook` when a pipeline request closes a stream, before the answer is sent; the answer waits for the hook.
	 * `undefined` removes it.
	 */
	onStreamClose(hook: (() => Promise<void> | void) | undefined): void;
	/**
	 * While `churning`, the server answers as sqld does while other connections keep changing the schema: every
	 * statement outside a write transaction, other than `BEGIN`, `COMMIT`, `ROLLBACK` and a kept stream's read of
	 * `sqlite_schema`, fails with `SQLITE_SCHEMA` without running, however often it is sent. A statement inside a write
	 * transaction runs: the transaction holds the write lock, so no other connection changes the schema under it.
	 */
	churnSchema(churning: boolean): void;
	/** Expires every open stream at once, rolling back the open transaction. */
	expireStreams(): void;
	close(): Promise<void>;
}

const DEFAULT_STREAM_TTL_MS = 10_000;

function sqlValue(value: HranaValue): SQLInputValue {
	switch (value.type) {
		case "null":
			return null;
		case "integer":
			return BigInt(value.value);
		case "float":
			return value.value;
		case "text":
			return value.value;
		case "blob":
			return Buffer.from(value.base64, "base64");
	}
}

function hranaValue(value: unknown): HranaValue {
	if (value === null) return { type: "null" };
	if (typeof value === "bigint") return { type: "integer", value: String(value) };
	if (typeof value === "number") return { type: "float", value };
	if (typeof value === "string") return { type: "text", value };
	return { type: "blob", base64: Buffer.from(value as Uint8Array).toString("base64") };
}

function sqliteError(error: unknown): HranaError {
	const { message, errstr } = error as { readonly message?: unknown; readonly errstr?: unknown };
	return {
		message: String(message),
		code: typeof errstr === "string" ? `SQLITE_${errstr.toUpperCase().replaceAll(" ", "_")}` : "SQLITE_ERROR",
	};
}

async function readBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += String(chunk);
	return body;
}

export async function startFakeLibsqlServer(options: FakeLibsqlServerOptions = {}): Promise<FakeLibsqlServer> {
	const ttlMs = options.streamTtlMs ?? DEFAULT_STREAM_TTL_MS;
	const database = new DatabaseSync(":memory:");
	/** The live streams. */
	const streams = new Set<Stream>();
	/** Every baton handed out, current or used, and its stream. */
	const batons = new Map<string, Stream>();
	const faults: FakeLibsqlFault[] = [];
	const pipelines: FakeLibsqlPipeline[] = [];
	const sockets = new Set<Socket>();
	let owner: Stream | undefined;
	let hook: ((pipeline: FakeLibsqlPipeline) => Promise<void> | void) | undefined;
	let batchHook: ((pipeline: FakeLibsqlPipeline) => Promise<void> | void) | undefined;
	let closeHook: (() => Promise<void> | void) | undefined;
	let expiredStatements = 0;
	let nextStream = 0;
	let nextBaton = 0;

	const rollBack = (stream: Stream) => {
		if (owner === stream) {
			if (database.isTransaction) database.exec("ROLLBACK");
			owner = undefined;
		}
	};
	const expire = (stream: Stream) => {
		rollBack(stream);
		streams.delete(stream);
	};
	const sweep = () => {
		const now = performance.now();
		for (const stream of [...streams]) if (now - stream.lastActive > ttlMs) expire(stream);
	};

	let busy = false;
	let schemaChanged = false;
	let schemaChangedAt: string | undefined;
	let churning = false;
	let missingTable: string | undefined;
	let staleTable: string | undefined;
	let schemaChangeAtLock: string | undefined;
	const execute = (stream: Stream, stmt: HranaStmt): StmtResult => {
		const sql = stmt.sql ?? stream.sqls.get(stmt.sql_id ?? -1);
		if (sql === "BEGIN IMMEDIATE" && schemaChangeAtLock !== undefined) {
			staleTable = schemaChangeAtLock;
			schemaChangeAtLock = undefined;
		}
		if (staleTable !== undefined) {
			if (sql?.startsWith("SELECT 1 FROM sqlite_schema")) staleTable = undefined;
			else if (!/^(?:BEGIN|COMMIT|ROLLBACK)\b/.test(sql ?? ""))
				throw Object.assign(new Error(`SQLite error: no such table: ${staleTable}`), { errstr: "unknown" });
		}
		// The read of `sqlite_schema` a kept stream sends before its statement takes no write lock, so the server never
		// answers it busy.
		if (busy && !sql?.startsWith("SELECT 1 FROM sqlite_schema")) {
			busy = false;
			throw Object.assign(new Error("database is locked"), { errstr: "busy" });
		}
		if (schemaChanged && !sql?.startsWith("SELECT 1 FROM sqlite_schema")) {
			schemaChanged = false;
			throw Object.assign(new Error("database schema has changed"), { errstr: "schema" });
		}
		if (schemaChangedAt !== undefined && sql?.includes(schemaChangedAt)) {
			schemaChangedAt = undefined;
			throw Object.assign(new Error("database schema has changed"), { errstr: "schema" });
		}
		if (
			churning &&
			!database.isTransaction &&
			!/^(?:BEGIN|COMMIT|ROLLBACK|SELECT 1 FROM sqlite_schema)\b/.test(sql ?? "")
		)
			throw Object.assign(new Error("database schema has changed"), { errstr: "schema" });
		if (missingTable !== undefined && !sql?.startsWith("SELECT 1 FROM sqlite_schema")) {
			const table = missingTable;
			missingTable = undefined;
			throw Object.assign(new Error(`SQLite error: no such table: ${table}`), { errstr: "unknown" });
		}
		if (sql === undefined) throw Object.assign(new Error("SQL text not found"), { errstr: "error" });
		const statement = database.prepare(sql);
		statement.setReadBigInts(true);
		const args = (stmt.args ?? []).map(sqlValue);
		const columns = statement.columns();
		if (columns.length === 0) {
			const { changes } = statement.run(...args);
			return { cols: [], rows: [], affected_row_count: Number(changes), last_insert_rowid: null };
		}
		statement.setReturnArrays(true);
		const rows = statement.all(...args) as unknown as unknown[][];
		return {
			cols: columns.map((column) => ({ name: column.name, decltype: column.type ?? null })),
			rows: rows.map((row) => row.map(hranaValue)),
			affected_row_count: 0,
			last_insert_rowid: null,
		};
	};

	const holds = (
		condition: HranaCondition | undefined,
		results: readonly (StmtResult | null)[],
		errors: readonly (HranaError | null)[],
	): boolean => {
		if (condition === undefined) return true;
		switch (condition.type) {
			case "ok":
				return results[condition.step!] !== null && results[condition.step!] !== undefined;
			case "error":
				return errors[condition.step!] !== null && errors[condition.step!] !== undefined;
			case "not":
				return !holds(condition.cond, results, errors);
			case "and":
				return (condition.conds ?? []).every((each) => holds(each, results, errors));
			case "or":
				return (condition.conds ?? []).some((each) => holds(each, results, errors));
			case "is_autocommit":
				return !database.isTransaction;
		}
	};

	const run = (stream: Stream, request: StreamRequest) => {
		switch (request.type) {
			case "execute":
				return { type: "execute", result: execute(stream, request.stmt) };
			case "batch": {
				const results: (StmtResult | null)[] = [];
				const errors: (HranaError | null)[] = [];
				for (const step of request.batch.steps) {
					if (!holds(step.condition, results, errors)) {
						results.push(null);
						errors.push(null);
						continue;
					}
					try {
						results.push(execute(stream, step.stmt));
						errors.push(null);
					} catch (error) {
						results.push(null);
						errors.push(sqliteError(error));
					}
				}
				return { type: "batch", result: { step_results: results, step_errors: errors } };
			}
			case "sequence":
				if (busy) {
					busy = false;
					throw Object.assign(new Error("database is locked"), { errstr: "busy" });
				}
				if (schemaChanged) {
					schemaChanged = false;
					throw Object.assign(new Error("database schema has changed"), { errstr: "schema" });
				}
				if (churning && !database.isTransaction)
					throw Object.assign(new Error("database schema has changed"), { errstr: "schema" });
				{
					const text = request.sql ?? stream.sqls.get(request.sql_id ?? -1) ?? "";
					const at = schemaChangedAt === undefined ? -1 : text.indexOf(schemaChangedAt);
					if (at !== -1) {
						// The statements before the refused one ran and committed.
						schemaChangedAt = undefined;
						database.exec(text.slice(0, text.lastIndexOf(";", at) + 1));
						throw Object.assign(new Error("database schema has changed"), { errstr: "schema" });
					}
					database.exec(text);
				}
				return { type: "sequence" };
			case "store_sql":
				stream.sqls.set(request.sql_id, request.sql);
				return { type: "store_sql" };
			case "close_sql":
				stream.sqls.delete(request.sql_id);
				return { type: "close_sql" };
			case "get_autocommit":
				return { type: "get_autocommit", is_autocommit: !database.isTransaction };
			case "close":
				return { type: "close" };
		}
	};

	const answer = (response: ServerResponse, status: number, body: object) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};

	const turn = async (stream: Stream | undefined, abandoned: () => boolean) => {
		for (;;) {
			sweep();
			if (abandoned() || owner === undefined || owner === stream) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	};

	const handlePipeline = async (request: IncomingMessage, response: ServerResponse) => {
		const body = JSON.parse(await readBody(request)) as {
			readonly baton?: string | null;
			readonly requests: readonly StreamRequest[];
		};
		const sql = body.requests.flatMap((each) => {
			if (each.type === "execute") return [each.stmt.sql ?? `#${each.stmt.sql_id}`];
			if (each.type === "batch") return each.batch.steps.map((step) => step.stmt.sql ?? `#${step.stmt.sql_id}`);
			if (each.type === "sequence") return [each.sql ?? `#${each.sql_id}`];
			return [];
		});
		const pipeline: FakeLibsqlPipeline = {
			sql,
			continuesStream: typeof body.baton === "string",
			headers: { ...request.headers },
		};
		pipelines.push(pipeline);
		const fault = faults.shift();
		const socket = request.socket;
		if (fault?.kind === "reset-before") return void socket.resetAndDestroy();
		if (fault?.kind === "closed-before") return void socket.end();
		if (fault?.kind === "no-connection")
			return answer(response, 429, { error: "Timed out while opening database connection" });
		if (fault?.kind === "bad-request") {
			response.writeHead(400, { "content-type": "text/plain" });
			return void response.end(fault.message);
		}
		const named = typeof body.baton === "string" ? batons.get(body.baton) : undefined;
		const existing = named !== undefined && streams.has(named) ? named : undefined;
		if (fault?.kind === "expired" && existing !== undefined) expire(existing);
		if (existing !== undefined && existing.baton !== body.baton) {
			response.writeHead(400, { "content-type": "text/plain" });
			return void response.end("Received a baton that has already been used");
		}
		const abandoned = () => socket.destroyed || response.destroyed || response.writableEnded;
		await turn(existing, abandoned);
		if (abandoned()) return;
		if (typeof body.baton === "string" && (existing === undefined || !streams.has(existing))) {
			if (sql.length > 0) expiredStatements++;
			return answer(response, 400, {
				message: "The stream has expired due to inactivity",
				code: "STREAM_EXPIRED",
			});
		}
		if (fault?.kind === "stream-busy") {
			if (existing !== undefined) expire(existing);
			return answer(response, 400, { message: "database is locked", code: "SQLITE_BUSY" });
		}
		const stream: Stream = existing ?? { id: ++nextStream, baton: "", sqls: new Map(), lastActive: 0 };
		stream.lastActive = performance.now();
		streams.add(stream);
		// The request takes the stream: the baton it carried is used up whether or not its answer reaches the client.
		stream.baton = `baton-${stream.id}-${++nextBaton}`;
		batons.set(stream.baton, stream);
		const timedOut =
			fault?.kind === "result-error"
				? { message: `Transaction failed (${fault.code})`, code: fault.code }
				: undefined;
		if (timedOut !== undefined) rollBack(stream);
		busy = fault?.kind === "busy";
		schemaChanged = fault?.kind === "schema-changed" && fault.statement === undefined;
		schemaChangedAt = fault?.kind === "schema-changed" ? fault.statement : undefined;
		missingTable = fault?.kind === "missing-table" ? fault.table : undefined;
		staleTable = undefined;
		schemaChangeAtLock = fault?.kind === "stale-schema" ? fault.table : undefined;
		const results = body.requests.map((each) => {
			if (fault?.kind === "timed-out-mid-batch" && each.type === "batch") {
				const began: StmtResult = { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null };
				const rolledBack = { message: "Transaction timed out", code: "TRANSACTION_TIMEOUT" };
				const result = {
					step_results: each.batch.steps.map((_step, index) => (index === 0 ? began : null)),
					step_errors: each.batch.steps.map((_step, index) => (index === 0 ? null : rolledBack)),
				};
				return { type: "ok", response: { type: "batch", result } };
			}
			if (fault?.kind === "rolled-back-before-commit" && each.type === "batch") {
				const ran: StmtResult = { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: null };
				const commit = each.batch.steps.findIndex((step) => step.stmt.sql === "COMMIT");
				const result = {
					step_results: each.batch.steps.map((_step, index) => (index < commit ? ran : null)),
					step_errors: each.batch.steps.map(() => null),
				};
				return { type: "ok", response: { type: "batch", result } };
			}
			if (timedOut !== undefined && each.type === "batch") {
				// As sqld answers a batch whose first step failed: the steps conditioned on it never ran.
				const steps = each.batch.steps.map(() => null);
				const result = {
					step_results: steps,
					step_errors: each.batch.steps.map((_step, index) => (index === 0 ? timedOut : null)),
				};
				return { type: "ok", response: { type: "batch", result } };
			}
			if (timedOut !== undefined && (each.type === "execute" || each.type === "sequence"))
				return { type: "error", error: timedOut };
			try {
				return { type: "ok", response: run(stream, each) };
			} catch (error) {
				return { type: "error", error: sqliteError(error) };
			}
		});
		const closing = body.requests.some((each) => each.type === "close");
		if (database.isTransaction) owner = stream;
		else if (owner === stream) owner = undefined;
		if (closing) expire(stream);
		if (fault?.kind === "reset-after") return void socket.resetAndDestroy();
		if (fault?.kind === "gateway-after") {
			const status = fault.status ?? 502;
			response.writeHead(status, { "content-type": "text/html" });
			return void response.end(`<html><body>${status}</body></html>`);
		}
		if (owner === stream && hook !== undefined) await hook(pipeline);
		if (batchHook !== undefined && body.requests.some((each) => each.type === "batch")) await batchHook(pipeline);
		if (closing && closeHook !== undefined) await closeHook();
		stream.lastActive = performance.now();
		answer(response, 200, { baton: closing ? null : stream.baton, base_url: null, results });
	};

	/** When each connection last finished an answer. */
	const answered = new WeakMap<Socket, number>();
	const server = createServer((request, response) => {
		const { socket } = request;
		const idleSince = answered.get(socket);
		if (
			options.idleCloseMs !== undefined &&
			idleSince !== undefined &&
			performance.now() - idleSince >= options.idleCloseMs
		)
			return void socket.resetAndDestroy();
		response.once("finish", () => answered.set(socket, performance.now()));
		if (request.method === "POST" && request.url === "/v2/pipeline") {
			handlePipeline(request, response).catch((error: unknown) => {
				if (!response.headersSent)
					answer(response, 500, { message: error instanceof Error ? error.message : "internal error" });
			});
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("not found");
	});
	// Node closes an idle keep-alive connection after 5 s. A client stopped longer would then meet a closed connection
	// instead of its expired stream, so idle connections stay open, however long a client stays stopped.
	server.keepAliveTimeout = 0;
	let connections = 0;
	server.on("connection", (socket) => {
		connections++;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		database,
		pipelines,
		get expiredStatements() {
			return expiredStatements;
		},
		get connections() {
			return connections;
		},
		get openConnections() {
			return sockets.size;
		},
		fail: (...planned) => void faults.push(...planned),
		onBatch(next) {
			batchHook = next;
		},
		onOpenTransaction(next) {
			hook = next;
		},
		churnSchema(next) {
			churning = next;
		},
		onStreamClose(next) {
			closeHook = next;
		},
		expireStreams() {
			for (const stream of [...streams]) expire(stream);
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			database.close();
		},
	};
}

/**
 * Fake servers and the libSQL databases a test file opens on them, all closed after each test, with any stubbed fetch
 * and mocks restored.
 */
export function useFakeLibsqlServers(): {
	server(options?: FakeLibsqlServerOptions): Promise<FakeLibsqlServer>;
	open(url: string): Promise<SqliteDatabase>;
} {
	const cleanups: (() => Promise<void>)[] = [];
	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});
	return {
		async server(options) {
			const started = await startFakeLibsqlServer(options);
			cleanups.push(() => started.close());
			return started;
		},
		async open(url) {
			const database = await openLibsqlDatabase({ url });
			cleanups.push(() => database.close());
			return database;
		},
	};
}

/** Expires the stream of the next transaction that stays open, once: the server's view of a process that stalled. */
export function stallNextTransaction(fake: FakeLibsqlServer): void {
	fake.onOpenTransaction(() => {
		fake.onOpenTransaction(undefined);
		fake.expireStreams();
	});
}

/** The next transaction that stays open meets a server that timed it out and rolled it back, once. */
export function timeOutNextTransaction(fake: FakeLibsqlServer): void {
	fake.onOpenTransaction(() => {
		fake.onOpenTransaction(undefined);
		fake.fail({ kind: "result-error", code: "TRANSACTION_TIMEOUT" });
	});
}

/** The value of `SELECT COUNT(*) AS count ...` on the server's database. */
export function countRows(fake: FakeLibsqlServer, sql: string): number {
	return Number((fake.database.prepare(sql).get() as { count: number | bigint }).count);
}

/** A fetch whose first request fails with `failure` before it reaches the server; later requests reach it. */
export function failFirstFetch(failure: Error): void {
	const real = globalThis.fetch;
	let failed = false;
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		if (failed) return real(input, init);
		failed = true;
		return Promise.reject(failure);
	});
}

/** A network failure with `code`, wrapped `depth` times as Node's fetch wraps one (`TypeError("fetch failed")`). */
export function networkFailure(code: string | number, depth = 1): Error {
	let failure: Error = Object.assign(new Error(`network failure ${code}`), { code });
	for (let level = 0; level < depth; level++) failure = new TypeError("fetch failed", { cause: failure });
	return failure;
}
