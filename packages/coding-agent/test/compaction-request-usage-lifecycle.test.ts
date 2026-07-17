import { Agent } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { bindAssistantUsageToRequest, providerPromptOccupancy } from "../src/core/agent-session-request-usage.ts";
import type { CompactionRequestPrefix } from "../src/core/compaction/compaction-types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model: Model<Api> = {
	id: "usage-lifecycle", name: "Usage Lifecycle", api: "anthropic-messages", provider: "anthropic",
	baseUrl: "https://example.com", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 60_000, maxTokens: 8_192,
};

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 50_000, output: 77_777, cacheRead: 50_000, cacheWrite: 0, totalTokens: 177_777,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...overrides,
	};
}

function streamWithUsage(requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const native = {
		system: context.systemPrompt,
		messages: context.messages.map((message) => ({ role: message.role, content: message.content })),
		max_tokens: options?.maxTokens ?? requestModel.maxTokens,
	};
	const stream = createAssistantMessageEventStream();
	void Promise.resolve(options?.onPayload?.(native, requestModel)).then(() => {
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text: "done" }], api: requestModel.api,
			provider: requestModel.provider, model: requestModel.id, usage: usage(), stopReason: "stop", timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

describe("request-bound compaction occupancy", () => {
	const sessions: AgentSession[] = [];
	afterEach(() => { while (sessions.length > 0) sessions.pop()!.dispose(); });

	it("keeps matching prompt occupancy for public threshold auto-compaction after agent_end clears the assistant", async () => {
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey(model.provider, "test-key");
		const manager = SessionManager.inMemory();
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key", sessionId: manager.getSessionId(),
				initialState: { model, systemPrompt: "active instructions", tools: [] },
				streamFn: streamWithUsage,
			}),
			sessionManager: manager, settingsManager: SettingsManager.inMemory(), cwd: process.cwd(),
			modelRegistry: ModelRegistry.create(auth), resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		let prefixAtCompaction: CompactionRequestPrefix | undefined;
		(session as unknown as { _applyVerbatimCompaction: () => Promise<undefined> })._applyVerbatimCompaction = async () => {
			prefixAtCompaction = (session as unknown as { _activeRequestPrefix?: CompactionRequestPrefix })._activeRequestPrefix;
			expect((session as unknown as { _lastAssistantMessage?: AssistantMessage })._lastAssistantMessage).toBeUndefined();
			return undefined;
		};

		await session.prompt("trigger threshold compaction");

		expect(prefixAtCompaction?.providerInputTokens).toBe(100_000);
	});
	it("invalidates prior occupancy when a new request starts and ignores a mismatched assistant", async () => {
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey(model.provider, "test-key");
		const manager = SessionManager.inMemory();
		let session: AgentSession;
		let call = 0;
		const prefixDuringTransport: Array<CompactionRequestPrefix | undefined> = [];
		const streamFn = async (requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			const native = { messages: context.messages, max_tokens: requestModel.maxTokens };
			await options?.onPayload?.(native, requestModel);
			prefixDuringTransport.push((session as unknown as { _activeRequestPrefix?: CompactionRequestPrefix })._activeRequestPrefix);
			const stream = createAssistantMessageEventStream();
			const current = call++;
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant", content: [{ type: "text", text: "done" }],
					api: current === 0 ? requestModel.api : "openai-responses",
					provider: current === 0 ? requestModel.provider : "other-provider",
					model: current === 0 ? requestModel.id : "other-model",
					usage: usage(), stopReason: "stop", timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", sessionId: manager.getSessionId(), initialState: { model, systemPrompt: "active", tools: [] }, streamFn }),
			sessionManager: manager, settingsManager: SettingsManager.inMemory(), cwd: process.cwd(),
			modelRegistry: ModelRegistry.create(auth), resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		(session as unknown as { _applyVerbatimCompaction: () => Promise<undefined> })._applyVerbatimCompaction = async () => undefined;

		await session.prompt("first request");
		expect((session as unknown as { _activeRequestPrefix?: CompactionRequestPrefix })._activeRequestPrefix?.providerInputTokens).toBe(100_000);
		await session.prompt("second request");

		expect(prefixDuringTransport[1]?.providerInputTokens).toBeUndefined();
		expect((session as unknown as { _activeRequestPrefix?: CompactionRequestPrefix })._activeRequestPrefix?.providerInputTokens).toBeUndefined();
	});

	it("normalizes and sums each prompt cache partition exactly once while excluding output", () => {
		expect(providerPromptOccupancy(usage({ input: 10.9, cacheRead: 20.8, cacheWrite: 30.7, output: 999_999 }))).toBe(60);
		expect(providerPromptOccupancy(usage({ input: -1, cacheRead: Number.NaN, cacheWrite: Number.POSITIVE_INFINITY, output: 999_999 }))).toBe(0);
	});

	it("ignores stale generations and synthetic assistants without a captured stream identity", () => {
		const prefix: CompactionRequestPrefix = {
			requestGeneration: 2,
			identity: { api: model.api, provider: model.provider, model: model.id, baseUrl: model.baseUrl, sessionId: "session" },
			messages: [], finalPayload: { messages: [] },
		};
		const message: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: usage(), stopReason: "stop", timestamp: Date.now(),
		};
		expect(bindAssistantUsageToRequest(prefix, 1, message, "session")).toBe(prefix);
		expect(bindAssistantUsageToRequest(prefix, undefined, message, "session")).toBe(prefix);
		expect(prefix.providerInputTokens).toBeUndefined();
	});

	it("keeps matching prompt occupancy for public overflow auto-compaction after assistant clearing", async () => {
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey(model.provider, "test-key");
		const manager = SessionManager.inMemory();
		const overflowStream = async (requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			await options?.onPayload?.({ messages: context.messages, max_tokens: requestModel.maxTokens }, requestModel);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant", content: [], api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
					usage: usage(), stopReason: "error", errorMessage: "context_length_exceeded", timestamp: Date.now(),
				};
				stream.push({ type: "error", reason: "error", error: message });
			});
			return stream;
		};
		const session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", sessionId: manager.getSessionId(), initialState: { model, systemPrompt: "active", tools: [] }, streamFn: overflowStream }),
			sessionManager: manager, settingsManager: SettingsManager.inMemory(), cwd: process.cwd(),
			modelRegistry: ModelRegistry.create(auth), resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		let prefixAtCompaction: CompactionRequestPrefix | undefined;
		(session as unknown as { _applyVerbatimCompaction: () => Promise<undefined> })._applyVerbatimCompaction = async () => {
			prefixAtCompaction = (session as unknown as { _activeRequestPrefix?: CompactionRequestPrefix })._activeRequestPrefix;
			expect((session as unknown as { _lastAssistantMessage?: AssistantMessage })._lastAssistantMessage).toBeUndefined();
			return undefined;
		};

		await session.prompt("trigger overflow compaction");
		expect(prefixAtCompaction?.providerInputTokens).toBe(100_000);
	});

});
