// Keep this cross-package entry in its own directory: Bun can cache the old contents of dist/utils during an update.
import { raceWithAbortSignal } from "../abort.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const ERROR_BODY_WAIT_MS = 250;

export function remainingRequestTimeoutMs(startedAt: number, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): number {
	return Math.max(0, Math.ceil(startedAt + timeoutMs - performance.now()));
}

export class ProviderWaitTimeoutError extends Error {
	constructor(label: string, timeoutMs: number) {
		super(`${label} timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
	}
}

/** Stop waiting on timeout or Esc even when the underlying task ignores its signal. */
export async function withProviderTimeout<T>(
	timeoutMs: number | undefined,
	callerSignal: AbortSignal | undefined,
	operation: (signal: AbortSignal) => Promise<T>,
	label: string,
): Promise<T> {
	const ms = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid timeoutMs: ${String(ms)}`);
	const controller = new AbortController();
	// A returned response can still observe caller cancellation after this timer is cleared.
	const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
	const expire = () => controller.abort(new ProviderWaitTimeoutError(label, ms));
	if (ms <= 0) expire();
	const timer = ms > 0 ? setTimeout(expire, Math.min(ms, 2_147_483_647)) : undefined;
	try {
		signal.throwIfAborted();
		return await raceWithAbortSignal(operation(signal), signal);
	} finally {
		clearTimeout(timer);
	}
}

/** Bound the wait for response headers without imposing a deadline on the response body. */
export function withResponseTimeout<T>(
	timeoutMs: number | undefined,
	callerSignal: AbortSignal | undefined,
	request: (signal: AbortSignal) => Promise<T>,
	label = "Provider",
): Promise<T> {
	return withProviderTimeout(timeoutMs, callerSignal, request, `${label} response headers`);
}

/** Fetch override used by SDKs that don't offer a headers-only timeout. */
export function fetchWithResponseTimeout(fetch: typeof globalThis.fetch | undefined, timeoutMs?: number): typeof globalThis.fetch {
	return Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const startedAt = performance.now();
		const response = await withResponseTimeout(timeoutMs, signal, (signal) => (fetch ?? globalThis.fetch)(input, { ...init, signal }));
		return boundProviderErrorResponse(response, signal, remainingRequestTimeoutMs(startedAt, timeoutMs));
	}, fetch ?? globalThis.fetch);
}

/** Observe bounded error details without consuming the SDK's copy. Undefined means the body was abandoned. */
export async function readBoundedErrorBody(
	response: Response,
	signal?: AbortSignal,
	timeoutMs = ERROR_BODY_WAIT_MS,
): Promise<string | undefined> {
	const reader = response.clone().body?.getReader();
	if (!reader) return "";
	try {
		return await withProviderTimeout(Math.min(timeoutMs, ERROR_BODY_WAIT_MS), signal, async () => {
			const decoder = new TextDecoder();
			let text = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) return text + decoder.decode();
				text += decoder.decode(chunk.value, { stream: true });
			}
		}, "Provider HTTP error body");
	} catch (error) {
		if (!signal?.aborted && !(error instanceof ProviderWaitTimeoutError)) throw error;
		// Both branches need cancelling. Neither cancellation is allowed to hold up the request.
		void response.body?.cancel().catch(() => {});
		return undefined;
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function responseWithoutBody(response: Response): Response {
	return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** A slow error body must not hide the response status or Retry-After from the SDK. */
export async function boundProviderErrorResponse(response: Response, signal?: AbortSignal, timeoutMs?: number): Promise<Response> {
	if (response.ok || !response.body) return response;
	const body = await readBoundedErrorBody(response, signal, timeoutMs).catch(() => "");
	return body === undefined ? responseWithoutBody(response) : response;
}
