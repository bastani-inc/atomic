import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import type { StageSessionCreateResult } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;

test("reattached stage reconstructs its saved custom model rather than using settings or parent models (#3432)", async () => {
	const cwd = makeTempDirectory("atomic-stage-saved-custom-");
	const agentDir = join(cwd, "agent");
	await writeFileEnsuringDir(
		join(agentDir, "auth.json"),
		JSON.stringify({ custom: { type: "api_key", key: "test" } }),
	);
	await writeFileEnsuringDir(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				custom: {
					baseUrl: "http://localhost:1/v1",
					api: "openai-completions",
					models: [
						{
							id: "catalog-model",
							name: "Catalog",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 10000,
							maxTokens: 1000,
						},
					],
				},
			},
		}),
	);
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const saved = SessionManager.inMemory(cwd);
	saved.appendModelChange("custom", "saved-not-in-catalog");
	saved.appendThinkingLevelChange("high");
	saved.appendMessage({ role: "user", content: "previous turn", timestamp: Date.now() });
	const settingsManager = SettingsManager.inMemory({
		defaultProvider: "custom",
		defaultModel: "catalog-model",
		fallbackModels: ["custom/catalog-model:low"],
	});
	let factoryCalls = 0;
	const adapters = buildRuntimeAdapters(
		{
			getChildSessionOptions: (options) => ({
				cwd,
				agentDir,
				modelRuntime: runtime,
				settingsManager,
				builtins: BUILTINS,
				tools: [],
				model: runtime.getModel("custom", "catalog-model"),
				...options,
			}),
		},
		{
			createAgentSession: async (options) => {
				factoryCalls++;
				return (await createAgentSession(options)) as StageSessionCreateResult;
			},
		},
	);
	try {
		assert.equal(runtime.getModel("custom", "saved-not-in-catalog"), undefined);
		const result = await adapters.agentSession!.create({
			sessionManager: saved,
			fallbackModels: [],
			thinkingLevel: "low",
		});
		const session = "session" in result ? result.session : result;
		try {
			assert.equal(session.model?.provider, "custom");
			assert.equal(session.model?.id, "saved-not-in-catalog");
			assert.equal(session.thinkingLevel, "high");
			assert.equal(factoryCalls, 1);
		} finally {
			await session.dispose();
		}
		const unavailable = SessionManager.inMemory(cwd);
		unavailable.appendModelChange("openai", "saved-unavailable");
		unavailable.appendMessage({ role: "user", content: "previous turn", timestamp: Date.now() });
		await assert.rejects(
			adapters.agentSession!.create({ sessionManager: unavailable, fallbackModels: [] }),
			/Workflow stage model unavailable: openai\/saved-unavailable/,
		);
		assert.equal(factoryCalls, 1, "unrestorable saved IDs must fail before SDK settings or parent fallback");
	} finally {
		removeTempDirectory(cwd);
	}
});
