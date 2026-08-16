import assert from "node:assert/strict";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, test } from "vitest";
import {
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/coding-agent/src/core/model-fallback-failures.ts";
import { guardStreamLiveness, isProgressEvent } from "../../packages/coding-agent/src/core/stream-liveness-guard.ts";

// ---------------------------------------------------------------------------
// Deterministic harness: an injectable clock + timer, so both stall shapes —
// a contentless flood (events keep arriving) and a silent hang (no event ever
// arrives) — are exercised without real wall-clock time.
// ---------------------------------------------------------------------------

interface FakeTimer {
	readonly callback: () => void;
	readonly ms: number;
	cancelled: boolean;
}

function makeHarness() {
	const clock = { now: 0 };
	const timers: FakeTimer[] = [];
	const schedule = (callback: () => void, ms: number): (() => void) => {
		const timer: FakeTimer = { callback, ms, cancelled: false };
		timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};
	return { clock, timers, now: () => clock.now, schedule };
}

// A source whose every `next()` outcome is scripted: deliver an event (optionally
// advancing the injected clock as it is pulled), report a normal close, or hang
// forever. `returnCount` proves the guard releases the producer exactly once.
type Step =
	| { readonly kind: "event"; readonly event: AssistantMessageEvent; readonly onDeliver?: () => void }
	| { readonly kind: "end" }
	| { readonly kind: "hang" };

class ScriptedSource extends EventStream<AssistantMessageEvent, AssistantMessage> {
	returnCount = 0;
	private index = 0;
	private readonly steps: readonly Step[];

	constructor(steps: readonly Step[]) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type for final result");
			},
		);
		this.steps = steps;
	}

	// The guard's async iterator never calls result(); a never-settling promise
	// keeps the fake honest (only a genuine terminal event would resolve it).
	override result(): Promise<AssistantMessage> {
		return new Promise<AssistantMessage>(() => {});
	}

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return {
			next: (): Promise<IteratorResult<AssistantMessageEvent>> => {
				const step = this.steps[this.index++];
				if (step === undefined || step.kind === "end") {
					return Promise.resolve({ value: undefined, done: true });
				}
				if (step.kind === "hang") {
					return new Promise<IteratorResult<AssistantMessageEvent>>(() => {});
				}
				step.onDeliver?.();
				return Promise.resolve({ value: step.event, done: false });
			},
			return: (): Promise<IteratorResult<AssistantMessageEvent>> => {
				this.returnCount++;
				return Promise.resolve({ value: undefined, done: true });
			},
		};
	}
}

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MESSAGE: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test-model",
	usage: USAGE,
	stopReason: "stop",
	timestamp: 0,
};

function deltaEvent(type: "text_delta" | "thinking_delta" | "toolcall_delta", delta: string): AssistantMessageEvent {
	return { type, contentIndex: 0, delta, partial: MESSAGE };
}

const DONE_EVENT: AssistantMessageEvent = { type: "done", reason: "stop", message: MESSAGE };
const ERROR_EVENT: AssistantMessageEvent = { type: "error", reason: "error", error: MESSAGE };

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

// ---------------------------------------------------------------------------
// Guard behavior
// ---------------------------------------------------------------------------

