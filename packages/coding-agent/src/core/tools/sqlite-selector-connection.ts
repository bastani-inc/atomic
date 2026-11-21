import { isBuiltin } from "node:module";
import { Worker } from "node:worker_threads";
import { EVAL_WORKER_BUILTIN, evalWorkerExecArgv } from "../../utils/worker-threads.js";
import type { SqliteRow, SqliteValue } from "../storage/database.js";

export type SqliteSelectorValue = string | number | boolean | null;
export type SqliteSelectorRow = Record<string, SqliteSelectorValue>;

const MISSING_NODE_SQLITE =
	"SQLite selectors need node:sqlite (Node >= 22.13 or Bun >= 1.4.2); this runtime does not provide it.";

const CONNECTION_SOURCE = `
${EVAL_WORKER_BUILTIN}
const { parentPort, workerData } = builtin("node:worker_threads");
process.emitWarning = () => {};
let database;

function failure(error, missingModule) {
	return {
		name: error?.name ?? "Error",
		message: String(error?.message ?? error),
		code: error?.code,
		errcode: error?.errcode,
		errstr: error?.errstr,
		missingModule,
	};
}

const statements = {
	all: (request) => database.prepare(request.sql).all(...request.params),
	rows: (request) => {
		const rows = [];
		if (rows.length >= request.limit) return rows;
		for (const row of database.prepare(request.sql).iterate(...request.params)) {
			rows.push(row);
			if (rows.length >= request.limit) break;
		}
		return rows;
	},
	run: (request) => ({ changes: Number(database.prepare(request.sql).run(...request.params).changes ?? 0) }),
	close: () => {
		database.close();
		globalThis.Bun?.gc?.(true);
	},
};

let DatabaseSync;
try {
	({ DatabaseSync } = builtin("node:sqlite"));
} catch (error) {
	parentPort.postMessage({ id: 0, failure: failure(error, true) });
}
if (DatabaseSync !== undefined) {
	try {
		database = workerData.readonly ? new DatabaseSync(workerData.path, { readOnly: true }) : new DatabaseSync(workerData.path);
		parentPort.postMessage({ id: 0 });
	} catch (error) {
		parentPort.postMessage({ id: 0, failure: failure(error, false) });
	}
}

parentPort.on("message", (request) => {
	try {
		parentPort.postMessage({ id: request.id, value: statements[request.kind](request) });
	} catch (error) {
		parentPort.postMessage({ id: request.id, failure: failure(error, false) });
	}
});
`;

interface ConnectionFailure {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly errcode?: number;
	readonly errstr?: string;
	readonly missingModule?: boolean;
}

interface ConnectionReply {
	readonly id: number;
	readonly value?: unknown;
	readonly failure?: ConnectionFailure;
}

type ConnectionRequest =
	| { readonly kind: "all" | "run"; readonly sql: string; readonly params: readonly unknown[] }
	| { readonly kind: "rows"; readonly sql: string; readonly params: readonly unknown[]; readonly limit: number }
	| { readonly kind: "close" };

interface Waiting {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

function errorOf(failure: ConnectionFailure): Error {
	if (failure.missingModule) return new Error(MISSING_NODE_SQLITE);
	const error = new Error(failure.message);
	error.name = failure.name;
	return Object.assign(error, {
		...(failure.code === undefined ? {} : { code: failure.code }),
		...(failure.errcode === undefined ? {} : { errcode: failure.errcode }),
		...(failure.errstr === undefined ? {} : { errstr: failure.errstr }),
	});
}

function bindValues(params: readonly SqliteSelectorValue[]): unknown[] {
	return params.map((param) => (typeof param === "boolean" ? (param ? 1 : 0) : param));
}

export class SqliteSelectorConnection {
	private readonly waiting = new Map<number, Waiting>();
	private nextId = 1;
	private ended: Error | undefined;
	private closing: Promise<void> | undefined;
	private readonly worker: Worker;

	private constructor(worker: Worker) {
		this.worker = worker;
		worker.on("message", (reply: ConnectionReply) => {
			const waiting = this.waiting.get(reply.id);
			if (waiting === undefined) return;
			this.waiting.delete(reply.id);
			if (reply.failure === undefined) waiting.resolve(reply.value);
			else waiting.reject(errorOf(reply.failure));
		});
		worker.on("error", (error) => this.end(error));
		worker.on("exit", (code) => this.end(new Error(`SQLite selector worker exited with code ${code}`)));
	}

	static async open(path: string, options: { readonly readonly?: boolean } = {}): Promise<SqliteSelectorConnection> {
		// Asked on this thread, without loading the module: the worker starts without the process's flags, so a
		// `--no-experimental-sqlite` given to the process would not reach it.
		if (!isBuiltin("node:sqlite")) throw new Error(MISSING_NODE_SQLITE);
		const worker = new Worker(CONNECTION_SOURCE, {
			eval: true,
			execArgv: evalWorkerExecArgv(),
			workerData: { path, readonly: options.readonly === true },
		});
		const connection = new SqliteSelectorConnection(worker);
		const opened = new Promise<unknown>((resolve, reject) => connection.waiting.set(0, { resolve, reject }));
		try {
			await opened;
		} catch (error) {
			await worker.terminate();
			throw error;
		}
		return connection;
	}

	all(sql: string, params: readonly SqliteSelectorValue[] = []): Promise<SqliteSelectorRow[]> {
		return this.request({ kind: "all", sql, params: bindValues(params) }) as Promise<SqliteSelectorRow[]>;
	}

	/** Transcript entries can contain binary chunks; preserve their SQLite values across the worker boundary. */
	storageRows<T extends SqliteRow>(sql: string, params: readonly SqliteValue[]): Promise<T[]> {
		return this.request({ kind: "all", sql, params }) as Promise<T[]>;
	}

	rows(sql: string, limit: number): Promise<SqliteSelectorRow[]> {
		return this.request({ kind: "rows", sql, params: [], limit }) as Promise<SqliteSelectorRow[]>;
	}

	run(sql: string, params: readonly SqliteSelectorValue[] = []): Promise<{ changes: number }> {
		return this.request({ kind: "run", sql, params: bindValues(params) }) as Promise<{ changes: number }>;
	}

	close(): Promise<void> {
		this.closing ??= this.request({ kind: "close" }).then(
			() => this.worker.terminate().then(() => undefined),
			async (error: unknown) => {
				await this.worker.terminate();
				throw error;
			},
		);
		return this.closing;
	}

	private request(request: ConnectionRequest): Promise<unknown> {
		if (this.ended !== undefined) return Promise.reject(this.ended);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve, reject });
			this.worker.postMessage({ ...request, id });
		});
	}

	private end(error: Error): void {
		this.ended ??= error;
		for (const waiting of this.waiting.values()) waiting.reject(this.ended);
		this.waiting.clear();
	}
}
