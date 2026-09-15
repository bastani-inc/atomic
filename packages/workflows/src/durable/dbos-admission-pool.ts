import type { Pool, PoolClient, QueryResult } from "pg";
import { raceAbort } from "../shared/abort.js";
import { DbosDependencyError, dbosAdmissionContext } from "./dbos-admission.js";

/** The SDK's supported custom-pool seam, scoped to admission, not other runs. */
export function fenceDbosAdmissionPool(pool: Pool): Pool {
	const connect = pool.connect.bind(pool);
	async function acquire(signal: AbortSignal): Promise<PoolClient> {
		if (signal.aborted) throw new DbosDependencyError();
		const pending = connect().then((client) => {
			if (signal.aborted) {
				client.release(true);
				throw new DbosDependencyError();
			}
			return fencedClient(client, signal);
		});
		try {
			return await raceAbort(pending, signal);
		} catch (error) {
			throw databaseError(error, signal);
		}
	}
	function scopedConnect(): Promise<PoolClient>;
	function scopedConnect(
		callback: (
			error: Error | undefined,
			client: PoolClient | undefined,
			done: (release?: Error | boolean) => void,
		) => void,
	): void;
	function scopedConnect(
		callback?: (
			error: Error | undefined,
			client: PoolClient | undefined,
			done: (release?: Error | boolean) => void,
		) => void,
	): Promise<PoolClient> | undefined {
		const signal = dbosAdmissionContext.getStore();
		if (signal === undefined) {
			if (callback === undefined) return connect();
			connect(callback);
			return;
		}
		const pending = acquire(signal);
		if (callback === undefined) return pending;
		void pending.then(
			(client) => callback(undefined, client, client.release),
			(error: Error) => callback(error, undefined, () => {}),
		);
	}
	pool.connect = scopedConnect;
	return pool;
}

function fencedClient(client: PoolClient, signal: AbortSignal): PoolClient {
	let released = false;
	const release = (error?: Error | boolean): void => {
		if (released) return;
		released = true;
		signal.removeEventListener("abort", abort);
		client.release(error);
	};
	const abort = (): void => release(true);
	signal.addEventListener("abort", abort, { once: true });
	// Preserve pg's overloads while adapting both its callback and promise forms.
	const query = new Proxy(client.query, {
		apply(target, _receiver, args: Parameters<PoolClient["query"]>) {
			const values = [...args];
			const last = values.at(-1);
			const callback =
				typeof last === "function"
					? (values.pop() as (error: Error | null, result?: QueryResult) => void)
					: undefined;
			const pending = (async () => {
				if (signal.aborted || released) throw new DbosDependencyError();
				try {
					return await raceAbort(
						new Promise<QueryResult>((resolve, reject) => {
							Reflect.apply(target, client, [
								...values,
								(error: Error | null, result: QueryResult) => {
									if (error) reject(error);
									else resolve(result);
								},
							]);
						}),
						signal,
					);
				} catch (error) {
					throw databaseError(error, signal);
				}
			})();
			if (callback === undefined) return pending;
			void pending.then(
				(result) => callback(null, result),
				(error: Error) => callback(error),
			);
		},
	});
	return new Proxy(client, {
		get(target, property, receiver) {
			if (property === "query") return query;
			if (property === "release") return release;
			return Reflect.get(target, property, receiver);
		},
	});
}

// Include every SQLSTATE class/errno retried by the SDK, plus DNS and broken pipes.
const connectionErrnos = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
]);
// pg/pg-pool emit these without a code; the SDK also retries their messages.
const connectionMessages = new Set([
	"Connection terminated unexpectedly",
	"Connection terminated due to connection timeout",
	"Client has encountered a connection error and is not queryable",
	"timeout exceeded when trying to connect",
]);

function databaseError(error: unknown, signal: AbortSignal): unknown {
	if (signal.aborted) return new DbosDependencyError();
	const pending = [error];
	const seen = new Set<object>();
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value !== "object" || value === null || seen.has(value)) continue;
		seen.add(value);
		if ("cause" in value) pending.push(value.cause);
		if ("error" in value) pending.push(value.error);
		if ("errors" in value && Array.isArray(value.errors)) pending.push(...value.errors);
		const code = "code" in value && typeof value.code === "string" ? value.code : undefined;
		const message = value instanceof Error ? value.message : "";
		if (
			(code !== undefined && (/^(?:08|53|57)[0-9A-Z]{3}$|^40003$/.test(code) || connectionErrnos.has(code))) ||
			(code === undefined && connectionMessages.has(message))
		) {
			// Do not let these errors enter DBOS's uninterruptible dbRetry backoff.
			return new DbosDependencyError();
		}
	}
	return error;
}