describe("guardStreamLiveness", () => {
	test("returns the source unchanged when disabled (stallMs <= 0 or NaN)", () => {
		const source = new ScriptedSource([]);
		assert.equal(guardStreamLiveness(source, { stallMs: 0 }), source);
		assert.equal(guardStreamLiveness(source, { stallMs: -5 }), source);
		assert.equal(guardStreamLiveness(source, { stallMs: Number.NaN }), source);
	});

	test("a long legitimate turn spanning many windows never trips", async () => {
		const { clock, now, schedule } = makeHarness();
		const stallMs = 1000;
		const stalls: number[] = [];
		// Five text deltas, each 400ms after the previous — 2000ms total, far past
		// the 1000ms window, but every gap stays under it — then a terminal done.
		const steps: Step[] = [];
		for (let i = 0; i < 5; i++) {
			steps.push({
				kind: "event",
				event: deltaEvent("text_delta", `chunk-${i}`),
				onDeliver: () => {
					clock.now += 400;
				},
			});
		}
		steps.push({ kind: "event", event: DONE_EVENT });
		steps.push({ kind: "end" });
		const guard = guardStreamLiveness(new ScriptedSource(steps), {
			stallMs,
			now,
			schedule,
			onStall: (idle) => stalls.push(idle),
		});
		const events = await collect(guard);
		assert.equal(events.length, 6);
		assert.equal(events.at(-1)?.type, "done");
		assert.deepEqual(stalls, []);
	});

	test("in-flight tool-call deltas keep the stream alive", async () => {
		const { clock, now, schedule } = makeHarness();
		const stallMs = 1000;
		const stalls: number[] = [];
		// Non-empty toolcall_delta chunks (partial JSON) are real progress even
		// though a whitespace-only toolcall_delta flood is the #2446 shape.
		const chunks = ['{"path":', '"a.ts",', '"line":', "42}"];
		const steps: Step[] = chunks.map((chunk) => ({
			kind: "event" as const,
			event: deltaEvent("toolcall_delta", chunk),
			onDeliver: () => {
				clock.now += 600;
			},
		}));
		steps.push({ kind: "event", event: DONE_EVENT });
		steps.push({ kind: "end" });
		const guard = guardStreamLiveness(new ScriptedSource(steps), {
			stallMs,
			now,
			schedule,
			onStall: (idle) => stalls.push(idle),
		});
		const events = await collect(guard);
		assert.equal(events.length, chunks.length + 1);
		assert.deepEqual(stalls, []);
	});

	test("a contentless whitespace flood trips after the window, bounded, with one stall", async () => {
		const { clock, now, schedule, timers } = makeHarness();
		const stallMs = 1000;
		const stalls: number[] = [];
		const source = new ScriptedSource(
			Array.from({ length: 100 }, () => ({
				kind: "event" as const,
				event: deltaEvent("toolcall_delta", "   "),
				onDeliver: () => {
					clock.now += 400;
				},
			})),
		);
		const guard = guardStreamLiveness(source, { stallMs, now, schedule, onStall: (idle) => stalls.push(idle) });
		const seen: AssistantMessageEvent[] = [];
		await assert.rejects(
			(async () => {
				for await (const event of guard) seen.push(event);
			})(),
			/stream ended before a terminal response event/,
		);
		// 3 whitespace deltas pass (idle 0 → 400 → 800), the 4th top-of-loop sees
		// idle 1200 ≥ 1000 and throws — a hard bound, not the full 100.
		assert.equal(seen.length, 3);
		assert.equal(stalls.length, 1);
		const firstStall = stalls[0];
		assert.ok(firstStall !== undefined && firstStall >= stallMs);
		assert.equal(source.returnCount, 1);
		assert.ok(timers.every((timer) => timer.cancelled));
	});

	test("a silent stall (next never resolves) trips via the timer, no unhandled rejection", async () => {
		const { clock, now, schedule, timers } = makeHarness();
		const stallMs = 1000;
		const stalls: number[] = [];
		const source = new ScriptedSource([{ kind: "hang" }]);
		const guard = guardStreamLiveness(source, { stallMs, now, schedule, onStall: (idle) => stalls.push(idle) });
		const iterator = guard[Symbol.asyncIterator]();
		const pull = iterator.next();
		await Promise.resolve(); // let the generator arm the stall timer
		const timer = timers[0];
		assert.ok(timer !== undefined);
		assert.equal(timer.ms, stallMs);
		clock.now = stallMs; // advance past the window, then fire the timer
		timer.callback();
		await assert.rejects(pull, /stream ended before a terminal response event/);
		assert.equal(stalls.length, 1);
		const firstStall = stalls[0];
		assert.ok(firstStall !== undefined && firstStall >= stallMs);
		assert.equal(source.returnCount, 1);
		assert.ok(timers.every((entry) => entry.cancelled));
	});

	test("an already-aborted signal ends as an abort, outranking any stall", async () => {
		const { clock, now, schedule } = makeHarness();
		const controller = new AbortController();
		controller.abort();
		clock.now = 10_000; // idle would far exceed the window, but abort must win
		const source = new ScriptedSource([{ kind: "event", event: deltaEvent("toolcall_delta", "   ") }]);
		const guard = guardStreamLiveness(source, { stallMs: 1000, signal: controller.signal, now, schedule });
		await assert.rejects(collect(guard), /stream consumption aborted/);
		assert.equal(source.returnCount, 1);
	});

	test("aborting during a silent stall ends promptly as an abort", async () => {
		const { now, schedule } = makeHarness();
		const controller = new AbortController();
		const source = new ScriptedSource([{ kind: "hang" }]);
		const guard = guardStreamLiveness(source, { stallMs: 100_000, signal: controller.signal, now, schedule });
		const iterator = guard[Symbol.asyncIterator]();
		const pull = iterator.next();
		await Promise.resolve();
		controller.abort();
		await assert.rejects(pull, /stream consumption aborted/);
		assert.equal(source.returnCount, 1);
	});

	test("cleanup removes the abort listener and cancels timers on stall", async () => {
		const { clock, now, schedule, timers } = makeHarness();
		const controller = new AbortController();
		const realRemove = controller.signal.removeEventListener.bind(controller.signal);
		let removeCount = 0;
		controller.signal.removeEventListener = ((...removeArgs: Parameters<AbortSignal["removeEventListener"]>) => {
			removeCount++;
			return realRemove(...removeArgs);
		}) as AbortSignal["removeEventListener"];
		const stallMs = 1000;
		const source = new ScriptedSource([
			{
				kind: "event",
				event: deltaEvent("toolcall_delta", "   "),
				onDeliver: () => {
					clock.now += 1500;
				},
			},
		]);
		const guard = guardStreamLiveness(source, { stallMs, signal: controller.signal, now, schedule });
		await assert.rejects(collect(guard), /stream ended before a terminal response event/);
		assert.equal(source.returnCount, 1);
		assert.ok(removeCount >= 1, "abort listener must be removed on cleanup");
		assert.ok(timers.every((timer) => timer.cancelled));
	});

	test("a stream that delivers a terminal done event completes without throwing", async () => {
		const { now, schedule } = makeHarness();
		const stalls: number[] = [];
		const source = new ScriptedSource([
			{ kind: "event", event: deltaEvent("text_delta", "hello") },
			{ kind: "event", event: DONE_EVENT },
			{ kind: "end" },
		]);
		const guard = guardStreamLiveness(source, { stallMs: 1000, now, schedule, onStall: (idle) => stalls.push(idle) });
		const events = await collect(guard);
		assert.deepEqual(
			events.map((event) => event.type),
			["text_delta", "done"],
		);
		assert.deepEqual(stalls, []);
	});

	test("a stream that closes without any terminal event ends retryably", async () => {
		const { now, schedule } = makeHarness();
		const source = new ScriptedSource([{ kind: "event", event: deltaEvent("text_delta", "hello") }, { kind: "end" }]);
		const guard = guardStreamLiveness(source, { stallMs: 1000, now, schedule });
		let captured: unknown;
		try {
			await collect(guard);
		} catch (error) {
			captured = error;
		}
		assert.ok(captured instanceof Error);
		assert.match(captured.message, /stream ended before a terminal response event/);
		assert.match(captured.message, /source closed without a terminal event/);
	});
});

