import type {
	SqliteBatchOptions,
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteStatement,
	SqliteTransactionOptions,
	SqliteValue,
	StorageDescriptor,
	StorageNotifications,
	TransactionConcurrency,
} from "./database.js";
import { type StorageDialect, sqliteDialect } from "./dialect.js";
import {
	largestValueBytes,
	payloadTooLargeKind,
	StorageConfigError,
	StorageError,
	type StorageFailureCause,
	StorageInvalidTextError,
	type StoragePayloadLimits,
	StoragePayloadTooLargeError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageTransientError,
	type StorageTransientErrorCode,
	type StorageTransientHop,
	type StorageTransientOutcome,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";

type Awaitable<T> = T | Promise<T>;

/** A value as a driver returns it. Blobs may be any binary view; the facade returns them as `Uint8Array` copies. */
export type SqliteDriverValue = SqliteValue | ArrayBuffer | ArrayBufferView;

/** One statement's result as a driver returns it: column names, positional rows, and the rows it changed. */
export interface SqliteDriverResult {
	readonly columns: readonly string[];
	readonly rows: readonly ArrayLike<SqliteDriverValue>[];
	readonly changes: number;
}

/** Runs SQL on a driver connection or on an open driver transaction. */
export interface SqliteDriverExecutor {
	/** Runs one statement with positional `?` parameters. */
	execute(sql: string, params: readonly SqliteValue[]): Awaitable<SqliteDriverResult>;
	/** Runs zero or more statements that take no parameters. */
	executeMultiple(sql: string): Awaitable<void>;
}

export interface SqliteDriverTransaction extends SqliteDriverExecutor {
	commit(): Awaitable<void>;
	rollback(): Awaitable<void>;
	/** Releases the transaction after it commits or rolls back. */
	close?(): Awaitable<void>;
}

/** A driver failure that passes, as `SqliteDriver.transientFailure` recognizes it. */
export interface SqliteDriverTransientFailure {
	readonly code: StorageTransientErrorCode;
	/**
	 * `"not-applied"` when the failed request cannot have changed the database, `"unknown"` when the connection broke
	 * after the server may have applied it.
	 */
	readonly outcome: StorageTransientOutcome;
	/**
	 * Optional. Where on the way to the server the call failed, when it did not reach the server, such as at a proxy:
	 * `StorageTransientError` then names this hop where it would name the database server. The facade passes both texts
	 * through `redact`.
	 */
	readonly hop?: StorageTransientHop;
}

/** How the facade asks a driver to begin a transaction. */
export interface SqliteDriverTransactionOptions {
	/** @internal A consistent read snapshot without acquiring the database's writer lock. */
	readonly readOnly?: boolean;
	/** Always present when the facade calls; `{ kind: "serial" }` unless the transaction asked for another. */
	readonly concurrency: TransactionConcurrency;
	/** The transaction's `SqliteTransactionOptions.lockWaitMs`, when it set one. */
	readonly lockWaitMs?: number;
}

/** The driver calls `createSqliteDatabase` turns into a `SqliteDatabase`. */
export interface SqliteDriver extends SqliteDriverExecutor {
	/** Diagnostic identity. Its `location` passes through `redact` before the facade exposes it. */
	readonly descriptor: StorageDescriptor;
	/** The SQL dialect the driver speaks; SQLite when absent. The facade exposes it as `SqliteDatabase.dialect`. */
	readonly dialect?: StorageDialect;
	/**
	 * Optional. The driver runs `fenced` transactions on connections of their own, concurrently with other calls: the
	 * facade then starts them without waiting for queued calls. Otherwise every transaction waits its turn.
	 */
	readonly concurrentTransactions?: boolean;
	/**
	 * Optional. A transaction's connection takes a statement before the one before it is answered, and runs them in the
	 * order it took them (a pipelined connection): the facade then sends each call of a transaction as it is made, so a
	 * body that makes several calls without awaiting each sends them in one round trip. Otherwise each call waits for
	 * the one before it to settle.
	 */
	readonly pipelinedTransactions?: boolean;
	/**
	 * Begins a write transaction. With `options.concurrency` `{ kind: "serial" }` (the default) it holds the write lock of the whole database
	 * or of `concurrency.domain`, like `BEGIN IMMEDIATE`; with `fenced` it may take no lock, and the body locks its rows.
	 * A SQLite driver runs both as `BEGIN IMMEDIATE` and may ignore the concurrency argument. An internal `readOnly`
	 * request instead opens a consistent read snapshot without any writer lock.
	 */
	beginTransaction(options?: SqliteDriverTransactionOptions): Awaitable<SqliteDriverTransaction>;
	/**
	 * Optional. Runs the statements in order in one write transaction, in one request: all commit or none do. Provide it
	 * only when the driver sends the whole batch at once; the facade then offers `SqliteDatabase.batch`. `options` are the
	 * caller's, as `SqliteDatabase.batch` took them.
	 */
	batch?(
		statements: readonly SqliteStatement[],
		options?: SqliteBatchOptions,
	): Awaitable<readonly SqliteDriverResult[]>;
	/** Releases the connection. Called once, after accepted work drains. */
	close(): Awaitable<void>;
	/** Removes credentials from diagnostic text: the descriptor location and driver failure messages and stacks. */
	redact?(text: string): string;
	/**
	 * Optional. Recognizes a failed `batch` that found the database's write lock busy and wrote nothing: the facade sends
	 * it again, after a randomized wait outside its call queue, for up to the caller's `lockWaitMs`. It receives the
	 * failure the facade reports, whose `cause` chain holds the driver's own.
	 */
	lockBusy?(failure: StorageFailureCause): boolean;
	/**
	 * Optional. Recognizes a failure a driver call threw as one that passes, from the failure's own fields, before the
	 * facade redacts it. The call then fails with `StorageTransientError`, and a call that wrote nothing runs again.
	 */
	transientFailure?(failure: StorageFailureCause): SqliteDriverTransientFailure | undefined;
	/**
	 * Optional. The backend's payload limits in bytes, named in the `StoragePayloadTooLargeError` the facade throws when
	 * a driver call fails because a value, row or response was too large for the backend (#4954).
	 */
	readonly payloadLimits?: StoragePayloadLimits;
	/**
	 * Optional. Wake-ups through the database, which the facade exposes as `SqliteDatabase.notifications`; the driver's
	 * `close` stops its listening connection.
	 */
	readonly notifications?: StorageNotifications;
}

/**
 * How many times the facade runs a call that a transient failure ended before it wrote anything, the first run
 * included. A transaction runs again only when its options allow it (`retryTransientFailures`).
 */
export const STORAGE_TRANSIENT_RETRY_ATTEMPTS = 5;
/** The wait before the second run, in milliseconds; each later wait is twice as long as the one before. */
const STORAGE_TRANSIENT_RETRY_BASE_DELAY_MS = 250;
/** Each wait varies by up to this fraction either way, so processes that failed together do not retry together. */
const STORAGE_TRANSIENT_RETRY_JITTER = 0.2;
/** The first bound on the wait before a batch that found the write lock busy is sent again; each later one doubles. */
const BUSY_RETRY_BASE_MS = 20;
/** The largest bound on that wait. */
const BUSY_RETRY_MAX_MS = 1000;

/**
 * How long the running call may run before the calls queued behind it fail without running (#5114). The facade
 * runs one call at a time, so a call that cannot complete, such as one waiting on a write lock a server keeps for a
 * stream an outage cut, would otherwise hold every call queued behind it, priority calls such as a worker host's
 * heartbeat included. A call queued behind it fails with `StorageUnavailableError` instead, having written nothing,
 * and its caller retries it as it retries any outage.
 */
export const STORAGE_QUEUED_CALL_MAX_WAIT_MS = 60_000;
/**
 * The same bound for a priority call, such as a worker host's heartbeat or a work lease renewal: a third of the 30 s a
 * host's or a work lease's last write keeps it live (`FLEET_HOST_LIVE_MS`), so a priority call stuck behind a call that
 * cannot complete fails, and its caller tries it again, while the lease it renews still holds.
 */
export const STORAGE_PRIORITY_CALL_MAX_WAIT_MS = 10_000;

/** How long the facade waits after the failed run `attempt` (1-based) before it runs the call again. */
function transientRetryDelayMs(attempt: number): number {
	const jitter = 1 + STORAGE_TRANSIENT_RETRY_JITTER * (2 * Math.random() - 1);
	return Math.round(STORAGE_TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * jitter);
}

/** One run of a call: which run it is, and the first transient failure it met. */
interface Attempt {
	readonly number: number;
	transient?: StorageTransientError;
}

const REDACTED = "[redacted]";

/** How {@link configuredSecretRedactor} matches the secrets it is given. */
export interface ConfiguredSecretRedactorOptions {
	/** Forms of a secret shorter than this are not redacted where they appear: they would match ordinary words. */
	readonly minLength?: number;
}

/**
 * Fewest characters of a form derived from a secret (a line of it, or an encoding) that is redacted, so short pieces
 * of a secret do not match ordinary text. A secret itself is redacted at any length its caller allows.
 */
const MIN_DERIVED_LENGTH = 6;
/** Fewest base64 characters of a secret's encoding that are redacted, so short secrets do not match random base64. */
const MIN_BASE64_LENGTH = 7;

/**
 * The base64 runs that appear wherever `secret`'s bytes are encoded, in standard and URL-safe alphabets: for each of
 * the three alignments of its first byte in a 3-byte group, the characters that only its bits decide.
 */
function base64Forms(secret: string): string[] {
	const bytes = Buffer.from(secret);
	const forms: string[] = [];
	for (let offset = 0; offset < 3; offset++) {
		const encoded = Buffer.concat([Buffer.alloc(offset), bytes, Buffer.alloc(2)]).toString("base64");
		const form = encoded.slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + bytes.length)) / 6));
		if (form.length >= MIN_BASE64_LENGTH) forms.push(form, form.replaceAll("+", "-").replaceAll("/", "_"));
	}
	return forms;
}

