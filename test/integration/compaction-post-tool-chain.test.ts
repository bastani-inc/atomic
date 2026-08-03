/**
 * RFC §8 — Integration: the load-bearing post-tool chain, driven through the
 * real prompt/tool/provider sequence rather than by calling preflight directly.
 *
 * A mid-turn compaction is the case where failure used to kill an active turn,
 * so this exercises the whole ladder there: primary planner failure, one planner
 * invocation per configured fallback, the fresh boundary, its user-visible
 * notice, exactly one follow-up chat request, and no `agent.continue()`.
 */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { RANGE_PLANNER_SYSTEM_PROMPT } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { CompactionBoundaryMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/compaction-boundary-message.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createFauxStreamFn } from "../../packages/coding-agent/test/test-harness.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";

const SESSION_MODEL = getModel("anthropic", "claude-sonnet-4-5")!;

const largeResultTool: AgentTool = {
	name: "large_result",
	label: "Large result",
	description: "Returns a controlled large result",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "x".repeat(4_000) }], details: {} }),
};

const longPrompt = Array.from({ length: 40 }, (_, index) => `context line ${index + 1}`).join("\n");

interface Traffic {
	planner: string[];
	chat: string[];
}

function message(model: Model<Api>, body: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 900,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 920,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...body,
	} as AssistantMessage;
}

/**
 * One stream function for both lanes. Planner requests are identified by the
 * range-planner system prompt, so chat turns and planner attempts stay countable
 * apart without stubbing the session. The chat lane uses the real faux event
 * stream because the agent loop consumes streamed events, not just `result()`.
 */
function laneStream(traffic: Traffic): StreamFn {
	const chat = createFauxStreamFn([
		{
			toolCalls: [{ id: "call-1", name: "large_result", args: {} }],
			usage: { input: 900, output: 20, totalTokens: 920 },
		},
		"completed after compaction",
	]);
	return ((model: Model<Api>, context: { systemPrompt?: string }, options?: unknown) => {
		const label = `${model.provider}/${model.id}`;
		if (context.systemPrompt === RANGE_PLANNER_SYSTEM_PROMPT) {
			traffic.planner.push(label);
			return { result: async () => message(model, { stopReason: "error", errorMessage: "429 Too Many Requests" }) };
		}
		traffic.chat.push(label);
		return chat.streamFn(model as never, context as never, options as never);
	}) as unknown as StreamFn;
}

test("post-tool preflight: every model fails, the turn still completes on the fresh rung", async () => {
	initTheme("dark");
	const traffic: Traffic = { planner: [], chat: [] };
	const model = { ...SESSION_MODEL, contextWindow: 2_000 } as Model<Api>;
	const manager = SessionManager.inMemory();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "test", tools: [], thinkingLevel: "high" },
		streamFn: laneStream(traffic),
	});
	agent.convertToLlm = convertToLlm;
	let continued = 0;
	const realContinue = agent.continue.bind(agent);
	agent.continue = ((...args: Parameters<typeof realContinue>) => {
		continued += 1;
		return realContinue(...args);
	}) as typeof agent.continue;

	const authStorage = AuthStorage.inMemory(
		Object.fromEntries(
			["anthropic", "openai", "google"].map((provider) => [
				provider,
				{ type: "api_key" as const, key: `${provider}-key` },
			]),
		),
	);
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	settingsManager.applyOverrides({
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		compaction: { enabled: true, reserveTokens: 1_200, compression_ratio: 0.5, preserve_recent: 2 },
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime,
		resourceLoader: createTestResourceLoader(),
		fallbackModels: ["openai/gpt-5.1", "google/gemini-2.5-pro"],
		baseToolsOverride: { large_result: largeResultTool },
	});
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));

	try {
		await session.bindExtensions({});
		session.setActiveToolsByName(["large_result"]);
		await session.prompt(longPrompt);

		// 1-2: the first provider response asked for the tool, and the tool result
		// pushed the prospective context over the threshold mid-turn.
		const starts = events.filter((event) => event.type === "compaction_start") as Array<{ midTurn?: boolean }>;
		assert.equal(starts.length, 1);
		assert.equal(starts[0].midTurn, true);

		// 3-4: the primary failed and each configured fallback got exactly one
		// planner invocation, in configured order.
		assert.deepEqual(traffic.planner, ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1", "google/gemini-2.5-pro"]);

		// 5: all failed, so the boundary is the fresh rung.
		const boundary = manager.getBranch().find((entry) => entry.type === "compaction");
		assert.ok(boundary, "no compaction boundary was persisted");
		const details = (boundary as { details?: VerbatimCompactionDetails }).details;
		assert.equal(details?.rung, "fresh");
		assert.equal(details?.plannerModel, undefined);

		// 6: the rung the user sees says the context was cleared.
		const rendered = stripVTControlCharacters(
			new CompactionBoundaryMessageComponent({
				text: (boundary as { summary?: string }).summary ?? "",
				stats: details!.stats,
				rung: details!.rung,
			})
				.render(200)
				.join("\n"),
		);
		assert.ok(rendered.includes("✻ Context cleared (compaction degraded)"), rendered);

		// 7-8: exactly one follow-up chat request, and it finished the original turn.
		assert.equal(traffic.chat.length, 2);
		assert.equal(session.getLastAssistantText(), "completed after compaction");

		// 9: the mid-turn path never schedules another continuation.
		assert.equal(continued, 0);

		const ends = events.filter((event) => event.type === "compaction_end") as Array<{
			midTurn?: boolean;
			errorMessage?: string;
			result?: { rung?: string };
		}>;
		assert.equal(ends.length, 1);
		assert.equal(ends[0].midTurn, true);
		assert.equal(ends[0].errorMessage, undefined);
		assert.equal(ends[0].result?.rung, "fresh");
	} finally {
		session.dispose();
	}
});
