/** Built-in event sources for `ctx.subscribe`, `ctx.events` and `session.subscribe`. */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { open, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve as resolvePath } from "node:path";
import { EventSourceError, SubscriptionClosedError, SubscriptionConfigError } from "./errors.js";
import type { EmitSubscriptionEvent, EventSource, SubscriptionEvent, SubscriptionEventPayload } from "./types.js";
import { sharedWakeDispatcher, type WakeDispatcher } from "./wake-dispatcher.js";

type JsonObject = { readonly [key: string]: SubscriptionEventPayload };

/** `setTimeout` treats anything above this as 1 ms, which would turn a long interval into a busy loop. */
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_LOG_POLL_MS = 250;
const MAX_LOG_READ_BYTES = 1_048_576;
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_GITHUB_INTERVAL_MS = 30_000;
const GH_MAX_OUTPUT_BYTES = 16 * 1_048_576;
const GH_MAX_STDERR_CHARS = 1_000;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

function requireTimerMs(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
		throw new SubscriptionConfigError(field, "not-positive-integer");
	}
}

function requireNonEmptyString(value: string, field: string): void {
	if (typeof value !== "string" || value.length === 0) throw new SubscriptionConfigError(field, "not-string");
}

/** Waits on the dispatcher. Resolves `true` after `ms`, or `false` as soon as `signal` aborts. */
async function wait(dispatcher: WakeDispatcher, ms: number, signal: AbortSignal): Promise<boolean> {
	try {
		await dispatcher.sleep(ms, signal);
		return true;
	} catch (error) {
		if (signal.aborted) return false;
		throw error;
	}
}

function resolveDispatcher(dispatcher: WakeDispatcher | undefined, field: string): WakeDispatcher {
	if (dispatcher === undefined) return sharedWakeDispatcher;
	if (typeof dispatcher.sleep !== "function") throw new SubscriptionConfigError(field, "not-function");
	return dispatcher;
}

/** The string `code` of a Node system error, or `undefined` for anything else, including thrown primitives. */
function errnoCode(error: unknown): string | undefined {
	const { code } = Object(error);
	return typeof code === "string" ? code : undefined;
}

/** True for a plain JSON object: not `null`, an array or a primitive. */
function isJsonObject(value: SubscriptionEventPayload | undefined): value is JsonObject {
	return Object.prototype.toString.call(value) === "[object Object]";
}

function parseJson(text: string): SubscriptionEventPayload {
	return JSON.parse(text);
}