/** The JSON-escaped, URI-encoded, URI-decoded and base64 forms of `plain`. */
function encodedForms(plain: string): string[] {
	const forms = [JSON.stringify(plain).slice(1, -1), ...base64Forms(plain)];
	try {
		forms.push(encodeURIComponent(plain));
	} catch {}
	try {
		forms.push(decodeURIComponent(plain));
	} catch {}
	return forms;
}

/** A line of a multi-line secret that many secrets share, such as a PEM armor line (`-----BEGIN … KEY-----`). */
const GENERIC_LINE = /^-----[A-Z0-9 ]+-----$|^[A-Za-z-]+: /u;

/**
 * The forms a configured secret takes in output: trimmed, since a secret read from a file often ends with a line break
 * that the text around a printed secret need not repeat; each line of a multi-line secret, trimmed, that holds a letter
 * or digit and is not a line many secrets share (a PEM armor or header line); and the encodings of both. The secret as given holds its trimmed form, so overlapping matches still remove
 * it whole. Forms derived from the secret are kept only from {@link MIN_DERIVED_LENGTH} characters.
 */
function secretForms(secret: string, minLength: number): string[] {
	const trimmed = secret.trim();
	if (trimmed.length < Math.max(1, minLength)) return [];
	const derivedLength = Math.max(minLength, MIN_DERIVED_LENGTH);
	const lines = trimmed.includes("\n")
		? trimmed
				.split(/\r?\n/u)
				.map((line) => line.trim())
				.filter((line) => /[\p{L}\p{N}]/u.test(line) && !GENERIC_LINE.test(line))
		: [];
	const derived = [...lines, ...[trimmed, ...lines].flatMap(encodedForms)];
	return [trimmed, ...derived.filter((form) => form.length >= derivedLength)];
}

