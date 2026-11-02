import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, ModelRuntime, SettingsManager } from "@bastani/atomic";
import { workflow } from "@bastani/atomic/workflows";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";

/** The command the stage's bash tool runs: it needs one process permit and nothing else. */
export const QUARANTINED_CAPACITY_COMMAND = "true";

/**
 * A pooled child whose agent stage runs one bash command, then ends its turn whatever the command's result was: an
 * admission refusal reaches the model as the tool's error and the stage goes on, as a real stage's would. Each attempt
 * appends a line to `attempts.log` in `directory` when its stage asks for the command.
 */
export const child = workflow({
	name: "pool-quarantined-capacity-child",
	description: "Local worker stage whose bash command needs a process permit",
	inputs: { directory: Type.String() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const cwd = ctx.cwd!;
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		// Registered anew by every attempt, so each attempt's stage asks for the command once, even when it resumes a
		// session that already holds an earlier attempt's tool result.
		let asked = false;
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
			streamSimple(model) {
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
				if (!asked) {
					asked = true;
					appendFileSync(join(ctx.inputs.directory, "attempts.log"), `${process.pid}\n`);
					stream.push({
						type: "done",
						reason: "toolUse",
						message: reply(
							[
								{
									type: "toolCall",
									id: `bash-${randomUUID()}`,
									name: "bash",
									arguments: { command: QUARANTINED_CAPACITY_COMMAND },
								},
							],
							"toolUse",
						),
					});
				} else stream.push({ type: "done", reason: "stop", message: reply([{ type: "text", text: "done" }], "stop") });
				stream.end();
				return stream;
			},
		});
		const stage = ctx.stage("agent", {
			cwd,
			agentDir: cwd,
			modelRuntime,
			model: modelRuntime.getModel("pool-fixture", "fixture")!,
			settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } }),
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		} as never);
		return { text: await stage.complete("Run the command") };
	},
});