function stringField(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(object: JsonObject, key: string): number | undefined {
	const value = object[key];
	return Number.isFinite(value) ? (value as number) : undefined; // `isFinite` does not coerce: only numbers pass
}

/** The string at `object[key][inner]`, or `undefined` when `object[key]` is not an object or has no string there. */
function nestedString(object: JsonObject, key: string, inner: string): string | undefined {
	const child = object[key];
	return isJsonObject(child) ? stringField(child, inner) : undefined;
}

function event(id: string, type: string | undefined, payload: SubscriptionEventPayload): SubscriptionEvent {
	return type === undefined ? { id, payload } : { id, type, payload };
}

/** Options shared by the polling sources. */
export interface SourceTimingOptions {
	/** Schedules the source's waits. Defaults to the process-wide dispatcher; pass another to drive time in tests. */
	readonly dispatcher?: WakeDispatcher;
}

/** Emits `{ tick, at }` every `ms` milliseconds. Ticks missed while the process was stalled are skipped, not replayed. */
export function interval(ms: number, options?: SourceTimingOptions): EventSource {
	requireTimerMs(ms, "interval.ms");
	const dispatcher = resolveDispatcher(options?.dispatcher, "interval.dispatcher");
	const id = `interval:${ms}`;
	return {
		id,
		async start(signal, emit) {
			const startedAt = dispatcher.elapsed();
			const startedAtWall = dispatcher.now();
			let slot = 0;
			let count = 0;
			for (;;) {
				slot++;
				const scheduled = startedAt + slot * ms;
				if (!(await wait(dispatcher, Math.max(0, scheduled - dispatcher.elapsed()), signal))) return;
				count++;
				emit({
					id: `${id}:${startedAtWall}:${count}`,
					type: "tick",
					payload: { tick: count, at: dispatcher.now() },
				});
				slot = Math.max(slot, Math.floor((dispatcher.elapsed() - startedAt) / ms));
			}
		},
	};
}

export interface LogTailOptions extends SourceTimingOptions {
	/** Milliseconds between checks for new bytes. Defaults to 250. */
	readonly pollMs?: number;
}

interface TailLine {
	readonly offset: number;
	readonly line: string;
}

interface TailChunk {
	readonly lines: readonly TailLine[];
	readonly more: boolean;
}

async function readRange(path: string, start: number, length: number): Promise<Buffer> {
	const handle = await open(path, "r");
	const data = Buffer.alloc(length);
	let filled = 0;
	let failure: { readonly error: unknown } | undefined;
	try {
		while (filled < length) {
			const { bytesRead } = await handle.read(data, filled, length - filled, start + filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
	} catch (error) {
		failure = { error };
	}
	try {
		await handle.close();
	} catch (closeError) {
		failure ??= { error: closeError };
	}
	if (failure !== undefined) throw failure.error;
	return data.subarray(0, filled);
}

/**
 * Follows a file like `tail -f`: emits each line appended after the subscription starts. A missing file is awaited
 * from offset 0. Event ids carry the byte offset of the line, so they are stable across restarts.
 */
export function logTail(path: string, options?: LogTailOptions): EventSource {
	requireNonEmptyString(path, "logTail.path");
	const pollMs = options?.pollMs ?? DEFAULT_LOG_POLL_MS;
	requireTimerMs(pollMs, "logTail.pollMs");
	const dispatcher = resolveDispatcher(options?.dispatcher, "logTail.dispatcher");
	const absolutePath = resolvePath(path);
	const id = `log:${absolutePath}`;
	return {
		id,
		async start(signal, emit) {
			let consumed = 0;
			let pending: Buffer = Buffer.alloc(0);

			async function pollOnce(): Promise<TailChunk> {
				try {
					const { size } = await stat(absolutePath);
					if (size < consumed + pending.length) {
						consumed = 0;
						pending = Buffer.alloc(0);
					}
					const readFrom = consumed + pending.length;
					if (size === readFrom) return { lines: [], more: false };
					const chunk = await readRange(absolutePath, readFrom, Math.min(size - readFrom, MAX_LOG_READ_BYTES));
					if (chunk.length === 0) return { lines: [], more: false };
					const buffer = Buffer.concat([pending, chunk]);
					const lines: TailLine[] = [];
					let lineStart = 0;
					for (let newline = buffer.indexOf(0x0a); newline !== -1; newline = buffer.indexOf(0x0a, lineStart)) {
						// For an empty line `buffer[newline - 1]` is the previous line's `\n` (or absent), never a `\r`.
						const lineEnd = buffer[newline - 1] === 0x0d ? newline - 1 : newline;
						lines.push({ offset: consumed + lineStart, line: buffer.toString("utf8", lineStart, lineEnd) });
						lineStart = newline + 1;
					}
					consumed += lineStart;
					pending = Buffer.from(buffer.subarray(lineStart));
					return { lines, more: readFrom + chunk.length < size };
				} catch (error) {
					if (errnoCode(error) !== "ENOENT") throw error;
					consumed = 0;
					pending = Buffer.alloc(0);
					return { lines: [], more: false };
				}
			}

			try {
				consumed = (await stat(absolutePath)).size;
			} catch (error) {
				if (signal.aborted) return;
				if (errnoCode(error) !== "ENOENT") {
					throw new EventSourceError(id, "read", { cause: error, detail: errnoCode(error) });
				}
			}
			while (!signal.aborted) {
				let chunk: TailChunk;
				try {
					chunk = await pollOnce();
				} catch (error) {
					if (signal.aborted) return;
					throw new EventSourceError(id, "read", { cause: error, detail: errnoCode(error) });
				}
				for (const { offset, line } of chunk.lines) {
					if (signal.aborted) return;
					emit({ id: `${absolutePath}:${offset}`, type: "line", payload: { path: absolutePath, line, offset } });
				}
				if (!chunk.more && !(await wait(dispatcher, pollMs, signal))) return;
			}
		},
	};
}

export interface WebhookOptions {
	/** URL path that accepts events, for example `/hooks/ci`. Must start with `/`. */
	readonly path: string;
	/** Port to listen on. Defaults to 0, which picks a free port; read it from `listening()`. */
	readonly port?: number;
	/** Interface to listen on. Defaults to `127.0.0.1`. */
	readonly hostname?: string;
	/** Largest accepted request body. Larger bodies get a 413 response. Defaults to 1 MiB. */
	readonly maxBodyBytes?: number;
}

export interface WebhookEventSource extends EventSource {
	/** Resolves with the base URL, including the path, once the server listens. Rejects if listening fails. */
	listening(): Promise<string>;
}

function present(text: string | undefined): string | undefined {
	return text === "" ? undefined : text;
}

/** A non-empty request header. Node joins duplicates into one string (only `set-cookie` is an array). */
function headerText(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return typeof value === "string" ? present(value) : undefined;
}

function respondJson(
	res: ServerResponse,
	status: number,
	body: JsonObject,
	headers: Readonly<Record<string, string>> = {},
): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
	res.end(text);
}

/** Resolves the request body, or `undefined` once it exceeds `limit` bytes (the rest is dropped, not buffered). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
	if (Number(req.headers["content-length"]) > limit) return Promise.resolve(undefined);
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > limit) {
				chunks.length = 0;
				resolve(undefined);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function deliveryId(req: IncomingMessage, fields: JsonObject): string {
	const fromHeader =
		headerText(req, "x-github-delivery") ?? headerText(req, "x-request-id") ?? headerText(req, "idempotency-key");
	if (fromHeader !== undefined) return fromHeader;
	const bodyText = present(stringField(fields, "id"));
	if (bodyText !== undefined) return bodyText;
	const bodyNumber = numberField(fields, "id");
	return bodyNumber === undefined ? randomUUID() : String(bodyNumber);
}

function deliveryType(req: IncomingMessage, fields: JsonObject): string | undefined {
	return headerText(req, "x-github-event") ?? stringField(fields, "type") ?? stringField(fields, "action");
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface WebhookListener {
	readonly server: Server;
	readonly routes: Map<string, RouteHandler>;
	/** Resolves once the server listens; rejects with the listen error. */
	readonly ready: Promise<void>;
}

/** Webhook servers by `hostname:port`. Sources on one fixed port share a server; each start on port 0 has its own. */
const sharedListeners = new Map<string, WebhookListener>();

function requestPath(req: IncomingMessage): string {
	const target = req.url as string; // a server request always has a url
	const query = target.indexOf("?");
	return query === -1 ? target : target.slice(0, query);
}

function openListener(key: string, hostname: string, port: number): WebhookListener {
	const routes = new Map<string, RouteHandler>();
	const server = createServer((req, res) => {
		const route = routes.get(requestPath(req));
		if (route === undefined) {
			respondJson(res, 404, { error: "not-found" });
			return;
		}
		route(req, res).catch(() => respondJson(res, 500, { error: "internal-error" }));
	});
	const listener: WebhookListener = { server, routes, ready: once(server, "listening").then(() => undefined) };
	sharedListeners.set(key, listener);
	server.listen(port, hostname);
	return listener;
}

function listenerUrl(server: Server, path: string): string {
	const address = server.address() as AddressInfo;
	const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
	return `http://${host}:${address.port}${path}`;
}

/**
 * Listens for `POST <path>` and emits each delivery as an event. The id comes from `x-github-delivery`,
 * `x-request-id`, `idempotency-key` or the body's `id`, so a redelivered webhook is deduplicated.
 *
 * Sources that listen on the same fixed `hostname` and `port` share one HTTP server, which closes when the last of
 * them stops; two of them cannot use the same path. With the default port 0 each source gets its own server.
 */
export function webhook(options: WebhookOptions): WebhookEventSource {
	const path = options?.path;
	requireNonEmptyString(path, "webhook.path");
	if (!path.startsWith("/")) throw new SubscriptionConfigError("webhook.path", "not-string");
	const port = options.port ?? 0;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new SubscriptionConfigError("webhook.port", "not-positive-integer");
	}
	const hostname = options.hostname ?? "127.0.0.1";
	requireNonEmptyString(hostname, "webhook.hostname");
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
	if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
		throw new SubscriptionConfigError("webhook.maxBodyBytes", "not-positive-integer");
	}
	const id = `webhook:${path}`;

	interface Waiter {
		readonly resolve: (url: string) => void;
		readonly reject: (reason: unknown) => void;
	}
	const waiters: Waiter[] = [];
	let outcome: { readonly url: string } | { readonly failure: unknown } | undefined;

	function settle(next: { readonly url: string } | { readonly failure: unknown }): void {
		if (outcome !== undefined && "url" in outcome) return;
		outcome = next;
		for (const waiter of waiters.splice(0)) {
			if ("url" in next) waiter.resolve(next.url);
			else waiter.reject(next.failure);
		}
	}

	function routeFor(signal: AbortSignal, emit: EmitSubscriptionEvent): RouteHandler {
		return async (req, res) => {
			if (req.method !== "POST") {
				respondJson(res, 405, { error: "method-not-allowed" }, { allow: "POST" });
				return;
			}
			const body = await readBody(req, maxBodyBytes);
			if (body === undefined) {
				respondJson(res, 413, { error: "payload-too-large" }, { connection: "close" });
				return;
			}
			const text = body.toString("utf8");
			let payload: SubscriptionEventPayload = text;
			if (headerText(req, "content-type")?.toLowerCase().includes("json")) {
				try {
					payload = parseJson(text);
				} catch {
					respondJson(res, 400, { error: "invalid-json" });
					return;
				}
			}
			const fields = isJsonObject(payload) ? payload : {};
			const eventId = deliveryId(req, fields);
			if (signal.aborted) {
				respondJson(res, 503, { accepted: false });
				return;
			}
			try {
				emit(event(eventId, deliveryType(req, fields), payload));
			} catch (error) {
				if (!(error instanceof SubscriptionClosedError)) throw error;
				respondJson(res, 503, { accepted: false });
				return;
			}
			respondJson(res, 202, { accepted: true, id: eventId });
		};
	}

	return {
		id,
		listening(): Promise<string> {
			if (outcome === undefined) {
				return new Promise((resolve, reject) => {
					waiters.push({ resolve, reject });
				});
			}
			return "url" in outcome ? Promise.resolve(outcome.url) : Promise.reject(outcome.failure);
		},
		async start(signal, emit) {
			if (signal.aborted) {
				settle({ failure: signal.reason });
				return;
			}
			const key = port === 0 ? `ephemeral:${randomUUID()}` : `${hostname}:${port}`;
			const existing = sharedListeners.get(key);
			if (existing?.routes.has(path)) {
				const failure = new SubscriptionConfigError("webhook.path", "duplicate-id");
				settle({ failure });
				throw failure;
			}
			const listener = existing ?? openListener(key, hostname, port);
			listener.routes.set(path, routeFor(signal, emit));

			const runtime: { failure?: { readonly error: unknown } } = {};
			const ended = Promise.withResolvers<void>();
			const stop = (): void => ended.resolve();
			const onServerError = (error: unknown): void => {
				runtime.failure = { error };
				stop();
			};
			signal.addEventListener("abort", stop);
			listener.server.on("error", onServerError);

			const release = (): Promise<void> => {
				signal.removeEventListener("abort", stop);
				listener.server.off("error", onServerError);
				listener.routes.delete(path);
				if (listener.routes.size > 0) return Promise.resolve();
				sharedListeners.delete(key);
				return new Promise<void>((resolve) => {
					listener.server.close(() => resolve());
					listener.server.closeAllConnections();
				});
			};

			try {
				await listener.ready;
			} catch (error) {
				await release();
				if (signal.aborted) {
					settle({ failure: signal.reason });
					return;
				}
				const failure = new EventSourceError(id, "listen", { cause: error, detail: errnoCode(error) });
				settle({ failure });
				throw failure;
			}
			if (signal.aborted) settle({ failure: signal.reason });
			else settle({ url: listenerUrl(listener.server, path) });
			await ended.promise;
			await release();
			if (runtime.failure !== undefined && !signal.aborted) {
				throw new EventSourceError(id, "listen", {
					cause: runtime.failure.error,
					detail: errnoCode(runtime.failure.error),
				});
			}
		},
	};
}