// ---------------------------------------------------------------------------
// isProgressEvent: only a whitespace-only streaming delta is "no progress";
// every other event (structural or terminal) counts as progress.
// ---------------------------------------------------------------------------

describe("isProgressEvent", () => {
	const toolCall: ToolCall = { type: "toolCall", id: "t1", name: "read", arguments: {} };
	const cases: { readonly label: string; readonly event: AssistantMessageEvent; readonly expected: boolean }[] = [
		{ label: "start", event: { type: "start", partial: MESSAGE }, expected: true },
		{ label: "text_start", event: { type: "text_start", contentIndex: 0, partial: MESSAGE }, expected: true },
		{ label: "text_delta non-empty", event: deltaEvent("text_delta", "hi"), expected: true },
		{ label: "text_delta whitespace", event: deltaEvent("text_delta", "  \n\t"), expected: false },
		{ label: "text_delta empty", event: deltaEvent("text_delta", ""), expected: false },
		{
			label: "text_end",
			event: { type: "text_end", contentIndex: 0, content: "hi", partial: MESSAGE },
			expected: true,
		},
		{ label: "thinking_start", event: { type: "thinking_start", contentIndex: 0, partial: MESSAGE }, expected: true },
		{ label: "thinking_delta non-empty", event: deltaEvent("thinking_delta", "reason"), expected: true },
		{ label: "thinking_delta whitespace", event: deltaEvent("thinking_delta", " "), expected: false },
		{
			label: "thinking_end",
			event: { type: "thinking_end", contentIndex: 0, content: "x", partial: MESSAGE },
			expected: true,
		},
		{ label: "toolcall_start", event: { type: "toolcall_start", contentIndex: 0, partial: MESSAGE }, expected: true },
		{ label: "toolcall_delta non-empty", event: deltaEvent("toolcall_delta", "{"), expected: true },
		{ label: "toolcall_delta whitespace", event: deltaEvent("toolcall_delta", "   "), expected: false },
		{
			label: "toolcall_end",
			event: { type: "toolcall_end", contentIndex: 0, toolCall, partial: MESSAGE },
			expected: true,
		},
		{ label: "done", event: DONE_EVENT, expected: true },
		{ label: "error", event: ERROR_EVENT, expected: true },
	];
	for (const { label, event, expected } of cases) {
		test(`${label} → ${expected ? "progress" : "no progress"}`, () => {
			assert.equal(isProgressEvent(event), expected);
		});
	}
});

