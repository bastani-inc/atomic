import assert from "node:assert/strict";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import type { AgentSessionAdapter } from "./stage-runner-helpers.js";

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1000,
};
const TOKENS_PER_CALL = 5;

/** Until the 10th call, every response asks to read a file, so the stage's turn keeps calling the model. */
function reply(model: { api: AssistantMessage["api"]; provider: string; id: string }, call: number) {
	const stream = createAssistantMessageEventStream();
	const toolTurn = call < 10;
	const message: AssistantMessage = {
		role: "assistant",
		content: toolTurn
			? [{ type: "toolCall", id: `t${call}`, name: "read", arguments: { path: "package.json" } }]
			: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: TOKENS_PER_CALL,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: TOKENS_PER_CALL,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolTurn ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
	stream.end(message);
	return stream;
}

const sessions: StageSessionRuntime[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

describe("token cap inside a stage's turn (#5053)", () => {
	test("a stage's tool loop stops after the model call that reaches the cap, then wraps up once (#5053)", async () => {
		let calls = 0;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
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
					streamSimple: (model) => reply(model, ++calls),
				});
				const { session } = await createAgentSession({
					cwd: process.cwd(),
					agentDir: process.cwd(),
					builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
					modelRuntime,
					model: modelRuntime.getModel("p", "m")!,
					fallbackModels: options.fallbackModels,
					settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
					sessionManager: SessionManager.inMemory(),
					resourceLoader: createTestResourceLoader(),
				});
				sessions.push(session as unknown as StageSessionRuntime);
				return session as unknown as StageSessionRuntime;
			},
		};
		const definition = workflow({
			name: "in-turn-cap",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("explore", { model: "p/m" }).prompt("look around");
				return { result: "done" };
			},
		});
		const store = createStore();
		const backend = await createMemoryTestBackend();
		const options = (maxTokens: number) => ({
			runId: "in-turn-cap",
			store,
			durableBackend: backend,
			budget: { maxTokens },
			adapters: { agentSession },
		});

		const result = await run(definition, {}, options(10));

		// Call 2 reaches the 10-token cap: its read is cancelled, the turn ends, and call 3 is the wrap-up.
		assert.equal(calls, 3);
		assert.equal((result.result as { status?: string } | undefined)?.status, "budget_exceeded");
		assert.equal(store.runs()[0]?.budgetState?.accounting?.tokens, 3 * TOKENS_PER_CALL);
		const toolResults = sessions[0]!.messages.filter((message) => message.role === "toolResult");
		assert.deepEqual(
			toolResults.map((message) => [message.toolCallId, message.isError]),
			[
				["t1", false],
				["t2", true],
				["t3", true],
			],
		);
		const cancelled = toolResults[1]!.content[0];
		assert.equal(
			cancelled?.type === "text" ? cancelled.text : undefined,
			"Cancelled: the workflow budget is exhausted",
		);

		// The stop held only for the stage's call: the session's own later turns run their tool loop again.
		await sessions[0]!.prompt("once more");
		assert.equal(calls, 10, "the next turn called the model until it answered without a tool call");

		const resumed = await run(definition, {}, options(1000));
		assert.equal(resumed.status, "completed", "the stopped run resumes under a raised budget");
	});
});
