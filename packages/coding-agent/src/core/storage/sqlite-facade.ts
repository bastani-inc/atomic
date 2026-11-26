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
	StorageOpenedCatalog,
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
import {
	MAX_SEQUENCE_REQUEST_STATEMENTS,
	offerFinish,
	offerSequences,
	type SqliteSequence,
} from "./statement-sequence.js";

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
	/**
	 * Optional. `SqliteTransactionOptions.leading`, with parameters snapshotted and none holding NUL: a driver with
	 * `pipelinedTransactions` may send them with the begin and answer the transaction's first calls that make them, in
	 * order, from what it got. A call that differs from the next of them ends the lead.
	 */
	readonly leading?: readonly SqliteStatement[];
	/**
	 * Optional. `SqliteTransactionOptions.leadingOnly`, set only with every statement of `leading`: a driver with
	 * `pipelinedTransactions` may send the commit right behind them, and then fails any other call without sending it.
	 */
	readonly leadingOnly?: boolean;
	/**
	 * Optional. `SqliteTransactionOptions.lockIfLeadingFinds`, set only with `leading` whose first statement is the
	 * transaction's: a driver with `pipelinedTransactions` may take a `serial` domain's locks in that statement, for the
	 * row it returns, instead of with the begin.
	 */
	readonly lockIfLeadingFinds?: boolean;
	/**
	 * Optional. `SqliteTransactionOptions.relaxedDurability`, never set on a read-only transaction: the driver may answer
	 * the commit before the transaction reaches disk.
	 */
	readonly relaxedDurability?: boolean;
}

/** The driver calls `createSqliteDatabase` turns into a `SqliteDatabase`. */
export interface SqliteDriver extends SqliteDriverExecutor {
	/** Diagnostic identity. Its `location` passes through `redact` before the facade exposes it. */
	readonly descriptor: StorageDescriptor;
	/** The SQL dialect the driver speaks; SQLite when absent. The facade exposes it as `SqliteDatabase.dialect`. */
	readonly dialect?: StorageDialect;
	/**
	 * Optional. The driver runs transactions on connections of their own, concurrently with other calls: the facade then
	 * starts `fenced` transactions without waiting for queued calls, and any other call once no earlier unfinished call
	 * conflicts with it (`ScopeQueue`). Otherwise every call waits its turn.
	 */
	readonly concurrentTransactions?: boolean;
	/**
	 * Optional. The driver runs reads on connections or streams of their own, up to this many at once: the facade then
	 * lets read-only transactions, and statements outside a transaction that `readsOnly` accepts, run beside each other,
	 * while every other call still waits for each call before it, as without it, and a read waits for the writes queued
	 * before it. A positive integer; anything else runs every call in turn. A driver with `concurrentTransactions` runs at
	 * most this many reads at once when it sets it.
	 */
	readonly concurrentReads?: number;
	/**
	 * Optional. Whether `sql`, run outside a transaction, only reads: with `concurrentReads` or `concurrentTransactions`,
	 * such a statement runs beside other reads. Answer true only for a statement that can never write.
	 */
	readsOnly?(sql: string): boolean;
	/**
	 * Optional. A transaction's connection takes a statement before the one before it is answered, and runs them in the
	 * order it took them (a pipelined connection): the facade then sends each call of a transaction as it is made, so a
	 * body that makes several calls without awaiting each sends them in one round trip, and the transaction runs
	 * statement sequences (`sequenceRunner`) that way. Otherwise each call waits for the one before it to settle.
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
	/**
	 * Optional. Opens a driver on this same database, on connections of its own, for reads: the facade offers it as
	 * `SqliteDatabase.openReader`, with a call queue of its own, and closes it when this driver's database closes.
	 */
	openReader?(): Awaitable<SqliteDriver>;
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
	/**
	 * Optional. The bytes this process may still write on the file system that holds the database's file, or undefined
	 * when the file system does not say; the facade exposes it as `SqliteDatabase.freeBytes`. Provide it only for a
	 * database in a file this process can see, such as a local SQLite or libSQL file.
	 */
	freeBytes?(): Awaitable<number | undefined>;
	/**
	 * @internal Optional. Which database the driver reaches, which the facade exposes as
	 * `SqliteDatabase.databaseIdentity`: the same string from two drivers only when each one's transactions read and write
	 * the very tables the other's do. Undefined where that cannot be told, as for a database in memory.
	 */
	databaseIdentity?(): string | undefined;
	/**
	 * Optional. The schema the driver read in its open's own round trip, given once; the facade exposes it as
	 * `SqliteDatabase.takeOpenedCatalog`, so the first store open does not read it again (#6560).
	 */
	takeOpenedCatalog?(): StorageOpenedCatalog | undefined;
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
	/**
	 * Set once the transaction's commit was sent: a statement answered after it may have been committed with it when the
	 * connection broke, so its failure keeps the outcome the driver gives it.
	 */
	committing?: boolean;
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
	private readonly started: Promise<unknown>[] = [];