/** Every occurrence of each of `forms` in `text`, overlapping ones merged, as `[start, end)` ranges in order. */
function secretRanges(text: string, forms: readonly string[]): [number, number][] {
	const found: [number, number][] = [];
	for (const form of forms) {
		for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) found.push([at, at + form.length]);
	}
	found.sort((first, second) => first[0] - second[0]);
	const merged: [number, number][] = [];
	for (const [start, end] of found) {
		const last = merged.at(-1);
		if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

/**
 * A redactor that replaces each configured secret with `[redacted]`: its plain, trimmed and per-line forms, and their
 * JSON-escaped, URI-encoded, URI-decoded and base64 forms. Occurrences that overlap, such as two secrets that share
 * characters, are replaced together, so no part of either survives, and text around them is left as it is. A
 * `[redacted]` marker already in the text is kept as it is, so redacting twice changes nothing.
 */
export function configuredSecretRedactor(
	secrets: Iterable<string>,
	options: ConfiguredSecretRedactorOptions = {},
): (text: string) => string {
	const forms = new Set<string>();
	for (const secret of secrets) for (const form of secretForms(secret, options.minLength ?? 1)) forms.add(form);
	const ordered = [...forms];
	return (text) =>
		text
			.split(REDACTED)
			.map((piece) => {
				let redacted = "";
				let copied = 0;
				for (const [start, end] of secretRanges(piece, ordered)) {
					redacted += piece.slice(copied, start) + REDACTED;
					copied = end;
				}
				return redacted + piece.slice(copied);
			})
			.join(REDACTED);
}

/**
 * A redactor that replaces every non-empty secret, and its trimmed, per-line, URI-encoded, URI-decoded, JSON-escaped
 * and base64 forms, with `[redacted]`. Occurrences that overlap are replaced together, so a secret that contains or
 * shares characters with another is removed whole. A `[redacted]` marker already in the text is kept as it is, so
 * redacting twice changes nothing, even for a secret that is part of the marker.
 */
export function redactSecrets(secrets: Iterable<string>): (text: string) => string {
	return configuredSecretRedactor(secrets);
}

function redactCause(cause: StorageFailureCause, redact: (text: string) => string): StorageFailureCause {
	if (typeof cause === "string") return redact(cause);
	if (!(cause instanceof Error)) return cause;
	const nested = cause.cause as StorageFailureCause;
	const safeCause = redactCause(nested, redact);
	const message = redact(cause.message);
	const stack = cause.stack === undefined ? undefined : redact(cause.stack);
	if (message === cause.message && stack === cause.stack && safeCause === nested) return cause;
	const safe = new StorageError(message, { cause: safeCause });
	safe.stack = stack;
	// The code names the failure, such as a TLS error's, and holds no credential.
	const code = (cause as { readonly code?: string | number }).code;
	if (typeof code === "string") Object.assign(safe, { code });
	return safe;
}

function snapshotParams(params: readonly SqliteValue[]): SqliteValue[] {
	return params.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value));
}

