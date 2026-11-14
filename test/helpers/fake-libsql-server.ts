import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

/**
 * A loopback stand-in for a libSQL server (sqld) speaking Hrana 2 over HTTP, the protocol `@libsql/client` uses for
 * `http:` and `libsql:` URLs: one in-memory SQLite database, streams addressed by batons, and stream expiry answered as
 * sqld answers it (HTTP 400 with code `STREAM_EXPIRED`). Faults a test plans are applied to the next pipeline
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
	readonly baton: string;
	readonly sqls: Map<number, string>;
	lastActive: number;
}

/**
 * What the next pipeline request meets. `expired`: its stream expired, as sqld expires an idle one, so the request
 * fails with `STREAM_EXPIRED` and the stream's open transaction rolls back. `result-error`: each of its requests
 * answers this error, and the stream's open transaction rolls back, as sqld rolls back a transaction it times out.
 * `reset-before` / `reset-after`: the connection is reset before the request runs, or after it ran and committed.
 * `closed-before`: the connection is closed without an answer before the request runs.
 */
export type FakeLibsqlFault =
	| { readonly kind: "expired" }
	| { readonly kind: "result-error"; readonly code: string }
	| { readonly kind: "reset-before" }
	| { readonly kind: "reset-after" }
	| { readonly kind: "closed-before" };

export interface FakeLibsqlPipeline {
	/** The SQL texts the request runs, in order. */
	readonly sql: readonly string[];
	/** Whether the request continues a stream, so it may run inside a transaction an earlier request began. */
	readonly continuesStream: boolean;
}

export interface FakeLibsqlServerOptions {
	/** How long a stream may stay idle before the server expires it and rolls back its transaction. */
	readonly streamTtlMs?: number;
	/** The port to listen on; 0, the default, picks a free one. */
	readonly port?: number;
}

export interface FakeLibsqlServer {
	readonly url: string;
	readonly port: number;
	/** The server's database, for reading what was committed. */
	readonly database: DatabaseSync;
	/** Every pipeline request the server received, faulted ones included. */
	readonly pipelines: FakeLibsqlPipeline[];
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
	const streams = new Map<string, Stream>();
	const faults: FakeLibsqlFault[] = [];
	const pipelines: FakeLibsqlPipeline[] = [];
	const sockets = new Set<Socket>();
	let owner: Stream | undefined;
	let hook: ((pipeline: FakeLibsqlPipeline) => Promise<void> | void) | undefined;
	let batchHook: ((pipeline: FakeLibsqlPipeline) => Promise<void> | void) | undefined;
	let expiredStatements = 0;
	let nextBaton = 0;

	const rollBack = (stream: Stream) => {
		if (owner === stream) {
			if (database.isTransaction) database.exec("ROLLBACK");
			owner = undefined;
		}
	};
	const expire = (stream: Stream) => {
		rollBack(stream);
		streams.delete(stream.baton);
	};
	const sweep = () => {
		const now = performance.now();
		for (const stream of streams.values()) if (now - stream.lastActive > ttlMs) expire(stream);
	};

	const execute = (stream: Stream, stmt: HranaStmt): StmtResult => {
		const sql = stmt.sql ?? stream.sqls.get(stmt.sql_id ?? -1);
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
				database.exec(request.sql ?? stream.sqls.get(request.sql_id ?? -1) ?? "");
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

	/** Waits while another stream's transaction is open, as sqld queues a writer behind the lock holder. */
	const turn = async (stream: Stream | undefined) => {
		for (;;) {
			sweep();
			if (owner === undefined || owner === stream) return;
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
		const pipeline: FakeLibsqlPipeline = { sql, continuesStream: typeof body.baton === "string" };
		pipelines.push(pipeline);
		const fault = faults.shift();
		const socket = request.socket;
		if (fault?.kind === "reset-before") return void socket.resetAndDestroy();
		if (fault?.kind === "closed-before") return void socket.end();
		const existing = typeof body.baton === "string" ? streams.get(body.baton) : undefined;
		if (fault?.kind === "expired" && existing !== undefined) expire(existing);
		await turn(existing);
		if (typeof body.baton === "string" && !streams.has(body.baton)) {
			if (sql.length > 0) expiredStatements++;
			return answer(response, 400, {
				message: "The stream has expired due to inactivity",
				code: "STREAM_EXPIRED",
			});
		}
		const stream: Stream = existing ?? { baton: `baton-${++nextBaton}`, sqls: new Map(), lastActive: 0 };
		stream.lastActive = performance.now();
		streams.set(stream.baton, stream);
		const timedOut =
			fault?.kind === "result-error"
				? { message: `Transaction failed (${fault.code})`, code: fault.code }
				: undefined;
		if (timedOut !== undefined) rollBack(stream);
		const results = body.requests.map((each) => {
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
		if (owner === stream && hook !== undefined) await hook(pipeline);
		if (batchHook !== undefined && body.requests.some((each) => each.type === "batch")) await batchHook(pipeline);
		stream.lastActive = performance.now();
		answer(response, 200, { baton: closing ? null : stream.baton, base_url: null, results });
	};

	const server = createServer((request, response) => {
		if (request.method === "POST" && request.url === "/v2/pipeline") {
			handlePipeline(request, response).catch((error: unknown) => {
				if (!response.headersSent) answer(response, 500, { message: String(error) });
			});
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("not found");
	});
	// Node closes an idle keep-alive connection after 5 s. A client stopped longer would then meet a closed connection
	// instead of its expired stream, so idle connections stay open, however long a client stays stopped.
	server.keepAliveTimeout = 0;
	server.on("connection", (socket) => {
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
		fail: (...planned) => void faults.push(...planned),
		onBatch(next) {
			batchHook = next;
		},
		onOpenTransaction(next) {
			hook = next;
		},
		expireStreams() {
			for (const stream of [...streams.values()]) expire(stream);
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
