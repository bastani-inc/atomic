import { setImmediate as realTurn } from "node:timers/promises";
import {
	type ConnectionRequest,
	type ConnectionStatement,
	type ConnectionValue,
	ThreadConnection,
} from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";

/** Sends `request` to the connection's thread as the adapter would. */
export type SendRequest = (request: ConnectionRequest) => Promise<ConnectionValue>;

export interface RequestInterception {
	restore(): void;
}

/**
 * Routes every request a node-sqlite adapter connection sends its thread through `handler` until `restore`: the
 * statements, `BEGIN IMMEDIATE` attempts, clock reads and closes of every connection `openNodeSqliteDatabase` opened.
 * The handler sees each request before it is sent, can change it, answer it or fail it, and sees its outcome. A
 * connection a caller opened and passed to `wrapNodeSqliteDatabase` runs on the caller's thread instead, where
 * `DatabaseSync.prototype` is what to intercept.
 */
export function interceptConnectionRequests(
	handler: (request: ConnectionRequest, send: SendRequest, connection: ThreadConnection) => Promise<ConnectionValue>,
): RequestInterception {
	const original = ThreadConnection.prototype.request;
	ThreadConnection.prototype.request = function (this: ThreadConnection, request: ConnectionRequest) {
		return handler(request, (next) => original.call(this, next), this);
	};
	return {
		restore: () => {
			ThreadConnection.prototype.request = original;
		},
	};
}

/** Whether `request` executes `sql`, as an `exec` request. */
export function isExec(request: ConnectionRequest, sql: string): boolean {
	return request.kind === "exec" && request.sql === sql;
}

/** A call of SQLite's clock functions with plain arguments: `unixepoch()`, `unixepoch('subsec')`, `julianday('now')`. */
const CLOCK_CALL = /\b(unixepoch|julianday)\s*\(([^()]*)\)/gi;

/**
 * Makes every adapter connection read SQLite's clock from `now` until `restore`, as a test's `node:sqlite` mock that
 * registers `unixepoch` and `julianday` does for connections on the test's thread: each call in a statement becomes the
 * time `now` returns as the statement is sent, and the writers' queue reads `now` too. Schema statements keep the
 * functions, so a column default still reads the clock when a row is written.
 */
export function clockConnections(now: () => number): RequestInterception {
	const clocked = (sql: string): string =>
		/^\s*(?:CREATE|ALTER|DROP)\b/i.test(sql)
			? sql
			: sql.replace(CLOCK_CALL, (_call, name: string) => {
					const at = now();
					return name.toLowerCase() === "unixepoch" ? `(${at / 1_000})` : `(${at / 86_400_000 + 2_440_587.5})`;
				});
	return interceptConnectionRequests((request, send) => {
		if (request.kind === "now") return Promise.resolve(now());
		// A batch's statements, sent together.
		const clockedStatements = (statements: readonly ConnectionStatement[]) =>
			statements.map((statement) => ({ ...statement, sql: clocked(statement.sql) }));
		if ("statements" in request) return send({ ...request, statements: clockedStatements(request.statements) });
		// A group's members, sent together.
		if ("members" in request) return send({ ...request, members: request.members.map(clockedStatements) });
		if (!("sql" in request)) return send(request);
		const sql = clocked(request.sql);
		return send(sql === request.sql ? request : ({ ...request, sql } as ConnectionRequest));
	});
}

/** Most real event-loop turns `settled` waits for the connections' threads; far past any statement a test runs. */
const SETTLE_TURNS = 100_000;

export interface ConnectionRequestTracker extends RequestInterception {
	/** Requests sent to a connection's thread and not answered yet. */
	readonly pending: number;
	/**
	 * Resolves once no request has been in flight for two real event-loop turns, so the code that awaited an answer
	 * has run on to its next step. A test that steps fake timers calls it between steps, as it waits for file I/O: an
	 * answer from a connection's thread arrives on a real turn, never on a fake timer.
	 */
	settled(): Promise<void>;
}

/** Counts the requests every adapter connection has in flight until `restore`; see `ConnectionRequestTracker`. */
export function trackConnectionRequests(): ConnectionRequestTracker {
	let pending = 0;
	const interception = interceptConnectionRequests(async (request, send) => {
		pending++;
		try {
			return await send(request);
		} finally {
			pending--;
		}
	});
	return {
		restore: interception.restore,
		get pending() {
			return pending;
		},
		async settled() {
			let quiet = 0;
			for (let turn = 0; turn < SETTLE_TURNS && quiet < 2; turn++) {
				await realTurn();
				quiet = pending === 0 ? quiet + 1 : 0;
			}
		},
	};
}
