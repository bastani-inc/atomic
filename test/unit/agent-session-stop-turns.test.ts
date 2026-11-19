import assert from "node:assert/strict";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1000,
};

/** Every response asks to read a file, so a turn keeps calling the model until something ends it. */
function readReply(model: { api: AssistantMessage["api"]; provider: string; id: string }, call: number) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: `t${call}`, name: "read", arguments: { path: "package.json" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "toolUse", message });
	stream.end(message);
	return stream;
}

const disposals: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
});

async function sessionCountingCalls() {
	const state = { calls: 0 };
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ p: { type: "api_key", key: "x" } }),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("p", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "x",
		models: [spec],
		streamSimple: (model) => readReply(model, ++state.calls),
	});
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		modelRuntime,
		model: modelRuntime.getModel("p", "m")!,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		sessionManager: SessionManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
	});
	disposals.push(() => session.dispose());
	return { session, state };
}

describe("AgentSession.stopTurns (#5053)", () => {
	test("a stopped session cancels the turn's tool calls and starts no further model call, even for a queued follow-up (#5053)", async () => {
		const { session, state } = await sessionCountingCalls();
		let queued = false;
		session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant" || queued) return;
			queued = true;
			session.stopTurns("the budget is spent");
			void session.followUp("and then this");
		});

		await session.prompt("go");

		assert.equal(state.calls, 1, "the model call in flight was the last");
		const results = session.messages.filter((message) => message.role === "toolResult");
		assert.equal(results.length, 1);
		assert.equal(results[0]!.isError, true);
		const content = results[0]!.content[0];
		assert.equal(content?.type === "text" ? content.text : undefined, "Cancelled: the budget is spent");
	});

	test("stopTurns(undefined) lets the next prompt's turn call the model again (#5053)", async () => {
		const { session, state } = await sessionCountingCalls();
		session.stopTurns("stopped");
		session.stopTurns(undefined);
		let stopAfter = 3;
		session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && --stopAfter === 0)
				session.stopTurns("enough");
		});

		await session.prompt("go");

		assert.equal(state.calls, 3, "the turn ran its tool loop until it was stopped");
	});
});
