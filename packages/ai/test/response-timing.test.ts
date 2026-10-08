import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { lazyStream } from "../src/api/lazy.js";
import { getBuiltinModel } from "../src/providers/all.js";
import type { AssistantMessage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function message(timestamp = Date.now(), durationMs?: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
		...(durationMs === undefined ? {} : { durationMs }),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("AssistantMessageEventStream timing", () => {
	it.each(["done", "error", "end"] as const)("times the final %s message with a monotonic clock", async (completion) => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const clock = vi.spyOn(performance, "now").mockReturnValue(100);
		const stream = new AssistantMessageEventStream();
		const result = message();
		clock.mockReturnValue(125.6);
		vi.mocked(Date.now).mockReturnValue(500);
		if (completion === "done") stream.push({ type: "done", reason: "stop", message: result });
		else if (completion === "error") stream.push({ type: "error", reason: "error", error: result });
		else stream.end(result);
		assert.equal((await stream.result()).durationMs, 26);
		assert.equal(result.timestamp, 1000);
	});

	it("preserves inner stream timing when forwarding a final message", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const clock = vi.spyOn(performance, "now").mockReturnValue(100);
		const outer = new AssistantMessageEventStream();
		clock.mockReturnValue(150);
		const inner = new AssistantMessageEventStream();
		const result = message();
		clock.mockReturnValue(160);
		inner.push({ type: "done", reason: "stop", message: result });
		clock.mockReturnValue(200);
		outer.push({ type: "done", reason: "stop", message: result });
		assert.equal((await outer.result()).durationMs, 10);
	});

	it("preserves existing timing and leaves fetched deferred results untimed", () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const preset = message(1000, 1234);
		new AssistantMessageEventStream().end(preset);
		assert.equal(preset.durationMs, 1234);
		const fetched = message(999);
		new AssistantMessageEventStream().push({ type: "done", reason: "stop", message: fetched });
		assert.equal(fetched.durationMs, undefined);
	});

	it("does not time final messages after completion", () => {
		const stream = new AssistantMessageEventStream();
		stream.end(message());
		const late = message();
		stream.push({ type: "done", reason: "stop", message: late });
		stream.end(late);
		assert.equal(late.durationMs, undefined);
	});

	it("clamps a negative elapsed clock reading to zero", () => {
		const clock = vi.spyOn(performance, "now").mockReturnValue(100);
		const stream = new AssistantMessageEventStream();
		clock.mockReturnValue(99);
		const result = message();
		stream.end(result);
		assert.equal(result.durationMs, 0);
	});

	it("keeps request-start timestamp and timing when lazy setup fails", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const clock = vi.spyOn(performance, "now").mockReturnValue(100);
		const stream = lazyStream(getBuiltinModel("openai", "gpt-6-luna"), async () => {
			vi.mocked(Date.now).mockReturnValue(2000);
			clock.mockReturnValue(175);
			throw new Error("setup failed");
		});
		const result = await stream.result();
		assert.equal(result.timestamp, 1000);
		assert.equal(result.durationMs, 75);
		assert.equal(result.errorMessage, "setup failed");
	});
});