/** Runs `gh` with `args` and resolves its stdout. It must reject when the command fails and honour `signal`. */
export type GitHubCommandRunner = (args: readonly string[], signal: AbortSignal) => Promise<string>;

export interface GitHubPullRequestSourceOptions {
	/** Repository as `owner/name`. */
	readonly repo: string;
	/** Pull request number. */
	readonly pr: number;
	/** Milliseconds between polls. Defaults to 30 000. */
	readonly intervalMs?: number;
	/** Runs the `gh` CLI. Defaults to spawning `gh`; supply one to use another transport or a test double. */
	readonly gh?: GitHubCommandRunner;
	/** Schedules the waits between polls. Defaults to the process-wide dispatcher. */
	readonly dispatcher?: WakeDispatcher;
}

function commandFailureDetail(exitCode: number | undefined, spawnCode: string | undefined): string {
	if (exitCode !== undefined) return `gh exited with code ${exitCode}`;
	return spawnCode === undefined ? "gh could not be run" : `gh could not be run (${spawnCode})`;
}

/** `gh` ran and failed, or could not be started. The message is the credential-free detail shown on the poll error. */
class GitHubCommandError extends Error {
	override readonly name = "GitHubCommandError" as const;
	/** Exit status of `gh`, or `undefined` when it could not be started or was killed. */
	readonly exitCode: number | undefined;
	/** Spawn error code such as `ENOENT` when `gh` could not be started. */
	readonly spawnCode: string | undefined;
	/** Truncated stderr of `gh`. */
	readonly stderr: string;

