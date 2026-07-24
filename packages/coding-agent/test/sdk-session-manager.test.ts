import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

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

		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
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
		expect(modelFallbackReason).toBe("session-restore");
		session.dispose();
	});

	it("propagates a generic warning for an unusable complete saved default without switching providers", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: ["cur", "sor"].join(""),
			defaultModel: ["composer", "-2"].join(""),
		});

		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.model?.provider).toBe("unknown");
		expect(session.model?.provider).not.toBe("openai");
		expect(typeof modelFallbackMessage).toBe("string");
		expect(modelFallbackMessage).toBe(
			"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.",
		);
		expect(modelFallbackReason).toBe("configured-provider-unsupported");
		expect(settingsManager.getDefaultProvider()).toBe(["cur", "sor"].join(""));
		expect(settingsManager.getDefaultModel()).toBe(["composer", "-2"].join(""));
		session.dispose();
	});
	it("keeps normal automatic selection for an unknown model on a supported provider", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "openai",
			defaultModel: "unknown-saved-model",
		});

		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.model?.provider).toBe("openai");
		expect(session.model?.id).not.toBe("unknown-saved-model");
		expect(modelFallbackMessage).toBeUndefined();
		expect(modelFallbackReason).toBeUndefined();
		session.dispose();
	});

	it("keeps normal automatic selection when a supported exact default lacks auth", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const savedModel = modelRegistry.getAll().find((model) => model.provider === "anthropic");
		if (!savedModel) throw new Error("missing Anthropic model fixture");
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: savedModel.provider,
			defaultModel: savedModel.id,
		});

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.model?.provider).toBe("openai");
		expect(session.model).not.toBe(savedModel);
		expect(modelFallbackMessage).toBeUndefined();
		session.dispose();
	});

	it("gives an unsupported saved provider precedence over failed persisted-session restoration", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const removedProvider = ["cur", "sor"].join("");
		const removedModel = ["composer", "-2"].join("");
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange(removedProvider, removedModel);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "persisted stale model" }],
			timestamp: Date.now(),
		});

		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({ defaultProvider: removedProvider, defaultModel: removedModel }),
			sessionManager,
		});

		expect(session.model?.provider).toBe("unknown");
		expect(modelFallbackMessage).toBe(
			"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.",
		);
		expect(modelFallbackReason).toBe("configured-provider-unsupported");
		session.dispose();
	});

	it("preserves failed restoration guidance when a valid saved default is selected", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const savedModel = modelRegistry.getAvailable().find((model) => model.provider === "openai");
		if (!savedModel) throw new Error("missing OpenAI model fixture");
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange("absent-session-provider", "absent-session-model");
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "restore" }], timestamp: Date.now() });

		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd, agentDir, authStorage, modelRegistry, sessionManager,
			settingsManager: SettingsManager.inMemory({ defaultProvider: savedModel.provider, defaultModel: savedModel.id }),
		});

		expect(session.model).toBe(savedModel);
		expect(modelFallbackMessage).toContain("Could not restore model absent-session-provider/absent-session-model");
		expect(modelFallbackMessage).toContain(`Using ${savedModel.provider}/${savedModel.id}`);
		expect(modelFallbackReason).toBe("session-restore");
		session.dispose();
	});

	it("preserves restoration guidance with supported unknown and unauthenticated saved defaults", async () => {
		for (const defaultKind of ["unknown", "unauthenticated"] as const) {
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey("openai", "test-key");
			const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
			const unauthenticated = modelRegistry.getAll().find((model) => model.provider === "anthropic");
			if (!unauthenticated) throw new Error("missing Anthropic model fixture");
			const sessionManager = SessionManager.inMemory(cwd);
			sessionManager.appendModelChange("absent-session-provider", "absent-session-model");
			sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: defaultKind }], timestamp: Date.now() });
			const settingsManager = SettingsManager.inMemory(defaultKind === "unknown"
				? { defaultProvider: "openai", defaultModel: "unknown-saved-model" }
				: { defaultProvider: unauthenticated.provider, defaultModel: unauthenticated.id });

			const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
				cwd, agentDir, authStorage, modelRegistry, settingsManager, sessionManager,
			});

			expect(session.model?.provider).toBe("openai");
			expect(modelFallbackMessage).toContain("Could not restore model absent-session-provider/absent-session-model");
			expect(modelFallbackMessage).toContain(`Using ${session.model?.provider}/${session.model?.id}`);
			expect(modelFallbackReason).toBe("session-restore");
			session.dispose();
		}
	});
	it("classifies ordinary empty catalogs separately from unsupported providers", async () => {
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([]);
		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd, agentDir, authStorage, modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(cwd),
		});
		expect(modelFallbackMessage).toContain("No models available");
		expect(modelFallbackReason).toBe("no-models-available");
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
