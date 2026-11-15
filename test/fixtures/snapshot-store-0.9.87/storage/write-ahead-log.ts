type Awaitable<T> = T | Promise<T>;

/** The first wait before another attempt; each later wait doubles up to the cap, as SQLite's own busy handler backs off. */
const RETRY_BASE_DELAY_MS = 5;
const RETRY_MAX_DELAY_MS = 100;

/**
 * SQLITE_BUSY, including its extended codes: another connection holds a lock the statement needs. Reads node:sqlite's
 * `errcode` and libSQL's `rawCode` on the error or on a cause it wraps, such as the facade's `StorageUnavailableError`.
 */
export function isSqliteBusy(error: unknown): boolean {
	const seen = new Set<object>();
	for (let cause = error; typeof cause === "object" && cause !== null && !seen.has(cause); ) {
		seen.add(cause);
		const { errcode, rawCode } = cause as { errcode?: unknown; rawCode?: unknown };
		const code = errcode ?? rawCode;
		if (typeof code === "number") return (code & 0xff) === 5;
		cause = (cause as { cause?: unknown }).cause;
	}
	return false;
}

const SQLITE_IOERR_TRUNCATE = 1546;
const TRUNCATE_RETRY_MS = 5_000;

function isSqliteTruncateFailure(error: unknown): boolean {
	const seen = new Set<object>();
	for (let cause = error; typeof cause === "object" && cause !== null && !seen.has(cause); ) {
		seen.add(cause);
		const { errcode, rawCode } = cause as { errcode?: unknown; rawCode?: unknown };
		const code = errcode ?? rawCode;
		if (typeof code === "number") return code === SQLITE_IOERR_TRUNCATE;
		cause = (cause as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * How long to wait after a failed attempt before the next, or rethrows its error: anything but SQLITE_BUSY and
 * SQLITE_IOERR_TRUNCATE at once, SQLITE_BUSY once `busyTimeoutMs` has passed since the first attempt, and
 * SQLITE_IOERR_TRUNCATE once the shorter of `busyTimeoutMs` and `TRUNCATE_RETRY_MS` has.
 */
function retryAfter(busyTimeoutMs: number): (error: unknown) => number {
	const started = Date.now();
	let delay = RETRY_BASE_DELAY_MS;
	return (error) => {
		const limitMs = isSqliteBusy(error)
			? busyTimeoutMs
			: isSqliteTruncateFailure(error)
				? Math.min(busyTimeoutMs, TRUNCATE_RETRY_MS)
				: 0;
		const remaining = started + limitMs - Date.now();
		if (remaining <= 0) throw error;
		const wait = Math.min(delay, remaining);
		delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
		return wait;
	};
}

const WAL_SWITCH = "PRAGMA journal_mode = WAL";

/**
 * Switches a database file to the write-ahead log through `exec`, waiting up to `busyTimeoutMs` for a lock another
 * connection holds, as every other statement on a connection with that busy timeout waits.
 *
 * SQLite switches a file still in the rollback journal by reading its header and then upgrading that read to a write.
 * An upgrade never calls the busy handler, so while another connection holds a lock on the file, such as another
 * process switching the same new file or writing an older one, the switch fails at once with SQLITE_BUSY however long
 * the busy timeout is. It has changed nothing then, so it is tried again after a short wait until the busy timeout has
 * passed. Once the file is in WAL mode, switched by this connection or another, the switch writes nothing and cannot
 * meet that lock. A switch refused with SQLITE_IOERR_TRUNCATE, as on Windows while a killed process still maps the
 * wal-index, is tried again for at most `TRUNCATE_RETRY_MS`. Any other failure is thrown at once.
 */
export async function switchToWriteAheadLog(
	exec: (sql: string) => Awaitable<unknown>,
	busyTimeoutMs: number,
): Promise<void> {
	const nextWait = retryAfter(busyTimeoutMs);
	for (;;) {
		try {
			await exec(WAL_SWITCH);
			return;
		} catch (error) {
			const wait = nextWait(error);
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * `switchToWriteAheadLog` for a synchronous caller: it waits on the calling thread between attempts, as a statement
 * on a node:sqlite connection waits on it for the busy timeout.
 */
export function switchToWriteAheadLogSync(exec: (sql: string) => unknown, busyTimeoutMs: number): void {
	const nextWait = retryAfter(busyTimeoutMs);
	for (;;) {
		try {
			exec(WAL_SWITCH);
			return;
		} catch (error) {
			Atomics.wait(sleeper, 0, 0, nextWait(error));
		}
	}
}
