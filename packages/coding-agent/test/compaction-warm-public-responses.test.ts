import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Transport,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import type { CompactionRequestPrefix } from "../src/core/compaction/compaction-types.ts";
import { runFullCollapseCompaction } from "../src/core/compaction/compaction-runner.ts";
import { prepareFullCollapseBoundary } from "../src/core/compaction/full-collapse-boundary.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const model: Model<Api> = {
	id: "gpt-5.6", name: "Public Responses", api: "openai-responses", provider: "openai",
	baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8_192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function providerItems(messages: Context["messages"]): Array<Record<string, unknown>> {
	return messages.map((message) => ({
		role: message.role,
		content: [{
			type: message.role === "user" ? "input_text" : "output_text",
			text: Array.isArray(message.content) && message.content[0]?.type === "text" ? message.content[0].text : "",
		}],
	}));
}

function assistant(text: string): AgentMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 2,
	};
}

describe("public Responses warm restoration", () => {
	it.each(["sse", "websocket"] as const)("recognizes the leading developer item and preserves %s routing", async (transport: Transport) => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `source-${index}`).join("\n") }], timestamp: 1 });
		manager.appendMessage(assistant("protected assistant"));
		const preparation = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 })!;
		const messages = convertToLlm(manager.buildSessionContext().messages);
		const historical = providerItems(messages);
		((historical.at(-1)!.content as Array<Record<string, unknown>>)[0]).prompt_cache_breakpoint = { mode: "explicit" };
		const prefix: CompactionRequestPrefix = {
			identity: { api: model.api, provider: model.provider, model: model.id, baseUrl: model.baseUrl, sessionId: "public-session", transport },
			systemPrompt: "public system", messages, sessionId: "public-session", transport,
			finalPayload: { model: model.id, input: [{ role: "developer", content: "public system" }, ...historical], stream: true, store: false, prompt_cache_key: "public-session", max_output_tokens: 8_192 },
		};
		const payloads: Array<Record<string, unknown>> = [];
		const transports: Array<Transport | undefined> = [];
		const streamFn = async (_requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			const candidate = {
				model: model.id, input: [{ role: "developer", content: "public system" }, ...providerItems(context.messages)],
				stream: true, store: false, prompt_cache_key: options?.sessionId, max_output_tokens: options?.maxTokens,
			};
			payloads.push(await options?.onPayload?.(candidate, model) as Record<string, unknown> ?? candidate);
			transports.push(options?.transport);
			const keep = `KEEP ${[1, ...(preparation.region.protectedLineNumbers ?? [])].join(",")}`;
			const response: AssistantMessage = {
				role: "assistant", content: [{ type: "text", text: keep }], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 1, output: 1, cacheRead: 777, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => { stream.push({ type: "start", partial: { ...response, content: [] } }); stream.push({ type: "done", reason: "stop", message: response }); });
			return stream;
		};

		const result = await runFullCollapseCompaction(preparation, model, "key", undefined, undefined, "off", { streamFn, prefix });
		expect(payloads).toHaveLength(1);
		expect((payloads[0].input as unknown[])[0]).toEqual({ role: "developer", content: "public system" });
		expect(JSON.stringify((payloads[0].input as unknown[])[2])).toContain("prompt_cache_breakpoint");
		expect(payloads[0].input).toHaveLength(historical.length + 2);
		expect(transports).toEqual([transport]);
		expect(result.cache).toMatchObject({ cacheHit: true, cacheReadTokens: 777 });
	});
});