	constructor(exitCode: number | undefined, spawnCode: string | undefined, stderr: string, cause: unknown) {
		super(commandFailureDetail(exitCode, spawnCode), { cause });
		this.exitCode = exitCode;
		this.spawnCode = spawnCode;
		this.stderr = stderr.slice(0, GH_MAX_STDERR_CHARS);
	}
}

type GitHubResponseReason = "not-json" | "not-object" | "not-array" | "no-head-sha";

/** `gh` succeeded but its output is not the JSON shape the source needs. */
class GitHubResponseError extends Error {
	override readonly name = "GitHubResponseError" as const;
	readonly reason: GitHubResponseReason;

	constructor(reason: GitHubResponseReason, cause?: unknown) {
		super(reason, cause === undefined ? undefined : { cause });
		this.reason = reason;
	}
}

const runGh: GitHubCommandRunner = (args, signal) =>
	new Promise((resolve, reject) => {
		execFile(
			"gh",
			[...args],
			{ signal, maxBuffer: GH_MAX_OUTPUT_BYTES, windowsHide: true },
			(error, stdout, stderr) => {
				if (error === null) {
					resolve(stdout);
					return;
				}
				const exitCode = typeof error.code === "number" ? error.code : undefined;
				const spawnCode = typeof error.code === "string" ? error.code : undefined;
				reject(new GitHubCommandError(exitCode, spawnCode, stderr, error));
			},
		);
	});

