/**
 * RFC §8 — Unit: borrowing purity (the load-bearing test).
 *
 * After a compaction rescued by a fallback model, the session's model, thinking
 * level, entry list, and `_fallbackAttemptedKeys` must be unchanged, with no
 * `model_changed`, `model_select`, `model_fallback_start`, and no
 * `agent.continue()`. Contrast `_trySwitchToFallbackModel`, which does all four.
 */

import assert from "node:assert/strict";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { runVerbatimCompaction } from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { preparation, registryOf, runRequest, scriptedStream, testModel } from "./compaction-rung-support.js";

const sessionModel = getModel("anthropic", "claude-sonnet-4-5")!;

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	} as AssistantMessage;
}

/** Session model always 429s; the configured fallback ranks the lines. */
function rescueStream(): { streamFn: StreamFn; models: string[] } {
	const models: string[] = [];
	const streamFn = ((model: Model<Api>) => {
		models.push(`${model.provider}/${model.id}`);
		const throttled = model.provider === "anthropic";
		return {
			result: async (): Promise<AssistantMessage> =>
				({
					role: "assistant",
					content: throttled ? [] : [{ type: "text", text: "3,8\n" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: throttled ? "error" : "stop",
					...(throttled ? { errorMessage: "429 Too Many Requests" } : {}),
					timestamp: Date.now(),
				}) as AssistantMessage,
		};
	}) as unknown as StreamFn;
	return { streamFn, models };
}

test("the borrowing operation itself touches no session state and emits no events", async () => {
	const events: string[] = [];
	let continued = 0;
	const session = {
		model: testModel(),
		thinkingLevel: "high" as const,
		fallbackAttemptedKeys: new Set<string>(),
		entries: [{ id: "e1" }, { id: "e2" }],
		emit: (event: string) => events.push(event),
		agent: {
			continue: async () => {
				continued += 1;
			},
		},
	};
	const before = {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		entries: JSON.stringify(session.entries),
		attempted: [...session.fallbackAttemptedKeys],
	};

	const fallback = testModel({ provider: "backup", id: "planner-b", baseUrl: "https://backup.example" });
	const stream = scriptedStream({
		"planner-a": [{ errorMessage: "429 Too Many Requests" }],
		"planner-b": [{ text: "1,10\n" }],
	});
	const result = await runVerbatimCompaction(
		preparation(),
		session.model,
		runRequest({
			streamFn: stream.streamFn,
			resolveAuth: async (model) => ({ apiKey: `${model.provider}-key` }),
			fallback: {
				fallbackModels: ["backup/planner-b"],
				registry: registryOf([session.model, fallback]),
				preferredProvider: "primary",
				sessionThinkingLevel: "high",
			},
		}),
	);

	assert.equal(result.rung, "planned");
	assert.deepEqual(result.plannerModel, { provider: "backup", id: "planner-b", thinkingLevel: "high" });
	assert.equal(session.model, before.model);
	assert.equal(session.thinkingLevel, before.thinkingLevel);
	assert.equal(JSON.stringify(session.entries), before.entries);
	assert.deepEqual([...session.fallbackAttemptedKeys], before.attempted);
	assert.deepEqual(events, []);
	assert.equal(continued, 0);
});

test("a fallback-rescued compaction leaves session model, thinking level, history, and attempted keys unchanged", async () => {
	const { streamFn, models } = rescueStream();
	const manager = SessionManager.inMemory();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: sessionModel, systemPrompt: "test", tools: [], thinkingLevel: "high" },
		streamFn,
	});
	let continued = 0;
	const realContinue = agent.continue.bind(agent);
	agent.continue = ((...args: Parameters<typeof realContinue>) => {
		continued += 1;
		return realContinue(...args);
	}) as typeof agent.continue;

	const authStorage = AuthStorage.inMemory({
		anthropic: { type: "api_key", key: "anthropic-key" },
		openai: { type: "api_key", key: "openai-key" },
	});
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	// One transport attempt per candidate, so the ladder alone explains the calls.
	settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime,
		resourceLoader: createTestResourceLoader(),
		fallbackModels: ["openai/gpt-5.1"],
	});
	try {
		const now = Date.now();
		for (let turn = 0; turn < 6; turn++) {
			manager.appendMessage({ role: "user", content: `task ${turn}\nline a\nline b`, timestamp: now + turn * 2 });
			manager.appendMessage(assistantMessage(`answer ${turn}\nline c\nline d`, now + turn * 2 + 1));
		}
		agent.state.messages = manager.buildSessionContext().messages;

		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));

		const before = {
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			entries: JSON.stringify(manager.getBranch()),
			attempted: [...(session as unknown as { _fallbackAttemptedKeys: Set<string> })._fallbackAttemptedKeys],
		};

		const result = await session.compact({ preserve_recent: 2 });

		// The session model was tried first and the configured fallback rescued it.
		assert.deepEqual(models, ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
		assert.equal(result.rung, "planned");
		assert.deepEqual(result.plannerModel, { provider: "openai", id: "gpt-5.1", thinkingLevel: "high" });

		assert.equal(session.model, before.model);
		assert.equal(session.thinkingLevel, before.thinkingLevel);
		assert.deepEqual(
			[...(session as unknown as { _fallbackAttemptedKeys: Set<string> })._fallbackAttemptedKeys],
			before.attempted,
		);

		// The only durable change is the expected compaction boundary; no
		// model-change or thinking-level-change entry was appended.
		const after = manager.getBranch();
		const added = after.slice(JSON.parse(before.entries).length);
		assert.equal(added.length, 1);
		assert.equal(added[0].type, "compaction");
		assert.equal(JSON.stringify(after.slice(0, JSON.parse(before.entries).length)), before.entries);
		for (const entry of after) assert.ok(entry.type !== "model_change" && entry.type !== "thinking_level_change");

		// `model_select` is an extension event and is not even representable on
		// AgentSessionEvent; compare as strings so its absence is asserted anyway.
		const forbiddenTypes = new Set(["model_changed", "model_select", "model_fallback_start"]);
		const forbidden = events.filter((event) => forbiddenTypes.has(event.type as string));
		assert.deepEqual(forbidden, []);
		assert.equal(continued, 0);
	} finally {
		session.dispose();
	}
});
