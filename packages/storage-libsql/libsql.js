// @ts-check
import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createSqliteDatabase, redactSecrets, StorageAdapterLoadError, switchToWriteAheadLog } from "@bastani/atomic/storage";

/**
 * @typedef {{ url: string, authToken?: string, namespace?: string, headers?: Readonly<Record<string, string>>, keepAliveMs?: number, concurrency?: number }} LibsqlDatabaseOptions
 * @typedef {{ fetch(request: Request, signal: AbortSignal): Promise<Response>, close(): Promise<void>, destroy(): Promise<void> }} KeptConnections
 * @typedef {[typeof import("@libsql/hrana-client"), typeof import("@libsql/core/config"), typeof import("@libsql/core/uri"), typeof import("@libsql/core/api")]} ServerProtocol
 */

/** Header names an HTTP request can carry: RFC 9110 tokens. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The request headers `namespace` and `headers` add, checked. A self-hosted sqld started with `--enable-namespaces`
 * picks the database by `x-namespace`.
 * @param {string} url
 * @param {string | undefined} namespace
 * @param {Readonly<Record<string, string>> | undefined} headers
 * @returns {[string, string][]}
 */
function requestHeaders(url, namespace, headers) {
	/** @type {[string, string][]} */
	const added = Object.entries(headers ?? {});
	if (namespace !== undefined) {
		if (typeof namespace !== "string" || namespace === "")
			throw new TypeError('The libSQL storage adapter\'s "namespace" option must be a non-empty string');
		added.push(["x-namespace", namespace]);
	}
	for (const [name, value] of added) {
		if (!HEADER_NAME.test(name)) throw new TypeError(`The libSQL storage adapter can't send the header name ${JSON.stringify(name)}`);
		if (typeof value !== "string" || /[\r\n\0]/.test(value))
			throw new TypeError(`The libSQL storage adapter can't send the value of header ${JSON.stringify(name)}`);
	}
	if (added.length > 0 && !/^(libsql|https?):/i.test(url))
		throw new TypeError(
			'The libSQL storage adapter sends "namespace" and "headers" only over HTTP: use a libsql:, https: or http: URL',
		);
	return added;
}

/**
 * `keepAliveMs` checked: a positive integer, or undefined to keep the runtime's own idle timeout. It is honoured only for
 * HTTP: a WebSocket URL keeps its one connection open anyway.
 * @param {string} url
 * @param {unknown} keepAliveMs
 * @returns {number | undefined}
 */
function keptAliveMs(url, keepAliveMs) {
	if (keepAliveMs === undefined) return undefined;
	if (typeof keepAliveMs !== "number" || !Number.isInteger(keepAliveMs) || keepAliveMs <= 0)
		throw new TypeError('The libSQL storage adapter\'s "keepAliveMs" option must be a positive integer of milliseconds');
	if (!/^(libsql|https?):/i.test(url)) return undefined;
	return keepAliveMs;
}

/**
 * How long, on Bun, a connection to a server may sit idle before the next request opens a new one instead, unless
 * `keepAliveMs` says otherwise: the 4 seconds of undici's `keepAliveTimeout`, which Node's fetch keeps an idle
 * connection for. Turso closes an idle connection 5 seconds after its last response and sends no `Keep-Alive` header,
 * while Bun keeps one in its pool for at least 8 seconds (oven-sh/bun#45138). A request Bun sends on a connection just
 * as the server closes it fails with `ECONNRESET`, and the adapter cannot tell whether the server ran it.
 */
const BUN_IDLE_CONNECTION_MS = 4_000;

/**
 * Bun's connections for one driver's requests, in a `Bun.FetchSession` of their own that keeps at most one idle
 * connection: the one whose answer came last. A request after `idleMs` without an answer first closes that connection,
 * so it never goes over a connection the server may be closing. The idle time counts from when `fetch` resolved,
 * before Bun had read the body and returned the connection, so it is never shorter than the connection's. Bun's own
 * shortest idle timeout is 8 seconds (`keepAlive.idleTimeout` moves in 4-second steps), and it does not keep a request
 * off the pool for a `Connection: close` header (oven-sh/bun#46027).
 * @implements {KeptConnections}
 */
class IdleClosedConnections {
	/** @param {number} idleMs */
	constructor(idleMs) {
		this.idleMs = idleMs;
		this.session = new Bun.FetchSession({ keepAlive: { maxIdleSockets: 1 } });
		/** When the last answer arrived. */
		this.answered = Number.NEGATIVE_INFINITY;
	}

	/**
	 * @param {Request} request
	 * @param {AbortSignal} signal
	 */
	async fetch(request, signal) {
		if (performance.now() - this.answered > this.idleMs) this.session.close();
		const response = await this.session.fetch(request, { signal });
		this.answered = performance.now();
		return response;
	}

	async close() {
		this.session.close();
	}

	async destroy() {
		this.session.close();
	}
}

/**
 * How long one request to a database server may go unanswered before it is abandoned. A server answers a request that
 * waits for its write lock within its own lock wait (sqld's is 5 seconds), so a request still unanswered long after
 * that is stuck in the server: abandoning it lets the caller plan its write again instead of waiting without end.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The wait before the first resend of the close of a stream abandoned in an outage (#5114); each later wait doubles, up
 * to `ABANDONED_STREAM_CLOSE_LAST_WAIT_MS`. A stream the server keeps holds its open transaction, and with it the
 * database's write lock, until the server expires it: every writer waits for the lock meanwhile, this process's and
 * every other's. A close the server answers, whatever the answer, is done. Each request of the same client also sends
 * the closes ahead of itself, whatever the wait (`AbandonedStreams.start` and `AbandonedStreams.beforeWrite`).
 */
const ABANDONED_STREAM_CLOSE_FIRST_WAIT_MS = 250;
/** The longest wait between two resends of abandoned stream closes. */
const ABANDONED_STREAM_CLOSE_LAST_WAIT_MS = 8_000;
/**
 * How long one abandoned stream's close is sent again before it is given up. The client does not know the server's
 * stream lifetime (10 s in sqld); a server keeps no stream this long, so the close no longer frees anything.
 */
const ABANDONED_STREAM_CLOSE_MAX_AGE_MS = 5 * 60_000;
/** How long one resend of an abandoned stream's close may go unanswered; a later resend tries again. */
const ABANDONED_STREAM_CLOSE_TIMEOUT_MS = 5_000;
/**
 * How long writes wait, in all, for a round of abandoned stream closes the server takes but does not answer. A server
 * that is reachable answers a close at once, without waiting for any lock; one that has not answered by then may never
 * answer, and a write that goes ahead waits on the server for the lock as it would have anyway. Writes wait no more
 * until the server answers a close again.
 */
const ABANDONED_STREAM_CLOSE_WRITE_WAIT_MS = 2_000;
/** The most abandoned stream closes kept for resending; the oldest is dropped past it, its stream long expired. */
const MAX_ABANDONED_STREAM_CLOSES = 16;

/**
 * Whether `body`, a Hrana pipeline request body, only closes the stream its baton names: the request the HTTP client
 * sends once for a stream it gave up on, `{"baton":…,"requests":[{"type":"close"}]}`. `@libsql/client` speaks Hrana 2
 * over HTTP, whose bodies are JSON; any other body is never taken for a close.
 * @param {Uint8Array} body
 * @param {boolean} [withoutBaton] whether the close names no stream instead, as a stream's first request that failed
 * leaves it
 */
function closesStream(body, withoutBaton = false) {
	try {
		const { baton, requests } = JSON.parse(new TextDecoder().decode(body));
		return (
			(withoutBaton ? baton === null || baton === undefined : typeof baton === "string") &&
			Array.isArray(requests) &&
			requests.length === 1 &&
			requests[0]?.type === "close"
		);
	} catch {
		return false;
	}
}

/** The most bytes a request body that only closes a stream takes: `{"baton":null,"requests":[{"type":"close"}]}`. */
const LONE_CLOSE_MAX_BYTES = 64;

/**
 * Whether `request` only closes a stream the server never gave a baton for. The Hrana client sends one when a
 * stream's first request fails; the server keeps no stream for it to close, so it opens one only to close it. A stream
 * reused across statements (#5151) has its first request fail in an outage, so that close would reach a server just
 * back for nothing, ahead of the next real request.
 * @param {Request} request an unread copy
 */
async function closesNoStream(request) {
	const reader = request.body?.getReader();
	if (reader === undefined) return false;
	/** @type {Uint8Array[]} */
	const chunks = [];
	let length = 0;
	try {
		// Reads no further than a lone close's size, so a large request is never read twice.
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			length += value.byteLength;
			if (length > LONE_CLOSE_MAX_BYTES) return false;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return closesStream(body, true);
}

/**
 * Whether `request`, a Hrana pipeline or cursor request, may take the database's write lock, so it would wait on the
 * server behind a lock an abandoned stream holds: it runs a statement that is not one `SELECT`, a sequence of
 * statements, or SQL it stored earlier. A request without a body, such as a version check, takes no lock; one whose body
 * is not JSON counts as a write.
 * @param {Request} request an unread copy
 */
async function mayWrite(request) {
	const text = await request.text();
	if (text === "") return false;
	/** @type {{ requests?: unknown, batch?: { steps?: unknown } }} */
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return true;
	}
	/** @type {unknown[]} */
	const statements = [];
	const steps = (/** @type {unknown} */ batch) =>
		Array.isArray(batch) ? batch.map((step) => /** @type {{ stmt?: unknown }} */ (step)?.stmt) : [];
	for (const each of Array.isArray(body?.requests) ? body.requests : []) {
		const { type, stmt, batch } = /** @type {{ type?: unknown, stmt?: unknown, batch?: { steps?: unknown } }} */ (each ?? {});
		if (type === "sequence") return true;
		if (type === "execute") statements.push(stmt);
		else if (type === "batch") statements.push(...steps(batch?.steps));
	}
	statements.push(...steps(body?.batch?.steps));
	return statements.some((stmt) => !readsOnly(/** @type {{ sql?: unknown }} */ (stmt)?.sql));
}

/** The keyword of a statement that only reads. */
const READ_KEYWORD = /SELECT\b/iy;

/**
 * Whether `sql` is one `SELECT`, which never takes the write lock. SQL that is not text, as a statement stored earlier
 * leaves it, may write.
 * @param {unknown} sql
 */
function readsOnly(sql) {
	if (typeof sql !== "string") return false;
	const start = firstTokenStart(sql);
	if (start === -1) return false;
	READ_KEYWORD.lastIndex = start;
	return READ_KEYWORD.test(sql) && isOneStatement(sql);
}

