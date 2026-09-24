import { Client } from "pg";

/**
 * Processes launching DBOS against one fresh system database race on its
 * schema migrations (duplicate migration rows, `CREATE INDEX CONCURRENTLY`
 * deadlocks). Launches take a session-level advisory lock on a dedicated
 * connection, which the server releases if the process dies. The lock is
 * polled with `pg_try_advisory_lock`: a session blocked in `pg_advisory_lock`
 * deadlocks with the holder's concurrent index build.
 *
 * Like Flyway's `lockRetryCount` and Liquibase's changelog lock wait, launch
 * never proceeds without the lock: contention is retried until the deadline and
 * then fails. Like Flyway's `connectRetries`, a failed or dropped lock
 * connection is reopened with a doubling delay inside the same deadline.
 */
export const DBOS_LAUNCH_LOCK_KEY = "4702111234474983745";

const LOCK_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_CONNECT_RETRIES = 3;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 250;
const MAX_CONNECT_RETRY_DELAY_MS = 2_000;

const CONNECTION_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

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
	readonly connectRetries?: number;
	readonly connectRetryDelayMs?: number;
	readonly connect?: (url: string) => Promise<LaunchLockClient>;
}

export class DbosLaunchLockTimeoutError extends Error {
	constructor(waitedMs: number) {
		super(
			`Timed out after ${Math.round(waitedMs / 1000)}s waiting for the DBOS launch lock; another process is still launching DBOS against this database. DBOS was not launched.`,
		);
		this.name = "DbosLaunchLockTimeoutError";
	}
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

export function isLaunchLockConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code !== undefined && (CONNECTION_ERROR_CODES.has(code) || /^08|^57P0[123]$/u.test(code))) return true;
	return /connection terminated|connection refused|server closed the connection/iu.test(error.message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function closeQuietly(client: LaunchLockClient): Promise<void> {
	await client.end().catch(() => undefined);
}

async function acquire(url: string, options: DbosLaunchLockOptions): Promise<LaunchLockClient> {
	const connect = options.connect ?? connectLockClient;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const connectRetries = options.connectRetries ?? DEFAULT_CONNECT_RETRIES;
	const started = performance.now();
	const deadline = started + maxWaitMs;
	let connectFailures = 0;
	let retryDelayMs = options.connectRetryDelayMs ?? DEFAULT_CONNECT_RETRY_DELAY_MS;
	for (;;) {
		let client: LaunchLockClient | undefined;
		try {
			client = await connect(url);
			for (;;) {
				const result = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [
					DBOS_LAUNCH_LOCK_KEY,
				]);
				if (result.rows[0]?.locked === true) return client;
				if (performance.now() >= deadline) throw new DbosLaunchLockTimeoutError(performance.now() - started);
				await sleep(pollIntervalMs);
			}
		} catch (error) {
			if (client !== undefined) await closeQuietly(client);
			if (!isLaunchLockConnectionError(error)) throw error;
			connectFailures += 1;
			if (connectFailures > connectRetries || performance.now() + retryDelayMs >= deadline) throw error;
			await sleep(retryDelayMs);
			retryDelayMs = Math.min(retryDelayMs * 2, MAX_CONNECT_RETRY_DELAY_MS);
		}
	}
}

/** Run `launch` while holding the database's DBOS launch lock; fail rather than launch without it. */
export async function withDbosLaunchLock<T>(
	url: string,
	launch: () => Promise<T>,
	options: DbosLaunchLockOptions = {},
): Promise<T> {
	const client = await acquire(url, options);
	try {
		return await launch();
	} finally {
		await client
			.query("SELECT pg_advisory_unlock($1::bigint) AS locked", [DBOS_LAUNCH_LOCK_KEY])
			.catch(() => undefined);
		await closeQuietly(client);
	}
}