	push<T>(operation: () => Promise<T>): Promise<T> {
		const result = operation();
		result.catch(() => {});
		// A queue lasts one transaction, so it keeps every call it started.
		this.started.push(result);
		return result;
	}

	drained(): Promise<void> {
		return Promise.allSettled(this.started).then(() => {});
	}

	/** The failure of the first call, in the order they were sent, that failed; undefined when none did. */
	firstFailure(): Promise<unknown> {
		return firstFailure(this.started);
	}
}

interface QueuedCall {
	run(): Promise<void>;
	fail(error: Error): void;
}

/** A database's call queue: which call may start when, and whether any is unfinished. */
interface CallLanes {
	push<T>(operation: () => Promise<T>, priority?: boolean, scope?: CallScope): Promise<T>;
	drained(): Promise<void>;
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

/**
 * What a call of a driver that runs transactions concurrently may run beside: `whole`, a serial transaction without a
 * domain, and `plain`, a statement or batch outside a transaction, run beside nothing; `domain`, a serial transaction
 * of one domain, beside calls of other domains and read-only transactions; `read`, a read-only transaction, beside
 * other read-only ones and the writes queued after it.
 */
type CallScope =
	| { readonly kind: "whole" }
	| { readonly kind: "plain" }
	| { readonly kind: "read" }
	| { readonly kind: "domain"; readonly domain: string };

const WHOLE_SCOPE: CallScope = Object.freeze({ kind: "whole" });
const PLAIN_SCOPE: CallScope = Object.freeze({ kind: "plain" });
const READ_SCOPE: CallScope = Object.freeze({ kind: "read" });

/**
 * Whether `later` must wait for `earlier`, a call queued before it. A read-only transaction waits for the writes queued
 * before it, so it sees them, but a write queued after a read-only transaction does not wait for it.
 */
function scopesConflict(earlier: CallScope, later: CallScope): boolean {
	if (earlier.kind === "whole" || earlier.kind === "plain" || later.kind === "whole" || later.kind === "plain")
		return true;
	if (later.kind === "read") return earlier.kind !== "read";
	return earlier.kind === "domain" && earlier.domain === later.domain;
}

interface ScopedCall extends QueuedCall {
	readonly scope: CallScope;
	readonly priority: boolean;
	/** Call order within the call's lane. */
	readonly seq: number;
	/** When the call was queued, on the queue's clock of admissions and starts. */
	readonly admitted: number;
	/** When the call started, on that clock; undefined while it waits. */
	started?: number;
	/** When the call started, as `Date.now()`. */
	runningSince: number;
}

/**
 * `LaneQueue` for a driver that runs transactions or reads concurrently: a call starts once no unfinished call ahead of
 * it conflicts with it (`scopesConflict`), so calls that conflict run one at a time in call order, and the others at
 * once, reads no more than `maxReads` at a time. A priority call is ahead of every waiting call of the normal lane,
 * as there. A waiting call fails with `stalled()` once a conflicting call ahead of it, or one such a call waits for,
 * has run `STORAGE_PRIORITY_CALL_MAX_WAIT_MS` (a priority call) or `STORAGE_QUEUED_CALL_MAX_WAIT_MS` without
 * settling; a read waiting for a free place waits for the reads running then.
 */
class ScopeQueue {
	/** Unfinished calls: priority ones first, then the normal lane's, each in call order. */
	private readonly calls: ScopedCall[] = [];
	/** How many calls of the read scope run at once at most. */
	private readonly maxReads: number;
	private seq = 0;
	private clock = 0;
	private idle: (() => void)[] = [];
	private watchdog?: ReturnType<typeof setTimeout>;
	/** When the planned check runs, as `Date.now()`, or undefined when none is planned. */
	private watchdogAt?: number;
	private readonly stalled: (ranMs: number) => Error;

