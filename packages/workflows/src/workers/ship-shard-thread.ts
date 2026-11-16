import { mkdir } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import { Worker } from "node:worker_threads";
import {
	payloadTooLargeKind,
	SQLITE_PAYLOAD_LIMITS,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteRunResult,
	type SqliteValue,
	type StorageDescriptor,
	StorageInvalidTextError,
	StoragePayloadTooLargeError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StoreClosedError,
} from "@bastani/atomic/storage";

const BUSY_TIMEOUT_MS = 5_000;
const MAX_GROUP_COMMIT_TRANSACTIONS = 128;
const WINDOWS_SQLITE_PLAIN_PATH_LIMIT = 240;
const OPENED = 0;

const CONNECTION_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let database;

function switchToWriteAheadLog() {
	const started = performance.now();
	let delay = 5;
	for (;;) {
		try {
			database.exec("PRAGMA journal_mode = WAL");
			return;
		} catch (error) {
			const code = typeof error?.errcode === "number" ? error.errcode : 0;
			const limit = (code & 0xff) === 5 ? workerData.busyTimeoutMs : code === 1546 ? Math.min(workerData.busyTimeoutMs, 5000) : 0;
			const remaining = started + limit - performance.now();
			if (remaining <= 0) throw error;
			Atomics.wait(sleeper, 0, 0, Math.min(delay, remaining));
			delay = Math.min(delay * 2, 100);
		}
	}
}

function normalize(row) {
	const result = {};
	for (const [key, value] of Object.entries(row))
		result[key] = typeof value === "bigint" && value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
	return result;
}

const prepared = new Map();

function statement(sql) {
	let cached = prepared.get(sql);
	if (cached === undefined) {
		cached = database.prepare(sql);
		cached.setReadBigInts(true);
		prepared.set(sql, cached);
	}
	return cached;
}

const statements = {
	exec: (request) => { database.exec(request.sql); },
	run: (request) => ({ changes: Number(statement(request.sql).run(...request.params).changes) }),
	get: (request) => {
		const row = statement(request.sql).get(...request.params);
		return row === undefined ? undefined : normalize(row);
	},
	all: (request) => statement(request.sql).all(...request.params).map(normalize),
	close: () => {
		prepared.clear();
		database.close();
		globalThis.Bun?.gc?.(true);
	},
};

function failure(error) {
	return {
		name: error?.name ?? "Error",
		message: String(error?.message ?? error),
		code: error?.code,
		errcode: error?.errcode,
		errstr: error?.errstr,
	};
}

try {
	database = new DatabaseSync(workerData.path);
	database.exec("PRAGMA busy_timeout=" + workerData.busyTimeoutMs);
	switchToWriteAheadLog();
	database.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
	parentPort.postMessage({ id: workerData.opened });
} catch (error) {
	try { database?.close(); } catch {}
	parentPort.postMessage({ id: workerData.opened, failure: failure(error) });
}

