import { Client } from "pg";

/**
 * Processes launching DBOS against one fresh system database race on its
 * schema migrations (duplicate migration rows, `CREATE INDEX CONCURRENTLY`
 * deadlocks). Launches take a session-level advisory lock on a dedicated
 * connection, which the server releases if the process dies. The lock is
 * polled with `pg_try_advisory_lock`: a session blocked in `pg_advisory_lock`
 * deadlocks with the holder's concurrent index build.
 */
export const DBOS_LAUNCH_LOCK_KEY = "4702111234474983745";

const LOCK_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_WAIT_MS = 60_000;

export interface LaunchLockClient {
	query(
		text: string,
		values?: readonly unknown[],
	): Promise<{ readonly rows: readonly { readonly locked?: boolean }[] }>;
	end(): Promise<void>;
}

export interface DbosLaunchLockOptions {
	readonly pollIntervalMs?: number;
	readonly maxWaitMs?: number;
	readonly connect?: (url: string) => Promise<LaunchLockClient>;
}

async function connectLockClient(url: string): Promise<LaunchLockClient> {
	const client = new Client({ connectionString: url, connectionTimeoutMillis: LOCK_CONNECT_TIMEOUT_MS });
	client.on("error", () => {});
	try {
		await client.connect();
	} catch (error) {
		await client.end().catch(() => undefined);
		throw error;
	}
	return {
		query: async (text, values) => await client.query(text, values === undefined ? undefined : [...values]),
		end: async () => await client.end(),
	};
}

async function acquire(client: LaunchLockClient, pollIntervalMs: number, maxWaitMs: number): Promise<boolean> {
	const deadline = performance.now() + maxWaitMs;
	for (;;) {
		const result = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [DBOS_LAUNCH_LOCK_KEY]);
		if (result.rows[0]?.locked === true) return true;
		if (performance.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

/** Run `launch` while holding the database's DBOS launch lock, or without it if the lock is unavailable. */
export async function withDbosLaunchLock<T>(
	url: string,
	launch: () => Promise<T>,
	options: DbosLaunchLockOptions = {},
): Promise<T> {
	const connect = options.connect ?? connectLockClient;
	let client: LaunchLockClient;
	try {
		client = await connect(url);
	} catch {
		return await launch();
	}
	let locked = false;
	try {
		locked = await acquire(
			client,
			options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
			options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
		).catch(() => false);
		return await launch();
	} finally {
		if (locked) {
			await client
				.query("SELECT pg_advisory_unlock($1::bigint) AS locked", [DBOS_LAUNCH_LOCK_KEY])
				.catch(() => undefined);
		}
		await client.end().catch(() => undefined);
	}
}
