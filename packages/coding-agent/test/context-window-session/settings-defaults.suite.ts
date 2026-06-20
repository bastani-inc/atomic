import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
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

	test("setContextWindow without persistDefault journals and emits without writing default settings", async () => {
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

		const contextWindowEvents: number[] = [];
		created.session.subscribe((event) => {
			if (event.type === "context_window_changed") {
				contextWindowEvents.push(event.contextWindow);
			}
		});

		created.session.setContextWindow(1_000_000);

		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		expect(contextWindowEvents).toEqual([1_000_000]);
		expect(settingsManager.getDefaultContextWindow()).toBeUndefined();
		await settingsManager.flush();
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);

		created.session.dispose();
	});

	test("setContextWindow with persistDefault writes model-specific context-window settings", async () => {
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

		const contextWindowEvents: number[] = [];
		created.session.subscribe((event) => {
			if (event.type === "context_window_changed") {
				contextWindowEvents.push(event.contextWindow);
			}
		});

		created.session.setContextWindow(1_000_000, { persistDefault: true });

		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		expect(contextWindowEvents).toEqual([1_000_000]);
		expect(settingsManager.getDefaultContextWindow()).toBeUndefined();
		expect(settingsManager.getDefaultContextWindowForModel("custom", "target-context")).toBe(1_000_000);
		await settingsManager.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			defaultContextWindows: { "custom/target-context": 1_000_000 },
		});

		created.session.dispose();
	});

	test("resolves a saved Copilot 1m model preference to its advertised prompt cap", async () => {
		setActiveCopilotModelCatalog(
			new Map([["claude-opus-4.8", { contextWindow: 200_000, contextWindowOptions: [200_000, 936_000] }]]),
		);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("github-copilot", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const opusModel = modelRegistry.find("github-copilot", "claude-opus-4.8");
		if (!opusModel) {
			throw new Error("Missing built-in github-copilot/claude-opus-4.8 test model");
		}
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setDefaultContextWindowForModel("github-copilot", "claude-opus-4.8", 1_000_000);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: opusModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});

		expect(created.contextWindowWarning).toBeUndefined();
		expect(created.contextWindowError).toBeUndefined();
		expect(created.session.model?.contextWindow).toBe(936_000);
		expect(contextWindowChanges(sessionManager)).toEqual([936_000]);
		created.session.setContextWindow(1_000_000, { persistDefault: true });
		expect(created.session.model?.contextWindow).toBe(936_000);
		expect(settingsManager.getDefaultContextWindow()).toBeUndefined();
		expect(settingsManager.getDefaultContextWindowForModel("github-copilot", "claude-opus-4.8")).toBe(936_000);
		created.session.dispose();
	});

	test("does not leak a saved model-specific Copilot prompt cap to another provider", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const largeDefaultModel = requireModel(modelRegistry, "natural-large-default");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setDefaultContextWindowForModel("github-copilot", "claude-opus-4.8", 936_000);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: largeDefaultModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});

		expect(created.contextWindowWarning).toBeUndefined();
		expect(created.contextWindowError).toBeUndefined();
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([]);
		created.session.dispose();
	});

	test("ignores an unsupported stale global context-window fallback without warning", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const largeDefaultModel = requireModel(modelRegistry, "natural-large-default");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setDefaultContextWindow(272_000);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: largeDefaultModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});

		expect(created.contextWindowWarning).toBeUndefined();
		expect(created.contextWindowError).toBeUndefined();
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([]);
		created.session.dispose();
	});

	test("warns for an unsupported model-specific context-window default", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const largeDefaultModel = requireModel(modelRegistry, "natural-large-default");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setDefaultContextWindowForModel("custom", "natural-large-default", 272_000);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: largeDefaultModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});

		expect(created.contextWindowWarning).toContain("Context window 272k is not supported");
		expect(created.contextWindowError).toBeUndefined();
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([]);
		created.session.dispose();
	});

});
