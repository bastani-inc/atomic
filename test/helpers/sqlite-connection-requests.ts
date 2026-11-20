import {
	type ConnectionAnswer,
	type ConnectionRequest,
	ThreadConnection,
} from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";

/** Sends `request` to the connection's thread as the adapter would. */
export type SendRequest = (request: ConnectionRequest) => Promise<ConnectionAnswer>;

export interface RequestInterception {
	restore(): void;
}

/**
 * Routes every request a node-sqlite adapter connection sends its thread through `handler` until `restore`: the
 * opens, statements, `BEGIN IMMEDIATE` attempts, clock reads and closes of every connection `openNodeSqliteDatabase`
 * opened on a file. The handler sees each request before it is sent, can change it, answer it or fail it, and sees its
 * answer. In-memory databases and connections passed to `wrapNodeSqliteDatabase` run on the caller's thread instead,
 * where `DatabaseSync.prototype` is what to intercept.
 */
export function interceptConnectionRequests(
	handler: (request: ConnectionRequest, send: SendRequest, connection: ThreadConnection) => Promise<ConnectionAnswer>,
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

/** The SQL `request` runs, for a statement request; undefined for the others. */
export function requestSql(request: ConnectionRequest): string | undefined {
	return "sql" in request ? request.sql : undefined;
}
