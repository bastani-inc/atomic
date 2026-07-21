import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { selectContextWindow } from "../src/core/context-window.ts";
import { clearActiveCopilotModelCatalog, setActiveCopilotModelCatalog } from "../src/core/copilot-model-catalog.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		clearActiveCopilotModelCatalog();
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
		});

		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		session.agent.streamFn = async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		};
		await session.prompt("hello");
		return baseUrl;
	}

	it("applies top-level registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/top-level" });
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/top-level");

		session.dispose();
	});

	it("applies session_start registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.on("session_start", () => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/session-start" });
				});
			},
		]);

		await session.bindExtensions({});

		expect(session.model?.baseUrl).toBe("http://localhost:8080/session-start");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/session-start");

		session.dispose();
	});

	it("applies command-time registerProvider overrides without reload", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-proxy", {
					description: "Use proxy",
					handler: async () => {
						pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/command" });
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-proxy");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/command");

		session.dispose();
	});

	it("preserves caller-selected Copilot metadata while applying a same-provider override", async () => {
		setActiveCopilotModelCatalog(
			new Map([["claude-opus-4.8", { contextWindow: 200_000, contextWindowOptions: [200_000, 936_000] }]]),
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("github-copilot", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const registryModel = modelRegistry.find("github-copilot", "claude-opus-4.8");
		if (!registryModel) throw new Error("Missing built-in github-copilot/claude-opus-4.8 test model");
		const selected = selectContextWindow(registryModel, 936_000);
		if ("error" in selected) throw new Error(selected.error);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerProvider("github-copilot", { baseUrl: "http://localhost:8080/copilot-proxy" });
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: selected.model,
			modelRegistry,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
		});

		expect(session.model?.provider).toBe("github-copilot");
		expect(session.model?.id).toBe("claude-opus-4.8");
		expect(session.model?.baseUrl).toBe("http://localhost:8080/copilot-proxy");
		expect(session.model?.contextWindow).toBe(936_000);
		expect(session.model?.defaultContextWindow).toBe(200_000);
		expect(session.model?.contextWindowOptions).toEqual([200_000, 936_000]);

		session.dispose();
	});

	it("preserves selected Copilot long context across unrelated provider registration", async () => {
		setActiveCopilotModelCatalog(
			new Map([["claude-opus-4.8", { contextWindow: 200_000, contextWindowOptions: [200_000, 936_000] }]]),
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("github-copilot", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const copilotOpus = modelRegistry.find("github-copilot", "claude-opus-4.8");
		if (!copilotOpus) {
			throw new Error("Missing built-in github-copilot/claude-opus-4.8 test model");
		}
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerCommand("register-anthropic-proxy", {
						description: "Register an unrelated provider override",
						handler: async () => {
							pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/other" });
						},
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: copilotOpus,
			modelRegistry,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
		});
		session.setContextWindow(936_000, { persistDefault: true });
		expect(session.model?.contextWindow).toBe(936_000);

		await session.bindExtensions({});
		await session.prompt("/register-anthropic-proxy");

		expect(session.model?.provider).toBe("github-copilot");
		expect(session.model?.id).toBe("claude-opus-4.8");
		expect(session.model?.contextWindow).toBe(936_000);
		expect(settingsManager.getDefaultContextWindow()).toBeUndefined();
		expect(settingsManager.getDefaultContextWindowForModel("github-copilot", "claude-opus-4.8")).toBe(936_000);
		expect(
			sessionManager
				.getEntries()
				.filter((entry) => entry.type === "context_window_change")
				.map((entry) => entry.contextWindow),
		).toEqual([936_000]);

		session.dispose();
	});
});
