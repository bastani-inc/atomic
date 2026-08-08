import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { RpcEventBuffer } from "../src/modes/rpc/rpc-event-buffer.ts";
import { RpcOutputBuffer } from "../src/modes/rpc/rpc-output-buffer.ts";
import type { RpcEvent } from "../src/modes/rpc/rpc-types.ts";

/**
 * `RpcOutputBuffer` writes through `writeRawStdout`, so the only way to observe
 * what it emitted is to capture that call. Everything else in `output-guard.ts`
 * stays real.
 */
const rawStdout = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../src/core/output-guard.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/output-guard.ts")>();
	return {
		...actual,
		writeRawStdout: (text: string) => {
			rawStdout.lines.push(text);
		},
	};
});

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** One streaming token, carrying its delta the way `agent-session-events.ts` builds it. */
function messageUpdate(delta: string): RpcEvent {
	const partial = assistantMessage(delta);
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
	};
}

function toolUpdate(toolCallId: string, partialResult: string): RpcEvent {
	return { type: "tool_execution_update", toolCallId, toolName: "bash", args: {}, partialResult };
}

/**
 * A stable one-line rendering of what reached the consumer, so a dropped delta
 * shows up as a missing array entry rather than a deep-equality wall.
 */
function labelOf(event: {
	type?: string;
	toolCallId?: string;
	partialResult?: unknown;
	assistantMessageEvent?: { type?: string; delta?: string };
}): string {
	if (event.type === "message_update") return `msg:${event.assistantMessageEvent?.delta}`;
	if (event.type === "tool_execution_update") return `tool:${event.toolCallId}=${String(event.partialResult)}`;
	return String(event.type);
}

function emittedLabels(events: readonly RpcEvent[]): string[] {
	return events.map((event) => labelOf(event));
}

function writtenLabels(): string[] {
	return rawStdout.lines.map((line) => labelOf(JSON.parse(line)));
}

beforeEach(() => {
	rawStdout.lines.length = 0;
});

/**
 * Both RPC buffers used to coalesce every `message_update` under the constant
 * key `"message"`, keeping only the last event per 16 ms window. That is sound
 * only while the event also carries a cumulative `message` snapshot, which
 * masks the loss because the final snapshot is complete. The deltas in
 * `assistantMessageEvent` were already being discarded.
 *
 * The wire now drops both cumulative snapshots (`modes/json-event.ts`), so a
 * dropped delta is permanently lost assistant text. Pass-through here is what
 * keeps every delta, and `suite/regressions/2221-json-stream-linear.test.ts`
 * is what keeps the resulting per-frame payload small.
 */
describe("RPC buffers preserve message_update deltas", () => {
	test("RpcEventBuffer emits every delta enqueued inside one coalescing window", () => {
		const emitted: RpcEvent[] = [];
		const buffer = new RpcEventBuffer((event) => emitted.push(event));

		buffer.enqueue(messageUpdate("alpha"));
		buffer.enqueue(messageUpdate("beta"));
		buffer.enqueue(messageUpdate("gamma"));
		buffer.dispose();

		expect(emittedLabels(emitted)).toEqual(["msg:alpha", "msg:beta", "msg:gamma"]);
	});

	test("RpcOutputBuffer writes every delta enqueued inside one coalescing window", () => {
		const buffer = new RpcOutputBuffer();

		buffer.output(messageUpdate("alpha"));
		buffer.output(messageUpdate("beta"));
		buffer.output(messageUpdate("gamma"));
		buffer.dispose();

		expect(writtenLabels()).toEqual(["msg:alpha", "msg:beta", "msg:gamma"]);
	});

	test("RpcEventBuffer still coalesces tool_execution_update per toolCallId", () => {
		const emitted: RpcEvent[] = [];
		const buffer = new RpcEventBuffer((event) => emitted.push(event));

		buffer.enqueue(toolUpdate("t1", "a"));
		buffer.enqueue(toolUpdate("t1", "b"));
		buffer.enqueue(toolUpdate("t2", "x"));
		buffer.dispose();

		expect(emittedLabels(emitted)).toEqual(["tool:t1=b", "tool:t2=x"]);
	});

	test("RpcOutputBuffer still coalesces tool_execution_update per toolCallId", () => {
		const buffer = new RpcOutputBuffer();

		buffer.output(toolUpdate("t1", "a"));
		buffer.output(toolUpdate("t1", "b"));
		buffer.output(toolUpdate("t2", "x"));
		buffer.dispose();

		expect(writtenLabels()).toEqual(["tool:t1=b", "tool:t2=x"]);
	});

	test("RpcEventBuffer keeps a message_update ordered against buffered tool updates", () => {
		const emitted: RpcEvent[] = [];
		const buffer = new RpcEventBuffer((event) => emitted.push(event));

		buffer.enqueue(toolUpdate("t1", "a"));
		buffer.enqueue(messageUpdate("alpha"));
		buffer.enqueue(toolUpdate("t1", "b"));
		buffer.dispose();

		expect(emittedLabels(emitted)).toEqual(["tool:t1=a", "msg:alpha", "tool:t1=b"]);
	});

	test("RpcOutputBuffer keeps a message_update ordered against buffered tool updates", () => {
		const buffer = new RpcOutputBuffer();

		buffer.output(toolUpdate("t1", "a"));
		buffer.output(messageUpdate("alpha"));
		buffer.output(toolUpdate("t1", "b"));
		buffer.dispose();

		expect(writtenLabels()).toEqual(["tool:t1=a", "msg:alpha", "tool:t1=b"]);
	});
});
