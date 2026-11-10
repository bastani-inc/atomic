import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { parseGitHubCopilotDiscoveredModels } from "../src/providers/github-copilot.ts";
import { GitHubCopilotStreamEndedEarlyError, getGitHubCopilotError } from "../src/providers/github-copilot-errors.ts";
import type { Api, Context, Model } from "../src/types.ts";
import { StreamDeadlineError, withStreamDeadline } from "../src/utils/stream-deadline.ts";

const DEADLINE_MS = 100_000;
const PING_INTERVAL_MS = 40_000;
const PING_COUNT = 5;

type Item = "ping" | "event";

function isPing(item: Item): item is "ping" {
	return item === "ping";
}

/** Items that each arrive after their own gap, on the fake clock. */
async function* arrivingAfter(gaps: readonly (readonly [Item, number])[]): AsyncGenerator<Item> {
	for (const [item, gapMs] of gaps) {
		await new Promise((resolve) => setTimeout(resolve, gapMs));
		yield item;
	}
}

async function collect(source: AsyncIterable<Item>): Promise<Item[]> {
	const seen: Item[] = [];
	for await (const item of source) seen.push(item);
	return seen;
}

describe("stream deadline keep-alives (#4626)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("restarts the idle timer on each keep-alive and never yields it (#4626)", async () => {
		vi.useFakeTimers();
		const gaps: (readonly [Item, number])[] = [
			...Array.from({ length: PING_COUNT }, (): readonly [Item, number] => ["ping", PING_INTERVAL_MS]),
			["event", PING_INTERVAL_MS],
		];
		let deadlineCalls = 0;
		const iteration = collect(
			withStreamDeadline(
				arrivingAfter(gaps),
				DEADLINE_MS,
				() => {
					deadlineCalls += 1;
				},
				isPing,
			),
		);

		await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * (PING_COUNT + 1));

		assert.deepEqual(await iteration, ["event"]);
		assert.equal(deadlineCalls, 0);
		assert.ok(PING_INTERVAL_MS * (PING_COUNT + 1) > DEADLINE_MS);
	});

	it("still cuts a stream whose gap between keep-alives exceeds the deadline (#4626)", async () => {
		vi.useFakeTimers();
		let deadlineCalls = 0;
		const iteration = collect(
			withStreamDeadline(
				arrivingAfter([
					["ping", PING_INTERVAL_MS],
					["ping", DEADLINE_MS + 1],
				]),
				DEADLINE_MS,
				() => {
					deadlineCalls += 1;
				},
				isPing,
			),
		);
		const rejection = assert.rejects(iteration, StreamDeadlineError);

		await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + DEADLINE_MS);

		await rejection;
		assert.equal(deadlineCalls, 1);
	});

	it("drops keep-alives when no deadline is set (#4626)", async () => {
		const items = arrivingAfter([
			["ping", 0],
			["event", 0],
			["ping", 0],
		]);

		assert.deepEqual(await collect(withStreamDeadline(items, undefined, undefined, isPing)), ["event"]);
	});

	it("yields every item when the source marks no keep-alives (#4626)", async () => {
		const items = arrivingAfter([
			["ping", 0],
			["event", 0],
		]);

		assert.deepEqual(await collect(withStreamDeadline(items, DEADLINE_MS)), ["ping", "event"]);
	});
});

const recordedModels: unknown = JSON.parse(
	readFileSync(new URL("./fixtures/github-copilot-models.json", import.meta.url), "utf8"),
);

function copilotClaude(): Model<Api> {
	const model = parseGitHubCopilotDiscoveredModels(recordedModels, []).find(
		(candidate) => candidate.id === "example-messages-model",
	);
	if (!model) throw new Error("Expected example-messages-model to be discovered");
	return model;
}

const userTurn: Context = {
	systemPrompt: "Think quietly.",
	messages: [{ role: "user", content: "Solve it.", timestamp: 0 }],
};

function sse(event: string, data: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const messageStart = sse("message_start", {
	type: "message_start",
	message: { id: "msg_quiet_fixture", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 0 } },
});
const ping = sse("ping", { type: "ping" });
const messageDelta = sse("message_delta", {
	type: "message_delta",
	delta: { stop_reason: "end_turn" },
	usage: { output_tokens: 1 },
});
const messageStop = sse("message_stop", { type: "message_stop" });

/** A Messages response whose body the test feeds by hand, so the fake clock decides when each event arrives. */
function controlledMessagesStream(): {
	readonly fetch: typeof globalThis.fetch;
	readonly send: (chunk: Uint8Array) => void;
	readonly close: () => void;
} {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		fetch: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
		send: (chunk) => {
			if (!cancelled) controller?.enqueue(chunk);
		},
		close: () => {
			if (!cancelled) controller?.close();
		},
	};
}

/** Resolves once the adapter has read `message_start`, so its idle timer is armed before the fake clock moves. */
function messageStartConsumed(): { readonly promise: Promise<void>; readonly onEvent: (event: unknown) => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((resolver) => {
		resolve = resolver;
	});
	return {
		promise,
		onEvent: (event) => {
			if ((event as { type: string }).type === "message_start") resolve();
		},
	};
}

describe("Anthropic Messages pings on the stream idle deadline (#4626)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps a silently thinking response alive across ping intervals longer than the deadline (#4626)", async () => {
		vi.useFakeTimers();
		const response = controlledMessagesStream();
		const started = messageStartConsumed();
		const seen: string[] = [];
		const result = streamSimple(copilotClaude(), userTurn, {
			apiKey: "test-key",
			maxRetries: 0,
			streamDeadlineMs: DEADLINE_MS,
			fetch: response.fetch,
			onProviderStreamEvent: (event) => {
				seen.push((event as { type: string }).type);
				started.onEvent(event);
			},
		}).result();

		response.send(messageStart);
		await started.promise;
		for (let pingIndex = 0; pingIndex < PING_COUNT; pingIndex++) {
			await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
			response.send(ping);
			await vi.advanceTimersByTimeAsync(0);
		}
		await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
		response.send(messageDelta);
		response.send(messageStop);
		response.close();
		const message = await result;

		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.deepEqual(seen, ["message_start", "message_delta", "message_stop"]);
		assert.ok(PING_INTERVAL_MS * (PING_COUNT + 1) > DEADLINE_MS);
	});

	it("still ends a response that goes silent, as a stream that ended early (#4626)", async () => {
		vi.useFakeTimers();
		const response = controlledMessagesStream();
		const started = messageStartConsumed();
		const result = streamSimple(copilotClaude(), userTurn, {
			apiKey: "test-key",
			maxRetries: 0,
			streamDeadlineMs: DEADLINE_MS,
			fetch: response.fetch,
			onProviderStreamEvent: started.onEvent,
		}).result();

		response.send(messageStart);
		await started.promise;
		response.send(ping);
		await vi.advanceTimersByTimeAsync(DEADLINE_MS);
		const message = await result;

		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage ?? "", /stream deadline exceeded/);
		const error = getGitHubCopilotError(message);
		assert.ok(error instanceof GitHubCopilotStreamEndedEarlyError, message.errorMessage);
		assert.equal(error.durationMs, DEADLINE_MS);
		assert.equal(error.startedContent, true);
	});
});
