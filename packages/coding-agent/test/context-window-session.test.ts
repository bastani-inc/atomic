import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { selectContextWindow } from "../src/core/context-window.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

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

	test("setContextWindow with persistDefault writes default context-window settings", async () => {
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
		expect(settingsManager.getDefaultContextWindow()).toBe(1_000_000);
		await settingsManager.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			defaultContextWindow: 1_000_000,
		});

		created.session.dispose();
	});

	test("journals an explicit default-sized context window for a new session", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const targetModel = requireModel(modelRegistry, "target-context");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: targetModel,
			contextWindow: 400_000,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});

		expect(created.contextWindowWarning).toBeUndefined();
		expect(created.contextWindowError).toBeUndefined();
		expect(created.session.model?.contextWindow).toBe(400_000);
		expect(contextWindowChanges(sessionManager)).toEqual([400_000]);
		created.session.dispose();
	});

	test("journals an explicit default-sized context window when resuming an existing transcript", async () => {
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
		sessionManager.appendMessage(assistantMessage("custom", "target-context"));
		created.session.dispose();

		const resumed = await createAgentSession({
			cwd,
			agentDir,
			contextWindow: 400_000,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});

		expect(resumed.contextWindowWarning).toBeUndefined();
		expect(resumed.contextWindowError).toBeUndefined();
		expect(resumed.session.model?.contextWindow).toBe(400_000);
		expect(contextWindowChanges(sessionManager)).toEqual([400_000]);
		resumed.session.dispose();
	});

	test("replays branch context-window changes during tree navigation without journaling or settings writes", async () => {
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

		sessionManager.appendMessage(userMessage("root"));
		const rootAssistantId = sessionManager.appendMessage(assistantMessage("custom", "target-context"));
		const largeContextEntryId = sessionManager.appendContextWindowChange(1_000_000);
		sessionManager.appendMessage(userMessage("large branch"));
		sessionManager.appendMessage(assistantMessage("custom", "target-context"));

		sessionManager.branch(rootAssistantId);
		sessionManager.appendMessage(userMessage("small branch"));
		sessionManager.appendMessage(assistantMessage("custom", "target-context"));

		expect(created.session.model?.contextWindow).toBe(400_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		const entryIdsBeforeNavigation = sessionManager.getEntries().map((entry) => entry.id);

		const result = await created.session.navigateTree(largeContextEntryId);

		expect(result.cancelled).toBe(false);
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowEvents).toEqual([1_000_000]);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		expect(sessionManager.getEntries().map((entry) => entry.id)).toEqual(entryIdsBeforeNavigation);
		expect(settingsManager.getDefaultContextWindow()).toBeUndefined();
		await settingsManager.flush();
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);

		created.session.dispose();
	});

	test("does not carry a source model's natural 1m default to a 400k-default target", async () => {
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
		expect(created.contextWindowWarning).toBeUndefined();
		expect(created.session.model?.contextWindow).toBe(1_000_000);

		sessionManager.appendMessage(assistantMessage("custom", "natural-large-default"));
		await created.session.setModel(targetModel);
		expect(created.session.model?.contextWindow).toBe(400_000);
		expect(contextWindowChanges(sessionManager)).toEqual([]);
		created.session.dispose();
	});

	test("preserves an incoming target model's explicit context window on setModel", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const sourceModel = requireModel(modelRegistry, "source-context");
		const targetModel = requireModel(modelRegistry, "target-context");
		const selectedTarget = selectContextWindow(targetModel, 1_000_000);
		if ("error" in selectedTarget) {
			throw new Error(selectedTarget.error);
		}
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setDefaultContextWindow(400_000);
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

		await created.session.setModel(selectedTarget.model);

		expect(created.session.model?.id).toBe("target-context");
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		created.session.dispose();
	});

	test("emits context-window changes for same-model setModel selections without model_changed", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const currentModel = requireModel(modelRegistry, "target-context");
		const selectedCurrent = selectContextWindow(currentModel, 1_000_000);
		if ("error" in selectedCurrent) {
			throw new Error(selectedCurrent.error);
		}
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: currentModel,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(created.contextWindowWarning).toBeUndefined();
		expect(created.contextWindowError).toBeUndefined();
		expect(created.session.model?.id).toBe("target-context");
		expect(created.session.model?.contextWindow).toBe(400_000);

		const contextWindowEvents: number[] = [];
		const modelChangedEvents: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "context_window_changed") {
				contextWindowEvents.push(event.contextWindow);
			}
			if (event.type === "model_changed") {
				modelChangedEvents.push(`${event.model.provider}/${event.model.id}`);
			}
		});

		await created.session.setModel(selectedCurrent.model);

		expect(created.session.model?.id).toBe("target-context");
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		expect(contextWindowEvents).toEqual([1_000_000]);
		expect(modelChangedEvents).toEqual([]);
		created.session.dispose();
	});

	test("carries an explicit off-default context window on model switch", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const sourceModel = requireModel(modelRegistry, "large-context");
		const selectedSource = selectContextWindow(sourceModel, 1_000_000);
		if ("error" in selectedSource) {
			throw new Error(selectedSource.error);
		}
		const targetModel = requireModel(modelRegistry, "target-context");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory(cwd);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: selectedSource.model,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);

		sessionManager.appendMessage(assistantMessage("custom", "large-context"));
		await created.session.setModel(targetModel);
		expect(created.session.model?.contextWindow).toBe(1_000_000);
		expect(contextWindowChanges(sessionManager)).toEqual([1_000_000]);
		created.session.dispose();
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

	test("uses a supported settings default instead of carrying an unsupported source fallback", async () => {
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
		expect(created.contextWindowWarning).toContain("not supported");
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
