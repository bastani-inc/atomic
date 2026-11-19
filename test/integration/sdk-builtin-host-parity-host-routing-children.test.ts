import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools } from "@bastani/atomic-ai";
import { test } from "vitest";
import { createAgentSession, SessionManager, SettingsManager } from "../../packages/coding-agent/src/index.js";

test("a headless SDK session without an input adapter refuses an ordinary dialog", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-missing-host-"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
	});
	const context = session.extensionRunner!.createContext();
	try {
		await assert.rejects(context.ui.input("ordinary"), { code: "HumanInputUnavailable" });
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: exercise the real in-process runner, not its testSession stub.
test.each([false, true])(
	"subagent child uses the parent's model runtime and tool ceiling, fallback=%s",
	async (fallback) => {
		const { getModel, createAssistantMessageEventStream } = await import("@bastani/atomic-ai/compat");
		const { AuthStorage, ModelRuntime } = await import("../../packages/coding-agent/src/index.js");
		const { runSingleInProcess } = await import("../../packages/subagents/src/runs/foreground/inprocess-run-sync.js");
		const { clearSubagentControls } = await import("../../packages/subagents/src/runs/inprocess/control-registry.js");
		const cwd = mkdtempSync(join(tmpdir(), "atomic-real-child-"));
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, provider: "child-parity" };
		const fallbackModel = { ...model, id: "child-fallback" };
		const requestedModels: string[] = [];
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const observed: string[][] = [];
		runtime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "child-fixture-key",
			models: [model, fallbackModel],
			streamSimple: (requestModel, context) => {
				requestedModels.push(requestModel.id);
				observed.push(getCurrentTools(context.messages).map((tool) => tool.name));
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "child complete" }],
					api: model.api,
					provider: model.provider,
					model: requestModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				if (fallback && requestModel.id === model.id) {
					const error = { ...message, stopReason: "error" as const, errorMessage: "model not found" };
					stream.push({ type: "error", reason: "error", error });
					stream.end(error);
					return stream;
				}
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			},
		});
		const { session: parent } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime: runtime,
			model,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["read"],
			fallbackModels: fallback ? [`${model.provider}/${fallbackModel.id}`] : [],
		});
		try {
			const result = await runSingleInProcess(
				cwd,
				{
					name: "worker",
					description: "fixture",
					systemPrompt: "",
					systemPromptMode: "replace",
					inheritProjectContext: false,
					inheritSkills: false,
					source: "user",
					filePath: join(cwd, "worker.md"),
					tools: ["read", "bash", "intercom"],
				},
				"report",
				{
					cwd,
					runId: `parity-${parent.sessionManager.getSessionId()}`,
					sessionDir: join(cwd, "children"),
					testSession: false,
					currentModel: `${model.provider}/${model.id}`,
					resolveCandidateModel: () => ({ model }),
					getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
				},
			);
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.deepEqual(requestedModels, fallback ? [model.id, fallbackModel.id] : [model.id]);
			assert.deepEqual(
				observed,
				requestedModels.map(() => ["read"]),
			);
		} finally {
			parent.dispose();
			clearSubagentControls();
			runtime.unregisterProvider(model.provider);
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
