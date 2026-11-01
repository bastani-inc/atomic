import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AuthStorage, ModelRuntime, SettingsManager } from "@bastani/atomic";
import { workflow } from "@bastani/atomic/workflows";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";

/** What the stage's background shell prints before it waits to be stopped. */
export const POOL_HEARTBEAT_SHELL_OUTPUT = "pooled-heartbeat-shell";
/** Heartbeat cadence the stage asks for on both launches: the shortest a caller may choose. */
export const POOL_HEARTBEAT_MS = 60_000;
const CHILD_SYSTEM_PROMPT = "You are the pooled heartbeat child.";

const CHILD_AGENT = `---
name: heartbeat-child
description: Holds its turn until the test releases it.
model: pool-fixture/fixture
tools: read
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
---
${CHILD_SYSTEM_PROMPT}
`;

/**
 * A pooled child whose agent stage starts a background shell and a background subagent, each with a one-minute task
 * heartbeat, then holds its turn (and the subagent holds its own) until the test creates `gatePath`. A test watches the
 * stage from the root for the heartbeat its own session receives on the worker.
 */
export const child = workflow({
	name: "pool-task-heartbeat-child",
	description: "Local worker stage whose background shell and subagent heartbeat",
	inputs: { gatePath: Type.String() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const cwd = ctx.cwd!;
		// Subagent children run a stub session under a test NODE_ENV; this child must run a real one on this worker.
		process.env.NODE_ENV = "development";
		mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", "agents", "heartbeat-child.md"), CHILD_AGENT);
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const released = (signal?: AbortSignal) => existsSync(ctx.inputs.gatePath) || signal?.aborted === true;
		modelRuntime.registerProvider("pool-fixture", {
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			apiKey: "fixture",
			models: [
				{
					id: "fixture",
					name: "Fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100000,
					maxTokens: 1000,
				},
			],
			streamSimple(model, context, streamOptions) {
				const stream = createAssistantMessageEventStream();
				const reply = (content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage => ({
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content,
					stopReason,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
				const launched = context.messages.some((message) => message.role === "toolResult");
				// The child's system prompt arrives as its first transcript message.
				const isChild = JSON.stringify(context.messages).includes(CHILD_SYSTEM_PROMPT);
				void (async () => {
					if (!isChild && !launched) {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: reply(
								[
									{
										type: "toolCall",
										id: "shell-call",
										name: "bash",
										arguments: {
											command: `echo ${POOL_HEARTBEAT_SHELL_OUTPUT}; sleep 600`,
											wait: { kind: "background" },
											timeout: 600,
											heartbeatMs: POOL_HEARTBEAT_MS,
										},
									},
									{
										type: "toolCall",
										id: "subagent-call",
										name: "subagent",
										arguments: {
											agent: "heartbeat-child",
											task: "Hold until released.",
											context: "fresh",
											wait: { kind: "background" },
											heartbeatMs: POOL_HEARTBEAT_MS,
										},
									},
								],
								"toolUse",
							),
						});
						stream.end();
						return;
					}
					// The stage and its subagent both hold their turns while the test waits for heartbeats.
					while (!released(streamOptions?.signal)) await delay(25);
					stream.push({ type: "done", reason: "stop", message: reply([{ type: "text", text: "done" }], "stop") });
					stream.end();
				})();
				return stream;
			},
		});
		const stage = ctx.stage("agent", {
			cwd,
			agentDir: cwd,
			modelRuntime,
			model: modelRuntime.getModel("pool-fixture", "fixture")!,
			settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } }),
			builtins: { workflows: false, subagents: true, mcp: false, intercom: false, "web-access": false },
		} as never);
		return { text: await stage.complete("Start the build and the helper in the background") };
	},
});