function normalizeValue(value: SqliteDriverValue): SqliteValue {
	if (typeof value === "bigint") {
		return value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: value;
	}
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	return value;
}

function normalizeRow(row: ArrayLike<SqliteDriverValue>, columns: readonly string[]): SqliteRow {
	return Object.fromEntries(columns.map((column, index) => [column, normalizeValue(row[index] ?? null)]));
}

/** Rejects a `retryTransientFailures` that is not a boolean, before the transaction is queued. */
function retriesTransientFailures(options: SqliteTransactionOptions | undefined): boolean {
	const retry = options?.retryTransientFailures;
	if (retry !== undefined && typeof retry !== "boolean")
		throw new StorageConfigError(
			"sdk",
			"retryTransientFailures",
			"boolean-required",
			"Pass true or false, or omit it",
		);
	return retry === true;
}

const SERIAL: TransactionConcurrency = Object.freeze({ kind: "serial" });

/** Rejects a `concurrency` that is not one of the two kinds, before the transaction is queued. */
function transactionConcurrency(options: SqliteTransactionOptions | undefined): TransactionConcurrency {
	const concurrency = options?.concurrency;
	if (concurrency === undefined) return SERIAL;
	if (typeof concurrency !== "object" || concurrency === null) throw concurrencyConfigError();
	if (concurrency.kind === "serial" && (concurrency.domain === undefined || typeof concurrency.domain === "string"))
		return concurrency;
	if (
		concurrency.kind === "fenced" &&
		typeof concurrency.audit === "string" &&
		concurrency.audit !== "" &&
		(concurrency.excludesSerial === undefined || typeof concurrency.excludesSerial === "boolean")
	)
		return concurrency;
	throw concurrencyConfigError();
}

function concurrencyConfigError(): StorageConfigError {
	return new StorageConfigError(
		"sdk",
		"concurrency",
		"kind-required",
		'Pass { kind: "serial" }, { kind: "serial", domain }, or { kind: "fenced", audit: fencedPath(name) }, or omit it',
	);
}

/** Serializes operations in call order; a failed operation does not stop the ones queued after it. */
class CallQueue {
	private tail: Promise<void> = Promise.resolve();

	push<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	drained(): Promise<void> {
		return this.tail;
	}
}

