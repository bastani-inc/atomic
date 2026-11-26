import assert from "node:assert/strict";
import { Agent, type StreamFn } from "@bastani/atomic-agent-core";
import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import { createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { getFixtureModel } from "../helpers/catalog-model-fixtures.ts";

const PRIMARY = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
const FALLBACK = getFixtureModel("openai", "gpt-5.1")!;

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface RecordedRequest {
	model: Parameters<StreamFn>[0];
	options: NonNullable<Parameters<StreamFn>[2]>;
}

function stickyFallbackStream(): { streamFn: StreamFn; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	let primaryFailed = false;
	const streamFn: StreamFn = (model, _context, options) => {
		requests.push({ model, options: options ?? {} });
		const fails = model.provider === PRIMARY.provider && !primaryFailed;
		if (fails) primaryFailed = true;
		const message: AssistantMessage = {
			role: "assistant",
			content: fails ? [] : [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: fails ? ZERO_USAGE : { ...ZERO_USAGE, output: 1, totalTokens: 1 },
			stopReason: fails ? "error" : "stop",
			...(fails ? { errorMessage: "OAuth token invalidated" } : {}),
			timestamp: Date.now(),
		};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push(
				fails ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message },
			),
		);
		return stream;
	};
	return { streamFn, requests };
}

test("a successful main-chat fallback stays selected for the next user prompt", async () => {
	const { streamFn, requests } = stickyFallbackStream();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: PRIMARY, systemPrompt: "test", tools: [], thinkingLevel: "high" },
		streamFn,
	});
	const authStorage = AuthStorage.inMemory({
		anthropic: { type: "api_key", key: "anthropic-key" },
		openai: { type: "api_key", key: "openai-key" },
	});
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } });
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager,
		cwd: process.cwd(),
		modelRuntime,
		resourceLoader: createTestResourceLoader(),
		fallbackModels: [`${FALLBACK.provider}/${FALLBACK.id}:high`],
	});
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));

	try {
		await session.prompt("first prompt");
		assert.equal(session.model?.provider, FALLBACK.provider);
		assert.equal(session.model?.id, FALLBACK.id);
		assert.equal(session.thinkingLevel, "high");

		await session.prompt("second prompt");

		assert.deepEqual(
			requests.map(({ model }) => `${model.provider}/${model.id}`),
			[
				`${PRIMARY.provider}/${PRIMARY.id}`,
				`${FALLBACK.provider}/${FALLBACK.id}`,
				`${FALLBACK.provider}/${FALLBACK.id}`,
			],
		);
		assert.equal(requests[1]?.options.reasoning, "high");
		assert.equal(requests[2]?.options.reasoning, "high");
		assert.equal(session.model?.provider, FALLBACK.provider);
		assert.equal(session.model?.id, FALLBACK.id);
		assert.equal(session.thinkingLevel, "high");
		assert.equal(
			events.some((event) => event.type === "model_changed" && event.source === "restore"),
			false,
		);
		assert.ok(events.some((event) => event.type === "model_fallback_end" && event.success));
	} finally {
		session.dispose();
	}
});

// #3090: auto-router hard constraints still govern the actual session fallback,
// after candidate defaults are resolved and clamped, not just launch preparation.
test("session fallback skips forbidden effort and preserves the allowed candidate's own effort", async () => {
	const { streamFn, requests } = stickyFallbackStream();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: PRIMARY, systemPrompt: "test", tools: [], thinkingLevel: "high" },
		streamFn,
	});
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "synthetic-primary" },
			openai: { type: "api_key", key: "synthetic-fallback" },
		}),
		modelsPath: null,
	});
	const checked: string[] = [];
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } }),
		cwd: process.cwd(),
		modelRuntime: runtime,
		resourceLoader: createTestResourceLoader(),
		fallbackModels: [`${FALLBACK.provider}/${FALLBACK.id}:high`, `${FALLBACK.provider}/${FALLBACK.id}:low`],
		isFallbackModelAllowed: (model, effort) => {
			checked.push(`${model.provider}/${model.id}:${effort}`);
			return effort === "low";
		},
	});
	try {
		await session.prompt("approved task");
		assert.deepEqual(checked, [
			`${FALLBACK.provider}/${FALLBACK.id}:high`,
			`${FALLBACK.provider}/${FALLBACK.id}:low`,
		]);
		assert.equal(requests.length, 2);
		assert.equal(requests[1]?.options.reasoning, "low");
		assert.equal(session.thinkingLevel, "low");
	} finally {
		session.dispose();
	}
});
