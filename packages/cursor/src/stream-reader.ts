import type { CursorServerMessage } from "./transport.js";

export type CursorMessageReadResult =
	| { readonly kind: "message"; readonly result: IteratorResult<CursorServerMessage> }
	| { readonly kind: "aborted" };

type CursorReadRaceResult =
	| { readonly kind: "message"; readonly result: IteratorResult<CursorServerMessage>; readonly read: CursorMessageReadHandle }
	| { readonly kind: "error"; readonly error: Error; readonly read: CursorMessageReadHandle }
	| { readonly kind: "aborted" };

export class CursorStreamAbortError extends Error {
	constructor() {
		super("Cursor stream aborted.");
		this.name = "CursorStreamAbortError";
	}
}

export class CursorStreamTimeoutError extends Error {
	constructor() {
		super("Cursor stream timed out while waiting for provider output.");
		this.name = "CursorStreamTimeoutError";
	}
}

interface CursorPendingMessageRead {
	readonly promise: Promise<IteratorResult<CursorServerMessage>>;
	consumed: boolean;
}

interface CursorMessageReadHandle {
	readonly promise: Promise<IteratorResult<CursorServerMessage>>;
	consumeResult(result: IteratorResult<CursorServerMessage>): void;
	consumeError(error: Error): void;
}

type CursorBufferedMessageRead =
	| { readonly kind: "result"; readonly result: IteratorResult<CursorServerMessage> }
	| { readonly kind: "error"; readonly error: Error };

export class CursorMessageReader {
	readonly #iterator: AsyncIterator<CursorServerMessage>;
	#pending: CursorPendingMessageRead | undefined;
	#buffered: CursorBufferedMessageRead | undefined;
	#finalization: Promise<void> | undefined;

	constructor(messages: AsyncIterable<CursorServerMessage>) {
		this.#iterator = messages[Symbol.asyncIterator]();
	}

	unread(result: IteratorResult<CursorServerMessage>): void {
		if (this.#buffered) return;
		this.#buffered = { kind: "result", result };
	}

	finalize(): Promise<void> {
		if (this.#finalization) return this.#finalization;
		this.#pending = undefined;
		this.#buffered = undefined;
		const returnIterator = this.#iterator.return;
		if (!returnIterator) {
			this.#finalization = Promise.resolve();
			return this.#finalization;
		}
		try {
			this.#finalization = Promise.resolve(returnIterator.call(this.#iterator)).then(() => undefined, () => undefined);
		} catch {
			this.#finalization = Promise.resolve();
		}
		return this.#finalization;
	}

	peek(): CursorMessageReadHandle {
		if (this.#buffered) return this.peekBuffered(this.#buffered);
		const pending = this.#pending ?? this.startRead();
		return {
			promise: pending.promise,
			consumeResult: (result) => {
				pending.consumed = true;
				if (this.#pending === pending) this.#pending = undefined;
				if (this.#buffered?.kind === "result" && this.#buffered.result === result) this.#buffered = undefined;
			},
			consumeError: (error) => {
				pending.consumed = true;
				if (this.#pending === pending) this.#pending = undefined;
				if (this.#buffered?.kind === "error" && this.#buffered.error === error) this.#buffered = undefined;
			},
		};
	}

	private peekBuffered(buffered: CursorBufferedMessageRead): CursorMessageReadHandle {
		return {
			promise: buffered.kind === "result" ? Promise.resolve(buffered.result) : Promise.reject(buffered.error),
			consumeResult: (result) => {
				if (this.#buffered === buffered && buffered.kind === "result" && buffered.result === result) this.#buffered = undefined;
			},
			consumeError: (error) => {
				if (this.#buffered === buffered && buffered.kind === "error" && buffered.error === error) this.#buffered = undefined;
			},
		};
	}

	private startRead(): CursorPendingMessageRead {
		const pending: CursorPendingMessageRead = {
			promise: this.#iterator.next().catch((error: Error) => {
				throw normalizeCursorReadError(error);
			}),
			consumed: false,
		};
		this.#pending = pending;
		pending.promise.then(
			(result) => {
				if (this.#pending !== pending) return;
				this.#pending = undefined;
				if (!pending.consumed) this.#buffered = { kind: "result", result };
			},
			(error: Error) => {
				if (this.#pending !== pending) return;
				this.#pending = undefined;
				if (!pending.consumed) this.#buffered = { kind: "error", error };
			},
		);
		void pending.promise.catch(() => undefined);
		return pending;
	}
}

export async function readNextCursorMessage(
	reader: CursorMessageReader,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<CursorMessageReadResult> {
	if (signal?.aborted) return { kind: "aborted" };
	let abortListener: (() => void) | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abortPromise = signal ? new Promise<CursorReadRaceResult>((resolve) => {
		abortListener = () => resolve({ kind: "aborted" });
		signal.addEventListener("abort", abortListener, { once: true });
	}) : undefined;
	const timeoutPromise = timeoutMs > 0 ? new Promise<CursorReadRaceResult>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new CursorStreamTimeoutError()), timeoutMs);
		timeout.unref?.();
	}) : undefined;
	const read = reader.peek();
	const messagePromise = read.promise.then(
		(result): CursorReadRaceResult => ({ kind: "message", result, read }),
		(error: Error): CursorReadRaceResult => ({ kind: "error", error: normalizeCursorReadError(error), read }),
	);
	try {
		const next = await Promise.race([messagePromise, ...(abortPromise ? [abortPromise] : []), ...(timeoutPromise ? [timeoutPromise] : [])]);
		if (signal?.aborted) return { kind: "aborted" };
		if (next.kind === "message") {
			next.read.consumeResult(next.result);
			if (signal?.aborted) return { kind: "aborted" };
			return { kind: "message", result: next.result };
		}
		if (next.kind === "error") {
			next.read.consumeError(next.error);
			if (signal?.aborted) return { kind: "aborted" };
			throw next.error;
		}
		return next;
	} finally {
		if (abortListener) signal?.removeEventListener("abort", abortListener);
		if (timeout) clearTimeout(timeout);
	}
}

function normalizeCursorReadError(error: Error): Error {
	return error instanceof Error ? error : new Error(String(error));
}