/** Starts each operation as it is pushed, so a pipelined connection receives them in push order without waiting. */
class PipelineQueue {
	private readonly started = new Set<Promise<void>>();

	push<T>(operation: () => Promise<T>): Promise<T> {
		const result = operation();
		const settled = result.then(
			() => {},
			() => {},
		);
		// A queue lasts one transaction, so it keeps every call it started.
		this.started.add(settled);
		return result;
	}

	drained(): Promise<void> {
		return Promise.all(this.started).then(() => {});
	}
}

interface QueuedCall {
	run(): Promise<void>;
	fail(error: Error): void;
}

/**
 * Runs operations one at a time, in call order within each lane: an operation of the priority lane runs before every
 * waiting operation of the normal lane. A failed operation does not stop the ones queued after it. Once the running
 * operation has run `STORAGE_PRIORITY_CALL_MAX_WAIT_MS` without settling, every priority operation waiting behind it
 * fails with `stalled()` without running, and once it has run `STORAGE_QUEUED_CALL_MAX_WAIT_MS`, every other one does;
 * so does every one queued behind it after that. Each operation that starts gets full waits of its own, so a queue of
 * operations that each settle in time never fails one.
 */
class LaneQueue {
	private readonly normal: QueuedCall[] = [];
	private readonly priority: QueuedCall[] = [];
	private running = false;
	/** When the running operation started, as `Date.now()`. */
	private runningSince = 0;
	private idle: (() => void)[] = [];
	private watchdog?: ReturnType<typeof setTimeout>;
	/** The bound the planned check enforces, or undefined when none is planned. */
	private watchdogBound?: number;
	private readonly stalled: (ranMs: number) => Error;

	constructor(stalled: (ranMs: number) => Error) {
		this.stalled = stalled;
	}

	push<T>(operation: () => Promise<T>, priority = false): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			(priority ? this.priority : this.normal).push({
				run: () => Promise.resolve().then(operation).then(resolve, reject),
				fail: reject,
			});
			this.next();
			this.watch();
		});
	}

	drained(): Promise<void> {
		if (!this.running && this.normal.length === 0 && this.priority.length === 0) return Promise.resolve();
		return new Promise((resolve) => this.idle.push(resolve));
	}

	private next(): void {
		if (this.running) return;
		const operation = this.priority.shift() ?? this.normal.shift();
		if (operation === undefined) {
			const idle = this.idle;
			this.idle = [];
			for (const resolve of idle) resolve();
			return;
		}
		this.running = true;
		this.runningSince = Date.now();
		// Started on a later microtask, as a promise chain starts it, never inside the call that queued it.
		void operation.run().finally(() => {
			clearTimeout(this.watchdog);
			this.watchdog = undefined;
			this.watchdogBound = undefined;
			this.running = false;
			this.next();
			this.watch();
		});
	}

	/**
	 * While operations wait behind a running one, fails the priority ones once that one has run
	 * `STORAGE_PRIORITY_CALL_MAX_WAIT_MS`, and the others once it has run `STORAGE_QUEUED_CALL_MAX_WAIT_MS`. No timer
	 * runs while nothing waits.
	 */
	private watch(): void {
		const bound =
			this.priority.length > 0
				? STORAGE_PRIORITY_CALL_MAX_WAIT_MS
				: this.normal.length > 0
					? STORAGE_QUEUED_CALL_MAX_WAIT_MS
					: undefined;
		// A priority call queued behind ordinary ones brings the planned check forward to its own, shorter bound.
		if (bound === this.watchdogBound) return;
		clearTimeout(this.watchdog);
		this.watchdog = undefined;
		this.watchdogBound = bound;
		if (bound === undefined) return;
		this.watchdog = setTimeout(
			() => {
				this.watchdog = undefined;
				this.watchdogBound = undefined;
				const ran = Date.now() - this.runningSince;
				const failing = this.priority.splice(0);
				if (ran >= STORAGE_QUEUED_CALL_MAX_WAIT_MS) failing.push(...this.normal.splice(0));
				for (const waiting of failing) waiting.fail(this.stalled(ran));
				this.watch();
			},
			Math.max(0, this.runningSince + bound - Date.now()),
		);
		// A stuck operation ahead of the queue never keeps the process alive on its own.
		this.watchdog.unref();
	}
}

