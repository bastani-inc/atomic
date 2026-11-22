import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { lazyApi } from "../src/api/lazy.ts";
import { getApiProvider } from "../src/compat.ts";
import type { Api, AssistantMessage, Model, ProviderStreams } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const PREWARM_SYMBOL = Symbol.for("@bastani/atomic-ai/api-prewarm");

type Prewarmable = { [PREWARM_SYMBOL]?: () => Promise<void> };

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "test-model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

function okStreams(): ProviderStreams {
	const reply = (m: Model<Api>) => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: m.api,
			provider: m.provider,
			model: m.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const s = new AssistantMessageEventStream();
		s.push({ type: "done", reason: "stop", message });
		s.end(message);
		return s;
	};
	return { stream: reply, streamSimple: reply };
}

describe("lazyApi prewarm hook", () => {
	it("exposes a non-enumerable prewarm hook that invokes load before the first request", async () => {
		let loads = 0;
		const api = lazyApi(async () => {
			loads += 1;
			return okStreams();
		});

		assert.deepEqual(Object.keys(api), ["stream", "streamSimple"]);
		const prewarm = (api as Prewarmable)[PREWARM_SYMBOL];
		assert.equal(typeof prewarm, "function");
		await prewarm!();
		assert.equal(loads, 1);

		const result = await api.streamSimple(model, context).result();
		assert.equal(result.stopReason, "stop");
		assert.equal(loads, 1);
	});

	it("swallows prewarm load rejection without poisoning a subsequent real stream request", async () => {
		let attempts = 0;
		const api = lazyApi(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient load failure");
			return okStreams();
		});

		const prewarm = (api as Prewarmable)[PREWARM_SYMBOL];
		assert.equal(typeof prewarm, "function");
		await assert.doesNotReject(() => prewarm!());
		assert.equal(attempts, 1);

		const result = await api.streamSimple(model, context).result();
		assert.equal(attempts, 2);
		assert.equal(result.stopReason, "stop");
	});

	it("preserves the prewarm hook on builtin API providers registered in compat", () => {
		const provider = getApiProvider("openai-completions") as Prewarmable | undefined;
		assert.ok(provider);
		assert.equal(typeof provider[PREWARM_SYMBOL], "function");
	});
});