parentPort.on("message", (request) => {
	try {
		parentPort.postMessage({ id: request.id, value: statements[request.kind](request) });
	} catch (error) {
		parentPort.postMessage({ id: request.id, failure: failure(error) });
	}
});
`;

type StatementKind = "exec" | "run" | "get" | "all";
type StatementValue = SqliteRunResult | SqliteRow | SqliteRow[] | undefined;
type ConnectionRequest =
	| { readonly kind: StatementKind; readonly sql: string; readonly params: readonly SqliteValue[] }
	| { readonly kind: "close" };

interface ConnectionFailure {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly errcode?: number;
	readonly errstr?: string;
}

interface ConnectionReply {
	readonly id: number;
	readonly value?: StatementValue;
	readonly failure?: ConnectionFailure;
}

interface Waiting {
	readonly resolve: (value: StatementValue) => void;
	readonly reject: (error: Error) => void;
}

interface Member {
	readonly callback: (transaction: SqliteExecutor) => Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
}

type Job =
	| { readonly kind: "statement"; readonly run: () => Promise<void> }
	| { readonly kind: "transaction"; readonly member: Member };

type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

function sqliteOpenPath(path: string): string {
	if (process.platform !== "win32") return path;
	return win32.resolve(path).length > WINDOWS_SQLITE_PLAIN_PATH_LIMIT ? win32.toNamespacedPath(path) : path;
}

function causeOf(failure: ConnectionFailure): Error {
	const cause = new Error(failure.message);
	cause.name = failure.name;
	return Object.assign(cause, {
		...(failure.code === undefined ? {} : { code: failure.code }),
		...(failure.errcode === undefined ? {} : { errcode: failure.errcode }),
		...(failure.errstr === undefined ? {} : { errstr: failure.errstr }),
	});
}

function snapshotParams(params: readonly SqliteValue[]): SqliteValue[] {
	return params.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value));
}

class ThreadedSqliteDatabase implements SqliteDatabase {
	readonly descriptor: StorageDescriptor;
	readonly opened: Promise<void>;
	private readonly worker: Worker;
	private readonly replies = new Map<number, Waiting>();
	private readonly queue: Job[] = [];
	private readonly executor: SqliteExecutor;
	private nextId = OPENED + 1;
	private draining = false;
	private closing = false;
	private closed?: Promise<void>;
	private lost?: Error;

	constructor(path: string, busyTimeoutMs: number) {
		this.descriptor = { adapter: "node-sqlite", location: path };
		this.executor = this.createExecutor(() => true);
		this.worker = new Worker(CONNECTION_SOURCE, {
			eval: true,
			execArgv: [],
			workerData: { path: sqliteOpenPath(path), busyTimeoutMs, opened: OPENED },
		});
		this.opened = new Promise<StatementValue>((resolve, reject) =>
			this.replies.set(OPENED, { resolve, reject }),
		).then(() => {});
		this.worker.on("message", (reply: ConnectionReply) => this.settle(reply));
		this.worker.on("error", (error: Error) => this.lose(error));
		this.worker.on("exit", (code: number) =>
			this.lose(new Error(`SQLite connection thread exited with code ${code}`)),
		);
	}

	private unavailable(cause: Error): Error {
		if (payloadTooLargeKind(cause) !== undefined)
			return new StoragePayloadTooLargeError(SQLITE_PAYLOAD_LIMITS.value ?? 0, 0, {
				descriptor: this.descriptor,
				cause,
			});
		const code = (cause as { errcode?: number }).errcode;
		const detail =
			cause.message === ""
				? undefined
				: code === undefined
					? cause.message
					: `${cause.message} (SQLite code ${code})`;
		return new StorageUnavailableError(this.descriptor, cause, detail);
	}

	private settle(reply: ConnectionReply): void {
		const waiting = this.replies.get(reply.id);
		if (waiting === undefined) return;
		this.replies.delete(reply.id);
		if (this.replies.size === 0) this.worker.unref();
		if (reply.failure === undefined) waiting.resolve(reply.value);
		else waiting.reject(this.unavailable(causeOf(reply.failure)));
	}

	private lose(cause: Error): void {
		if (this.lost !== undefined) return;
		this.lost = this.unavailable(cause);
		for (const waiting of this.replies.values()) waiting.reject(this.lost);
		this.replies.clear();
		this.worker.unref();
	}

	private request(request: ConnectionRequest): Promise<StatementValue> {
		if (this.lost !== undefined) return Promise.reject(this.lost);
		const id = this.nextId++;
		return new Promise<StatementValue>((resolve, reject) => {
			this.worker.postMessage({ id, ...request });
			if (this.replies.size === 0) this.worker.ref();
			this.replies.set(id, { resolve, reject });
		});
	}

	private statement(kind: StatementKind, sql: string, params: readonly SqliteValue[]): Promise<StatementValue> {
		const invalidIndex = params.findIndex((value) => typeof value === "string" && value.includes("\0"));
		if (invalidIndex !== -1) return Promise.reject(new StorageInvalidTextError(invalidIndex));
		return this.request({ kind, sql, params });
	}

	private createExecutor(active: () => boolean): SqliteExecutor {
		const execute = (kind: StatementKind, sql: string, params: readonly SqliteValue[] = []) =>
			active() ? this.statement(kind, sql, params) : Promise.reject(new StorageTransactionClosedError());
		return {
			exec: async (sql) => {
				await execute("exec", sql);
			},
			run: async (sql, ...params) => (await execute("run", sql, params)) as SqliteRunResult,
			get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				(await execute("get", sql, params)) as T | undefined,
			all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				(await execute("all", sql, params)) as T[],
		};
	}

	private schedule(job: Job): void {
		this.queue.push(job);
		if (this.draining) return;
		this.draining = true;
		queueMicrotask(() => void this.drain());
	}

	private async drain(): Promise<void> {
		for (let job = this.queue.shift(); job !== undefined; job = this.queue.shift()) {
			if (job.kind === "statement") {
				await job.run();
				continue;
			}
			const members = [job.member];
			for (
				let next = this.queue[0];
				members.length < MAX_GROUP_COMMIT_TRANSACTIONS && next?.kind === "transaction";
				next = this.queue[0]
			) {
				this.queue.shift();
				members.push(next.member);
			}
			await this.commit(members);
		}
		this.draining = false;
	}

	private enqueueStatement<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new StoreClosedError(this.descriptor));
		return new Promise<T>((resolve, reject) =>
			this.schedule({ kind: "statement", run: () => operation().then(resolve, reject) }),
		);
	}

	exec(sql: string): Promise<void> {
		return this.enqueueStatement(() => this.executor.exec(sql));
	}

	run(sql: string, ...params: readonly SqliteValue[]): Promise<SqliteRunResult> {
		const bound = snapshotParams(params);
		return this.enqueueStatement(() => this.executor.run(sql, ...bound));
	}

	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined> {
		const bound = snapshotParams(params);
		return this.enqueueStatement(() => this.executor.get<T>(sql, ...bound));
	}

	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
		const bound = snapshotParams(params);
		return this.enqueueStatement(() => this.executor.all<T>(sql, ...bound));
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new StoreClosedError(this.descriptor));
		return new Promise<T>((resolve, reject) =>
			this.schedule({
				kind: "transaction",
				member: { callback, resolve: resolve as (value: unknown) => void, reject },
			}),
		);
	}

	private async commit(members: Member[]): Promise<void> {
		try {
			await this.executor.exec("BEGIN IMMEDIATE");
		} catch (cause) {
			for (const member of members) member.reject(cause);
			return;
		}
		if (members.length === 1) await this.commitAlone(members[0]!);
		else await this.commitMembers(members);
	}

	private async commitAlone(member: Member): Promise<void> {
		let active = true;
		try {
			const value = await member.callback(this.createExecutor(() => active));
			active = false;
			await this.executor.exec("COMMIT");
			member.resolve(value);
		} catch (cause) {
			active = false;
			try {
				await this.executor.exec("ROLLBACK");
			} catch (rollbackCause) {
				member.reject(this.rollbackFailure(cause, rollbackCause));
				return;
			}
			member.reject(cause);
		}
	}

	private pipelined(sql: string): Promise<void> {
		const sent = this.executor.exec(sql);
		sent.catch(() => {});
		return sent;
	}

	private async commitMembers(members: Member[]): Promise<void> {
		const outcomes: Outcome[] = [];
		const released: Promise<void>[] = [];
		for (const member of members) {
			const savepoint = `atomic_group_${outcomes.length}`;
			const opened = this.pipelined(`SAVEPOINT ${savepoint}`);
			let active = true;
			try {
				const value = await member.callback(this.createExecutor(() => active));
				active = false;
				await opened;
				released.push(this.pipelined(`RELEASE ${savepoint}`));
				outcomes.push({ ok: true, value });
			} catch (cause) {
				active = false;
				try {
					await opened;
					await this.executor.exec(`ROLLBACK TO ${savepoint}`);
					await this.executor.exec(`RELEASE ${savepoint}`);
				} catch (rollbackCause) {
					await this.abandonMembers(members, outcomes, cause, rollbackCause as Error);
					return;
				}
				outcomes.push({ ok: false, error: cause });
			}
		}
		let commitCause: unknown;
		let committed = true;
		try {
			await Promise.all(released);
			await this.executor.exec("COMMIT");
		} catch (cause) {
			committed = false;
			commitCause = cause;
			await this.rollbackQuietly();
		}
		members.forEach((member, index) => {
			const outcome = outcomes[index]!;
			if (!committed) member.reject(outcome.ok ? commitCause : outcome.error);
			else if (outcome.ok) member.resolve(outcome.value);
			else member.reject(outcome.error);
		});
	}

	private async abandonMembers(
		members: Member[],
		outcomes: readonly Outcome[],
		cause: unknown,
		rollbackCause: Error,
	): Promise<void> {
		await this.rollbackQuietly();
		const failed = outcomes.length;
		members.slice(0, failed).forEach((member, index) => {
			const outcome = outcomes[index]!;
			member.reject(outcome.ok ? (this.lost ?? this.unavailable(rollbackCause)) : outcome.error);
		});
		members[failed]!.reject(this.rollbackFailure(cause, rollbackCause));
		this.queue.unshift(...members.slice(failed + 1).map((member) => ({ kind: "transaction" as const, member })));
	}

	private rollbackFailure(cause: unknown, rollbackCause: unknown): unknown {
		return rollbackCause === this.lost ? cause : new StorageRollbackError(cause as Error, rollbackCause as Error);
	}

	private async rollbackQuietly(): Promise<void> {
		await this.executor.exec("ROLLBACK").catch(() => {});
	}

	close(): Promise<void> {
		if (this.closed === undefined) {
			this.closed = new Promise<void>((resolve, reject) =>
				this.schedule({
					kind: "statement",
					run: () =>
						(this.lost === undefined ? this.request({ kind: "close" }) : Promise.resolve(undefined))
							.finally(() => this.terminate())
							.then(() => resolve(), reject),
				}),
			);
			this.closing = true;
		}
		return this.closed;
	}

	async terminate(): Promise<void> {
		await this.worker.terminate();
	}
}

export async function openThreadedSqliteDatabase(
	path: string,
	busyTimeoutMs = BUSY_TIMEOUT_MS,
): Promise<SqliteDatabase> {
	await mkdir(dirname(path), { recursive: true });
	const database = new ThreadedSqliteDatabase(path, busyTimeoutMs);
	try {
		await database.opened;
	} catch (error) {
		await database.terminate();
		throw error;
	}
	return database;
}