	constructor(stalled: (ranMs: number) => Error, maxReads = Number.POSITIVE_INFINITY) {
		this.stalled = stalled;
		this.maxReads = maxReads;
	}

	push<T>(operation: () => Promise<T>, priority = false, scope: CallScope = PLAIN_SCOPE): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const call: ScopedCall = {
				scope,
				priority,
				seq: this.seq++,
				admitted: this.clock++,
				runningSince: 0,
				run: () => Promise.resolve().then(operation).then(resolve, reject),
				fail: reject,
			};
			const firstNormal = this.calls.findIndex((queued) => !queued.priority);
			if (priority && firstNormal !== -1) this.calls.splice(firstNormal, 0, call);
			else this.calls.push(call);
			this.next();
			this.watch();
		});
	}

	drained(): Promise<void> {
		if (this.calls.length === 0) return Promise.resolve();
		return new Promise((resolve) => this.idle.push(resolve));
	}

	/** Whether `call`, still waiting, must wait for `other`. */
	private waitsFor(call: ScopedCall, other: ScopedCall): boolean {
		if (other === call) return false;
		// A read waits for a running read while as many as `maxReads` run.
		if (call.scope.kind === "read" && other.scope.kind === "read" && other.started !== undefined)
			return call.started === undefined && this.runningReads() >= this.maxReads;
		if (!scopesConflict(other.scope, call.scope)) return false;
		if (other.priority === call.priority) return other.seq < call.seq;
		// A priority call goes ahead of the normal lane's waiting calls, not of those already running when it came.
		return other.priority || (other.started !== undefined && other.started < call.admitted);
	}

	private runningReads(): number {
		let running = 0;
		for (const call of this.calls) if (call.scope.kind === "read" && call.started !== undefined) running++;
		return running;
	}

	private next(): void {
		for (const call of this.calls) {
			if (call.started !== undefined || this.calls.some((other) => this.waitsFor(call, other))) continue;
			call.started = this.clock++;
			call.runningSince = Date.now();
			// Started on a later microtask, as a promise chain starts it, never inside the call that queued it.
			void call.run().finally(() => {
				this.calls.splice(this.calls.indexOf(call), 1);
				this.next();
				this.watch();
			});
		}
		if (this.calls.length > 0) return;
		const idle = this.idle;
		this.idle = [];
		for (const resolve of idle) resolve();
	}

	/** Each waiting call with when the earliest running call it waits for, directly or through others, started. */
	private stuck(): Map<ScopedCall, number> {
		const since = new Map<ScopedCall, number>();
		for (const call of this.calls) {
			if (call.started !== undefined) continue;
			let earliest = Number.POSITIVE_INFINITY;
			for (const other of this.calls) {
				if (!this.waitsFor(call, other)) continue;
				earliest = Math.min(
					earliest,
					other.started === undefined ? (since.get(other) ?? earliest) : other.runningSince,
				);
			}
			since.set(call, earliest);
		}
		return since;
	}

	private static bound(call: ScopedCall): number {
		return call.priority ? STORAGE_PRIORITY_CALL_MAX_WAIT_MS : STORAGE_QUEUED_CALL_MAX_WAIT_MS;
	}

	/** Plans the check that fails the waiting calls whose wait passed its bound. No timer runs while nothing waits. */
	private watch(): void {
		let at: number | undefined;
		for (const [call, since] of this.stuck())
			if (Number.isFinite(since)) at = Math.min(at ?? Number.POSITIVE_INFINITY, since + ScopeQueue.bound(call));
		if (at === this.watchdogAt) return;
		clearTimeout(this.watchdog);
		this.watchdog = undefined;
		this.watchdogAt = at;
		if (at === undefined) return;
		this.watchdog = setTimeout(
			() => {
				this.watchdog = undefined;
				this.watchdogAt = undefined;
				const now = Date.now();
				const failing: [ScopedCall, number][] = [];
				for (const [call, since] of this.stuck())
					if (now - since >= ScopeQueue.bound(call)) failing.push([call, now - since]);
				for (const [call] of failing) this.calls.splice(this.calls.indexOf(call), 1);
				for (const [call, ran] of failing) call.fail(this.stalled(ran));
				this.next();
				this.watch();
			},
			Math.max(0, at - Date.now()),
		);
		// A stuck call ahead of the queue never keeps the process alive on its own.
		this.watchdog.unref();
	}
}