// ---------------------------------------------------------------------------
// Classification bridge: the guard's throw must normalize to a fallbackable,
// same-model-retryable provider_unavailable failure so retry/fallback advance.
// ---------------------------------------------------------------------------

describe("classification bridge to model-fallback-failures", () => {
	test("the guard's real stall error advances retry and fallback as provider_unavailable", async () => {
		const { clock, now, schedule } = makeHarness();
		const stallMs = 1000;
		const source = new ScriptedSource(
			Array.from({ length: 100 }, () => ({
				kind: "event" as const,
				event: deltaEvent("toolcall_delta", "   "),
				onDeliver: () => {
					clock.now += 400;
				},
			})),
		);
		const guard = guardStreamLiveness(source, { stallMs, now, schedule });
		let captured: unknown;
		try {
			await collect(guard);
		} catch (error) {
			captured = error;
		}
		assert.ok(captured instanceof Error);
		assert.match(captured.message, /stream ended before a terminal response event/);
		assert.equal(isRetryableModelFailure(captured), true);
		assert.equal(isRetryableSameModelFailure(captured), true);
		assert.equal(normalizeModelFailureSignal(captured).kind, "provider_unavailable");
	});

	test("the terminalless-close error classifies identically", () => {
		const error = new Error("stream ended before a terminal response event (source closed without a terminal event)");
		assert.equal(isRetryableModelFailure(error), true);
		assert.equal(isRetryableSameModelFailure(error), true);
		assert.equal(normalizeModelFailureSignal(error).kind, "provider_unavailable");
	});
});
