import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const missingApiKeyEnv = "ATOMIC_SDK_SESSION_MANAGER_MISSING_KEY";
const testModel = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
});

async function createSelectionRuntime(): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("test-ready", {
		api: "openai-completions",
		baseUrl: "https://ready.invalid/v1",
		apiKey: "test-key",
		models: [testModel("ready-model")],
	});
	runtime.registerProvider("test-locked", {
		api: "openai-completions",
		baseUrl: "https://locked.invalid/v1",
		apiKey: `$${missingApiKeyEnv}`,
		models: [testModel("locked-model")],
	});
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

function persistedSession(cwd: string, provider: string, modelId: string): SessionManager {
	const manager = SessionManager.inMemory(cwd);
	manager.appendModelChange(provider, modelId);
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "restore" }],
		timestamp: Date.now(),
	});
	return manager;
}

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let previousMissingApiKey: string | undefined;

	beforeEach(() => {
		previousMissingApiKey = process.env[missingApiKeyEnv];
		delete process.env[missingApiKeyEnv];
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (previousMissingApiKey === undefined) delete process.env[missingApiKeyEnv];
		else process.env[missingApiKeyEnv] = previousMissingApiKey;
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
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
		// The system prompt always renders the cwd with POSIX separators (system-prompt.ts).
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd.replaceAll("\\", "/")}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		// Prove the tool's working directory by reading a marker only resolvable from
		// sessionCwd. Comparing `pwd` text is not portable: on Windows the bash tool runs
		// under Git Bash, which reports MSYS paths (/tmp/...) that Node cannot resolve.
		writeFileSync(join(sessionCwd, "cwd-marker.txt"), "session-cwd-marker");
		const result = await bashTool!.execute("test", { command: "cat cwd-marker.txt" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(output.trim()).toBe("session-cwd-marker");

		session.dispose();
	});

	it("exposes current session state to the built-in bash tool", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			thinkingLevel: "high",
		});
		expect(session.sessionFile).toBeTruthy();
		expect(session.systemPrompt).toContain(
			"You can inspect ATOMIC_* or PI_* environment variables for current model and session details.",
		);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `printf '%s\\n' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(output.trim().split("\n")).toEqual([
			session.sessionId,
			session.sessionFile,
			model!.provider,
			model!.id,
			session.thinkingLevel,
		]);

		session.dispose();
	});

	it("enables ask_user_question and todo by default", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session } = await createAgentSession({ cwd, agentDir, model: model! });

		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "ask_user_question", "todo"]),
		);
		session.dispose();
	});

	it("restores an absent model id for a registered OpenAI-compatible provider", async () => {
		const modelRuntime = await createSelectionRuntime();
		const restoredModelId = "future/custom-restored-model";

		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: persistedSession(cwd, "test-ready", restoredModelId),
		});

		expect(session.model?.provider).toBe("test-ready");
		expect(session.model?.id).toBe(restoredModelId);
		expect(modelFallbackMessage).toBeUndefined();
		expect(modelFallbackReason).toBeUndefined();
		session.dispose();
	});

	it("does not synthesize an exact unauthenticated model during SDK session restoration", async () => {
		const modelRuntime = await createSelectionRuntime();
		const locked = modelRuntime.getModel("test-locked", "locked-model");
		expect(locked).toBeDefined();
		expect(modelRuntime.hasConfiguredAuth("test-locked")).toBe(false);

		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: persistedSession(cwd, "test-locked", "locked-model"),
		});

		expect(session.model).not.toEqual(locked);
		expect(modelFallbackMessage).toContain("test-locked/locked-model");
		expect(modelFallbackReason).toBe("session-restore");
		session.dispose();
	});

	it("propagates a generic warning for an unusable complete saved default without switching providers", async () => {
		const modelRuntime = await createSelectionRuntime();
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "unsupported-provider",
			defaultModel: "unsupported-model",
		});
		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.model?.provider).not.toBe("test-ready");
		expect(modelFallbackMessage).toBe(
			"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.",
		);
		expect(modelFallbackReason).toBe("configured-provider-unsupported");
		expect(settingsManager.getDefaultProvider()).toBe("unsupported-provider");
		expect(settingsManager.getDefaultModel()).toBe("unsupported-model");
		session.dispose();
	});

	it("keeps normal automatic selection for an unknown model on a supported provider", async () => {
		const modelRuntime = await createSelectionRuntime();
		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "test-ready",
				defaultModel: "unknown-saved-model",
			}),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.model?.id).not.toBe("unknown-saved-model");
		expect(modelFallbackMessage).toBeUndefined();
		expect(modelFallbackReason).toBeUndefined();
		session.dispose();
	});

	it("keeps normal automatic selection when a supported exact default lacks auth", async () => {
		const modelRuntime = await createSelectionRuntime();
		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "test-locked",
				defaultModel: "locked-model",
			}),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.model?.provider).not.toBe("test-locked");
		expect(modelFallbackMessage).toBeUndefined();
		expect(modelFallbackReason).toBeUndefined();
		session.dispose();
	});

	it("gives an unsupported saved provider precedence over failed persisted-session restoration", async () => {
		const modelRuntime = await createSelectionRuntime();
		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "unsupported-provider",
				defaultModel: "unsupported-model",
			}),
			sessionManager: persistedSession(cwd, "absent-session-provider", "absent-session-model"),
		});

		expect(session.model?.provider).toBe("unknown");
		expect(session.model?.provider).not.toBe("test-ready");
		expect(modelFallbackMessage).toBe(
			"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.",
		);
		expect(modelFallbackReason).toBe("configured-provider-unsupported");
		session.dispose();
	});

	it("preserves restoration guidance with supported unknown and unauthenticated saved defaults", async () => {
		for (const savedDefault of [
			{ defaultProvider: "test-ready", defaultModel: "unknown-saved-model" },
			{ defaultProvider: "test-locked", defaultModel: "locked-model" },
		]) {
			const modelRuntime = await createSelectionRuntime();
			const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory(savedDefault),
				sessionManager: persistedSession(cwd, "absent-session-provider", "absent-session-model"),
			});

			expect(modelFallbackMessage).toContain("Could not restore model absent-session-provider/absent-session-model");
			expect(modelFallbackMessage).toContain(`Using ${session.model?.provider}/${session.model?.id}`);
			expect(modelFallbackReason).toBe("session-restore");
			session.dispose();
		}
	});

	it("classifies ordinary empty catalogs separately from unsupported providers", async () => {
		const modelRuntime = await createSelectionRuntime();
		vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([]);
		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(modelFallbackMessage).toContain("No models available");
		expect(modelFallbackReason).toBe("no-models-available");
		session.dispose();
	});

	it("marks workflow-stage sessions internal with their orchestration identity", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const sessionManager = SessionManager.inMemory(cwd);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
			orchestrationContext: {
				kind: "workflow-stage",
				workflowRunId: "run-42",
				workflowStageId: "stage-7",
				workflowStageName: "build",
				constraints: { disableWorkflowTool: true, maxSubagentDepth: 5 },
			},
		});

		expect(sessionManager.getHeader()?.internal).toBe(true);
		expect(sessionManager.getHeader()?.workflow).toEqual({
			runId: "run-42",
			stageId: "stage-7",
			stageName: "build",
		});
		session.dispose();
	});

	it("reports session-restore fallback reason and selected replacement model", async () => {
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const replacement = modelRuntime.getAvailableSnapshot().find((model) => model.provider === "openai");
		expect(replacement).toBeDefined();
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange("absent-session-provider", "absent-session-model");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restore" }],
			timestamp: Date.now(),
		});

		const { session, modelFallbackMessage, modelFallbackReason } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: replacement!.provider,
				defaultModel: replacement!.id,
			}),
		});

		expect(session.model).toEqual(replacement);
		expect(modelFallbackReason).toBe("session-restore");
		expect(modelFallbackMessage).toBe(
			`Could not restore model absent-session-provider/absent-session-model. Using ${replacement!.provider}/${replacement!.id}`,
		);
		session.dispose();
	});
});