function pollFailureDetail(error: unknown): string {
	if (error instanceof GitHubCommandError) return error.message;
	if (error instanceof GitHubResponseError) return "unexpected gh response";
	const code = errnoCode(error);
	return code === undefined ? "gh failed" : `gh failed (${code})`;
}

async function ghJson(
	gh: GitHubCommandRunner,
	args: readonly string[],
	signal: AbortSignal,
): Promise<SubscriptionEventPayload> {
	const stdout = await gh(args, signal);
	try {
		return parseJson(stdout);
	} catch (error) {
		throw new GitHubResponseError("not-json", error);
	}
}

function asObject(value: SubscriptionEventPayload): JsonObject {
	if (!isJsonObject(value)) throw new GitHubResponseError("not-object");
	return value;
}

/** The object elements of a JSON array; anything else in the array is skipped. */
function asObjects(value: SubscriptionEventPayload | undefined): readonly JsonObject[] {
	if (!Array.isArray(value)) throw new GitHubResponseError("not-array");
	return (value as readonly SubscriptionEventPayload[]).filter(isJsonObject);
}

function validateGitHubOptions(
	name: "githubChecks" | "githubReviews",
	options: GitHubPullRequestSourceOptions,
): {
	readonly repo: string;
	readonly pr: number;
	readonly intervalMs: number;
	readonly gh: GitHubCommandRunner;
	readonly dispatcher: WakeDispatcher;
} {
	const { repo, pr } = options;
	if (typeof repo !== "string" || !REPO_PATTERN.test(repo))
		throw new SubscriptionConfigError(`${name}.repo`, "not-string");
	if (!Number.isSafeInteger(pr) || pr <= 0) throw new SubscriptionConfigError(`${name}.pr`, "not-positive-integer");
	const intervalMs = options.intervalMs ?? DEFAULT_GITHUB_INTERVAL_MS;
	requireTimerMs(intervalMs, `${name}.intervalMs`);
	const gh = options.gh ?? runGh;
	if (typeof gh !== "function") throw new SubscriptionConfigError(`${name}.gh`, "not-function");
	return { repo, pr, intervalMs, gh, dispatcher: resolveDispatcher(options.dispatcher, `${name}.dispatcher`) };
}

