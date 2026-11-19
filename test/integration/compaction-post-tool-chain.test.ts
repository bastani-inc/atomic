/**
 * Integration: the post-tool clear, driven through the real prompt/tool/provider sequence rather than by calling
 * preflight directly. A mid-turn compaction makes no model call: it writes one boundary after the whole tool batch,
 * the next request carries exactly the system prompt and one `Context cleared` message, the turn finishes with one
 * follow-up chat request, and no `agent.continue()` is scheduled.
 */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Agent, type AgentTool, type StreamFn } from "@bastani/atomic-agent-core";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import { getModel } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
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
	/** The messages of every model request, in order. */
	requests: Array<Array<{ role: string; content?: unknown }>>;
}

/** Records every model request; compaction must add none of its own. */
function recordingStream(traffic: Traffic): StreamFn {
	const chat = createFauxStreamFn([
		{
			toolCalls: [{ id: "call-1", name: "large_result", args: {} }],
			usage: { input: 900, output: 20, totalTokens: 920 },
		},
		"completed after compaction",
	]);
	return ((model: Model<Api>, context: { messages?: Array<{ role: string }> }, options?: unknown) => {
		traffic.requests.push(structuredClone(context.messages ?? []));
		return chat.streamFn(model as never, context as never, options as never);
	}) as unknown as StreamFn;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return (content as Array<{ type: string; text?: string }>)
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

test("post-tool preflight clears the context with no model call and the turn finishes on one follow-up request", async () => {
	initTheme("dark");
	const traffic: Traffic = { requests: [] };
	const model = { ...SESSION_MODEL, contextWindow: 2_000 } as Model<Api>;
	const manager = SessionManager.inMemory();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "test", tools: [], thinkingLevel: "high" },
		streamFn: recordingStream(traffic),
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
		compaction: { enabled: true, reserveTokens: 1_200 },
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime,
		resourceLoader: createTestResourceLoader({ systemPrompt: "test" }),
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
		assert.equal(starts.length, 1, JSON.stringify({ traffic, events }));
		assert.equal(starts[0].midTurn, true);

		// 3: no compaction model call: only the two chat requests of the turn reached a provider.
		assert.equal(traffic.requests.length, 2, JSON.stringify(traffic.requests.map((request) => request.length)));

		// 4: one boundary, placed after the whole tool batch, so the call and its result are both behind it.
		// After the clear the live session keeps only the current context window, so read the saved session (one branch).
		const branch = (await manager.getSessionStore().load(manager.getSessionId())).entries;
		const boundaryIndex = branch.findIndex((entry) => entry.type === "compaction");
		assert.ok(boundaryIndex >= 0, "no compaction boundary was persisted");
		const boundary = branch[boundaryIndex] as { summary: string; details?: VerbatimCompactionDetails };
		const before = branch.slice(0, boundaryIndex);
		assert.ok(before.some((entry) => entry.type === "message" && entry.message.role === "toolResult"));
		assert.ok(
			!branch
				.slice(boundaryIndex + 1)
				.some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		);
		const details = boundary.details;
		assert.equal(details?.form, "cleared");
		assert.equal(details?.history?.sessionId, manager.getSessionId());

		// 5: the follow-up request is the system prompt plus one Context cleared message. This agent has neither
		// `read` nor `search`, so the only other thing it sees is the declaration of its own-session history tool.
		const followUp = traffic.requests[1];
		assert.deepEqual(
			followUp.map((message) => message.role),
			["system", "user", "system"],
		);
		const declared = (followUp[2] as { toolsAdded?: Array<{ name: string }> }).toolsAdded ?? [];
		assert.deepEqual(
			declared.map((tool) => tool.name),
			["session_history"],
		);
		assert.equal(textOf(followUp[2].content), "");
		const cleared = textOf(followUp[1].content);
		assert.ok(cleared.startsWith("Context cleared."), cleared);
		assert.ok(cleared.includes(`history://sessions/${manager.getSessionId()}`), cleared);
		assert.ok(cleared.includes("session_history"), cleared);
		assert.equal(cleared, boundary.summary);

		// 6: the boundary line the user sees.
		const rendered = stripVTControlCharacters(
			new CompactionBoundaryMessageComponent({ text: boundary.summary, form: details!.form, stats: details!.stats })
				.render(200)
				.join("\n"),
		);
		assert.match(rendered, /⚛ Context cleared · [\d.,k]+ tokens/u);
		assert.ok(!rendered.includes("degraded"));

		// 7-8: the follow-up request finished the original turn, and no continuation was scheduled.
		assert.equal(session.getLastAssistantText(), "completed after compaction");
		assert.equal(continued, 0);

		const ends = events.filter((event) => event.type === "compaction_end") as Array<{
			midTurn?: boolean;
			errorMessage?: string;
			result?: { form?: string };
		}>;
		assert.equal(ends.length, 1);
		assert.equal(ends[0].midTurn, true);
		assert.equal(ends[0].errorMessage, undefined);
		assert.equal(ends[0].result?.form, "cleared");
	} finally {
		session.dispose();
	}
});