/** How many reads `driver` runs at once, when it runs any beside each other (`SqliteDriver.concurrentReads`). */
function concurrentReads(driver: SqliteDriver): number | undefined {
	const reads = driver.concurrentReads;
	return typeof reads === "number" && Number.isInteger(reads) && reads > 0 ? reads : undefined;
}

/**
 * The scope a transaction runs in on a driver that runs transactions or reads concurrently: a write transaction keeps
 * its domain only on a driver that runs writes concurrently (`concurrentTransactions`), and runs alone otherwise.
 */
function transactionScope(
	concurrency: TransactionConcurrency,
	readOnly: boolean,
	concurrentWrites: boolean,
): CallScope {
	if (readOnly) return READ_SCOPE;
	if (concurrentWrites && concurrency.kind === "serial" && concurrency.domain !== undefined)
		return { kind: "domain", domain: concurrency.domain };
	return WHOLE_SCOPE;
}

function hasInvalidText(statement: SqliteStatement): boolean {
	return statement.params.some((value) => typeof value === "string" && value.includes("\0"));
}

/** The failure of the first of `calls` that failed, in their order, once all settled; undefined when none did. */
async function firstFailure(calls: readonly Promise<unknown>[]): Promise<unknown> {
	for (const outcome of await Promise.allSettled(calls)) if (outcome.status === "rejected") return outcome.reason;
	return undefined;
}

/** `leading` with parameters snapshotted, up to the first statement that holds NUL, which the facade refuses to send. */
function leadingStatements(leading: readonly SqliteStatement[] | undefined): readonly SqliteStatement[] {
	const sent: SqliteStatement[] = [];
	for (const statement of leading ?? []) {
		if (hasInvalidText(statement)) break;
		sent.push({ sql: statement.sql, params: snapshotParams(statement.params) });
	}
	return sent;
}

/**
 * Runs `sequence` on a transaction of a pipelined connection: `repeat` one run at a time, since each run's changes
 * decide the next, then the statements a request's worth at a time, each request sent whole before any answer comes.
 * A statement sent behind one that failed fails too, or runs in a transaction that can no longer commit, so the
 * first failure in order is the sequence's, as when each waited for the one before. Nothing is sent after a statement
 * whose text holds NUL, which fails as `run` fails it.
 */