function pollingSource(
	id: string,
	dispatcher: WakeDispatcher,
	intervalMs: number,
	poll: (signal: AbortSignal) => Promise<readonly SubscriptionEvent[]>,
): EventSource {
	return {
		id,
		async start(signal, emit) {
			while (!signal.aborted) {
				let events: readonly SubscriptionEvent[];
				try {
					events = await poll(signal);
				} catch (error) {
					if (signal.aborted) return;
					throw new EventSourceError(id, "poll", {
						cause: error,
						detail: pollFailureDetail(error),
						retryable: !(error instanceof GitHubResponseError),
					});
				}
				for (const item of events) {
					if (signal.aborted) return;
					emit(item);
				}
				if (!(await wait(dispatcher, intervalMs, signal))) return;
			}
		},
	};
}

/**
 * Emits one `check_run` event per check run of a pull request's head commit on every poll. The id carries the run's
 * status and conclusion, so a run that changes state produces a new event and an unchanged one is deduplicated.
 */
export function githubChecks(options: GitHubPullRequestSourceOptions): EventSource {
	const { repo, pr, intervalMs, gh, dispatcher } = validateGitHubOptions("githubChecks", options);
	return pollingSource(`github-checks:${repo}#${pr}`, dispatcher, intervalMs, async (signal) => {
		const pull = asObject(await ghJson(gh, ["api", `repos/${repo}/pulls/${pr}`], signal));
		const headSha = nestedString(pull, "head", "sha");
		if (headSha === undefined) throw new GitHubResponseError("no-head-sha");
		const checks = asObject(
			await ghJson(gh, ["api", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`], signal),
		);
		const events: SubscriptionEvent[] = [];
		for (const run of asObjects(checks.check_runs)) {
			const runId = numberField(run, "id");
			const status = stringField(run, "status");
			if (runId === undefined || status === undefined) continue;
			const conclusion = stringField(run, "conclusion") ?? null;
			events.push(
				event(`check-run:${runId}:${status}:${conclusion ?? "none"}`, "check_run", {
					name: stringField(run, "name") ?? "",
					status,
					conclusion,
					url: stringField(run, "html_url") ?? null,
					headSha,
					startedAt: stringField(run, "started_at") ?? null,
					completedAt: stringField(run, "completed_at") ?? null,
				}),
			);
		}
		return events;
	});
}

/** Emits one `pull_request_review` event per submitted review of a pull request. The id is the review's id. */
export function githubReviews(options: GitHubPullRequestSourceOptions): EventSource {
	const { repo, pr, intervalMs, gh, dispatcher } = validateGitHubOptions("githubReviews", options);
	return pollingSource(`github-reviews:${repo}#${pr}`, dispatcher, intervalMs, async (signal) => {
		const reviews = await ghJson(gh, ["api", `repos/${repo}/pulls/${pr}/reviews?per_page=100`], signal);
		const events: SubscriptionEvent[] = [];
		for (const review of asObjects(reviews)) {
			const reviewId = numberField(review, "id");
			if (reviewId === undefined) continue;
			events.push(
				event(`review:${reviewId}`, "pull_request_review", {
					reviewer: nestedString(review, "user", "login") ?? null,
					state: stringField(review, "state") ?? "",
					body: stringField(review, "body") ?? "",
					submittedAt: stringField(review, "submitted_at") ?? null,
					url: stringField(review, "html_url") ?? null,
				}),
			);
		}
		return events;
	});
}
