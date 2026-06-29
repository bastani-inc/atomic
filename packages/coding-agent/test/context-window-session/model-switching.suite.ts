import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { selectContextWindow } from "../../src/core/context-window.ts";
import { clearActiveCopilotModelCatalog, setActiveCopilotModelCatalog } from "../../src/core/copilot-model-catalog.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";

function writeCustomModels(agentDir: string): void {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				custom: {
					baseUrl: "https://example.invalid/v1",
					apiKey: "test-key",
					api: "openai-responses",
					models: [
						{
							id: "source-context",
							name: "Source Context",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 400_000,
							maxTokens: 4096,
						},
						{
							id: "natural-large-default",
							name: "Natural Large Default",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1_000_000,
							maxTokens: 4096,
						},
						{
							id: "target-context",
							name: "Target Context",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 400_000,
							contextWindowOptions: [1_000_000],
							maxTokens: 4096,
						},
						{
							id: "large-context",
							name: "Large Context",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 400_000,
							contextWindowOptions: [1_000_000],
							maxTokens: 4096,
						},
						{
							id: "small-context",
							name: "Small Context",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 400_000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
}

function requireModel(registry: ModelRegistry, modelId: string): Model<Api> {
	const model = registry.find("custom", modelId);
	if (!model) {
		throw new Error(`Missing test model: ${modelId}`);
	}
	return model;
}

function assistantMessage(provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider,
		model: modelId,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function contextWindowChanges(sessionManager: SessionManager): number[] {
	return sessionManager
		.getEntries()
		.filter((entry) => entry.type === "context_window_change")
		.map((entry) => entry.contextWindow);
}

describe("AgentSession context-window persistence", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-context-window-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "cwd");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeCustomModels(agentDir);
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		clearActiveCopilotModelCatalog();
	});

	test("journals an incoming selected model context window so resume preserves it", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const targetModel = requireModel(modelRegistry, "target-context");
		const selectedTarget = selectContextWindow(targetModel, 1_000_000);
		if ("error" in selectedTarget) {
			throw new Error(selectedTarget.error);
		}
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setDefaultContextWindow(400_000);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: selectedTarget.model,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(created.contextWindowWarning).toBeUndefined();
		expect(created.contextWindowError).toBeUndefined();
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		sessionManager.appendMessage(assistantMessage("custom", "target-context"));
		created.session.dispose();

		const resumed = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(resumed.contextWindowWarning).toBeUndefined();
		expect(resumed.contextWindowError).toBeUndefined();
		expect(resumed.session.model?.id).toBe("target-context");
		expect(resumed.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		resumed.session.dispose();
	});

	test("applies an incoming selected model context window when resuming an existing transcript", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const targetModel = requireModel(modelRegistry, "target-context");
		const selectedTarget = selectContextWindow(targetModel, 1_000_000);
		if ("error" in selectedTarget) {
			throw new Error(selectedTarget.error);
		}
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setDefaultContextWindow(400_000);
		const sessionManager = SessionManager.inMemory(cwd);

		const initial = await createAgentSession({
			cwd,
			agentDir,
			model: targetModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(initial.session.model?.contextWindow).toBe(400_000);
		sessionManager.appendMessage(assistantMessage("custom", "target-context"));
		initial.session.dispose();
		expect(contextWindowChanges(sessionManager)).toEqual([]);

		const resumedWithSelectedModel = await createAgentSession({
			cwd,
			agentDir,
			model: selectedTarget.model,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(resumedWithSelectedModel.contextWindowWarning).toBeUndefined();
		expect(resumedWithSelectedModel.contextWindowError).toBeUndefined();
		expect(resumedWithSelectedModel.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		resumedWithSelectedModel.session.dispose();

		const resumedAgain = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(resumedAgain.contextWindowWarning).toBeUndefined();
		expect(resumedAgain.contextWindowError).toBeUndefined();
		expect(resumedAgain.session.model?.id).toBe("target-context");
		expect(resumedAgain.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		resumedAgain.session.dispose();
	});

	test("carries an explicit session context-window entry on model switch", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const sourceModel = requireModel(modelRegistry, "natural-large-default");
		const targetModel = requireModel(modelRegistry, "target-context");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: sourceModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(created.session.model?.contextWindow).toBe(1_000_000);

		sessionManager.appendContextWindowChange(1_000_000);
		sessionManager.appendMessage(assistantMessage("custom", "natural-large-default"));
		await created.session.setModel(targetModel);
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		created.session.dispose();
	});

	test("uses an explicit supported default context window on model switch", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const sourceModel = requireModel(modelRegistry, "natural-large-default");
		const targetModel = requireModel(modelRegistry, "target-context");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setDefaultContextWindow(1_000_000);
		await settingsManager.flush();
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: sourceModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(created.session.model?.contextWindow).toBe(1_000_000);

		sessionManager.appendMessage(assistantMessage("custom", "natural-large-default"));
		await created.session.setModel(targetModel);
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([]);
		created.session.dispose();
	});

	test("uses a supported global default instead of carrying an unsupported source fallback", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const sourceModel = requireModel(modelRegistry, "source-context");
		const targetModel = requireModel(modelRegistry, "target-context");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setDefaultContextWindow(1_000_000);
		await settingsManager.flush();
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: sourceModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(created.contextWindowWarning).toBeUndefined();
		expect(created.session.model?.contextWindow).toBe(400_000);

		sessionManager.appendMessage(assistantMessage("custom", "source-context"));
		await created.session.setModel(targetModel);
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([]);

		created.session.dispose();

		const resumed = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(resumed.session.model?.id).toBe("target-context");
		expect(resumed.session.model?.contextWindow).toBe(1_000_000);
		resumed.session.dispose();
	});

	test("appends a corrective context window when switching from 1m to a smaller-only model", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const largeModel = requireModel(modelRegistry, "large-context");
		const smallModel = requireModel(modelRegistry, "small-context");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: largeModel,
			contextWindow: 1_000_000,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(created.contextWindowWarning).toBeUndefined();
		expect(created.session.model?.contextWindow).toBe(1_000_000);

		sessionManager.appendMessage(assistantMessage("custom", "large-context"));
		await created.session.setModel(smallModel);
		expect(created.session.model?.contextWindow).toBe(400_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000, 400_000]);

		created.session.dispose();

		const resumed = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(resumed.contextWindowWarning).toBeUndefined();
		expect(resumed.contextWindowError).toBeUndefined();
		expect(resumed.session.model?.id).toBe("small-context");
		expect(resumed.session.model?.contextWindow).toBe(400_000);
		resumed.session.dispose();
	});

	test("journals an explicit context-window override when resuming an existing transcript", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const targetModel = requireModel(modelRegistry, "target-context");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: targetModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(created.session.model?.contextWindow).toBe(400_000);
		sessionManager.appendMessage(assistantMessage("custom", "target-context"));
		created.session.dispose();

		const resumed = await createAgentSession({
			cwd,
			agentDir,
			contextWindow: 1_000_000,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(resumed.contextWindowWarning).toBeUndefined();
		expect(resumed.contextWindowError).toBeUndefined();
		expect(resumed.session.model?.id).toBe("target-context");
		expect(resumed.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		resumed.session.dispose();
	});

});
