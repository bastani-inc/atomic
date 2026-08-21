import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError, type RetryPolicy, retryAssistantCall } from "../src/utils/retry.ts";
import {
	DEFAULT_STREAM_DEADLINE_MS,
	createStreamDeadline,
	resolveStreamDeadlineMs,
	StreamDeadlineError,
	withStreamDeadline,
} from "../src/utils/stream-deadline.ts";

/** The exact wrapper text GitHub Copilot reports on `transport: "auto"` (#2553). */
const copilotZlibMessage = "Library error: zlib error: incorrect header check";

/** A stream that yields nothing and never settles, reproducing the stalled attempt. */
function neverSettlingStream(): AsyncIterable<string> {
	return {
		[Symbol.asyncIterator]() {
			return {
				next: () => new Promise<IteratorResult<string>>(() => {}),
			};
		},
	};
}

/** A stream that yields some events, then fails the way a corrupt body decode does. */
async function* decompressionFailingStream(): AsyncGenerator<string, void, undefined> {
	yield "chunk-1";
	yield "chunk-2";
	throw new Error(copilotZlibMessage);
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
	const seen: string[] = [];
	for await (const value of source) seen.push(value);
	return seen;
}

describe("stream deadline (#2553)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves the default, honours an override, and treats non-positive values as disabled", () => {
		expect(resolveStreamDeadlineMs(undefined)).toBe(DEFAULT_STREAM_DEADLINE_MS);
		expect(resolveStreamDeadlineMs(30_000)).toBe(30_000);
		expect(resolveStreamDeadlineMs(0)).toBeUndefined();
		expect(resolveStreamDeadlineMs(-1)).toBeUndefined();
		expect(resolveStreamDeadlineMs(Number.NaN)).toBeUndefined();
	});

	it("keeps the default below the 600000 ms HTTP idle timeout so it bounds failures below the HTTP layer", () => {
		expect(DEFAULT_STREAM_DEADLINE_MS).toBeLessThan(600_000);
		expect(DEFAULT_STREAM_DEADLINE_MS).toBeGreaterThan(0);
	});

	it("cuts a stream that never settles once the configured deadline elapses", async () => {
		vi.useFakeTimers();
		const iteration = collect(withStreamDeadline(neverSettlingStream(), 30_000));
		const assertion = expect(iteration).rejects.toBeInstanceOf(StreamDeadlineError);

		await vi.advanceTimersByTimeAsync(29_999);
		await vi.advanceTimersByTimeAsync(1);

		await assertion;
	});

	it("settles a stalled stream that stays pending forever without the wrapper", async () => {
		vi.useFakeTimers();
		let unwrappedSettled = false;
		let wrappedSettled = false;

		// The pre-fix adapter awaited the source directly. A body that stalls
		// without erroring leaves this pending forever, which is exactly why the
		// attempt never settled and the workflow stage stayed `running` (#2553).
		void collect(neverSettlingStream()).then(
			() => {
				unwrappedSettled = true;
			},
			() => {
				unwrappedSettled = true;
			},
		);
		void collect(withStreamDeadline(neverSettlingStream(), 10_000)).then(
			() => {
				wrappedSettled = true;
			},
			() => {
				wrappedSettled = true;
			},
		);

		// Far beyond both the deadline and the 600000 ms default HTTP idle timeout.
		await vi.advanceTimersByTimeAsync(900_000);

		expect(unwrappedSettled).toBe(false);
		expect(wrappedSettled).toBe(true);
	});

	it("aborts the pending provider read before the deadline error reaches fallback", async () => {
		vi.useFakeTimers();
		const deadline = createStreamDeadline(20);
		let abortObserved = false;
		let cleanupObserved = false;
		async function* providerRead(): AsyncGenerator<string, void, undefined> {
			try {
				await new Promise<void>((_resolve, reject) => {
					deadline.signal?.addEventListener("abort", () => {
						abortObserved = true;
						reject(deadline.signal?.reason);
					}, { once: true });
				});
			} finally {
				cleanupObserved = true;
			}
		}

		const captured = collect(withStreamDeadline(providerRead(), deadline.deadlineMs, deadline.abort)).catch(
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(20);

		await expect(captured).resolves.toBeInstanceOf(StreamDeadlineError);
		expect(abortObserved).toBe(true);
		expect(cleanupObserved).toBe(true);
		deadline.cleanup();
	});

	it("does not overflow platform timers for a deadline above the 32-bit timer limit", async () => {
		vi.useFakeTimers();
		const deadlineMs = 2_147_483_648;
		const captured = collect(withStreamDeadline(neverSettlingStream(), deadlineMs)).catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(2_147_483_647);
		let settled = false;
		void captured.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(captured).resolves.toBeInstanceOf(StreamDeadlineError);
	});

	it("surfaces the deadline as a retryable transport error", async () => {
		vi.useFakeTimers();
		const iteration = collect(withStreamDeadline(neverSettlingStream(), 1_000));
		const captured = iteration.catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(1_000);

		const error = await captured;
		expect(error).toBeInstanceOf(StreamDeadlineError);
		const message = (error as StreamDeadlineError).message;
		expect(message).toContain("stream deadline exceeded");
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: message })),
		).toBe(true);
	});

	it("closes the source iterator when the deadline fires so the underlying request is torn down", async () => {
		vi.useFakeTimers();
		const close = vi.fn(async () => ({ done: true, value: undefined }) as IteratorResult<string>);
		const stalled: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise<IteratorResult<string>>(() => {}),
					return: close,
				};
			},
		};

		const captured = collect(withStreamDeadline(stalled, 5_000)).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(captured).resolves.toBeInstanceOf(StreamDeadlineError);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("restarts the deadline per event, so a slow but progressing stream is never cut", async () => {
		vi.useFakeTimers();
		async function* slowStream(): AsyncGenerator<string, void, undefined> {
			for (const value of ["a", "b", "c"]) {
				await new Promise((resolve) => setTimeout(resolve, 900));
				yield value;
			}
		}

		const iteration = collect(withStreamDeadline(slowStream(), 1_000));
		await vi.advanceTimersByTimeAsync(3_000);

		await expect(iteration).resolves.toEqual(["a", "b", "c"]);
	});

	it("passes events straight through when the deadline is disabled", async () => {
		async function* fast(): AsyncGenerator<string, void, undefined> {
			yield "a";
			yield "b";
		}

		await expect(collect(withStreamDeadline(fast(), resolveStreamDeadlineMs(0)))).resolves.toEqual(["a", "b"]);
	});

	it("settles a mid-stream decompression failure instead of hanging, preserving the events seen so far", async () => {
		const seen: string[] = [];
		let settled: string | undefined;

		try {
			for await (const value of withStreamDeadline(decompressionFailingStream(), 30_000)) {
				seen.push(value);
			}
		} catch (error) {
			settled = (error as Error).message;
		}

		expect(seen).toEqual(["chunk-1", "chunk-2"]);
		expect(settled).toBe(copilotZlibMessage);
	});
});

