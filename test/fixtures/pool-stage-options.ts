import { AuthStorage, ModelRuntime, SettingsManager } from "@bastani/atomic";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";

export async function poolStageOptions(cwd: string, crashDuring: boolean, firstPid: number) {
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider("pool-fixture", {
		api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "fixture",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model) {
			if (crashDuring && firstPid === process.pid) process.kill(process.pid, "SIGKILL");
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: [{ type: "text", text: String(process.pid) }], stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			} });
			stream.end();
			return stream;
		},
	});
	return {
		cwd, agentDir: cwd, modelRuntime, model: modelRuntime.getModel("pool-fixture", "fixture")!,
		settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } }),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	};
}
