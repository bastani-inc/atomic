// Pooled child of the session-commit measurement (#4768): `stages` agent stages on a stub model that answers at once,
// each after a `ctx.tool` step, so its steps are what an agent-stage child's are: tool checkpoints, stage sessions
// (create, prompt, reply), and the checkpoints that end each stage and bill its usage.
import { AuthStorage, ModelRuntime, SettingsManager } from "@bastani/atomic";
import { workflow } from "@bastani/atomic/workflows";
import { createAssistantMessageEventStream } from "@bastani/atomic-ai";
import { Type } from "typebox";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function stubStageOptions(cwd) {
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider("bench-stub", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "stub",
		models: [{ id: "stub", name: "Stub", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			setTimeout(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: "ok" }], stopReason: "stop", usage },
				});
				stream.end();
			}, 0);
			return stream;
		},
	});
	return {
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: modelRuntime.getModel("bench-stub", "stub"),
		settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } }),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	};
}

export const sessionCommitsChild = workflow({
	name: "session-commits-child",
	description: "Runs agent stages and tool steps, each one step of the child",
	inputs: { index: Type.Number(), stages: Type.Number() },
	outputs: { replies: Type.Number() },
	async run(ctx) {
		let replies = 0;
		for (let stage = 0; stage < ctx.inputs.stages; stage++) {
			await ctx.tool(`step-${stage}`, { stage }, async () => stage);
			const reply = await ctx.stage(`agent-${stage}`, await stubStageOptions(ctx.cwd ?? process.cwd())).complete(`Stage ${stage} of child ${ctx.inputs.index}`);
			if (String(reply) === "ok") replies++;
		}
		return { replies };
	},
});
