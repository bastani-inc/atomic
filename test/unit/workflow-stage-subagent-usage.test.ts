/**
 * A subagent a stage launches makes model calls of its own. They are the stage's spend, so the stage's attempt usage
 * and the run budget charge them once. A real workflow run, a real stage AgentSession and a real in-process child
 * session against a local provider; no network is contacted.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Message } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { AuthStorage, ModelRuntime, SettingsManager } from "../../packages/coding-agent/src/index.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const REAL_SESSIONS_TIMEOUT_MS = 120_000;
const PROVIDER_KEY = "local-provider-key-5053";
const STAGE_PROMPT = "Delegate the fixture task.";

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

function firstUserText(messages: readonly Message[]): string {
	const user = messages.find((message) => message.role === "user");
	if (!user) return "";
	return typeof user.content === "string"
		? user.content
		: user.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function reply(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	content: AssistantMessage["content"],
	cost: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

describe("subagent usage inside a stage (#5053)", () => {
	test(
		"a subagent's model calls are charged to the stage that launched it (#5053)",
		async () => {
			const directory = makeTempDirectory("stage-subagent-usage-5053-");
			directories.push(directory);
			const agentDir = join(directory, "agent-home");
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			writeFileSync(
				join(agentDir, "agents", "plain-worker.md"),
				"---\nname: plain-worker\ndescription: Fixture worker.\nsystemPromptMode: replace\ntools: read\nmodel: p/m\n---\n\nAnswer briefly.\n",
			);
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
			// Subagent children are test doubles under NODE_ENV=test; this one must be a real session.
			vi.stubEnv("NODE_ENV", "development");

			const spent: Array<{ caller: "stage" | "child"; cost: number }> = [];
			let stageCalls = 0;
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({ p: { type: "api_key", key: PROVIDER_KEY } }),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider("p", {
				api: "openai-completions",
				baseUrl: "https://example.invalid",
				apiKey: PROVIDER_KEY,
				models: [spec],
				streamSimple: (model, context) => {
					const stream = createAssistantMessageEventStream();
					const caller = firstUserText(context.messages).startsWith(STAGE_PROMPT) ? "stage" : "child";
					const stageCall = caller === "stage" ? stageCalls++ : -1;
					// The stage launches the child, then waits for it by the task id its launch returned.
					const launchedTaskId = /"taskId":"([^"]+)"/.exec(
						context.messages
							.flatMap((entry) =>
								entry.role === "toolResult"
									? entry.content.map((block) => (block.type === "text" ? block.text : ""))
									: [],
							)
							.join("\n"),
					)?.[1];
					const message =
						caller === "child"
							? reply(model, [{ type: "text", text: "child done" }], 2)
							: stageCall === 0
								? reply(
										model,
										[
											{
												type: "toolCall",
												id: "delegate",
												name: "subagent",
												arguments: {
													agent: "plain-worker",
													task: "Inspect the fixture and report.",
													context: "fresh",
													output: false,
													progress: false,
												},
											},
										],
										1,
									)
								: stageCall === 1 && launchedTaskId
									? reply(
											model,
											[
												{
													type: "toolCall",
													id: "wait",
													name: "subagent",
													arguments: { action: "wait", id: launchedTaskId, budgetMs: 60_000 },
												},
											],
											1,
										)
									: reply(model, [{ type: "text", text: "stage done" }], 1);
					spent.push({ caller, cost: message.usage.cost.total });
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
					stream.end(message);
					return stream;
				},
			});

			const store = createStore();
			const definition = workflow({
				name: "stage-subagent-usage",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx
						.stage("delegate", {
							model: modelRuntime.getModel("p", "m")!,
							modelRuntime,
							agentDir: join(directory, "stage-agent"),
							settingsManager: SettingsManager.inMemory({
								retry: { enabled: false },
								compaction: { enabled: false },
							}),
							builtins: { workflows: false, subagents: true, intercom: false, mcp: false, "web-access": false },
						})
						.prompt(STAGE_PROMPT);
					return {};
				},
			});
			const result = await run(definition, {}, { store, cwd: directory });

			assert.equal(result.status, "completed", result.error);
			assert.ok(
				spent.some((call) => call.caller === "child"),
				"the subagent made a model call",
			);
			const stage = store.runs()[0]?.stages.find((candidate) => candidate.name === "delegate");
			const charged = (stage?.modelAttempts ?? []).reduce((sum, attempt) => sum + (attempt.usage?.cost ?? 0), 0);
			assert.equal(
				charged,
				spent.reduce((sum, call) => sum + call.cost, 0),
				`spent ${JSON.stringify(spent)}`,
			);
		},
		REAL_SESSIONS_TIMEOUT_MS,
	);
});