class DriverDatabase implements SqliteDatabase {
	readonly descriptor: StorageDescriptor;
	readonly dialect: StorageDialect;
	private readonly driver: SqliteDriver;
	/** Fenced transactions a concurrent driver runs outside the queue; closing waits for them. */
	private readonly concurrent = new Set<Promise<unknown>>();
	private readonly redact: (text: string) => string;
	private readonly queue = new LaneQueue(
		(ranMs) =>
			new StorageUnavailableError(
				this.descriptor,
				undefined,
				`the call was queued behind an earlier call that ran ${Math.round(ranMs / 1000)} seconds without settling, and did not run; nothing was written, retry it`,
			),
	);
	private closePromise?: Promise<void>;
	/** End the waits before calls run again, when closing begins during them. */
	private readonly wakeRetries = new Set<() => void>();
	private retryReported = false;
	private readonly executor: SqliteExecutor;
	readonly batch?: (statements: readonly SqliteStatement[], options?: SqliteBatchOptions) => Promise<SqliteRow[][]>;
	readonly notifications?: StorageNotifications;

	constructor(driver: SqliteDriver, redact: (text: string) => string) {
		this.driver = driver;
		if (driver.notifications !== undefined) this.notifications = driver.notifications;
		this.redact = redact;
		this.descriptor = { adapter: driver.descriptor.adapter, location: redact(driver.descriptor.location) };
		this.dialect = driver.dialect ?? sqliteDialect;
		this.executor = this.createExecutor(
			driver,
			(operation) => {
				if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
				return this.queue.push(() => this.retrying(operation, true));
			},
			true,
		);
		const batch = driver.batch?.bind(driver);
		if (batch) this.batch = (statements, options) => this.runBatch(batch, statements, options);
	}

	private runBatch(
		batch: NonNullable<SqliteDriver["batch"]>,
		statements: readonly SqliteStatement[],
		options: SqliteBatchOptions | undefined,
	): Promise<SqliteRow[][]> {
		if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
		const bound = statements.map((statement) => ({ sql: statement.sql, params: snapshotParams(statement.params) }));
		const passed = options === undefined ? undefined : { ...options };
		const send = () => this.sendBatch(batch, bound, passed);
		const lockWaitMs = passed?.lockWaitMs ?? 0;
		const busy = this.driver.lockBusy?.bind(this.driver);
		if (lockWaitMs <= 0 || busy === undefined) return send();
		return this.whileBusy(send, busy, performance.now() + lockWaitMs);
	}

