import type { PoolClient } from "pg";
import { DbosDependencyError } from "./dbos-admission.js";
import { redactedDatabaseMessage } from "./dbos-database-diagnostics.js";

export interface PostgresHealthIdentity {
	readonly url: string;
	readonly identity: string;
}

interface PostgresHealthOperations {
	readonly probe: () => Promise<PostgresHealthIdentity | undefined>;
	readonly url?: () => string;
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

/** pg stops waiting on a slow query but cannot cancel it, so this says nothing about the server's identity. */
export function isQueryReadTimeout(error: unknown): boolean {
	return error instanceof Error && error.message === "Query read timeout";
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
	private healthySinceFailure = false;
	private revision = 0;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly operations: PostgresHealthOperations) {}

	get lastFailure(): Error | undefined {
		return this.failure;
	}

	get endpoint(): string | undefined {
		return this.operations.url?.();
	}

	private retainFailure(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const safe = redactedDatabaseMessage(message, this.endpoint);
		this.failure = new Error(safe);
		this.healthySinceFailure = false;
	}

	private dependencyFailure(message: string): DbosDependencyError {
		return new DbosDependencyError(
			message,
			this.endpoint === undefined
				? undefined
				: { provider: "managed", url: this.endpoint, failure: this.failure?.message },
		);
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
			try {
				await this.operations.validate?.(client);
			} catch (error) {
				if (!isQueryReadTimeout(error) || this.stopped) throw error;
				// The client-side timer can expire for a reply already buffered on a starved host. Ask the
				// read-only identity check once more on this socket; a mismatch is never retried or accepted.
				await this.operations.validate?.(client);
			}
		} catch (error) {
			this.retainFailure(error);
			// An unanswered check is load, not evidence about the server: destroy only this unvalidated
			// socket instead of every concurrent checkout, and let the caller retry admission.
			if (!isQueryReadTimeout(error)) {
				this.invalidate();
				if (this.endpoint === undefined) throw error;
				const failure = this.dependencyFailure(
					"Managed PostgreSQL connection validation refused. Preserve its data and ownership records.",
				);
				throw error instanceof DbosDependencyError ? failure : new Error(failure.message);
			}
			throw this.dependencyFailure("Managed PostgreSQL did not answer a connection identity check in time.");
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
			if (!(isMonitoringConnectionFailure(error) || isQueryReadTimeout(error)) || this.stopped) throw error;
			// A busy host can expire a monitoring connection or read while existing SQL sockets remain healthy.
			// Retry only this read-only probe, never application SQL.
			try {
				identity = await this.operations.probe();
			} catch (retryError) {
				if (!isMonitoringConnectionFailure(retryError)) throw retryError;
				this.retainFailure(retryError);
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
		this.healthySinceFailure = true;
		return identity.url;
	}

	private async refresh(): Promise<string> {
		try {
			const ready = await this.probe();
			if (ready !== undefined) return ready;
		} catch (error) {
			if (isQueryReadTimeout(error)) {
				// An unanswered monitoring query is load, not evidence about the server: keep `available` and
				// every checkout, and start no recovery.
				this.retainFailure(new Error("Managed PostgreSQL did not answer a health check in time."));
				throw this.dependencyFailure("Managed PostgreSQL did not answer a health check in time.");
			}
			// Identity/authentication failures are not permission to restart anything.
			this.retainFailure(error);
			// A refused monitoring connection does not imply existing sockets are unhealthy.
			if (!(error instanceof Error && "code" in error && error.code === "53300")) this.invalidate();
			throw this.endpoint === undefined
				? error
				: this.dependencyFailure(
						"Managed PostgreSQL recovery refused after a health probe failure. Preserve its data and ownership records.",
					);
		}
		if (this.attempts === 0 && (this.failure === undefined || this.healthySinceFailure)) {
			this.retainFailure(new Error("Managed PostgreSQL failed its live health check."));
			this.healthySinceFailure = false;
		}
		this.invalidate();
		if ((this.operations.now ?? Date.now)() < this.nextRecoveryAt)
			throw this.dependencyFailure("Managed Postgres recovery is cooling down after bounded attempts.");
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
				this.retainFailure(error);
			}
		}
		this.attempts = 0;
		this.nextRecoveryAt = (this.operations.now ?? Date.now)() + HEALTH_INTERVAL_MS;
		throw this.dependencyFailure(
			"Managed Postgres is unavailable after bounded recovery. Preserve its data and ownership records.",
		);
	}
}
