import type { PoolClient } from "pg";
import { DbosDependencyError } from "./dbos-admission.js";

export interface PostgresHealthIdentity {
	readonly url: string;
	readonly identity: string;
}

interface PostgresHealthOperations {
	readonly probe: () => Promise<PostgresHealthIdentity | undefined>;
	readonly recover: () => Promise<void>;
	readonly validate?: (client: PoolClient) => Promise<void>;
	readonly wait?: (ms: number) => Promise<void>;
	readonly now?: () => number;
}

const HEALTH_INTERVAL_MS = 5_000;
const RECOVERY_ATTEMPTS = 3;

function isMonitoringConnectionFailure(error: unknown): error is Error {
	if (!(error instanceof Error)) return false;
	if ("code" in error)
		return ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01", "57P02", "57P03"].includes(
			String(error.code),
		);
	// pg's connection timer, not query/statement timeouts or identity/authentication failures.
	return error.message === "timeout expired" || error.message === "Connection terminated due to connection timeout";
}

/** One process-local observer. The recover operation must elect under the shared setup lock. */
export class PostgresHealth {
	private pending?: Promise<string>;
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private available?: PostgresHealthIdentity;
	private attempts = 0;
	private nextRecoveryAt = 0;
	private failure?: Error;
	private revision = 0;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly operations: PostgresHealthOperations) {}

	get lastFailure(): Error | undefined {
		return this.failure;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	invalidate(): void {
		this.revision++;
		this.available = undefined;
		for (const listener of this.listeners) listener();
	}

	async validate(client: PoolClient): Promise<void> {
		try {
			if (this.stopped) throw new DbosDependencyError();
			await this.operations.validate?.(client);
		} catch (error) {
			this.failure = error instanceof Error ? error : new Error(String(error));
			this.invalidate();
			throw error;
		}
	}

	check(): Promise<string> {
		if (this.stopped) return Promise.reject(new Error("Managed Postgres health observer is stopped."));
		this.pending ??= this.refresh().finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}

	start(): void {
		if (this.stopped || this.timer !== undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.check()
				.catch(() => {})
				.finally(() => this.start());
		}, HEALTH_INTERVAL_MS);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		await this.pending?.catch(() => {});
		this.listeners.clear();
	}

	private async probe(): Promise<string | undefined> {
		const revision = this.revision;
		let identity: PostgresHealthIdentity | undefined;
		try {
			identity = await this.operations.probe();
		} catch (error) {
			if (!isMonitoringConnectionFailure(error) || this.stopped) throw error;
			// A busy host can expire a monitoring connection while existing SQL sockets remain healthy.
			// Retry only this read-only probe, never borrowed-client validation or application SQL.
			try {
				identity = await this.operations.probe();
			} catch (retryError) {
				if (!isMonitoringConnectionFailure(retryError)) throw retryError;
				this.failure = retryError;
				return undefined;
			}
		}
		if (revision !== this.revision) return undefined;
		if (this.stopped) throw new Error("Managed Postgres health observer is stopped.");
		if (!identity) return undefined;
		if (this.available && this.available.identity !== identity.identity) this.invalidate();
		this.available = identity;
		this.attempts = 0;
		this.nextRecoveryAt = 0;
		return identity.url;
	}

	private async refresh(): Promise<string> {
		try {
			const ready = await this.probe();
			if (ready !== undefined) return ready;
		} catch (error) {
			// Identity/authentication failures are not permission to restart anything.
			this.failure = error instanceof Error ? error : new Error(String(error));
			// A refused monitoring connection does not imply existing sockets are unhealthy.
			if (!(error instanceof Error && "code" in error && error.code === "53300")) this.invalidate();
			throw error;
		}
		// Preserve the latest outage for diagnostics even after automatic recovery.
		if (this.attempts === 0)
			this.failure = new DbosDependencyError("Managed PostgreSQL failed its live health check.");
		this.invalidate();
		if ((this.operations.now ?? Date.now)() < this.nextRecoveryAt)
			throw new DbosDependencyError("Managed Postgres recovery is cooling down after bounded attempts.");
		while (!this.stopped && this.attempts < RECOVERY_ATTEMPTS) {
			const attempt = this.attempts++;
			if (attempt > 0)
				await (this.operations.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
					250 * 2 ** (attempt - 1),
				);
			if (this.stopped) break;
			try {
				await this.operations.recover();
				const ready = await this.probe();
				if (ready !== undefined) return ready;
			} catch (error) {
				this.failure = error instanceof Error ? error : new Error(String(error));
			}
		}
		this.attempts = 0;
		this.nextRecoveryAt = (this.operations.now ?? Date.now)() + HEALTH_INTERVAL_MS;
		throw new DbosDependencyError(
			"Managed Postgres is unavailable after bounded recovery. Preserve its data and ownership records.",
		);
	}
}