describe("decompression failures classify as transient transport errors (#2553)", () => {
	const variants = [
		copilotZlibMessage,
		"zlib error: incorrect header check",
		"incorrect header check",
		"Error: unexpected end of file (zlib)",
		"Library error: failed to decompress response body",
		"ContentDecoding: decompression failed",
		// Verified against Bun 1.4.0 — the runtime the shipped Atomic binary uses —
		// by serving a body whose Content-Encoding lies. This is the literal text
		// `fetch` throws there, so the classifier must cover it, not just the
		// "Library error:"-wrapped wording quoted in the issue.
		'ZlibError fetching "https://api.githubcopilot.com/chat/completions". For more information, pass `verbose: true` in the second argument to fetch()',
	];

	for (const errorMessage of variants) {
		it(`classifies ${JSON.stringify(errorMessage)} as retryable`, () => {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
		});
	}

	it("still refuses to retry deterministic quota and billing failures", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
			),
		).toBe(false);
	});
});

describe("a stalled Copilot attempt reaches a terminal state via retry (#2553)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries the decompression failure and settles on the next attempt within bounded virtual time", async () => {
		vi.useFakeTimers();
		const policy: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1_000 };
		const produce = vi
			.fn<() => Promise<ReturnType<typeof fauxAssistantMessage>>>()
			.mockResolvedValueOnce(fauxAssistantMessage("", { stopReason: "error", errorMessage: copilotZlibMessage }))
			.mockResolvedValueOnce(fauxAssistantMessage("recovered"));

		const call = retryAssistantCall(produce, policy, undefined);
		await vi.advanceTimersByTimeAsync(1_000);

		const result = await call;
		expect(result.stopReason).not.toBe("error");
		expect(produce).toHaveBeenCalledTimes(2);
	});

	it("fails terminally rather than staying pending when every attempt hits the decompression failure", async () => {
		vi.useFakeTimers();
		const policy: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 1_000 };
		const produce = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: copilotZlibMessage }),
		);

		const call = retryAssistantCall(produce, policy, undefined);
		await vi.advanceTimersByTimeAsync(1_000);

		const result = await call;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(copilotZlibMessage);
		expect(produce).toHaveBeenCalledTimes(2);
	});
});