async function pipelineSequence(
	handle: SqliteExecutor,
	{ repeat, statements, signal }: SqliteSequence,
): Promise<number> {
	let repeated = 0;
	if (repeat !== undefined) {
		for (let done = 0; done < repeat.times; done++) {
			signal?.throwIfAborted();
			const { changes } = await handle.run(repeat.statement.sql, ...repeat.statement.params);
			if (changes < repeat.minChanges) break;
			repeated++;
		}
	}
	const pending = statements[Symbol.iterator]();
	for (let next = pending.next(); next.done !== true; ) {
		const sent: Promise<unknown>[] = [];
		for (; next.done !== true && sent.length < MAX_SEQUENCE_REQUEST_STATEMENTS; next = pending.next()) {
			if (signal?.aborted === true) break;
			const statement = next.value;
			sent.push(
				statement.script === true ? handle.exec(statement.sql) : handle.run(statement.sql, ...statement.params),
			);
			// `run` refuses it without sending it, so the sequence fails with that below.
			if (hasInvalidText(statement)) break;
		}
		const outcomes = await Promise.allSettled(sent);
		const failed = outcomes.find((outcome) => outcome.status === "rejected");
		if (failed !== undefined) throw failed.reason;
		signal?.throwIfAborted();
	}
	return repeated;
}

class DriverDatabase implements SqliteDatabase {
	readonly descriptor: StorageDescriptor;
	readonly dialect: StorageDialect;
	private readonly driver: SqliteDriver;
	/** Fenced transactions a concurrent driver runs outside the queue; closing waits for them. */
	private readonly concurrent = new Set<Promise<unknown>>();
	private readonly redact: (text: string) => string;
	private readonly queue: CallLanes;
	private closePromise?: Promise<void>;
	/** End the waits before calls run again, when closing begins during them. */
	private readonly wakeRetries = new Set<() => void>();
	private retryReported = false;
	private readonly executor: SqliteExecutor;
	readonly batch?: (statements: readonly SqliteStatement[], options?: SqliteBatchOptions) => Promise<SqliteRow[][]>;
	readonly notifications?: StorageNotifications;
	readonly freeBytes?: () => Promise<number | undefined>;
	readonly databaseIdentity?: () => string | undefined;
	readonly openReader?: () => Promise<SqliteDatabase>;
	readonly takeOpenedCatalog?: () => StorageOpenedCatalog | undefined;
	readonly autocommit?: (statement: SqliteStatement, concurrency: TransactionConcurrency) => Promise<SqliteRow[]>;
	/** Readers this database opened and that are not closed; closing closes them. */
	private readonly readers = new Set<DriverDatabase>();
	private readonly closed?: () => void;

	constructor(driver: SqliteDriver, redact: (text: string) => string, closed?: () => void) {
		this.driver = driver;
		this.closed = closed;
		const openReader = driver.openReader?.bind(driver);
		if (openReader) this.openReader = () => this.startReader(openReader);
		if (driver.notifications !== undefined) this.notifications = driver.notifications;
		const freeBytes = driver.freeBytes?.bind(driver);
		if (freeBytes) this.freeBytes = async () => freeBytes();
		const databaseIdentity = driver.databaseIdentity?.bind(driver);
		if (databaseIdentity) this.databaseIdentity = databaseIdentity;
		const takeOpenedCatalog = driver.takeOpenedCatalog?.bind(driver);
		if (takeOpenedCatalog) this.takeOpenedCatalog = takeOpenedCatalog;
		this.redact = redact;
		this.descriptor = { adapter: driver.descriptor.adapter, location: redact(driver.descriptor.location) };
		const stalled = (ranMs: number) =>
			new StorageUnavailableError(
				this.descriptor,
				undefined,
				`the call was queued behind an earlier call that ran ${Math.round(ranMs / 1000)} seconds without settling, and did not run; nothing was written, retry it`,
			);
		const maxReads = concurrentReads(driver);
		this.queue =
			driver.concurrentTransactions === true || maxReads !== undefined
				? new ScopeQueue(stalled, maxReads)
				: new LaneQueue(stalled);
		this.dialect = driver.dialect ?? sqliteDialect;
		const readsOnly = driver.readsOnly?.bind(driver);
		const scopeOf =
			readsOnly !== undefined && (driver.concurrentTransactions === true || maxReads !== undefined)
				? (sql: string) => (readsOnly(sql) ? READ_SCOPE : PLAIN_SCOPE)
				: () => PLAIN_SCOPE;
		this.executor = this.createExecutor(
			driver,
			(operation, sql) => {
				if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
				return this.queue.push(
					() => this.retrying(operation, true),
					false,
					sql === undefined ? PLAIN_SCOPE : scopeOf(sql),
				);
			},
			true,
		);
		const batch = driver.batch?.bind(driver);
		if (batch) this.batch = (statements, options) => this.runBatch(batch, statements, options);
		if (driver.concurrentTransactions === true)
			this.autocommit = (statement, concurrency) => this.runAutocommit(statement, concurrency);
	}