	/**
	 * Sends a batch again while it finds the write lock busy, until `deadline`. Each wait is random up to a bound that
	 * doubles from `BUSY_RETRY_BASE_MS` to `BUSY_RETRY_MAX_MS` ("full jitter"), so writers that failed together do not
	 * come back together. The waits happen outside the call queue, so calls queued meanwhile, a priority batch such as
	 * a lease renewal included, run during them.
	 */
	private async whileBusy<T>(
		send: () => Promise<T>,
		busy: (failure: StorageFailureCause) => boolean,
		deadline: number,
	): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await send();
			} catch (failure) {
				if (!busy(failure as StorageFailureCause) || performance.now() >= deadline || this.closePromise)
					throw failure;
			}
			const bound = Math.min(BUSY_RETRY_MAX_MS, BUSY_RETRY_BASE_MS * 2 ** Math.min(attempt, 16));
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(Math.random() * bound, deadline - performance.now())),
			);
			if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
		}
	}

	private sendBatch(
		batch: NonNullable<SqliteDriver["batch"]>,
		bound: readonly SqliteStatement[],
		passed: SqliteBatchOptions | undefined,
	): Promise<SqliteRow[][]> {
		return this.queue.push(
			() =>
				this.retrying(async (attempt) => {
					for (const statement of bound) {
						const invalidIndex = statement.params.findIndex(
							(value) => typeof value === "string" && value.includes("\0"),
						);
						if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
					}
					const results = await this.call(
						() => batch(bound, passed),
						attempt,
						true,
						bound.flatMap((statement) => statement.params),
					);
					return results.map((result) => result.rows.map((row) => normalizeRow(row, result.columns)));
				}, true),
			passed?.priority === true,
		);
	}

	/**
	 * Runs `operation` again while a transient failure ended its run before it wrote anything, waiting longer before
	 * each run, and only when `replay` allows it. Gives up with the last run's failure after
	 * `STORAGE_TRANSIENT_RETRY_ATTEMPTS` runs, or once closing begins.
	 */
	private async retrying<T>(operation: (attempt: Attempt) => Promise<T>, replay: boolean): Promise<T> {
		for (let number = 1; ; number++) {
			const attempt: Attempt = { number };
			try {
				return await operation(attempt);
			} catch (failure) {
				const transient = attempt.transient;
				if (!replay || transient?.outcome !== "not-applied" || !(await this.backoff(transient))) throw failure;
			}
		}
	}

	/**
	 * Waits before the run after `failure`'s, and says whether to run again: not after the last run, nor once closing
	 * begins, which also ends a wait under way. The first transient failure that makes the database run a call again is
	 * emitted as a process warning.
	 */
	private async backoff(failure: StorageTransientError): Promise<boolean> {
		if (failure.attempts >= STORAGE_TRANSIENT_RETRY_ATTEMPTS || this.closePromise) return false;
		if (!this.retryReported) {
			this.retryReported = true;
			process.emitWarning(failure);
		}
		let wake: (() => void) | undefined;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, transientRetryDelayMs(failure.attempts));
			wake = () => {
				clearTimeout(timer);
				resolve();
			};
			this.wakeRetries.add(wake);
		});
		if (wake) this.wakeRetries.delete(wake);
		return this.closePromise === undefined;
	}

	/**
	 * Maps a driver failure to `StorageUnavailableError` with a credential-free cause: a `StorageTransientError` when
	 * the driver recognizes it and the call belongs to an `attempt`. `applies` says whether the call commits on its
	 * own; a failed call inside an open transaction applied nothing, whatever the driver says of the request.
	 */
	private async call<T>(
		operation: () => Awaitable<T>,
		attempt?: Attempt,
		applies = false,
		params: readonly SqliteValue[] = [],
	): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			const safe = redactCause(cause as StorageFailureCause, this.redact);
			// A payload too large for the backend fails the same way every time: permanent, never an outage (#4954).
			const kind = payloadTooLargeKind(cause as StorageFailureCause);
			if (kind !== undefined) {
				throw new StoragePayloadTooLargeError(
					this.driver.payloadLimits?.[kind] ?? 0,
					kind === "value" ? largestValueBytes(params) : 0,
					{ kind, descriptor: this.descriptor, cause: safe },
				);
			}
			if (attempt !== undefined) {
				const transient = this.driver.transientFailure?.(cause as StorageFailureCause);
				if (transient !== undefined) {
					const failure = new StorageTransientError(
						this.descriptor,
						{
							code: transient.code,
							outcome: applies ? transient.outcome : "not-applied",
							attempts: attempt.number,
							...(transient.hop === undefined
								? {}
								: {
										hop: {
											name: this.redact(transient.hop.name),
											failure: this.redact(transient.hop.failure),
										},
									}),
						},
						safe,
					);
					attempt.transient ??= failure;
					throw failure;
				}
			}
			throw new StorageUnavailableError(this.descriptor, safe);
		}
	}

	private createExecutor(
		connection: SqliteDriverExecutor,
		admit: <T>(operation: (attempt: Attempt) => Promise<T>) => Promise<T>,
		applies: boolean,
	): SqliteExecutor {
		const statement = (sql: string, params: readonly SqliteValue[]) => {
			const bound = snapshotParams(params);
			return admit(async (attempt) => {
				const invalidIndex = bound.findIndex((value) => typeof value === "string" && value.includes("\0"));
				if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
				return this.call(() => connection.execute(sql, bound), attempt, applies, bound);
			});
		};
		return {
			exec: (sql) => admit((attempt) => this.call(() => connection.executeMultiple(sql), attempt, applies)),
			run: async (sql, ...params) => ({ changes: (await statement(sql, params)).changes }),
			get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
				const result = await statement(sql, params);
				const row = result.rows[0];
				return row === undefined ? undefined : (normalizeRow(row, result.columns) as T);
			},
			all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
				const result = await statement(sql, params);
				return result.rows.map((row) => normalizeRow(row, result.columns) as T);
			},
		};
	}

	exec(sql: string): Promise<void> {
		return this.executor.exec(sql);
	}

	run(sql: string, ...params: readonly SqliteValue[]) {
		return this.executor.run(sql, ...params);
	}

	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined> {
		return this.executor.get<T>(sql, ...params);
	}

	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
		return this.executor.all<T>(sql, ...params);
	}

	transaction<T>(
		callback: (transaction: SqliteExecutor) => Promise<T>,
		options?: SqliteTransactionOptions,
	): Promise<T> {
		if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
		let replay: boolean;
		let concurrency: TransactionConcurrency;
		try {
			replay = retriesTransientFailures(options);
			concurrency = transactionConcurrency(options);
		} catch (error) {
			return Promise.reject(error);
		}
		const begin: SqliteDriverTransactionOptions = {
			concurrency,
			...(options?.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }),
			...(options?.readOnly === true ? { readOnly: true } : {}),
		};
		const run = () => this.retrying((attempt) => this.runTransaction(callback, attempt, begin), replay);
		if (concurrency.kind === "serial" || this.driver.concurrentTransactions !== true) return this.queue.push(run);
		const result = run();
		const settled = result.then(
			() => {},
			() => {},
		);
		this.concurrent.add(settled);
		void settled.then(() => this.concurrent.delete(settled));
		return result;
	}

	private async runTransaction<T>(
		callback: (transaction: SqliteExecutor) => Promise<T>,
		attempt: Attempt,
		begin: SqliteDriverTransactionOptions,
	): Promise<T> {
		const connection = await this.call(() => this.driver.beginTransaction(begin), attempt);
		const pipelined = this.driver.pipelinedTransactions === true;
		const handleQueue = pipelined ? new PipelineQueue() : new CallQueue();
		let active = true;
		let result: T;
		const handle = this.createExecutor(
			connection,
			(operation) =>
				active ? handleQueue.push(() => operation(attempt)) : Promise.reject(new StorageTransactionClosedError()),
			false,
		);
		const close = () => this.call(() => connection.close?.());
		// Once the callback has returned, the commit's own failure decides whether the transaction runs again: a commit
		// that may have applied, or that failed for a reason the driver does not recognize, never does, whatever the
		// callback met before it. A committed transaction never runs again either.
		const commit = () => {
			attempt.transient = undefined;
			return this.call(() => connection.commit(), attempt, true);
		};
		try {
			let committing: Promise<void> | undefined;
			try {
				result = await callback(handle);
				// A pipelined connection takes the commit behind statements the callback left unanswered, so locks they take
				// are held for one round trip. The driver's commit fails when one of them failed, so nothing commits then;
				// a statement that fails as transient after this point lets the transaction run again, having written nothing.
				if (pipelined) {
					committing = commit();
					committing.catch(() => {});
				}
			} finally {
				active = false;
				await handleQueue.drained();
			}
			await (committing ?? commit());
		} catch (cause) {
			let failure = cause as StorageFailureCause;
			try {
				await this.call(() => connection.rollback());
			} catch (rollbackCause) {
				failure = new StorageRollbackError(failure, rollbackCause as StorageFailureCause);
			}
			// Cleanup must not replace a callback, commit, or rollback failure.
			await close().catch(() => {});
			throw failure;
		}
		await close();
		return result;
	}

	close(): Promise<void> {
		this.closePromise ??= Promise.all([this.queue.drained(), ...this.concurrent]).then(() =>
			this.call(() => this.driver.close()),
		);
		for (const wake of this.wakeRetries) wake();
		return this.closePromise;
	}
}

/**
 * Wraps a SQLite-compatible driver as a `SqliteDatabase`. The facade queues operations in call order and keeps them
 * outside active transactions, snapshots binary parameters at call time, rejects NUL text, returns safe-range integers
 * as numbers and blobs as `Uint8Array` copies, expires transaction handles when their callback settles, maps driver
 * failures to `StorageUnavailableError` with credentials redacted, and reports failed rollbacks with
 * `StorageRollbackError`. A failure the driver recognizes as transient is a `StorageTransientError`; a statement, a
 * batch, or a transaction whose options allow it runs again, up to `STORAGE_TRANSIENT_RETRY_ATTEMPTS` times in all,
 * while such a failure ended it before it wrote anything. Closing rejects new calls, stops those retries, drains
 * accepted work, then closes the driver once.
 */
export function createSqliteDatabase(driver: SqliteDriver): SqliteDatabase {
	return new DriverDatabase(driver, driver.redact?.bind(driver) ?? ((text) => text));
}
