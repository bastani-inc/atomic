import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalHomeDrive = process.env.HOMEDRIVE;
const originalHomePath = process.env.HOMEPATH;
const originalAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function configureTemporaryHome(home: string): void {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.HOMEDRIVE;
	delete process.env.HOMEPATH;
	delete process.env.ATOMIC_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
}

function writeCustomModels(path: string, models: Array<{ id: string; name?: string }>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				"project-probe": {
					baseUrl: "https://example.test/v1",
					api: "openai-completions",
					apiKey: "test-key",
					models,
				},
			},
		}),
	);
}

function writeCustomModel(path: string, id: string, name = id): void {
	writeCustomModels(path, [{ id, name }]);
}

afterEach(() => {
	restoreEnvironment("HOME", originalHome);
	restoreEnvironment("USERPROFILE", originalUserProfile);
	restoreEnvironment("HOMEDRIVE", originalHomeDrive);
	restoreEnvironment("HOMEPATH", originalHomePath);
	restoreEnvironment("ATOMIC_CODING_AGENT_DIR", originalAtomicAgentDir);
	restoreEnvironment("PI_CODING_AGENT_DIR", originalPiAgentDir);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent session service model paths", () => {
	it("does not load project-scoped models for a trusted project", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-project-models-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		const cwd = join(home, "project");
		const agentDir = join(home, ".atomic", "agent");
		mkdirSync(cwd);
		writeCustomModel(join(cwd, ".atomic", "models.json"), "project-scoped-only");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });

		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		expect(services.modelRuntime.getModel("project-probe", "project-scoped-only")).toBeUndefined();
	});

	it("preserves an explicitly supplied model registry without adding project paths", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-explicit-models-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		const cwd = join(home, "project");
		mkdirSync(cwd);
		const explicitPath = join(home, "explicit-models.json");
		writeCustomModel(explicitPath, "explicit-only");
		writeCustomModel(join(cwd, ".atomic", "models.json"), "project-only");
		const explicitRegistry = await createModelRegistry(AuthStorage.inMemory(), explicitPath);

		const services = await createAgentSessionServices({
			cwd,
			agentDir: join(home, ".atomic", "agent"),
			modelRuntime: getModelRuntime(explicitRegistry),
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		expect(services.modelRuntime).toBe(getModelRuntime(explicitRegistry));
		expect(services.modelRuntime.getModel("project-probe", "explicit-only")?.id).toBe("explicit-only");
		expect(services.modelRuntime.getModel("project-probe", "project-only")).toBeUndefined();
	});

	it("keeps an API-supplied modelsPath isolated from default project layers", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-runtime-explicit-models-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		const cwd = join(home, "project");
		mkdirSync(cwd);
		const explicitPath = join(home, "api-models.json");
		writeCustomModel(explicitPath, "api-explicit-only");
		writeCustomModel(join(cwd, ".atomic", "models.json"), "project-default-only");

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: explicitPath,
			allowModelNetwork: false,
		});

		expect(runtime.getModel("project-probe", "api-explicit-only")?.id).toBe("api-explicit-only");
		expect(runtime.getModel("project-probe", "project-default-only")).toBeUndefined();
	});

	it("tracks eager extension providers so a later reload removes vanished registrations", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-extension-provider-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		const cwd = join(home, "project");
		const agentDir = join(home, ".atomic", "agent");
		mkdirSync(cwd);
		let registerProvider = true;
		const providerId = "eager-extension-provider";
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
						if (!registerProvider) return;
						pi.registerProvider(providerId, {
							api: "openai-completions",
							baseUrl: "http://localhost:8080/eager-provider/v1",
							models: [{ id: "eager-model", name: "Eager model" }],
						});
					},
				],
			},
		});
		expect(services.modelRuntime.getRegisteredProviderIds()).toContain(providerId);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		try {
			registerProvider = false;
			await session.reload({ reason: "reload", failOnExtensionErrors: true });
			expect(session.modelRuntime.getRegisteredProviderIds()).not.toContain(providerId);
			expect(session.modelRuntime.getModel(providerId, "eager-model")).toBeUndefined();
		} finally {
			session.dispose();
		}
	});
});
