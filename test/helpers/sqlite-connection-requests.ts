import {
	type ConnectionRequest,
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