/** The answer a server gives a request that only closes a stream. */
function closedResponse() {
	return new Response(JSON.stringify({ baton: null, base_url: null, results: [{ type: "ok", response: { type: "close" } }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/**
 * The closes of streams this client abandoned that never reached the server, sent again until the server answers one.
 * The HTTP client sends a stream's close once, when a request of the stream fails; in an outage that close fails too,
 * and the server keeps the stream, with its open transaction and the write lock it holds, for the stream's whole
 * lifetime. Sending the close again as soon as the server is reachable ends the transaction there and frees the lock:
 * a timer sends the closes with growing waits while the client sends nothing else, and each request the client sends
 * sends them ahead of itself. A write waits for them (`beforeWrite`), so it does not queue on the server behind a lock
 * its own client's abandoned stream holds; any other request goes at once.
 */
class AbandonedStreams {
	/** @type {{ url: string, headers: [string, string][], body: ArrayBuffer, since: number }[]} */
	pending = [];
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	timer;
	/** Whether a round the timer started, or joined, is under way: the timer plans the next one when it ends. */
	timerRound = false;
	/** @type {Promise<boolean> | undefined} */
	sending;
	/** When the writes waiting for the round under way stop waiting for it. @type {number | undefined} */
	waitUntil;
	/**
	 * Whether a round left the writes waiting for it unanswered: writes wait no more for the closes kept then, until one is
	 * answered, given up or joined by a newly kept close.
	 */
	stalled = false;
	wait = ABANDONED_STREAM_CLOSE_FIRST_WAIT_MS;
	closed = false;

	/**
	 * Keeps `request`'s close for resending when it only closes a stream.
	 * @param {Request} request an unread copy of the request that failed
	 */
	async failed(request) {
		const body = await request.arrayBuffer();
		if (this.closed || !closesStream(new Uint8Array(body))) return;
		this.pending.push({ url: request.url, headers: [...request.headers], body, since: Date.now() });
		// A stall belongs to the closes it was found for: a newly kept close, whose stream may hold the lock now, is waited for.
		this.stalled = false;
		if (this.pending.length > MAX_ABANDONED_STREAM_CLOSES) this.pending.shift();
		this.schedule();
	}

	/**
	 * Sends the kept closes again after the current wait, unless a resend is already planned or the timer's round is under
	 * way. A round the timer started that leaves a close unanswered doubles the wait before the next one, once; a round a
	 * request started, which the timer joined, leaves it as it is.
	 */
	schedule() {
		if (this.timer !== undefined || this.timerRound || this.pending.length === 0) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.timerRound = true;
			const joined = this.sending !== undefined;
			void this.send().then((answered) => {
				this.timerRound = false;
				if (!answered && !joined) this.wait = Math.min(this.wait * 2, ABANDONED_STREAM_CLOSE_LAST_WAIT_MS);
				this.schedule();
			});
		}, this.wait);
		// A close waiting to be sent again never keeps the process alive.
		this.timer.unref();
	}

	/** Sends the kept closes ahead of a request that does not wait for them, unless a round is under way. */
	start() {
		if (this.pending.length > 0) void this.send();
	}

	/**
	 * Sends the kept closes ahead of a write, unless a round is under way, and waits for the round. A server reachable
	 * again would otherwise take the write while an abandoned stream still holds the write lock, and the write would wait
	 * for that lock until the next timed resend. The writes waiting for one round wait for it at most
	 * `ABANDONED_STREAM_CLOSE_WRITE_WAIT_MS` in all; a round still unanswered then stalls the closes, and no write waits
	 * for them again until the server answers one, they are given up, or another close is kept. A round that fails at once costs nothing: the write finds the server
	 * unreachable on its own. Rejects with the reason of `signal` when it aborts first; the round goes on.
	 * @param {AbortSignal} signal
	 */
	async beforeWrite(signal) {
		if (this.pending.length === 0) return;
		signal.throwIfAborted();
		const round = this.send();
		if (this.stalled) return;
		this.waitUntil ??= performance.now() + ABANDONED_STREAM_CLOSE_WRITE_WAIT_MS;
		const left = this.waitUntil - performance.now();
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		/** @type {(() => void) | undefined} */
		let abort;
		try {
			const late = await new Promise((resolve, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				timer = setTimeout(() => resolve(true), Math.max(left, 0));
				void round.then(() => resolve(false));
			});
			if (late && this.sending === round) this.stalled = true;
		} finally {
			clearTimeout(timer);
			if (abort !== undefined) signal.removeEventListener("abort", abort);
		}
	}

	/**
	 * Sends each kept close again, in order, until one goes unanswered; an answered close is done, whatever it says, and
	 * resets the wait and any stall. A close older than `ABANDONED_STREAM_CLOSE_MAX_AGE_MS` is given up. Joins the round
	 * under way, if any. Resolves whether every kept close was answered.
	 * @returns {Promise<boolean>}
	 */
	send() {
		this.sending ??= (async () => {
			const oldest = Date.now() - ABANDONED_STREAM_CLOSE_MAX_AGE_MS;
			this.pending = this.pending.filter((close) => close.since > oldest);
			if (this.pending.length === 0) this.stalled = false;
			while (this.pending.length > 0) {
				const [close] = this.pending;
				try {
					const response = await fetch(close.url, {
						method: "POST",
						headers: close.headers,
						body: close.body,
						signal: AbortSignal.timeout(ABANDONED_STREAM_CLOSE_TIMEOUT_MS),
					});
					await response.arrayBuffer().catch(() => {});
				} catch {
					return false;
				}
				this.wait = ABANDONED_STREAM_CLOSE_FIRST_WAIT_MS;
				this.stalled = false;
				this.pending = this.pending.filter((kept) => kept !== close);
			}
			return true;
		})().finally(() => {
			this.sending = undefined;
			this.waitUntil = undefined;
		});
		return this.sending;
	}

	/** Stops resending: the closes kept are given up, and a resend under way sends no further close. */
	close() {
		this.closed = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = [];
	}
}

/**
 * `fetch` that adds `headers` to every request the libSQL HTTP client sends, sends the closes `abandoned` keeps ahead of
 * it (a write waits for them), abandons a request after `REQUEST_TIMEOUT_MS`, wait included, and hands a stream's close
 * that failed to `abandoned` for resending. With `kept`, requests go over its connections instead of the runtime's
 * pool.
 * @param {[string, string][]} headers
 * @param {AbandonedStreams} abandoned
 * @param {KeptConnections} [kept]
 * @returns {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>}
 */
function fetchWith(headers, abandoned, kept) {
	return async (input, init) => {
		const request = new Request(input, init);
		for (const [name, value] of headers) request.headers.set(name, value);
		const copy = request.clone();
		if (await closesNoStream(request.clone())) return closedResponse();
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		// The caller's signal: the one `init` passes, or else the one `input`, a request, carries.
		const signal = AbortSignal.any([request.signal, timeout]);
		if (abandoned.pending.length > 0) {
			if (await mayWrite(request.clone())) await abandoned.beforeWrite(signal);
			else abandoned.start();
		}
		try {
			return await (kept === undefined ? fetch(request, { signal }) : kept.fetch(request, signal));
		} catch (error) {
			await abandoned.failed(copy).catch(() => {});
			throw error;
		}
	};
}

/**
 * Credentials a libSQL URL can carry: its userinfo and every `authToken` query value.
 * @param {string} url
 * @returns {string[]}
 */
function urlCredentials(url) {
	const secrets = [];
	// Scan each key/value once, including malformed URLs, without retrying a growing suffix at every '?'.
	for (let index = 0; index < url.length; index++) {
		if (url[index] !== "?" && url[index] !== "&") continue;
		const start = ++index;
		while (index < url.length && !"?&=#".includes(url[index])) index++;
		if (url[index] === "=") {
			const valueStart = ++index;
			while (index < url.length && url[index] !== "&" && url[index] !== "#") index++;
			const token = new URLSearchParams(url.slice(start, index)).get("authToken");
			if (token !== null) secrets.push(url.slice(valueStart, index), token);
		}
		index--;
	}
	const userinfo = url.match(/\/\/([^/?#]*)@/)?.[1];
	if (userinfo !== undefined) secrets.push(...userinfo.split(":"));
	return secrets;
}

/**
 * How long a reused stream may sit idle before a statement opens a new one instead. sqld expires a stream idle for 10
 * seconds; a stream reused well inside that never meets its expiry, which costs a request sent for nothing.
 */
const STREAM_REUSE_IDLE_MS = 5_000;
/** How long one stream is reused at most, however busy: a later statement opens a new one. */
const STREAM_REUSE_MAX_AGE_MS = 60_000;
/**
 * How long closing a database waits for its reused stream's close to be answered. A server that does not answer in
 * time expires the stream itself; the stream runs outside any transaction, so it holds no lock meanwhile.
 */
const STREAM_CLOSE_WAIT_MS = 1_000;

/**
 * The statement a kept stream runs before each statement, in the same request, so its connection rereads a schema
 * another connection changed (#5151). `PRAGMA schema_version` reads the cookie but does not reload the schema; a read of
 * `sqlite_schema` does, and returns no row.
 */
const SCHEMA_CHECK = "SELECT 1 FROM sqlite_schema LIMIT 0";

/** The table a server's `no such table` answer names, at the end of its message. */
const MISSING_TABLE = /no such table: (\S+)$/;
/** A read of the schema itself, not of the connection's copy of it, for a table or view of the main database. */
const TABLE_LOOKUP = "SELECT 1 FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE";
/**
 * How many times a statement the server answered `no such table` for a table that exists runs again. Each answer is
 * an independent loss of a race with other connections' schema changes, so the bound counts runs, not time: a server
 * slowed by load answers each run late, yet each run loses as rarely.
 */
const MISSING_TABLE_RERUNS = 20;

/**
 * What sqld answers, as plain text with HTTP 400, for a request whose baton it refuses when it looks the stream up,
 * before it runs any request of the pipeline (`stream::acquire` and `Guard::get_db` in sqld's
 * `hrana/http/stream.rs`): the stream was cleaned up after expiring, the baton was used already, or the stream was
 * closed. Any other HTTP 400 can follow a request of the same pipeline that ran, so it is never taken for a refusal.
 */
const REFUSED_BATON = [
	"Received an invalid baton",
	"Received a baton that has already been used",
	"Stream for this baton was closed",
];

/**
 * The keyword that makes a statement run on the reused stream: reads and writes that leave the connection as they
 * found it. Anything else, such as `BEGIN`, a `PRAGMA`, a temporary table or a schema change, runs on a stream of its
 * own, so the connection a reused stream holds never carries a transaction or a setting from one call into the next.
 */
const REUSABLE_KEYWORD = /(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|VALUES)\b/iy;

const WHITESPACE = /\s/;

/**
 * Where `sql`'s first token starts, after its leading whitespace, `--` comments and `/* *\/` comments, or -1 when a
 * block comment is left open. One pass, which ends a block comment at its first `*\/` as SQLite does: a regular
 * expression for the same prefix backtracks exponentially on runs of comments such as `/**\//**\/…`.
 * @param {string} sql
 */
function firstTokenStart(sql) {
	let index = 0;
	while (index < sql.length) {
		if (WHITESPACE.test(sql[index])) index++;
		else if (sql.startsWith("--", index)) {
			const end = sql.indexOf("\n", index + 2);
			if (end === -1) return sql.length;
			index = end + 1;
		} else if (sql.startsWith("/*", index)) {
			const end = sql.indexOf("*/", index + 2);
			if (end === -1) return -1;
			index = end + 2;
		} else return index;
	}
	return index;
}

/**
 * Whether `sql`, one statement, runs on the reused stream.
 * @param {string} sql
 */
function reusable(sql) {
	const start = firstTokenStart(sql);
	if (start === -1) return false;
	REUSABLE_KEYWORD.lastIndex = start;
	return REUSABLE_KEYWORD.test(sql) && isOneStatement(sql);
}

/**
 * The Hrana code `@libsql/client` gives a failure of the protocol, as its `mapHranaError` does, so a statement on the
 * reused stream fails with the same `LibsqlError` it fails with through the client.
 * @param {typeof import("@libsql/hrana-client")} hrana
 * @param {unknown} error
 * @returns {string}
 */
function hranaCode(hrana, error) {
	if (error instanceof hrana.ResponseError && error.code !== undefined) return error.code;
	if (error instanceof hrana.ProtoError) return "HRANA_PROTO_ERROR";
	if (error instanceof hrana.ClosedError)
		return error.cause instanceof hrana.ClientError ? hranaCode(hrana, error.cause) : "HRANA_CLOSED_ERROR";
	if (error instanceof hrana.WebSocketError) return "HRANA_WEBSOCKET_ERROR";
	if (error instanceof hrana.HttpServerError) return "SERVER_ERROR";
	if (error instanceof hrana.ProtocolVersionError) return "PROTOCOL_VERSION_ERROR";
	if (error instanceof hrana.InternalError) return "INTERNAL_ERROR";
	return "UNKNOWN";
}

/**
 * One Hrana stream that statements outside a transaction take in turn (#5151). sqld loads the database's schema for
 * every stream it opens, so a request that opens, uses and closes a stream costs time that grows with the number of
 * tables; a stream kept open loads it once. A stream that failed, sat idle `STREAM_REUSE_IDLE_MS` or lived
 * `STREAM_REUSE_MAX_AGE_MS` is closed and a new one opened. A statement is sent again only when the server refused its
 * request without running it: it found the stream expired, or refused its baton (`REFUSED_BATON`). A request whose
 * answer was lost may have run, so its failure is the caller's, as it is for a statement on a stream of its own. A
 * statement the server answered `no such table` for a table the schema holds runs again, with growing waits, up to
 * `MISSING_TABLE_RERUNS` times (#5464): the server compiled it while other connections changed the schema and ran none
 * of it.
 */
class ReusedStream {
	/** @type {import("@libsql/hrana-client").Stream | undefined} */
	stream;
	openedAt = 0;
	usedAt = 0;
	/** Whether a statement is on the stream now; a statement arriving meanwhile takes a stream of its own. */
	busy = false;

	/**
	 * @param {typeof import("@libsql/hrana-client")} hrana
	 * @param {typeof import("@libsql/core/api").LibsqlError} LibsqlError
	 * @param {() => import("@libsql/hrana-client").Client} client
	 */
	constructor(hrana, LibsqlError, client) {
		this.hrana = hrana;
		this.LibsqlError = LibsqlError;
		this.client = client;
	}

	/**
	 * Runs `sql` on the stream, or answers undefined when another statement is on it.
	 * @param {string} sql
	 * @param {readonly unknown[]} params
	 * @returns {Promise<import("@bastani/atomic/storage").SqliteDriverResult | undefined>}
	 */
	async execute(sql, params) {
		if (this.busy) return undefined;
		this.busy = true;
		try {
			let resent = false;
			let reruns = 0;
			for (let wait = SERVER_BUSY_FIRST_WAIT_MS; ; ) {
				const now = performance.now();
				const kept = this.stream;
				if (
					kept !== undefined &&
					(kept.closed || now - this.usedAt > STREAM_REUSE_IDLE_MS || now - this.openedAt > STREAM_REUSE_MAX_AGE_MS)
				)
					this.drop();
				const fresh = this.stream === undefined;
				const stream = (this.stream ??= this.client().openStream());
				if (fresh) this.openedAt = now;
				try {
					const statement = new this.hrana.Stmt(sql);
					statement.bindIndexes(/** @type {import("@libsql/hrana-client").InValue[]} */ ([...params]));
					// A kept connection compiles a statement against the schema it read last, and SQLite rereads the schema
					// only when a statement's transaction finds the schema cookie changed. A statement compiled against a
					// stale schema expands `SELECT *` to the old columns, or fails to compile at all. Reading
					// `sqlite_schema` first, in the same request, makes the connection reread a schema changed elsewhere.
					// A new stream's connection reads the schema afresh.
					const checked = fresh ? undefined : stream.query(new this.hrana.Stmt(SCHEMA_CHECK));
					checked?.catch(() => {});
					const rows = await stream.query(statement);
					return {
						columns: rows.columnNames.map((name) => name ?? ""),
						rows: /** @type {import("@bastani/atomic/storage").SqliteDriverResult["rows"]} */ (rows.rows),
						changes: rows.affectedRowCount,
					};
				} catch (error) {
					if (stream.closed && this.stream === stream) this.stream = undefined;
					if (!fresh && !resent && this.ranNothing(error)) {
						resent = true;
						continue;
					}
					if (reruns >= MISSING_TABLE_RERUNS || !(await this.namesExistingTable(stream, error)))
						throw this.libsqlError(error);
					reruns++;
					await new Promise((resolve) => setTimeout(resolve, wait));
					wait = Math.min(wait * 2, SERVER_BUSY_LAST_WAIT_MS);
				} finally {
					this.usedAt = performance.now();
				}
			}
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Whether the server refused a request on a kept stream without running it: it found the stream expired, or refused
	 * the stream's baton (`REFUSED_BATON`).
	 * @param {unknown} error
	 */
	ranNothing(error) {
		const { hrana } = this;
		if (error instanceof hrana.ResponseError) return error.code === "STREAM_EXPIRED";
		return (
			error instanceof hrana.HttpServerError &&
			error.status === 400 &&
			REFUSED_BATON.some((refusal) => error.message.endsWith(`: ${refusal}`))
		);
	}

	/**
	 * Whether `error` is the server's answer `no such table` for a table that `stream` finds in the schema. sqld gives
	 * that answer, without running the statement, when it prepares the statement while other connections change the
	 * schema; the same statement sent again finds the table (#5464). A table that does not exist is reported.
	 * @param {import("@libsql/hrana-client").Stream} stream
	 * @param {unknown} error
	 */
	async namesExistingTable(stream, error) {
		if (!(error instanceof this.hrana.ResponseError) || stream.closed) return false;
		const named = MISSING_TABLE.exec(error.message)?.[1];
		if (named === undefined) return false;
		try {
			const lookup = new this.hrana.Stmt(TABLE_LOOKUP);
			lookup.bindIndexes([named.replace(/^main\./i, "")]);
			return (await stream.query(lookup)).rows.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * `error` as `@libsql/client` reports it.
	 * @param {unknown} error
	 */
	libsqlError(error) {
		return error instanceof this.hrana.ClientError
			? new this.LibsqlError(error.message, hranaCode(this.hrana, error), undefined, undefined, error)
			: error;
	}

	/** Closes the stream, if one is open; its close is sent in the background. */
	drop() {
		this.stream?.close();
		this.stream = undefined;
	}
}

/**
 * Lone reads that find the reused stream busy, sent together (#6560). Each such read used to open a stream of its own,
 * one request each, so reads made at once opened as many streams, and as many connections, as the client allows. Now
 * the reads made while one turn of the event loop runs go out in one pipeline request, on one stream of their own that
 * the same request closes. The server runs a pipeline's requests in turn, each `execute` outside any transaction on
 * its own, so each read still reads the snapshot of its own statement, as on a stream of its own. A failure of the
 * request fails each read in it, as it would have failed each request; a read's own failure is its own.
 */
class MergedReads {
	/** @type {{ statement: import("@libsql/hrana-client").Stmt, resolve: (result: import("@bastani/atomic/storage").SqliteDriverResult) => void, reject: (error: unknown) => void }[] | undefined} */
	pending;

	/**
	 * @param {typeof import("@libsql/hrana-client")} hrana
	 * @param {typeof import("@libsql/core/api").LibsqlError} LibsqlError
	 * @param {() => import("@libsql/hrana-client").Client} client
	 */
	constructor(hrana, LibsqlError, client) {
		this.hrana = hrana;
		this.LibsqlError = LibsqlError;
		this.client = client;
	}

	/**
	 * Runs `sql`, one `SELECT`, with the other reads made in this turn of the event loop.
	 * @param {string} sql
	 * @param {readonly unknown[]} params
	 * @returns {Promise<import("@bastani/atomic/storage").SqliteDriverResult>}
	 */
	execute(sql, params) {
		const statement = new this.hrana.Stmt(sql);
		statement.bindIndexes(/** @type {import("@libsql/hrana-client").InValue[]} */ ([...params]));
		return new Promise((resolve, reject) => {
			if (this.pending === undefined) {
				this.pending = [];
				setImmediate(() => this.send());
			}
			this.pending.push({ statement, resolve, reject });
		});
	}

	/** Sends the reads made since the last request, in one request on a stream that request also closes. */
	send() {
		const reads = this.pending ?? [];
		this.pending = undefined;
		/** @param {unknown} error */
		const mapped = (error) =>
			error instanceof this.hrana.ClientError
				? new this.LibsqlError(error.message, hranaCode(this.hrana, error), undefined, undefined, error)
				: error;
		/** @type {import("@libsql/hrana-client").Stream} */
		let stream;
		try {
			stream = this.client().openStream();
		} catch (error) {
			for (const read of reads) read.reject(mapped(error));
			return;
		}
		try {
			for (const read of reads)
				stream.query(read.statement).then(
					(rows) =>
						read.resolve({
							columns: rows.columnNames.map((name) => name ?? ""),
							rows: /** @type {import("@bastani/atomic/storage").SqliteDriverResult["rows"]} */ (rows.rows),
							changes: rows.affectedRowCount,
						}),
					(error) => read.reject(mapped(error)),
				);
		} finally {
			stream.closeGracefully();
		}
	}
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: unknown }>}
 */
function settle(promise) {
	return promise.then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, error }),
	);
}

/**
 * @param {typeof import("@libsql/hrana-client")} hrana
 * @param {typeof import("@libsql/core/api")} api
 * @param {import("@libsql/hrana-client").Client} client
 * @param {readonly import("@bastani/atomic/storage").SqliteStatement[]} batched
 * @returns {Promise<import("@bastani/atomic/storage").SqliteDriverResult[]>}
 */
async function writeBatch(hrana, api, client, batched) {
	/** @param {unknown} error */
	const mapped = (error) =>
		error instanceof hrana.ClientError
			? new api.LibsqlError(error.message, hranaCode(hrana, error), undefined, undefined, error)
			: error;
	const version = await client.getVersion();
	const stream = client.openStream();
	const { began, refreshed, ran, committed, executed } = (() => {
		try {
			const batch = stream.batch(false);
			const inTransaction = () => hrana.BatchCond.not(hrana.BatchCond.isAutocommit(batch));
			const begin = batch.step();
			const began = settle(begin.run("BEGIN IMMEDIATE"));
			// The connection may have loaded its schema before another connection's DDL committed. BEGIN takes the
			// write lock but does not refresh that schema; read it after the lock, while no other DDL can change it.
			const refresh = batch.step().condition(hrana.BatchCond.ok(begin));
			if (version >= 3) refresh.condition(inTransaction());
			const refreshed = settle(refresh.run(SCHEMA_CHECK));
			let last = refresh;
			const ran = batched.map(({ sql, params }) => {
				const step = batch.step().condition(hrana.BatchCond.ok(last));
				if (version >= 3) step.condition(inTransaction());
				const statement = new hrana.Stmt(sql);
				statement.bindIndexes(/** @type {import("@libsql/hrana-client").InValue[]} */ ([...params]));
				last = step;
				return settle(step.query(statement));
			});
			const commit = batch.step().condition(hrana.BatchCond.ok(last));
			if (version >= 3) commit.condition(inTransaction());
			const committed = settle(commit.run("COMMIT"));
			void settle(batch.step().condition(hrana.BatchCond.not(hrana.BatchCond.ok(commit))).run("ROLLBACK"));
			return { began, refreshed, ran, committed, executed: batch.execute() };
		} finally {
			stream.closeGracefully();
		}
	})();
	try {
		await executed;
	} catch (error) {
		throw mapped(error);
	}
	const beginning = await began;
	if (!beginning.ok) throw mapped(beginning.error);
	const refresh = await refreshed;
	if (!refresh.ok) throw mapped(refresh.error);
	if (refresh.value === undefined)
		throw new api.LibsqlError("The batch ended before its schema could be refreshed", "TRANSACTION_CLOSED");
	/** @type {import("@bastani/atomic/storage").SqliteDriverResult[]} */
	const results = [];
	for (const [index, outcome] of (await Promise.all(ran)).entries()) {
		if (!outcome.ok) {
			const failure = mapped(outcome.error);
			if (!(failure instanceof api.LibsqlError)) throw failure;
			throw new api.LibsqlBatchError(
				failure.message,
				index,
				failure.code,
				failure.extendedCode,
				failure.rawCode,
				outcome.error instanceof Error ? outcome.error : undefined,
			);
		}
		if (outcome.value === undefined)
			throw new api.LibsqlBatchError(
				"Statement in a batch was not executed, probably because the transaction has been rolled back",
				index,
				"TRANSACTION_CLOSED",
			);
		results.push({
			columns: outcome.value.columnNames.map((name) => name ?? ""),
			rows: /** @type {import("@bastani/atomic/storage").SqliteDriverResult["rows"]} */ (outcome.value.rows),
			changes: outcome.value.affectedRowCount,
		});
	}
	const commitment = await committed;
	if (!commitment.ok) throw mapped(commitment.error);
	if (commitment.value === undefined)
		throw new api.LibsqlError(
			"The batch did not execute its COMMIT; its transaction ended before completion could be confirmed",
			"TRANSACTION_CLOSED",
		);
	return results;
}

/**
 * @param {() => Promise<import("@libsql/client").Client | import("@libsql/client").Transaction>} connection
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} watch
 * @param {<T>(operation: () => Promise<T>, afterSchemaChange?: () => Promise<T>) => Promise<T>} [single] runs one
 *   statement, which a failure may run again; after `SQLITE_SCHEMA` it may run `afterSchemaChange` in its place
 * @param {() => Promise<ReusedStream | undefined>} [shared] the stream statements outside a transaction reuse
 * @param {(batched: readonly import("@bastani/atomic/storage").SqliteStatement[]) => Promise<import("@bastani/atomic/storage").SqliteDriverResult[]>} [locked]
 *   runs statements in one write transaction, where no other connection can change the schema
 * @param {(separate: readonly string[]) => Promise<StoppedStatement | undefined>} [stepped] runs statements in order
 *   in one request, each committing on its own (`stepBatch`)
 * @param {() => Promise<MergedReads | undefined>} [merged] what runs a lone read that finds the reused stream busy
 * @returns {import("@bastani/atomic/storage").SqliteDriverExecutor}
 */
function statements(
	connection,
	watch,
	single = watch,
	shared = async () => undefined,
	locked,
	stepped,
	merged = async () => undefined,
) {
	/**
	 * An `exec` of one statement, which wrote nothing when it fails, as one `execute` did.
	 * @param {string} sql
	 */
	const one = (sql) =>
		single(
			async () => (await connection()).executeMultiple(sql),
			locked !== undefined && rerunsLocked(sql)
				? async () => {
						await locked([{ sql, params: [] }]);
					}
				: undefined,
		);
	return {
		execute: (sql, params) =>
			single(
				async () => {
					const reused = reusable(sql) ? await (await shared())?.execute(sql, params) : undefined;
					if (reused !== undefined) return reused;
					// A read that finds the reused stream busy goes with the other reads made meanwhile, not on a stream of its own.
					const beside = readsOnly(sql) ? await (await merged())?.execute(sql, params) : undefined;
					return beside ?? driverResult(await (await connection()).execute({ sql, args: [...params] }));
				},
				// A write that commits on its own and that the server answered `SQLITE_SCHEMA` runs again in a write
				// transaction of its own: no other connection changes the schema while the transaction holds the write lock,
				// so sent as it was it could keep meeting a changed schema for as long as other connections keep changing it.
				locked !== undefined && rerunsLocked(sql) ? async () => (await locked([{ sql, params }]))[0] : undefined,
			),
		// One of several statements may fail after the statements before it committed, so the text is never sent again.
		// On a server, outside a transaction, a text that `separateStatements` splits is sent as its statements, in
		// one request that runs them in order and stops at the first that fails, as the server runs the text. A
		// statement the server refused without running it, with `SQLITE_SCHEMA` while other connections change the
		// schema (#5652) or busy, then runs again on its own as an `exec` of one statement does, and the statements
		// after it go on in a request of their own: a statement that ran is never sent again.
		executeMultiple: async (sql) => {
			if (isOneStatement(sql)) return one(sql);
			const separate = stepped === undefined ? undefined : separateStatements(sql);
			const whole = () => watch(async () => (await connection()).executeMultiple(sql));
			if (stepped === undefined || separate === undefined) return whole();
			for (let next = 0; next < separate.length; ) {
				/** @type {number} */
				let failed = next;
				try {
					/** @type {StoppedStatement | undefined} */
					let stopped;
					try {
						stopped = await watch(() => stepped(separate.slice(next)));
					} catch (error) {
						// The server reads every statement of a request before it runs any, so statements it could not read ran
						// none. It reads the whole text differently: it tells where in the text a syntax error is, and runs the
						// statements before an unfinished last one. So the text is sent as it is, and the caller gets the
						// server's own answer for it.
						if (next === 0 && UNREAD_CODES.has(/** @type {{ readonly code?: unknown }} */ (error)?.code)) return whole();
						throw error;
					}
					if (stopped === undefined) return;
					failed = next + stopped.index;
					if (!isBusy(stopped.error) && !isSchemaChanged(stopped.error)) throw stopped.error;
					await one(separate[failed]);
					next = failed + 1;
				} catch (error) {
					if (failed > 0 && typeof error === "object" && error !== null) partlyApplied.add(error);
					throw error;
				}
			}
		},
	};
}

/**
 * The statement of a `stepBatch` that did not run, by its index among the statements sent, and the server's answer.
 * @typedef {{ index: number, error: unknown }} StoppedStatement
 */

/**
 * Runs `separate`, statements that each commit on their own, in order in one request on a stream of its own, as the
 * server runs an `exec` of their text: the server reads every statement before it runs any, so a text it cannot read
 * runs nothing, and a statement runs only when the one before it succeeded.
 * @param {typeof import("@libsql/hrana-client")} hrana
 * @param {typeof import("@libsql/core/api")} api
 * @param {import("@libsql/hrana-client").Client} client
 * @param {readonly string[]} separate
 * @returns {Promise<StoppedStatement | undefined>} the first statement that did not run, or undefined when all ran
 */
async function stepBatch(hrana, api, client, separate) {
	/** @param {unknown} error */
	const mapped = (error) =>
		error instanceof hrana.ClientError
			? new api.LibsqlError(error.message, hranaCode(hrana, error), undefined, undefined, error)
			: error;
	const stream = client.openStream();
	const { ran, executed } = (() => {
		try {
			const batch = stream.batch(false);
			/** @type {import("@libsql/hrana-client").BatchStep | undefined} */
			let last;
			const ran = separate.map((sql) => {
				const step = batch.step();
				if (last !== undefined) step.condition(hrana.BatchCond.ok(last));
				last = step;
				return settle(step.run(sql));
			});
			return { ran, executed: batch.execute() };
		} finally {
			stream.closeGracefully();
		}
	})();
	try {
		await executed;
	} catch (error) {
		throw mapped(error);
	}
	for (const [index, outcome] of (await Promise.all(ran)).entries()) {
		if (!outcome.ok) return { index, error: mapped(outcome.error) };
		if (outcome.value === undefined)
			return {
				index,
				error: new api.LibsqlError("Statement in a batch was not executed", "TRANSACTION_CLOSED"),
			};
	}
	return undefined;
}

/**
 * The codes a server answers a request with when it cannot read its statements, which it reads before it runs any.
 * @type {ReadonlySet<unknown>}
 */
const UNREAD_CODES = new Set(["SQL_PARSE_ERROR", "SQL_NO_STATEMENT", "SQL_MANY_STATEMENTS"]);

/**
 * Failures of an `exec` of several statements after statements of it committed. A transient failure among them is
 * reported with an unknown outcome even when the request that failed never reached the server, so the facade does not
 * run the whole `exec` again.
 * @type {WeakSet<object>}
 */
const partlyApplied = new WeakSet();

/**
 * The keywords that start a statement `separateStatements` may send apart from the ones before it: statements whose
 * effect is in the database, which another connection sees once it committed, and which return no rows.
 */
const SEPARABLE_KEYWORDS = new Set(["CREATE", "DROP", "ALTER", "INSERT", "UPDATE", "DELETE", "REPLACE"]);
/**
 * Names, quoted or not, that tie a statement to the connection that ran the statements before it: a temporary table,
 * view or trigger, and the functions that read what that connection did last or load code into it.
 */
const CONNECTION_NAMES = new Set(["TEMP", "TEMPORARY", "LAST_INSERT_ROWID", "CHANGES", "TOTAL_CHANGES", "LOAD_EXTENSION"]);
/** The keyword after which a write returns rows. */
const RETURNING_KEYWORD = "RETURNING";

/**
 * The statements of `sql`, an `exec` of several, each as the server reads it on its own, or undefined when they must
 * run on one connection or are not told apart exactly. Each statement starts with one of `SEPARABLE_KEYWORDS`, no
 * name of `CONNECTION_NAMES` and no `RETURNING_KEYWORD` appears in the text, quoted or not, the text's tokens are
 * SQLite's (`statementSpans`), and each statement passes `isOneStatement` on its own. A statement ends at the `;`
 * after it, and a `CREATE TRIGGER` at the first `END` right after a `;`, as in SQLite's grammar. Settings such as a
 * `PRAGMA`, transaction control and temporary tables hold on one connection only, which statements sent again apart
 * from the ones before them may not share, so a text with one of them is not split. Nor is a text with a statement
 * that returns rows: a server describes the columns of each statement sent apart, which together may pass the size it
 * answers in one response, and describes none for the statements of a text. Each statement starts where the server's
 * reading of the text starts it, right after the `;` before it (the first at the text's start), so a failure the
 * server reports at a place in the statement is at the same place as in the text.
 * @param {string} sql
 * @returns {string[] | undefined}
 */
function separateStatements(sql) {
	const spans = statementSpans(sql);
	if (spans === undefined) return undefined;
	for (const { start, end } of spans) {
		const text = sql.slice(start, end);
		const name = Object.hasOwn(QUOTE_END, text[0]) ? text.slice(1, -1) : text;
		const upper = name.toUpperCase();
		if (CONNECTION_NAMES.has(upper) || upper === RETURNING_KEYWORD) return undefined;
	}
	/** @type {string[]} */
	const separate = [];
	let from = 0;
	for (let index = 0; index < spans.length; ) {
		if (spans[index].token === ";") {
			index++;
			continue;
		}
		if (!SEPARABLE_KEYWORDS.has(spans[index].token)) return undefined;
		let last = index;
		if (spans[index].token === "CREATE" && spans[index + 1]?.token === "TRIGGER") {
			while (last + 1 < spans.length && !(spans[last].token === ";" && spans[last + 1].token === "END")) last++;
			if (last + 1 >= spans.length) return undefined;
			last++;
			if (last + 1 < spans.length && spans[last + 1].token !== ";") return undefined;
		} else while (last + 1 < spans.length && spans[last + 1].token !== ";") last++;
		const statement = sql.slice(from, spans[last].end);
		if (!isOneStatement(statement)) return undefined;
		separate.push(statement);
		from = spans[last + 1]?.end ?? sql.length;
		index = last + 1;
	}
	return separate.length > 1 ? separate : undefined;
}

/** The keyword of a statement that writes and runs the same inside a write transaction as on its own. */
const LOCKED_RERUN_KEYWORD = /(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/iy;
/** The keyword of a statement that starts with common table expressions, which may read or write. */
const COMMON_TABLE_KEYWORD = /WITH\b/iy;
/** A write inside a statement that starts with common table expressions. */
const COMMON_TABLE_WRITE = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

/**
 * Whether `sql`, one statement the server answered `SQLITE_SCHEMA`, runs again in a write transaction of its own: a
 * write (also one that starts with common table expressions) or a schema change. Not a read, such as `SELECT`,
 * `VALUES` or a `WITH` that only selects, and not a statement that runs differently in a transaction or not at all, as
 * `PRAGMA foreign_keys` and `VACUUM` do.
 * @param {string} sql
 */
function rerunsLocked(sql) {
	const start = firstTokenStart(sql);
	if (start === -1 || readsOnly(sql) || !isOneStatement(sql)) return false;
	LOCKED_RERUN_KEYWORD.lastIndex = start;
	if (LOCKED_RERUN_KEYWORD.test(sql)) return true;
	COMMON_TABLE_KEYWORD.lastIndex = start;
	return COMMON_TABLE_KEYWORD.test(sql) && COMMON_TABLE_WRITE.test(sql.slice(start));
}

/**
 * Whether `sql` is one statement: it has no `;` but at its end, or it is one `CREATE TRIGGER`, whose body holds a `;`
 * after each of its statements. Otherwise a `;` in a literal or a comment also counts, so several statements are never
 * taken for one. After the last `;`, any white space counts as none, a no-break space or a byte-order mark too (#5676):
 * SQLite skips a byte-order mark and fails on any other such character, and sqld runs such a text as one statement,
 * so none of them can start another statement that runs.
 * @param {string} sql
 */
function isOneStatement(sql) {
	const first = sql.indexOf(";");
	return first === -1 || /^[\s;]*$/.test(sql.slice(first)) || isOneTrigger(sql);
}

/** The keyword that starts a `CREATE TRIGGER`. */
const CREATE_KEYWORD = /CREATE\b/iy;
/** The characters SQLite skips between tokens; it reads any other character, a no-break space too, as part of one. */
const SQL_SPACE = " \t\n\f\r";
/** The characters of operators and punctuation, other than `;`, that SQLite reads as tokens that are not names. */
const SQL_PUNCTUATION = "(),.+-*/%=<>!|&~";
/** The character that ends a quoted literal or name, by the character that opened it. */
const QUOTE_END = /** @type {Record<string, string>} */ ({ "'": "'", '"': '"', "`": "`", "[": "]" });

/**
 * Whether the UTF-16 code unit `code` belongs to a keyword or a name that is not quoted, as SQLite reads them: an ASCII
 * letter or digit, `_`, `$`, or any character outside ASCII, every byte of which is outside ASCII in the UTF-8 SQLite
 * reads. So a combining accent, a joiner or a no-break space after the letters of a keyword makes a name.
 * @param {number} code
 */
function isWordCode(code) {
	return (
		(code >= 0x30 && code <= 0x39) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		code === 0x5f ||
		code === 0x24 ||
		code > 0x7f
	);
}

/**
 * The tokens of `sql`, as SQLite and sqld split it, that tell where its statements end: `;`, each keyword or name that
 * is not quoted, as its ASCII letters upper-cased or as "" when it has another character, and "" for any other token.
 * Whitespace and comments are left out. Undefined for text whose tokens this does not tell exactly, so that no
 * statement boundary can hide in it: an open literal, quoted name or block comment, a parameter (`?`, `:`, `@`, `#`, or
 * `$` where a token starts, which no trigger may hold), a NUL, at which SQLite stops reading, a byte-order mark where a
 * token starts, which SQLite skips as whitespace and sqld reads as part of a name (inside a token both read it as part
 * of it), and any other character that is in no token.
 * @param {string} sql
 * @returns {string[] | undefined}
 */
function statementTokens(sql) {
	return statementSpans(sql)?.map(({ token }) => token);
}

/**
 * The tokens `statementTokens` reads in `sql`, each with where it starts and ends in `sql`.
 * @param {string} sql
 * @returns {{ token: string, start: number, end: number }[] | undefined}
 */
function statementSpans(sql) {
	if (sql.includes("\0")) return undefined;
	/** @type {{ token: string, start: number, end: number }[]} */
	const tokens = [];
	let index = 0;
	while (index < sql.length) {
		const character = sql[index];
		if (SQL_SPACE.includes(character)) index++;
		else if (sql.startsWith("--", index)) {
			const end = sql.indexOf("\n", index + 2);
			index = end === -1 ? sql.length : end + 1;
		} else if (sql.startsWith("/*", index)) {
			const end = sql.indexOf("*/", index + 2);
			if (end === -1) return undefined;
			index = end + 2;
		} else if (Object.hasOwn(QUOTE_END, character)) {
			// A quote doubled inside a literal or name stays in it: the scan goes on from the quote after it, which starts a
			// token here that is the same token's rest to SQLite. Neither is `;` or a word.
			const end = sql.indexOf(QUOTE_END[character], index + 1);
			if (end === -1) return undefined;
			tokens.push({ token: "", start: index, end: end + 1 });
			index = end + 1;
		} else if (character === ";" || SQL_PUNCTUATION.includes(character)) {
			tokens.push({ token: character === ";" ? ";" : "", start: index, end: index + 1 });
			index++;
		} else if (character !== "$" && character !== "\uFEFF" && isWordCode(sql.charCodeAt(index))) {
			// A number is read as a word: SQLite reads the letters and digits that follow a number's own as part of it.
			let end = index + 1;
			while (end < sql.length && isWordCode(sql.charCodeAt(end))) end++;
			const word = sql.slice(index, end);
			tokens.push({ token: /^[A-Za-z]+$/.test(word) ? word.toUpperCase() : "", start: index, end });
			index = end;
		} else return undefined;
	}
	return tokens;
}

/**
 * Whether `sql` is one `CREATE [TEMP] TRIGGER ... BEGIN ... END` statement, followed by nothing but `;`, whitespace and
 * comments. Its tokens are SQLite's, or the answer is no. SQLite takes no `;` before a trigger's `BEGIN`, ends every
 * statement of its body with `;`, and starts none with `END`, so the trigger ends at the first `END` right after a `;`,
 * whatever `CASE ... END` the body holds. A text that starts so but whose first statement is no such trigger is a
 * syntax error, which runs nothing.
 * @param {string} sql
 */
function isOneTrigger(sql) {
	// Most texts are no trigger, which their first word tells without reading them whole.
	const start = firstTokenStart(sql);
	if (start === -1) return false;
	CREATE_KEYWORD.lastIndex = start;
	if (!CREATE_KEYWORD.test(sql)) return false;
	const tokens = statementTokens(sql);
	if (tokens === undefined || tokens[0] !== "CREATE") return false;
	let index = tokens[1] === "TEMP" || tokens[1] === "TEMPORARY" ? 2 : 1;
	if (tokens[index++] !== "TRIGGER") return false;
	const first = tokens.indexOf(";", index);
	if (first === -1 || !tokens.slice(index, first).includes("BEGIN")) return false;
	for (let at = first; at + 1 < tokens.length; at++) {
		if (tokens[at] === ";" && tokens[at + 1] === "END") return tokens.slice(at + 2).every((token) => token === ";");
	}
	return false;
}

/**
 * @param {import("@libsql/client").ResultSet} result
 * @returns {import("@bastani/atomic/storage").SqliteDriverResult}
 */
function driverResult(result) {
	return { columns: result.columns, rows: result.rows, changes: result.rowsAffected };
}

/**
 * How long a connection to a local `file:` database waits for a lock another connection holds before failing with
 * `SQLITE_BUSY`, as Atomic's own SQLite stores wait. Without it the driver fails at once, so two processes writing
 * one file, such as two Atomic processes that share a session store, lose statements to each other.
 */
const FILE_BUSY_TIMEOUT_MS = 5000;

/** How many reads one handle on a libSQL server runs at once by default: the libSQL client's own default limit. */
export const DEFAULT_CONCURRENCY = 20;

/**
 * `concurrency` checked: a positive integer, `DEFAULT_CONCURRENCY` when absent. The libSQL client turns 0 into its
 * default of 20 rather than lifting the limit, so 0 is refused instead of meaning something it does not.
 * @param {unknown} concurrency
 */
function readConcurrency(concurrency) {
	if (concurrency === undefined) return DEFAULT_CONCURRENCY;
	if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1)
		throw new TypeError(
			'The libSQL storage adapter\'s "concurrency" option must be a positive integer, the most reads one connection runs at once',
		);
	return concurrency;
}

/**
 * Normal wall-clock and cumulative backoff sleep budget for retrying `SQLITE_BUSY` or `SQLITE_SCHEMA` from a libSQL
 * server. sqld answers a writer that meets its checkpoint `SQLITE_BUSY` at once, without waiting and without running
 * any of the call, and leaves the waiting to the client; its own checkpoint waits this long for the lock. It answers
 * `SQLITE_SCHEMA`, also without running the call, while other connections keep changing the schema.
 */
const SERVER_BUSY_TIMEOUT_MS = 5000;
/**
 * `sqld`'s own write-lock transaction timeout (`TXN_TIMEOUT` = 5 s): an attempt waiting behind an abandoned write
 * transaction can spend this long inside the server before hitting a periodic WAL checkpoint.
 */
const SERVER_LOCK_TIMEOUT_MS = 5000;
/**
 * Hard total wall-clock cap from the start of a call (including every attempt's duration) for busy/schema retries:
 * one `sqld` 5 s transaction timeout plus one full 5 s checkpoint retry window (`SERVER_BUSY_TIMEOUT_MS`). Keeps
 * fast and WAN-RTT persistent refusals within `SERVER_BUSY_TIMEOUT_MS` plus one RTT and stops repeated slow-lock
 * refusals after two attempts, while giving a post-lock refusal a full 5 s checkpoint window.
 */
const SERVER_BUSY_MAX_TOTAL_MS = SERVER_LOCK_TIMEOUT_MS + SERVER_BUSY_TIMEOUT_MS;
/** The first wait before a call a libSQL server answered busy runs again; each later wait doubles, up to the last. */
const SERVER_BUSY_FIRST_WAIT_MS = 10;
const SERVER_BUSY_LAST_WAIT_MS = 200;
/** Each busy retry wait varies by up to this fraction either way, so concurrent callers do not retry in lockstep. */
const SERVER_BUSY_JITTER = 0.2;

/**
 * The next backoff delay for a libSQL server refusal, or `0` when the retry budget is exhausted.
 * @param {number} wait base wait before jitter, in ms
 * @param {number} left remaining retry budget, in ms
 * @returns {number}
 */
function serverBusyDelayMs(wait, left) {
	if (left <= 0) return 0;
	const factor = 1 + SERVER_BUSY_JITTER * (2 * Math.random() - 1);
	return Math.min(Math.round(wait * factor), left);
}

/**
 * Runs `operation` again, with growing jittered waits, while it fails with `SQLITE_BUSY` and `ranNothing` says the
 * failed run ran nothing, or with `SQLITE_SCHEMA`; then it fails with the last run's failure.
 *
 * The wall-clock deadline is measured from `started` (the call's start) and includes every attempt's duration:
 * `started + min(SERVER_BUSY_MAX_TOTAL_MS, SERVER_BUSY_TIMEOUT_MS + maxAttemptMs)`, paired with a cumulative backoff
 * sleep budget of `SERVER_BUSY_TIMEOUT_MS` (which also guarantees termination when `performance.now()` does not
 * advance). A retry starts only when `delay + min(prevAttemptMs, attemptMs)` fits in the remaining wall-clock time, so
 * a single slow server lock wait still gets a probe retry for a fast checkpoint while persistent WAN-RTT or slow-lock
 * refusals stay bounded. `prepare` runs before each run after the first.
 *
 * A server answers `SQLITE_SCHEMA` when other connections kept changing the database's schema while it prepared the
 * statement, as on a server shared by several stores that create and drop their tables: the statement never ran, so
 * a statement or batch that commits on its own runs again. `rerunsAfterSchemaChange` says whether the run may.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {() => boolean} ranNothing
 * @param {() => Promise<void>} [prepare]
 * @param {() => boolean} [rerunsAfterSchemaChange] whether a run that `SQLITE_SCHEMA` ended may run again
 * @param {number} [started] call start time (`performance.now()`) shared across multi-phase fallbacks
 * @param {number} [initialMaxAttemptMs] longest attempt duration already observed before this loop
 * @returns {Promise<T>}
 */
async function whileServerBusy(
	operation,
	ranNothing,
	prepare,
	rerunsAfterSchemaChange = () => true,
	started = performance.now(),
	initialMaxAttemptMs = 0,
) {
	let maxAttemptMs = Math.max(0, initialMaxAttemptMs);
	let prevAttemptMs = 0;
	let waited = 0;
	for (let wait = SERVER_BUSY_FIRST_WAIT_MS; ; wait = Math.min(wait * 2, SERVER_BUSY_LAST_WAIT_MS)) {
		const attemptStarted = performance.now();
		try {
			return await operation();
		} catch (error) {
			const rerun = isBusy(error) ? ranNothing() : isSchemaChanged(error) && rerunsAfterSchemaChange();
			if (!rerun) throw error;
			const now = performance.now();
			const attemptMs = Math.max(0, now - attemptStarted);
			maxAttemptMs = Math.max(maxAttemptMs, attemptMs);
			const wallDeadline = started + Math.min(SERVER_BUSY_MAX_TOTAL_MS, SERVER_BUSY_TIMEOUT_MS + maxAttemptMs);
			const wallLeft = wallDeadline - now;
			const left = Math.min(wallLeft, SERVER_BUSY_TIMEOUT_MS - waited);
			const delay = serverBusyDelayMs(wait, left);
			if (delay <= 0 || delay + Math.min(prevAttemptMs, attemptMs) > wallLeft) throw error;
			prevAttemptMs = attemptMs;
			waited += Math.max(delay, 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
			await prepare?.();
		}
	}
}

/**
 * Whether a driver call failed because another connection held a lock past the busy timeout.
 * @param {unknown} error
 */
function isBusy(error) {
	return /** @type {{ readonly code?: unknown } | undefined} */ (error)?.code === "SQLITE_BUSY";
}

/**
 * Whether a server refused a statement because the schema it was prepared against kept changing.
 * @param {unknown} error
 */
function isSchemaChanged(error) {
	return /** @type {{ readonly code?: unknown } | undefined} */ (error)?.code === "SQLITE_SCHEMA";
}

/** V8's `gc`, taken from a context created while `--expose-gc` is set; the flag is off again for code that runs later. */
function exposeGc() {
	setFlagsFromString("--expose-gc");
	try {
		return /** @type {() => void} */ (runInNewContext("gc"));
	} finally {
		setFlagsFromString("--no-expose-gc");
	}
}

function collectGarbage() {
	if (globalThis.gc) globalThis.gc();
	else if (typeof Bun !== "undefined") Bun.gc(true);
	else exposeGc()();
}

/**
 * Consecutive full collections one close runs. One forced collection occasionally leaves a statement uncollected, about
 * once in several thousand closes in a loop that opens, uses and closes a file database, and a further event-loop turn
 * does not collect it; a second collection does.
 */
const COLLECTION_PASSES = 2;

/** @type {Promise<void>} */
let collection = Promise.resolve();
/** @type {Promise<void> | undefined} */
let pendingCollection;

/**
 * libsql 0.5 finalizes a statement only when the statement is garbage-collected, and a connection stays open until
 * its last statement is finalized, so the client's `close()` leaves a `file:` database's files open and Windows
 * refuses to delete them. This resolves after `COLLECTION_PASSES` full collections that started after the call, each
 * followed by the event-loop turn in which the runtime runs the native finalizers it queued. Calls made before those
 * collections start share them.
 * @returns {Promise<void>}
 */
function releaseClosedConnections() {
	if (!pendingCollection) {
		pendingCollection = collection.then(collectAndFinalize, collectAndFinalize);
		collection = pendingCollection;
	}
	return pendingCollection;
}

async function collectAndFinalize() {
	pendingCollection = undefined;
	for (let pass = 0; pass < COLLECTION_PASSES; pass++) {
		collectGarbage();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/**
 * Write requests one process sends to one database server at once, over every database it opened there: the server takes its
 * write lock one writer at a time, so more requests in flight only lengthen the queue for it, and a process with many
 * workers would fill it. Batches that set `priority` do not count, so a lease renewal never waits behind them.
 */
const MAX_IN_FLIGHT_WRITES = 4;

/** Write batches in a row a server left unanswered, after which its writes count as stalled. */
const STALLED_WRITES_WARNING_AFTER = 3;
/**
 * Each server's unanswered write batches in a row, and whether its stall was reported, by its location: one stalled
 * server is told apart from another that answers.
 * @type {Map<string, { unanswered: number; reported: boolean }>}
 */
const writeHealth = new Map();

/**
 * Counts a write batch's outcome toward the process's warning that a server stopped taking writes, once per stall: the
 * first write answered after it warns that writes go through again. sqld 0.24.33 and earlier can stop granting its
 * write lock to anyone (tursodatabase/libsql#2286): the stall warning names the fix.
 * @param {unknown} error undefined for a batch the server answered
 * @param {string} location
 */
function noteWriteOutcome(error, location) {
	const health = writeHealth.get(location) ?? { unanswered: 0, reported: false };
	if (!isTimeout(error)) {
		// A write answered after a reported stall: the server takes writes again, and a later stall warns again.
		if (health.reported)
			reportWriteHealth(
				false,
				`The libSQL server at ${location} is taking writes again after ${health.unanswered} unanswered write requests.`,
				"ATOMIC_LIBSQL_WRITES_RECOVERED",
			);
		writeHealth.delete(location);
		return;
	}
	health.unanswered++;
	writeHealth.set(location, health);
	if (health.unanswered < STALLED_WRITES_WARNING_AFTER || health.reported) return;
	health.reported = true;
	reportWriteHealth(
		true,
		`The libSQL server at ${location} left ${health.unanswered} write requests in a row unanswered for ${REQUEST_TIMEOUT_MS / 1000} seconds each. sqld 0.24.33 and earlier can stop taking writes from every client until it restarts (https://github.com/tursodatabase/libsql/issues/2286); start sqld with --checkpoint-interval-s 60 (SQLD_CHECKPOINT_INTERVAL_S=60) to avoid it, and restart it now if writes stay stuck. Atomic keeps retrying its writes meanwhile.`,
		"ATOMIC_LIBSQL_WRITES_STALLED",
	);
}

/**
 * Reports a server's write health as a process warning, and as the process event `atomic-libsql-write-health`, which a
 * process that silences warnings (as Atomic's CLI does) still hears: `{ stalled, message }`.
 * @param {boolean} stalled
 * @param {string} message
 * @param {string} code
 */
function reportWriteHealth(stalled, message, code) {
	process.emitWarning(message, { code });
	/** @type {(event: string, payload: { stalled: boolean; message: string }) => boolean} */ (process.emit)(
		"atomic-libsql-write-health",
		{ stalled, message },
	);
}

/**
 * Whether a request was abandoned after `REQUEST_TIMEOUT_MS`, read along the cause chain.
 * @param {unknown} error
 */
function isTimeout(error) {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		const { name, cause } = /** @type {{ readonly name?: unknown, readonly cause?: unknown }} */ (current);
		if (name === "TimeoutError") return true;
		current = cause;
	}
	return false;
}

/**
 * Each server's write lane, by its location: the writes this process has in flight to it and those waiting for one of
 * them to finish. A server that stops answering fills only its own lane, so writes to another server go on.
 * @type {Map<string, { inFlight: number; waiting: (() => void)[] }>}
 */
const writeLanes = new Map();

/**
 * Runs `operation` once fewer than `MAX_IN_FLIGHT_WRITES` other writes of this process to the server at `location` are
 * in flight.
 * @template T
 * @param {string} location
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function limitedWrite(location, operation) {
	let lane = writeLanes.get(location);
	if (!lane) writeLanes.set(location, (lane = { inFlight: 0, waiting: [] }));
	const own = lane;
	if (own.inFlight >= MAX_IN_FLIGHT_WRITES) await new Promise((resolve) => own.waiting.push(() => resolve(undefined)));
	else own.inFlight++;
	try {
		return await operation();
	} finally {
		const next = own.waiting.shift();
		// The slot passes straight to the next waiter, so a write arriving meanwhile cannot take it first.
		if (next) next();
		else if (--own.inFlight === 0) writeLanes.delete(location);
	}
}

/**
 * Codes a server answers a batch with when it could not take the write lock in time: the batch wrote nothing.
 * @type {ReadonlySet<unknown>}
 */
const LOCK_BUSY = new Set(["SQLITE_BUSY", "TRANSACTION_TIMEOUT"]);

/**
 * Whether a failed request found the write lock busy, read from each error's `code` along the cause chain.
 * @param {unknown} error
 */
function isLockBusy(error) {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		const { code, cause } = /** @type {{ readonly code?: unknown, readonly cause?: unknown }} */ (current);
		if (LOCK_BUSY.has(code)) return true;
		current = cause;
	}
	return false;
}

/** Marks a `libsql` Database class whose close {@link closeLocalConnectionsOnce} replaced. */
const closesOnce = Symbol.for("@bastani/atomic-storage-libsql.closesOnce");

/**
 * Statements that hold a closing connection until its native close has returned.
 * @type {Set<unknown>}
 */
const closingHolders = new Set();

/**
 * Makes every close of a local libsql connection close its SQLite handle once.
 *
 * libsql 0.5.29, the native driver `@libsql/client` 0.18 uses, is built from the libsql crate 0.9.30. That crate calls
 * `sqlite3_close_v2` twice when the connection itself drops the last reference to its handle, and the second call
 * reads the connection the first one freed (tursodatabase/libsql#2251, fixed in crate 0.10 by
 * tursodatabase/libsql#2261, which no npm `libsql` release contains yet). The connection drops that reference when
 * `close()` finds no statement still holding the handle: a connection used only through `exec`, or one whose
 * statements a collection already finalized. The collections every local close runs (`releaseClosedConnections`)
 * finalize the statements of every other open connection, so the next close in the process is such a close. On
 * Windows the second call crashes the process (0xC0000005) without a message once the heap has reused the freed
 * block. When a statement still holds the handle, the statement's finalizer closes the handle once and then
 * finalizes the statement, which is safe. So each close prepares a statement first and lets it go after the close.
 * The collections the close runs next finalize it and release the database's files.
 * @param {string} clientEntry the resolved `@libsql/client` entry, whose `libsql` is the driver it uses
 */
function closeLocalConnectionsOnce(clientEntry) {
	/** @type {{ prototype: { close(): void, prepare(sql: string): unknown, open: boolean, [closesOnce]?: true } }} */
	const Database = createRequire(clientEntry)("libsql");
	if (Database.prototype[closesOnce]) return;
	const close = Database.prototype.close;
	Database.prototype.close = function () {
		/** @type {unknown} */
		let holder;
		try {
			if (this.open) holder = this.prepare("SELECT 1");
		} catch {
			// A connection that cannot prepare closes as before.
		}
		if (holder !== undefined) closingHolders.add(holder);
		try {
			return close.call(this);
		} finally {
			closingHolders.delete(holder);
		}
	};
	Database.prototype[closesOnce] = true;
}

/**
 * A libSQL server's (sqld's) default payload limits, which the facade names when a value or a response is too large
 * (#4954): `max_row_size`, which sqld sets as SQLite's `SQLITE_LIMIT_LENGTH` on every connection, is `bytesize::mb(5)`
 * (5,000,000 bytes) for a value and a whole row, and `--max-response-size` is 10 MB for one statement's response.
 */
const SERVER_PAYLOAD_LIMITS = Object.freeze({ value: 5_000_000, response: 10_000_000 });
/** A local file's limit: SQLite's default `SQLITE_MAX_LENGTH`. */
const LOCAL_PAYLOAD_LIMITS = Object.freeze({ value: 1_000_000_000 });

/** How far `transientFailure` follows `cause`: a driver error wraps the network error that fetch wraps. */
const MAX_CAUSE_DEPTH = 8;
/**
 * Codes sqld answers for a stream or transaction it ended and rolled back: nothing of it was written.
 * @type {ReadonlyMap<unknown, import("@bastani/atomic/storage").StorageTransientErrorCode>}
 */
const ENDED_BY_SERVER = new Map([
	["STREAM_EXPIRED", "stream-expired"],
	["TRANSACTION_TIMEOUT", "transaction-timeout"],
]);
/**
 * Network codes of a request that never reached the server, from Node's fetch and from Bun's.
 * @type {ReadonlySet<unknown>}
 */
const NOT_SENT = new Set(["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
/**
 * Network codes of a connection that broke after a request may have reached the server.
 * @type {ReadonlySet<unknown>}
 */
const CONNECTION_LOST = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"]);

/**
 * The failure, as one that passes, when the server ended the stream or transaction of a process that stalled, or the
 * connection to the server could not be made or broke, or something between answered HTTP 5xx; read from each error's
 * `code`, `name` and `status` along the cause chain, never from its message. A failure of an `exec` of several
 * statements after some of them committed (`partlyApplied`) has an unknown outcome.
 * @param {import("@bastani/atomic/storage").StorageFailureCause} failure
 * @returns {import("@bastani/atomic/storage").SqliteDriverTransientFailure | undefined}
 */
function transientFailure(failure) {
	const transient = transientCause(failure);
	return transient !== undefined && typeof failure === "object" && failure !== null && partlyApplied.has(failure)
		? { ...transient, outcome: "unknown" }
		: transient;
}

/**
 * `transientFailure` of one request.
 * @param {import("@bastani/atomic/storage").StorageFailureCause} failure
 * @returns {import("@bastani/atomic/storage").SqliteDriverTransientFailure | undefined}
 */
function transientCause(failure) {
	/** @type {unknown} */
	let current = failure;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		const { code, cause, name, status } = /** @type {{ readonly code?: unknown, readonly cause?: unknown, readonly name?: unknown, readonly status?: unknown }} */ (
			current
		);
		// A request abandoned after `REQUEST_TIMEOUT_MS`: the server may have applied it.
		if (name === "TimeoutError") return { code: "connection-lost", outcome: "unknown" };
		// An HTTP 5xx with no Hrana error in it, such as a gateway's 502 or 504: the request may have reached the server
		// and been applied before the answer was lost (#4970).
		if (name === "HttpServerError" && typeof status === "number" && status >= 500)
			return { code: "connection-lost", outcome: "unknown" };
		const ended = ENDED_BY_SERVER.get(code);
		if (ended !== undefined) return { code: ended, outcome: "not-applied" };
		if (NOT_SENT.has(code)) return { code: "connection-refused", outcome: "not-applied" };
		if (CONNECTION_LOST.has(code)) return { code: "connection-lost", outcome: "unknown" };
		current = cause;
	}
	return undefined;
}

/**
 * The bytes this process may still write on the file system that holds the database file a `file:` URL names (where a
 * link to it points, and where its write-ahead log goes), or undefined for a database in memory or when the file system
 * does not say.
 * @param {string} url
 * @returns {Promise<number | undefined>}
 */
async function freeBytesOfFile(url) {
	try {
		const file = url.split("?")[0] ?? "";
		const path = /^file:\/\//i.test(file) ? fileURLToPath(file) : decodeURIComponent(file.slice("file:".length));
		if (path === "" || path === ":memory:") return undefined;
		// The file itself, not its directory: a link to a database on another file system measures that file system.
		const { bavail, bsize } = await statfs(path);
		return Number(bavail) * Number(bsize);
	} catch {
		return undefined;
	}
}

/**
 * @param {LibsqlDatabaseOptions} options
 * @returns {Promise<import("@bastani/atomic/storage").SqliteDatabase>}
 */
export async function openLibsqlDatabase({ url, authToken, namespace, headers, keepAliveMs, concurrency }) {
	const added = requestHeaders(url, namespace, headers);
	const reads = readConcurrency(concurrency);
	const keptMs = keptAliveMs(url, keepAliveMs);
	/** @type {(() => KeptConnections) | undefined} */
	let keepConnections;
	if (typeof process.versions.bun === "string") {
		// Bun before 1.4.3 has no `FetchSession`: its requests go over Bun's own pool.
		if (/^(libsql|https?):/i.test(url) && typeof Bun.FetchSession === "function")
			keepConnections = () => new IdleClosedConnections(keptMs ?? BUN_IDLE_CONNECTION_MS);
	} else if (keptMs !== undefined) {
		try {
			const { EnvHttpProxyAgent } = await import("undici");
			keepConnections = () => {
				// The same proxy rules as Node's own fetch in Atomic: HTTP_PROXY, HTTPS_PROXY and NO_PROXY, and HTTP/1.1.
				const agent = new EnvHttpProxyAgent({
					keepAliveTimeout: keptMs,
					keepAliveMaxTimeout: keptMs,
					allowH2: false,
					proxyTunnel: true,
				});
				return {
					// `dispatcher` is an option of Node's fetch, which is undici's.
					fetch: (request, signal) => fetch(request, /** @type {RequestInit} */ ({ signal, dispatcher: agent })),
					close: () => agent.close(),
					destroy: () => agent.destroy(),
				};
			};
		} catch (cause) {
			throw new StorageAdapterLoadError("undici", /** @type {import("@bastani/atomic/storage").StorageFailureCause} */ (cause));
		}
	}
	/** @type {typeof import("@libsql/client").createClient} */
	let createClient;
	try {
		({ createClient } = await import("@libsql/client"));
	} catch (cause) {
		throw new StorageAdapterLoadError("@libsql/client", /** @type {import("@bastani/atomic/storage").StorageFailureCause} */ (cause));
	}
	const local = /^file:/i.test(url);
	/** @type {ServerProtocol | undefined} */
	let protocol;
	if (!local) {
		try {
			protocol = await Promise.all([
				import("@libsql/hrana-client"),
				import("@libsql/core/config"),
				import("@libsql/core/uri"),
				import("@libsql/core/api"),
			]);
		} catch (cause) {
			throw new StorageAdapterLoadError(
				"@libsql/hrana-client",
				/** @type {import("@bastani/atomic/storage").StorageFailureCause} */ (cause),
			);
		}
	}
	if (local) {
		try {
			closeLocalConnectionsOnce(createRequire(import.meta.url).resolve("@libsql/client"));
		} catch (cause) {
			throw new StorageAdapterLoadError("libsql", /** @type {import("@bastani/atomic/storage").StorageFailureCause} */ (cause));
		}
	}
	const redact = redactSecrets([authToken ?? "", ...urlCredentials(url), ...Object.values(headers ?? {})]);
	const driver = () => createDriver(url, authToken, added, redact, createClient, protocol, keepConnections, reads);
	// A reader shares the checked route and credentials, but no client, stream or queue. Reads need no write setup.
	// Which database this one reaches (#6560): a server's URL with the headers that pick its database, such as the
	// namespace, digested so no header's secret is kept in it. A local file has none: its URL may name it relative to a
	// directory that changes.
	const identity = local
		? undefined
		: JSON.stringify(["libsql", createHash("sha256").update(JSON.stringify([url, added])).digest("hex")]);
	const databaseIdentity = identity === undefined ? undefined : () => identity;
	const database = createSqliteDatabase({
		...driver(),
		openReader: driver,
		...(databaseIdentity === undefined ? {} : { databaseIdentity }),
	});
	try {
		await database.exec("PRAGMA foreign_keys = ON");
		// Readers and the one writer of a file share it through the write-ahead log, as in Atomic's own SQLite stores;
		// in the default rollback journal a read refuses a writer's commit and the other way round. The mode is stored
		// in the file, so this changes it once and costs nothing afterwards. SQLite does not wait for another
		// connection's lock while it changes the mode, so the switch waits out the busy timeout itself: several
		// processes opening one new file at once, or one writing it, would otherwise fail the open with SQLITE_BUSY.
		if (local) await switchToWriteAheadLog((sql) => database.exec(sql), FILE_BUSY_TIMEOUT_MS);
		return database;
	} catch (error) {
		await database
			.close()
			.catch((cleanupCause) =>
				Object.defineProperty(/** @type {Error} */ (error), "cleanupCause", { value: cleanupCause, configurable: true }),
			);
		throw error;
	}
}

/**
 * The driver of a client of its own to `url`.
 * @param {string} url
 * @param {string | undefined} authToken
 * @param {[string, string][]} added
 * @param {(text: string) => string} redact
 * @param {typeof import("@libsql/client").createClient} createClient
 * @param {ServerProtocol | undefined} protocol
 * @param {(() => KeptConnections) | undefined} keepConnections opens the connections this driver's requests go over, when
 *   idle connections are to be kept longer than the runtime keeps them, or on Bun closed sooner
 * @param {number} concurrency how many reads a server's driver runs at once
 */
function createDriver(url, authToken, added, redact, createClient, protocol, keepConnections, concurrency) {
	const local = protocol === undefined;
	/** @type {import("@libsql/client").Client | undefined} */
	let client;
	const abandoned = new AbandonedStreams();
	const kept = local ? undefined : keepConnections?.();
	// Create the client inside a driver call, so the facade redacts credentials from its failures. The busy timeout is a
	// client option, not a PRAGMA, because the client opens more connections than the one that ran the PRAGMA, and
	// each needs it; a connection waits for a lock on the calling thread.
	const create = () =>
		createClient({
			url,
			authToken,
			intMode: "bigint",
			...(local ? { timeout: FILE_BUSY_TIMEOUT_MS } : {}),
			...(local ? {} : { fetch: fetchWith(added, abandoned, kept), concurrency }),
		});
	// The Hrana client whose stream statements outside a transaction reuse, made on first use inside a driver call, as the
	// client is, so the facade redacts credentials from a failure to read the URL.
	/** @type {import("@libsql/hrana-client").Client | undefined} */
	let hranaClient;
	/** @type {ReusedStream | undefined} */
	let reused;
	/** The requests of the reused stream's client not yet answered, which a close waits for. @type {Set<Promise<Response>>} */
	const streamRequests = new Set();
	const remote = () => {
		const [hrana, { expandConfig }, { encodeBaseUrl }] = /** @type {NonNullable<typeof protocol>} */ (protocol);
		if (hranaClient === undefined || hranaClient.closed) {
			const config = expandConfig({ url, authToken }, true);
			const base = encodeBaseUrl(config.scheme, config.authority, config.path);
			if (config.scheme === "ws" || config.scheme === "wss") hranaClient = hrana.openWs(base, config.authToken);
			else {
				const send = fetchWith(added, abandoned, kept);
				/** @type {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} */
				const tracked = (input, init) => {
					const sent = send(input, init);
					streamRequests.add(sent);
					void sent.finally(() => streamRequests.delete(sent)).catch(() => {});
					return sent;
				};
				hranaClient = hrana.openHttp(base, config.authToken, tracked);
			}
			hranaClient.intMode = "bigint";
		}
		return hranaClient;
	};
	const shared = async () => {
		if (protocol === undefined) return undefined;
		const [hrana, , , { LibsqlError }] = protocol;
		return (reused ??= new ReusedStream(hrana, LibsqlError, remote));
	};
	/** @type {MergedReads | undefined} */
	let merged;
	const mergedReads = async () => {
		if (protocol === undefined) return undefined;
		const [hrana, , , { LibsqlError }] = protocol;
		return (merged ??= new MergedReads(hrana, LibsqlError, remote));
	};
	// A local statement that fails part way, as a write does when another process holds the lock past the busy timeout,
	// stays active on its connection: the driver resets and finalizes a statement only when it is garbage collected.
	// Until then that connection commits nothing ("cannot commit transaction - SQL statements in progress"), and a
	// write outside a transaction reports success but is never committed. So after a local failure the next call gets
	// new connections. The facade runs one call at a time, so no call is still using the old ones.
	let replace = false;
	/** @type {<T>(operation: () => Promise<T>) => Promise<T>} */
	const watch = async (operation) => {
		try {
			return await operation();
		} catch (error) {
			if (local) replace = true;
			throw error;
		}
	};
	// SQLite's busy handler polls for a lock with growing sleeps, so a writer behind others that take the lock in turn
	// can miss every poll and fail after the busy timeout although the lock changed hands many times meanwhile. So a
	// call that the busy timeout ended before it wrote anything runs again, on new connections, as long as another
	// connection committed while it waited: it fails only after a whole busy timeout in which nobody committed, as
	// Atomic's own SQLite stores fail only after their lock wait passes without a commit. `PRAGMA data_version`, read
	// on a connection of its own, changes when another connection commits.
	/** @type {import("@libsql/client").Client | undefined} */
	let probe;
	const dataVersion = async () => {
		probe ??= create();
		const version = (await probe.execute("PRAGMA data_version")).rows[0]?.data_version;
		return typeof version === "bigint" || typeof version === "number" ? version : undefined;
	};
	/** @type {<T>(operation: () => Promise<T>, afterSchemaChange?: () => Promise<T>) => Promise<T>} */
	const waitForLock = async (operation, afterSchemaChange) => {
		// A server answers busy before it runs anything of one statement or a batch, and `SQLITE_SCHEMA` before it runs
		// anything of one statement. After `SQLITE_SCHEMA`, `afterSchemaChange`, when given, always runs once in its
		// place (a slow first try under schema churn still gets the locked write transaction), sharing the call's start
		// time so repeated busy refusals across both phases stay within `SERVER_BUSY_MAX_TOTAL_MS`.
		if (!local) {
			if (afterSchemaChange === undefined) return whileServerBusy(() => watch(operation), () => true);
			const started = performance.now();
			let schemaChanged = false;
			try {
				return await whileServerBusy(
					() => watch(operation),
					() => true,
					undefined,
					() => {
						schemaChanged = true;
						return false;
					},
					started,
				);
			} catch (error) {
				if (!schemaChanged) throw error;
			}
			const beforeLockedMs = Math.max(0, performance.now() - started);
			return whileServerBusy(() => watch(afterSchemaChange), () => true, undefined, undefined, started, beforeLockedMs);
		}
		/** @type {bigint | number | undefined} */
		let version;
		for (;;) {
			try {
				return await watch(operation);
			} catch (error) {
				if (!local || !isBusy(error)) throw error;
				// The first wait's progress is unknown, so it runs again once whatever the version says.
				const current = await dataVersion().catch(() => version);
				if (current === undefined || current === version) throw error;
				version = current;
			}
		}
	};
	const connection = async () => {
		if (replace) {
			replace = false;
			client?.close();
			const fresh = create();
			client = fresh;
			// A new connection does not have the PRAGMA the open ran on the one it replaces.
			await watch(() => fresh.execute("PRAGMA foreign_keys = ON"));
		}
		return (client ??= create());
	};
	/**
	 * Runs `batched` in one write transaction, in one request to a server.
	 * @param {readonly import("@bastani/atomic/storage").SqliteStatement[]} batched
	 */
	const writeTransaction = async (batched) => {
		if (protocol !== undefined) return writeBatch(protocol[0], protocol[3], remote(), batched);
		const results = await (await connection()).batch(
			batched.map(({ sql, params }) => ({ sql, args: [...params] })),
			"write",
		);
		return results.map(driverResult);
	};
	/** The server's location as diagnostics show it, without credentials. */
	const redacted = redact(url);
	/** @type {import("@bastani/atomic/storage").SqliteDriver} */
	const driver = {
		descriptor: { adapter: "libsql", location: url },
		redact,
		transientFailure,
		payloadLimits: local ? LOCAL_PAYLOAD_LIMITS : SERVER_PAYLOAD_LIMITS,
		// A server's disk is not this process's to see.
		...(local ? { freeBytes: () => freeBytesOfFile(url) } : {}),
		// A server transaction's stream sends the statements made while a request is out together, in order.
		...(local ? {} : { pipelinedTransactions: true }),
		// A server runs each read-only transaction on a stream of its own, and the lone `SELECT`s that find the reused stream
		// busy together on another (`MergedReads`), so reads overlap while writes keep their turn. A local file's driver runs every call
		// on the calling thread, so its reads gain nothing from overlapping.
		...(local ? {} : { concurrentReads: concurrency, readsOnly }),
		// A server's batch the busy lock ended: the facade sends it again within the caller's `lockWaitMs`.
		lockBusy: (failure) => !local && isLockBusy(failure),
		// One statement outside a transaction, run alone or as an `exec` of one statement, that waited out the busy
		// timeout wrote nothing and runs again. Several statements in one `exec` are never sent again as a whole: the
		// ones before the failed statement were committed. On a server, the failed statement alone may be (`statements`).
		...statements(
			connection,
			watch,
			waitForLock,
			shared,
			local ? undefined : writeTransaction,
			protocol === undefined ? undefined : (separate) => stepBatch(protocol[0], protocol[3], remote(), separate),
			mergedReads,
		),
		// One request for the whole batch, in a write transaction. Only its `BEGIN IMMEDIATE` waits for the write lock,
		// so a batch the busy timeout ended wrote nothing (`lockBusy`). A server's batch counts against this process's
		// writes in flight to that server, unless it has priority.
		batch: (batched, options) => {
			const send = () => writeTransaction(batched);
			if (local) return waitForLock(send);
			const sent = () =>
				watch(() =>
					send().then(
						(results) => {
							noteWriteOutcome(undefined, redacted);
							return results;
						},
						(error) => {
							noteWriteOutcome(error, redacted);
							throw error;
						},
					),
				);
			// A server that answers busy ran nothing of the batch: it is sent again as main's other calls are, waiting
			// outside this process's writes in flight; a caller's `lockWaitMs` waits longer on top of that.
			return whileServerBusy(
				() => (options?.priority === true ? sent() : limitedWrite(redacted, sent)),
				() => true,
			);
		},
		async beginTransaction(options) {
			const begin = async () => (await connection()).transaction(options?.readOnly === true ? "read" : "write");
			let transaction = await waitForLock(begin);
			// A server's transaction sends its `BEGIN IMMEDIATE` with its first statement. A server that answers that busy
			// fails the statement and the client closes the transaction, having run nothing of it, so the statement runs
			// again in a new transaction. A busy answer after the transaction began is not run again: a busy statement
			// leaves the transaction open, and a busy answer that ends its stream also ends the statements it already ran.
			// The transaction began once a statement in it settled and left it open: the server acknowledged its BEGIN.
			// A statement in a transaction that the server answered `SQLITE_SCHEMA` is not run again here: the server may
			// have ended the transaction, and the statement would then run, and commit, on its own.
			let started = false;
			/** @type {<T>(operation: () => Promise<T>) => Promise<T>} */
			const inTransaction = async (operation) => {
				try {
					return await whileServerBusy(
						() => watch(operation),
						() => !started && transaction.closed,
						async () => {
							transaction = await watch(begin);
						},
						() => false,
					);
				} finally {
					if (!transaction.closed) started = true;
				}
			};
			if (local)
				return {
					...statements(async () => transaction, inTransaction, inTransaction),
					commit: () => watch(() => transaction.commit()),
					rollback: () => watch(() => transaction.rollback()),
					close: () => transaction.close(),
				};
			const [hrana, , , api] = /** @type {ServerProtocol} */ (protocol);
			return pipelinedTransaction(hrana, api, () => transaction, inTransaction, watch, options?.leading ?? []);
		},
		async close() {
			reused?.drop();
			hranaClient?.close();
			if (hranaClient !== undefined) {
				// The stream's close is sent on a later turn; wait for it a little, so it neither outlives the database for
				// long nor is left to a server that would otherwise keep the stream until it expires.
				await new Promise((resolve) => setImmediate(resolve));
				/** @type {ReturnType<typeof setTimeout> | undefined} */
				let timer;
				await Promise.race([
					Promise.allSettled([...streamRequests]),
					new Promise((resolve) => {
						timer = setTimeout(resolve, STREAM_CLOSE_WAIT_MS);
					}),
				]);
				clearTimeout(timer);
			}
			client?.close();
			probe?.close();
			abandoned.close();
			if (local) await releaseClosedConnections();
			// The kept connections close once their requests end, or at once after the wait a stream's close gets.
			if (kept !== undefined) {
				/** @type {ReturnType<typeof setTimeout> | undefined} */
				let timer;
				const closed = kept.close().catch(() => {});
				const late = await Promise.race([
					closed.then(() => false),
					new Promise((resolve) => {
						timer = setTimeout(() => resolve(true), STREAM_CLOSE_WAIT_MS);
					}),
				]);
				clearTimeout(timer);
				if (late) await kept.destroy().catch(() => {});
			}
		},
	};
	return driver;
}

/**
 * A call of a pipelined server transaction: a statement, or with `script` SQL text of one or more statements.
 * @typedef {{
 *   readonly sql: string,
 *   readonly params: readonly import("@bastani/atomic/storage").SqliteValue[],
 *   readonly script: boolean,
 *   readonly operation: () => Promise<import("@bastani/atomic/storage").SqliteDriverResult | void>,
 *   overtaken: boolean,
 *   resolve: (value: any) => void,
 *   reject: (error: unknown) => void,
 * }} PipelinedCall
 */

/**
 * Whether two statements' parameters are the same values.
 * @param {readonly import("@bastani/atomic/storage").SqliteValue[]} first
 * @param {readonly import("@bastani/atomic/storage").SqliteValue[]} second
 */
function sameParams(first, second) {
	if (first.length !== second.length) return false;
	return first.every((value, index) => {
		const other = second[index];
		if (value instanceof Uint8Array && other instanceof Uint8Array)
			return value.length === other.length && value.every((byte, at) => byte === other[at]);
		return value === other;
	});
}

/**
 * A server transaction whose statements go out without waiting for the answers before them (`pipelinedTransactions`).
 *
 * The transaction begins with its `leading` reads, sent with the `BEGIN` in one request and answered to the calls that
 * make them, in order, until a call differs; without them, with its first statement. That request is retried as
 * `inTransaction` retries it while the server refuses the `BEGIN`. A statement made before it settled waits for it, since
 * sent alongside it it would run outside the transaction such a refusal ended. Later statements are held until the
 * calls made with them are made, then sent together: the stream carries the statements of one turn in one request, in
 * the order they were made. A commit made while statements are held sends them and the `COMMIT` as one batch, where the
 * `COMMIT` runs only when every statement before it succeeded and a `ROLLBACK` runs otherwise: a transaction's last
 * writes and its commit cost one request.
 *
 * A failed statement leaves a SQLite transaction open. One made after it was sent, before its answer came back, had
 * no chance to react to it, so the commit then fails with that failure instead of committing what the others wrote,
 * as a pipelined connection's commit must. A failure the caller saw before making its next statement keeps SQLite's
 * meaning: the caller may handle it and commit the rest.
 * @param {typeof import("@libsql/hrana-client")} hrana
 * @param {typeof import("@libsql/core/api")} api
 * @param {() => import("@libsql/client").Transaction} current the transaction, which a refused `BEGIN` replaces
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} inTransaction
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} watch
 * @param {readonly import("@bastani/atomic/storage").SqliteStatement[]} leading
 * @returns {Promise<import("@bastani/atomic/storage").SqliteDriverTransaction>}
 */
async function pipelinedTransaction(hrana, api, current, inTransaction, watch, leading) {
	/** @param {unknown} error */
	const mapped = (error) =>
		error instanceof hrana.ClientError
			? new api.LibsqlError(error.message, hranaCode(hrana, error), undefined, undefined, error)
			: error;
	/** The request that began the transaction, once sent. @type {Promise<unknown> | undefined} */
	let first;
	/** Calls follow the first in the order they were made. @type {Promise<unknown>} */
	let tail = Promise.resolve();
	/** Calls made, not yet sent. @type {PipelinedCall[]} */
	const held = [];
	/** Calls sent, not yet answered. @type {Set<PipelinedCall>} */
	const unanswered = new Set();
	/** @type {Set<Promise<void>>} */
	const settling = new Set();
	/** @type {ReturnType<typeof setImmediate> | undefined} */
	let flushing;
	/** @type {{ readonly error: unknown } | undefined} */
	let unseen;
	/** Set once a batch with the `COMMIT` went out: the transaction ended there, committed or rolled back. */
	let ended = false;
	/** @type {{ sql: string, params: readonly import("@bastani/atomic/storage").SqliteValue[], result: import("@bastani/atomic/storage").SqliteDriverResult }[]} */
	let lead = [];

	/** @param {PipelinedCall} call @param {Promise<unknown>} answered */
	const track = (call, answered) => {
		unanswered.add(call);
		const settled = answered.then(
			() => {
				unanswered.delete(call);
			},
			(error) => {
				unanswered.delete(call);
				if (call.overtaken) unseen ??= { error };
			},
		);
		settling.add(settled);
		void settled.then(() => settling.delete(settled));
	};
	/** @param {PipelinedCall} call */
	const send = (call) => {
		const answered = inTransaction(call.operation);
		track(call, answered);
		answered.then(call.resolve, call.reject);
	};
	const flush = () => {
		flushing = undefined;
		for (const call of held.splice(0)) send(call);
	};
	/** @param {PipelinedCall} call */
	const hold = (call) => {
		held.push(call);
		flushing ??= setImmediate(flush);
	};
	/**
	 * @param {string} sql
	 * @param {readonly import("@bastani/atomic/storage").SqliteValue[]} params
	 * @param {boolean} script
	 * @param {PipelinedCall["operation"]} operation
	 * @returns {Promise<any>}
	 */
	const make = (sql, params, script, operation) => {
		const next = lead[0];
		if (!script && next !== undefined && next.sql === sql && sameParams(next.params, params)) {
			lead.shift();
			return Promise.resolve(next.result);
		}
		lead = [];
		for (const earlier of unanswered) earlier.overtaken = true;
		for (const earlier of held) earlier.overtaken = true;
		return new Promise((resolve, reject) => {
			/** @type {PipelinedCall} */
			const call = { sql, params, script, operation, overtaken: false, resolve, reject };
			if (first === undefined) {
				const answered = inTransaction(operation);
				first = answered;
				tail = answered.catch(() => {});
				track(call, answered);
				answered.then(resolve, reject);
				return;
			}
			tail = tail.then(() => hold(call));
		});
	};

	if (leading.length > 0) {
		const began = inTransaction(() =>
			current().batch(leading.map(({ sql, params }) => ({ sql, args: [...params] }))),
		);
		first = began;
		tail = began.catch(() => {});
		try {
			const results = await began;
			lead = leading.map(({ sql, params }, index) => ({ sql, params, result: driverResult(results[index]) }));
		} catch (error) {
			// A transaction the server never began fails here; one whose reads failed after it began goes on, and its
			// callback makes the reads again.
			if (current().closed) throw error;
		}
	}

	/**
	 * Sends `calls`, each one statement, and the `COMMIT` in one batch on the transaction's stream, where each runs only
	 * after the one before it succeeded, and a `ROLLBACK` runs when the `COMMIT` did not.
	 * @param {readonly PipelinedCall[]} calls
	 */
	const commitWith = async (calls) => {
		ended = true;
		const stream = /** @type {{ _getStream(): import("@libsql/hrana-client").Stream }} */ (
			/** @type {unknown} */ (current())
		)._getStream();
		const batch = stream.batch(false);
		/** @type {import("@libsql/hrana-client").BatchStep | undefined} */
		let last;
		const ran = calls.map(({ sql, params }) => {
			const step = batch.step();
			if (last !== undefined) step.condition(hrana.BatchCond.ok(last));
			last = step;
			const statement = new hrana.Stmt(sql);
			statement.bindIndexes(/** @type {import("@libsql/hrana-client").InValue[]} */ ([...params]));
			return settle(step.query(statement));
		});
		const commit = batch.step();
		if (last !== undefined) commit.condition(hrana.BatchCond.ok(last));
		const committed = settle(commit.run("COMMIT"));
		void settle(batch.step().condition(hrana.BatchCond.not(hrana.BatchCond.ok(commit))).run("ROLLBACK"));
		const executed = batch.execute();
		stream.closeGracefully();
		try {
			await executed;
		} catch (error) {
			const failure = mapped(error);
			for (const call of calls) call.reject(failure);
			throw failure;
		}
		/** @type {unknown} */
		let failed;
		for (const [index, outcome] of (await Promise.all(ran)).entries()) {
			const call = /** @type {PipelinedCall} */ (calls[index]);
			if (!outcome.ok) {
				const failure = mapped(outcome.error);
				failed ??= failure;
				call.reject(failure);
			} else if (outcome.value === undefined) {
				call.reject(
					new api.LibsqlError(
						"Statement in a transaction was not executed, probably because the transaction has been rolled back",
						"TRANSACTION_CLOSED",
					),
				);
			} else {
				call.resolve({
					columns: outcome.value.columnNames.map((name) => name ?? ""),
					rows: /** @type {import("@bastani/atomic/storage").SqliteDriverResult["rows"]} */ (outcome.value.rows),
					changes: outcome.value.affectedRowCount,
				});
			}
		}
		if (failed !== undefined) throw failed;
		const commitment = await committed;
		if (!commitment.ok) throw mapped(commitment.error);
		if (commitment.value === undefined)
			throw new api.LibsqlError(
				"The transaction did not execute its COMMIT; it ended before completion could be confirmed",
				"TRANSACTION_CLOSED",
			);
	};

	return {
		execute: (sql, params) =>
			make(sql, params, false, async () => driverResult(await current().execute({ sql, args: [...params] }))),
		executeMultiple: (sql) => make(sql, [], true, () => current().executeMultiple(sql)),
		commit: async () => {
			await tail;
			if (flushing !== undefined) clearImmediate(flushing);
			flushing = undefined;
			const calls = held.splice(0);
			// A statement already sent may still fail: the held ones and the commit go once it is answered.
			if (calls.some(({ script }) => script)) {
				for (const call of calls) send(call);
				calls.length = 0;
			}
			while (settling.size > 0) await Promise.all(settling);
			if (unseen !== undefined) {
				for (const call of calls) call.reject(unseen.error);
				throw unseen.error;
			}
			if (calls.length === 0) return watch(() => current().commit());
			return watch(() => commitWith(calls));
		},
		rollback: async () => {
			if (flushing !== undefined) clearImmediate(flushing);
			flushing = undefined;
			for (const call of held.splice(0))
				call.reject(new api.LibsqlError("The transaction rolled back before the statement was sent", "TRANSACTION_CLOSED"));
			if (ended) return;
			return watch(() => current().rollback());
		},
		close: () => current().close(),
	};
}

/** @satisfies {import("@bastani/atomic/storage").StorageAdapterModule} */
const adapter = {
	atomicStorageAdapter: 1,
	openDatabase(options) {
		if (typeof options.url !== "string" || options.url === "") {
			throw new TypeError('The libSQL storage adapter requires a non-empty string "url" option');
		}
		if (options.namespace !== undefined && typeof options.namespace !== "string") {
			throw new TypeError('The libSQL storage adapter\'s "namespace" option must be a non-empty string');
		}
		return openLibsqlDatabase({
			url: options.url,
			authToken: typeof options.authToken === "string" ? options.authToken : undefined,
			...(options.namespace === undefined ? {} : { namespace: options.namespace }),
			// A value that is not a number reaches the option's check, which names it.
			...(options.keepAliveMs === undefined ? {} : { keepAliveMs: /** @type {number} */ (options.keepAliveMs) }),
			...(options.concurrency === undefined ? {} : { concurrency: /** @type {number} */ (options.concurrency) }),
		});
	},
};
export default adapter;
