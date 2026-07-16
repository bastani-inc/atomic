import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { getModel, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { mapCursorCatalogToProviderModels } from "../../cursor/src/model-mapper.ts";
import { registerTrustedCursorProvider } from "./cursor-test-provider-source.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}${sep}`)).toBe(true);

		session.dispose();
	});

	it("rejects an explicit or later static lowercase Cursor model object", async () => {
		const staticCursor: Model<Api> = {
			id: "static-forbidden", name: "Static", provider: "cursor", api: "anthropic-messages",
			baseUrl: "https://static.invalid", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100,
		};
		const rejected = await createAgentSession({ cwd, agentDir, model: staticCursor });
		expect(`${String(rejected.session.model?.provider)}/${rejected.session.model?.id}`).not.toBe("cursor/static-forbidden");
		expect(rejected.modelFallbackMessage).toContain("reselect");
		rejected.session.dispose();

		const ordinary = getModel("anthropic", "claude-sonnet-4-5");
		expect(ordinary).toBeTruthy();
		const accepted = await createAgentSession({ cwd, agentDir, model: ordinary! });
		await expect(accepted.session.setModel(staticCursor)).rejects.toThrow(/current authenticated catalog/u);
		expect(accepted.session.model?.provider).toBe("anthropic");
		accepted.session.dispose();
	});

	it("requires current live registry membership for explicit Cursor objects", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registerTrustedCursorProvider(registry, {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
			models: mapCursorCatalogToProviderModels({ source: "live", fetchedAt: 1, models: [{ id: "actual-live", maxMode: false }] }),
		});
		const live = registry.getAll().find((candidate) => candidate.provider === "cursor");
		expect(live).toBeTruthy();
		const forgedClone = { ...live! } as Model<Api>;
		const forgedOther = { ...live!, id: "forged-not-live", name: "Forged", compat: { cursorRouting: { "forged-not-live": { modelId: "forged-not-live", maxMode: false, supportsImages: false, catalogOccurrence: 0 } } } } as Model<Api>;
		expect(registry.isCurrentModel(live!)).toBe(true);
		expect(registry.isCurrentModel(forgedClone)).toBe(false);
		expect(registry.isCurrentModel(forgedOther)).toBe(false);

		for (const forged of [forgedClone, forgedOther]) {
			const rejected = await createAgentSession({ cwd, agentDir, model: forged, modelRegistry: registry, sessionManager: SessionManager.inMemory(cwd) });
			expect(rejected.session.model).not.toBe(forged);
			expect(rejected.modelFallbackMessage).toContain("reselect");
			rejected.session.dispose();
		}

		const accepted = await createAgentSession({
			cwd, agentDir, model: live!, modelRegistry: registry,
			sessionManager: SessionManager.inMemory(cwd), contextWindow: live!.contextWindow,
		});
		expect(accepted.session.model).toBe(live);
		accepted.session.setContextWindow(live!.contextWindow, { persistDefault: true });
		expect(accepted.session.model).toBe(live);
		accepted.session._applyContextWindowReplay(live!.contextWindow);
		expect(accepted.session.model).toBe(live);
		await accepted.session.setModel(live!);
		expect(accepted.session.model).toBe(live);
		await expect(accepted.session.setModel(forgedClone)).rejects.toThrow(/current authenticated catalog/u);
		expect(accepted.session.model).toBe(live);
		accepted.session.setScopedModels([{ model: forgedClone }, { model: live! }]);
		expect(accepted.session.scopedModels.map((entry) => entry.model)).toEqual([live]);
		registerTrustedCursorProvider(registry, {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
			models: mapCursorCatalogToProviderModels({ source: "live", fetchedAt: 2, models: [{ id: "actual-live", maxMode: true }] }),
		});
		expect(registry.isCurrentModel(live!)).toBe(false);
		await expect(accepted.session.setModel(live!)).rejects.toThrow(/current authenticated catalog/u);
		accepted.session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd.replaceAll("\\", "/")}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: 'bun -e "console.log(process.cwd())"' });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});

	it("enables ask_user_question and todo by default", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "ask_user_question", "todo"]),
		);

		session.dispose();
	});

	it("synthesizes an absent custom model id only while restoring persisted session state", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openrouter", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange("openrouter", "future/custom-restored-model");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restore me" }],
			timestamp: Date.now(),
		});

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
		});

		expect(session.model?.provider).toBe("openrouter");
		expect(session.model?.id).toBe("future/custom-restored-model");
		expect(modelFallbackMessage).toBeUndefined();
		session.dispose();
	});

	it("does not synthesize an exact unauthenticated model during SDK session restoration", async () => {
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const openRouterModels = modelRegistry.getAll().filter((model) => model.provider === "openrouter");
		const exactModel = openRouterModels[0];
		const sameProviderTemplate = openRouterModels[1];
		expect(exactModel).toBeDefined();
		expect(sameProviderTemplate).toBeDefined();

		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockImplementation((model) => model !== exactModel);
		expect(modelRegistry.getAvailable()).toContain(sameProviderTemplate);
		expect(modelRegistry.getAvailable()).not.toContain(exactModel);
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange(exactModel!.provider, exactModel!.id);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restore without auth" }],
			timestamp: Date.now(),
		});

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
		});

		expect(session.model).not.toBe(exactModel);
		expect(session.model?.id).not.toBe(exactModel!.id);
		expect(modelFallbackMessage).toContain(`${exactModel!.provider}/${exactModel!.id}`);
		session.dispose();
	});

	for (const source of ["settings", "session"] as const) {
		it(`preserves a stale Cursor ${source} reselection failure without SDK/workflow model fallback`, async () => {
			const authStorage = AuthStorage.inMemory();
			const modelRegistry = ModelRegistry.inMemory(authStorage);
			const other = getModel("anthropic", "claude-sonnet-4-5")!;
			modelRegistry.registerProvider("anthropic", {
				baseUrl: other.baseUrl, apiKey: "test-key", api: other.api, models: [other],
			});
			const settingsManager = SettingsManager.inMemory();
			const sessionManager = SessionManager.inMemory(cwd);
			if (source === "settings") settingsManager.setDefaultModelAndProvider("cursor", "old-synthetic-high");
			else {
				sessionManager.appendModelChange("cursor", "old-synthetic-high");
				sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
			}
			const { session, modelFallbackMessage } = await createAgentSession({
				cwd, agentDir, authStorage, modelRegistry, settingsManager, sessionManager,
			});
			expect(session.model?.provider).not.toBe("anthropic");
			expect(session.model?.provider).not.toBe("cursor");
			expect(modelFallbackMessage).toContain("cursor/old-synthetic-high");
			expect(modelFallbackMessage).toContain("reselect an exact model");
			session.dispose();
		});
	}

	it("discovers and selects an exact saved Cursor default through a trusted extension module", async () => {
		const exactId = "continuity-route";
		const authStorage = AuthStorage.inMemory();
		authStorage.set("cursor", { type: "oauth", access: `x.${Buffer.from(JSON.stringify({ sub: "resumed-cli-test" })).toString("base64url")}.x`, refresh: "test", expires: Date.now() + 60_000 });
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setDefaultModelAndProvider("cursor", exactId);
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			additionalExtensionPaths: [resolve(import.meta.dirname, "../../cursor/test/resumed-history-extension.ts")],
			builtinPackagePaths: [], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd, agentDir, authStorage, modelRegistry, settingsManager,
			sessionManager: SessionManager.inMemory(cwd), resourceLoader,
		});
		expect(session.model?.provider).toBe("cursor");
		expect(session.model?.id).toBe(exactId);
		expect(modelFallbackMessage).toBeUndefined();
		session.dispose();
	});

	it("does not activate Cursor discovery for a case-variant saved provider", async () => {
		let discoveries = 0;
		const extensionFactory: ExtensionFactory = (pi) => {
			pi.on("model_catalog_discover", () => { discoveries += 1; });
		};
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const fallback = getModel("anthropic", "claude-sonnet-4-5")!;
		modelRegistry.registerProvider("anthropic", {
			baseUrl: fallback.baseUrl, apiKey: "test-key", api: fallback.api, models: [fallback],
		});
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setDefaultModelAndProvider("Cursor", "missing-route");
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager, extensionFactories: [extensionFactory],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd, agentDir, authStorage, modelRegistry, settingsManager,
			sessionManager: SessionManager.inMemory(cwd), resourceLoader,
		});
		expect(discoveries).toBe(0);
		expect(session.model?.provider).toBe("anthropic");
		expect(session.model?.id).toBe(fallback.id);
		expect(modelFallbackMessage).toBeUndefined();
		session.dispose();
	});

	it("keeps a stale resumed Cursor reference fatal through real extension binding", async () => {
		let discoveries = 0;
		let runCalls = 0;
		const extensionFactory: ExtensionFactory = (pi) => {
			pi.on("model_catalog_discover", () => {
				discoveries += 1;
				pi.registerProvider("cursor", {
					baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
					streamSimple: () => { runCalls += 1; throw new Error("must not dispatch"); },
					models: [{
						id: "current-exact", name: "Current Exact", reasoning: false, input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000, maxTokens: 64_000,
					}],
				});
			});
		};
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const other = getModel("anthropic", "claude-sonnet-4-5")!;
		modelRegistry.registerProvider("anthropic", {
			baseUrl: other.baseUrl, apiKey: "test-key", api: other.api, models: [other],
		});
		const settingsManager = SettingsManager.inMemory();
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange("cursor", "old-synthetic-high");
		sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager, extensionFactories: [extensionFactory],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd, agentDir, authStorage, modelRegistry, settingsManager, sessionManager, resourceLoader,
		});
		expect(discoveries).toBe(1);
		expect(session.model?.provider).toBe("unknown");
		expect(modelFallbackMessage).toContain("cursor/old-synthetic-high");
		expect(modelFallbackMessage).toContain("reselect an exact model");
		expect(runCalls).toBe(0);
		session.dispose();
	});
	it("marks the session header internal when a workflow-stage orchestration context is supplied", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			orchestrationContext: {
				kind: "workflow-stage",
				workflowRunId: "run-42",
				workflowStageId: "stage-7",
				workflowStageName: "build",
				constraints: { disableWorkflowTool: true, maxSubagentDepth: 5 },
			},
		});

		const header = session.sessionManager.getHeader();
		expect(header?.internal).toBe(true);
		expect(header?.workflow).toEqual({ runId: "run-42", stageId: "stage-7", stageName: "build" });

		session.dispose();
	});
});
