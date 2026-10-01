import { getPGClientConfig } from "@dbos-inc/dbos-sdk/datasource";
import { Pool, type PoolClient } from "pg";
import { DbosDependencyError } from "./dbos-admission.js";

interface RecoverablePostgresPoolOptions {
	readonly beforeConnect?: () => Promise<string>;
	readonly afterConnect?: (client: PoolClient) => Promise<void>;
	readonly onConnectionError?: (error: Error) => void;
	readonly onEnd?: () => void;
	readonly createPool?: (url: string) => Pool;
}

/** Keep DBOS's pool object stable while replacing its physical connections. Never replay SQL. */
export function createRecoverablePostgresPool(
	initialUrl: string,
	options: RecoverablePostgresPoolOptions = {},
): { pool: Pool; invalidate: () => void } {
	const pool = new Pool(getPGClientConfig(initialUrl));
	const endFacade = pool.end.bind(pool);
	const createPool = options.createPool ?? ((url: string) => new Pool(getPGClientConfig(url)));
	const draining = new Set<Promise<void>>();
	const checkouts = new Map<Pool, Set<{ client: PoolClient; release: PoolClient["release"] }>>();
	let current: Pool | undefined;
	let currentUrl = initialUrl;
	let closed = false;
	let ending: Promise<void> | undefined;
	// pg requires an idle-error listener even when the SDK has not installed one yet.
	pool.on("error", () => {});

	function retire(physical: Pool): void {
		const pending = physical.end();
		draining.add(pending);
		void pending.then(
			() => draining.delete(pending),
			() => draining.delete(pending),
		);
	}
	function invalidate(): void {
		const previous = current;
		current = undefined;
		if (previous !== undefined) {
			const held = [...(checkouts.get(previous) ?? [])];
			retire(previous);
			// Destroy all checkouts before notifying: SDK error handlers can reentrantly release.
			for (const { release } of held) release(true);
			for (const { client } of held) {
				// An idle LISTEN client only emits end on destruction; DBOS needs error.
				if (client.listenerCount("error") > 0) {
					client.emit("error", new DbosDependencyError("Postgres dependency invalidated"));
				}
			}
		}
	}
	function physicalPool(url: string): Pool {
		if (current !== undefined && url !== currentUrl) invalidate();
		if (current === undefined) {
			currentUrl = url;
			const physical = createPool(url);
			current = physical;
			pool.options = physical.options;
			physical.on("error", (error, client) => {
				if (!closed && current === physical) {
					invalidate();
					options.onConnectionError?.(error);
					pool.emit("error", error, client);
				}
			});
			for (const event of ["connect", "acquire", "remove"] as const) {
				physical.on(event, (client) => pool.emit(event, client));
			}
			physical.on("release", (error, client) => pool.emit("release", error, client));
		}
		return current;
	}
	physicalPool(initialUrl);
	for (const property of ["totalCount", "idleCount", "waitingCount", "expiredCount"] as const) {
		Object.defineProperty(pool, property, { get: () => current?.[property] ?? 0 });
	}

	async function acquire(): Promise<PoolClient> {
		if (closed) throw new Error("Cannot use a pool after calling end on the pool");
		const url = options.beforeConnect === undefined ? currentUrl : await options.beforeConnect();
		if (closed) throw new Error("Cannot use a pool after calling end on the pool");
		const physical = physicalPool(url);
		let client: PoolClient;
		try {
			client = await physical.connect();
		} catch (error) {
			// Queue timeouts and server capacity refusals are admission pressure, not failed sockets.
			// pg-pool's queue timeout has no code; new-client timeouts use a different message.
			const admissionPressure =
				error instanceof Error &&
				("code" in error ? error.code === "53300" : error.message === "timeout exceeded when trying to connect");
			if (!admissionPressure && !closed && current === physical) {
				invalidate();
				if (error instanceof Error) options.onConnectionError?.(error);
			}
			throw error;
		}
		if (closed || current !== physical) {
			client.release(true);
			throw new Error("Postgres connection pool changed while acquiring a connection");
		}
		const nativeRelease = client.release.bind(client);
		let released = false;
		const checkout = {
			client,
			release(error?: Error | boolean) {
				if (released) return;
				released = true;
				const held = checkouts.get(physical);
				held?.delete(checkout);
				if (held?.size === 0) checkouts.delete(physical);
				nativeRelease(error);
			},
		};
		const held = checkouts.get(physical) ?? new Set();
		held.add(checkout);
		checkouts.set(physical, held);
		client.release = checkout.release;
		// Until validation finishes there is no caller to observe client socket errors.
		let validationFailure: Error | undefined;
		const validationError = (error: Error) => {
			validationFailure = error;
		};
		client.on("error", validationError);
		try {
			await options.afterConnect?.(client);
			if (closed || current !== physical) throw new Error("Postgres connection pool changed during validation");
			if (validationFailure !== undefined) throw validationFailure;
		} catch (error) {
			checkout.release(true);
			throw error;
		} finally {
			client.removeListener("error", validationError);
		}
		return client;
	}
	function connect(): Promise<PoolClient>;
	function connect(
		callback: (
			error: Error | undefined,
			client: PoolClient | undefined,
			done: (release?: Error | boolean) => void,
		) => void,
	): void;
	function connect(
		callback?: (
			error: Error | undefined,
			client: PoolClient | undefined,
			done: (release?: Error | boolean) => void,
		) => void,
	): Promise<PoolClient> | undefined {
		const pending = acquire();
		if (callback === undefined) return pending;
		void pending.then(
			(client) => callback(undefined, client, client.release.bind(client)),
			(error: Error) => callback(error, undefined, () => {}),
		);
	}
	pool.connect = connect;
	function end(): Promise<void>;
	function end(callback: () => void): void;
	function end(callback?: () => void): Promise<void> | undefined {
		if (ending === undefined) {
			closed = true;
			options.onEnd?.();
			invalidate();
			ending = Promise.all([...draining, endFacade()]).then(() => {});
		}
		if (callback === undefined) return ending;
		void ending.then(callback, (error: Error) => Reflect.apply(callback, undefined, [error]));
	}
	pool.end = end;
	return { pool, invalidate };
}
