import { setTimeout as sleep } from "node:timers/promises";
import { isStorageTransientError, StorageRollbackError, type StorageTransientError } from "./storage/errors.js";

/** A bare SessionManager can wait out a restart, but has no live session to cancel a longer wait. */
const BARE_RECOVERY_MS = 60_000;
const FIRST_NOTICE_MS = 10_000;
const REPEAT_NOTICE_MS = 60_000;
const BACKOFF_MS = 250;

export interface AppendRecoveryNotice {
	readonly state: "waiting" | "recovered";
	readonly elapsedMs: number;
	readonly reconnecting: boolean;
}

export interface LiveAppendRecovery {
	readonly lifetime: AbortSignal;
	readonly signal: () => AbortSignal | undefined;
	readonly notify: (notice: AppendRecoveryNotice) => void;
}

/** Only a dropped or refused PostgreSQL connection is an outage, not a busy lock or a refused write. */
export function postgresAppendConnectionFailure(error: unknown): StorageTransientError | undefined {
	// Storage may be loaded from another module instance by a plugin; only a failed rollback wraps its primary failure.
	const primary = error instanceof Error && error.name === StorageRollbackError.name ? error.cause : error;
	if (
		isStorageTransientError(primary) &&
		primary.adapter === "postgres" &&
		(primary.code === "connection-refused" || primary.code === "connection-lost")
	)
		return primary;
	return undefined;
}

/** Holds one mutation's place in the session queue while it waits for PostgreSQL. Never replays a write itself. */
export class SessionAppendRecovery {
	private readonly started = performance.now();
	private readonly abort = new AbortController();
	private readonly signal: AbortSignal;
	private readonly live: LiveAppendRecovery | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private announced = false;
	private disconnected = false;

	constructor(live?: LiveAppendRecovery) {
		this.live = live;
		const run = live?.signal();
		this.signal = live
			? AbortSignal.any(run ? [this.abort.signal, live.lifetime, run] : [this.abort.signal, live.lifetime])
			: this.abort.signal;
		// Warn even when a driver call is still waiting for its first connection timeout.
		if (!this.signal.aborted) this.scheduleNotice(FIRST_NOTICE_MS);
	}

	cancel(): void {
		this.abort.abort();
	}

	private get remainingMs(): number {
		return this.live ? Infinity : BARE_RECOVERY_MS - (performance.now() - this.started);
	}

	private notify(state: AppendRecoveryNotice["state"]): void {
		const notice = {
			state,
			elapsedMs: Math.round(performance.now() - this.started),
			reconnecting: this.disconnected,
		};
		try {
			if (this.live) this.live.notify(notice);
			else console.error(formatAppendRecoveryNotice(notice));
		} catch {
			// Diagnostic subscribers may not interrupt recovery or turn a committed append into a failure.
		}
	}

	private scheduleNotice(delayMs: number): void {
		this.timer = setTimeout(() => {
			if (this.signal.aborted) return;
			this.announced = true;
			this.notify("waiting");
			this.scheduleNotice(REPEAT_NOTICE_MS);
		}, delayMs);
		this.timer.unref();
	}

	get reconnecting(): boolean {
		return this.disconnected;
	}

	markDisconnected(): void {
		this.disconnected = true;
	}

	async wait(): Promise<boolean> {
		this.markDisconnected();
		const remaining = this.remainingMs;
		if (this.signal.aborted || remaining <= 0) return false;
		// The SQL facade already backs off within a call. Add jitter here for repeated unknown outcomes and retries of calls.
		try {
			await sleep(Math.min(remaining, BACKOFF_MS * (0.8 + Math.random() * 0.4)), undefined, { signal: this.signal });
		} catch (error) {
			if (!this.signal.aborted) throw error;
		}
		return !this.signal.aborted && this.remainingMs > 0;
	}

	finish(saved: boolean): void {
		clearTimeout(this.timer);
		if (saved && this.announced && !this.signal.aborted) this.notify("recovered");
	}
}

export function formatAppendRecoveryNotice({ state, elapsedMs, reconnecting }: AppendRecoveryNotice): string {
	const seconds = Math.round(elapsedMs / 1000);
	if (state === "waiting") {
		return `Waiting for PostgreSQL ${reconnecting ? "to reconnect " : ""}to save this session (${seconds}s elapsed).`;
	}
	return reconnecting
		? `PostgreSQL reconnected after ${seconds}s; session changes saved.`
		: `PostgreSQL saved session changes after ${seconds}s.`;
}
