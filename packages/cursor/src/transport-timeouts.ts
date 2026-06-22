import { CursorTransportError } from "./transport-errors.js";

export async function runWithDeadline<T>(operation: (signal: AbortSignal | undefined) => Promise<T>, timeoutMs: number, parentSignal: AbortSignal | undefined, timeoutMessage: string): Promise<T> {
	if (parentSignal?.aborted) throw new CursorTransportError("Aborted", "Cursor request aborted.");
	const controller = new AbortController();
	let rejectAbort: ((error: CursorTransportError) => void) | undefined;
	const onAbort = (): void => {
		controller.abort();
		rejectAbort?.(new CursorTransportError("Aborted", "Cursor request aborted."));
	};
	parentSignal?.addEventListener("abort", onAbort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abortPromise = parentSignal ? new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	}) : undefined;
	const timeoutPromise = timeoutMs > 0 ? new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new CursorTransportError("NetworkError", timeoutMessage));
		}, timeoutMs);
		timeout.unref?.();
	}) : undefined;
	try {
		return await Promise.race([operation(controller.signal), ...(abortPromise ? [abortPromise] : []), ...(timeoutPromise ? [timeoutPromise] : [])]);
	} finally {
		if (timeout) clearTimeout(timeout);
		parentSignal?.removeEventListener("abort", onAbort);
		rejectAbort = undefined;
	}
}

let nativeOperationCounter = 0;

export function nextNativeOperationId(): string {
	nativeOperationCounter = (nativeOperationCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `cursor-h2-${Date.now().toString(36)}-${nativeOperationCounter.toString(36)}`;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, timeoutMessage: string): Promise<T> {
	if (!timeoutMs || timeoutMs <= 0) return promise;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new CursorTransportError("NetworkError", timeoutMessage)), timeoutMs);
		timeout.unref?.();
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string, onLateResolve?: (value: T) => void | Promise<void>, onAbort?: () => void | Promise<void>): Promise<T> {
	if (signal?.aborted) throw new CursorTransportError("Aborted", message);
	if (!signal) return promise;
	let settled = false;
	let rejectAbort: ((error: CursorTransportError) => void) | undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const abort = (): void => {
		void onAbort?.();
		rejectAbort?.(new CursorTransportError("Aborted", message));
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([
			promise.then(async (value) => {
				settled = true;
				if (signal.aborted) {
					if (onLateResolve) await onLateResolve(value);
					throw new CursorTransportError("Aborted", message);
				}
				return value;
			}),
			abortPromise,
		]);
	} finally {
		signal.removeEventListener("abort", abort);
		rejectAbort = undefined;
		if (!settled) {
			promise.then((value) => {
				if (signal.aborted) void onLateResolve?.(value);
			}).catch(() => undefined);
		}
	}
}