	/** `autocommit`: the statement on its own, through the driver's `execute`, in the queue scope of `concurrency`. */
	private runAutocommit(statement: SqliteStatement, concurrency: TransactionConcurrency): Promise<SqliteRow[]> {
		if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
		let scope: CallScope;
		try {
			scope = transactionScope(transactionConcurrency({ concurrency }), false, true);
		} catch (error) {
			return Promise.reject(error);
		}
		const bound = snapshotParams(statement.params);
		return this.queue.push(
			() =>
				this.retrying(async (attempt) => {
					const invalidIndex = bound.findIndex((value) => typeof value === "string" && value.includes("\0"));
					if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
					const result = await this.call(() => this.driver.execute(statement.sql, bound), attempt, true, bound);
					return result.rows.map((row) => normalizeRow(row, result.columns));
				}, true),
			false,
			scope,
		);
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
							outcome: applies || attempt.committing === true ? transient.outcome : "not-applied",
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
		admit: <T>(operation: (attempt: Attempt) => Promise<T>, sql?: string) => Promise<T>,
		applies: boolean,
	): SqliteExecutor {
		const statement = (sql: string, params: readonly SqliteValue[]) => {
			const bound = snapshotParams(params);
			return admit(async (attempt) => {
				const invalidIndex = bound.findIndex((value) => typeof value === "string" && value.includes("\0"));
				if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
				return this.call(() => connection.execute(sql, bound), attempt, applies, bound);
			}, sql);
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
		const leading = this.driver.pipelinedTransactions === true ? leadingStatements(options?.leading) : [];
		const begin: SqliteDriverTransactionOptions = {
			concurrency,
			...(options?.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }),
			...(options?.readOnly === true ? { readOnly: true } : {}),
			...(leading.length === 0 ? {} : { leading }),
			// Only when the callback makes nothing but calls that went with the start: a statement the facade held back is one.
			...(options?.leadingOnly === true && leading.length > 0 && leading.length === options.leading?.length
				? { leadingOnly: true }
				: {}),
			// `leading` holds the first statement whenever it holds any.
			...(options?.lockIfLeadingFinds === true && leading.length > 0 ? { lockIfLeadingFinds: true } : {}),
			...(options?.relaxedDurability === true && options.readOnly !== true ? { relaxedDurability: true } : {}),
		};
		const run = () => this.retrying((attempt) => this.runTransaction(callback, attempt, begin), replay);
		const concurrentWrites = this.driver.concurrentTransactions === true;
		if (concurrency.kind === "serial" || !concurrentWrites)
			return this.queue.push(
				run,
				false,
				transactionScope(concurrency, options?.readOnly === true, concurrentWrites),
			);
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
		/** Set once `finish` sent the callback's last calls: the transaction takes no more. */
		let finished = false;
		const handle = this.createExecutor(
			connection,
			(operation) =>
				active && !finished
					? handleQueue.push(() => operation(attempt))
					: Promise.reject(new StorageTransactionClosedError()),
			false,
		);
		if (pipelined) {
			offerSequences(handle, (sequence) => pipelineSequence(handle, sequence));
			offerFinish(handle, (statements) => {
				if (!active || finished) return false;
				if (statements.length > MAX_SEQUENCE_REQUEST_STATEMENTS || statements.some(hasInvalidText)) return false;
				// Their failures are the transaction's, reported once the commit is answered.
				for (const statement of statements) {
					const sent =
						statement.script === true
							? handle.exec(statement.sql)
							: handle.run(statement.sql, ...statement.params);
					sent.catch(() => {});
				}
				finished = true;
				return true;
			});
		}
		const close = () => this.call(() => connection.close?.());
		// Once the callback has returned, the commit's own failure decides whether the transaction runs again: a commit
		// that may have applied, or that failed for a reason the driver does not recognize, never does, whatever the
		// callback met before it. A committed transaction never runs again either.
		const commit = () => {
			attempt.transient = undefined;
			attempt.committing = true;
			return this.call(() => connection.commit(), attempt, true);
		};
		let returned = false;
		try {
			let committing: Promise<void> | undefined;
			try {
				result = await callback(handle);
				returned = true;
				// A pipelined connection takes the commit behind statements the callback left unanswered, such as those sent by
				// `finish`, so locks they take are held for one round trip. The driver's commit fails when one of them failed,
				// so nothing commits then, and the first of them to fail is the failure. One that the server refused lets the
				// transaction run again, having written nothing; one whose connection broke may have committed, so it does not.
				if (pipelined) {
					committing = commit();
					committing.catch(() => {});
				}
			} finally {
				active = false;
				await handleQueue.drained();
			}
			// A read-only transaction on a connection of its own has its answer once its reads are answered: its commit only
			// ends the snapshot, so the connection goes back once the commit is answered, while the caller goes on.
			if (
				begin.readOnly === true &&
				(this.driver.concurrentTransactions === true || concurrentReads(this.driver) !== undefined)
			) {
				this.endInBackground(committing ?? commit(), connection, close);
				return result;
			}
			await (committing ?? commit());
		} catch (cause) {
			let failure = cause as StorageFailureCause;
			// A commit that came back as a rollback names no reason: the statement that failed is the transaction's failure,
			// and whether it may run again is that failure's, as when the callback awaited it.
			const unanswered =
				returned && handleQueue instanceof PipelineQueue ? await handleQueue.firstFailure() : undefined;
			if (unanswered !== undefined) {
				failure = unanswered as StorageFailureCause;
				if (unanswered instanceof StorageTransientError) attempt.transient = unanswered;
			}
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

	/**
	 * Ends a read-only transaction whose reads were all answered once `committing` settles: rolls it back when the commit
	 * failed, then closes it. Closing the database waits for it.
	 */
	private endInBackground(
		committing: Promise<void>,
		connection: SqliteDriverTransaction,
		close: () => Promise<void>,
	): void {
		const ended = committing
			.catch(() => this.call(() => connection.rollback()).catch(() => {}))
			.then(close)
			.catch(() => {});
		this.concurrent.add(ended);
		void ended.then(() => this.concurrent.delete(ended));
	}

	private startReader(openReader: () => Awaitable<SqliteDriver>): Promise<SqliteDatabase> {
		if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
		const opening = this.call(openReader).then((driver) => {
			const reader: DriverDatabase = new DriverDatabase(driver, this.redact, () => this.readers.delete(reader));
			this.readers.add(reader);
			if (this.closePromise) throw new StoreClosedError(this.descriptor);
			return reader;
		});
		const settled = opening.then(
			() => {},
			() => {},
		);
		this.concurrent.add(settled);
		void settled.then(() => this.concurrent.delete(settled));
		return opening;
	}

	close(): Promise<void> {
		const closeReaders = () => Promise.allSettled([...this.readers].map((reader) => reader.close()));
		// Readers stop taking calls now; one that finished opening meanwhile is closed after the drain.
		this.closePromise ??= Promise.all([this.queue.drained(), ...this.concurrent, closeReaders()])
			.then(closeReaders)
			.then(() => this.call(() => this.driver.close()))
			.finally(() => this.closed?.());
		for (const wake of this.wakeRetries) wake();
		return this.closePromise;
	}
}

/**
 * Wraps a SQLite-compatible driver as a `SqliteDatabase`. The facade queues operations in call order and keeps them
 * outside active transactions (on a driver that runs transactions concurrently, only operations that conflict wait for
 * each other), snapshots binary parameters at call time, rejects NUL text, returns safe-range integers
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
