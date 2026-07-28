import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

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

function writeLegacyOverride(home: string): void {
	const legacyAgentDir = join(home, ".pi", "agent");
	mkdirSync(legacyAgentDir, { recursive: true });
	writeFileSync(
		join(legacyAgentDir, "models.json"),
		JSON.stringify({
			providers: {
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": { name: "Legacy startup override" },
					},
				},
			},
		}),
	);
}

function writeCustomModels(path: string, models: Array<{ id: string; name?: string }>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({
		providers: {
			"project-probe": {
				baseUrl: "https://example.test/v1",
				api: "openai-completions",
				apiKey: "test-key",
				models,
			},
		},
	}));
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
	it("loads legacy and primary models.json layers during normal CLI startup", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-model-paths-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		writeLegacyOverride(home);
		const agentDir = join(home, ".atomic", "agent");
		mkdirSync(agentDir, { recursive: true });

		const services = await createAgentSessionServices({
			cwd: home,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager: SettingsManager.inMemory(),
		});

		expect(services.modelRegistry.find("openrouter", "anthropic/claude-sonnet-4")?.name).toBe(
			"Legacy startup override",
		);
	});

	it("loads project .atomic/models.json during normal CLI startup", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-project-models-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		const cwd = join(home, "project");
		mkdirSync(cwd);
		writeCustomModel(join(cwd, ".atomic", "models.json"), "atomic-1995-reload-probe");

		const services = await createAgentSessionServices({
			cwd,
			agentDir: join(home, ".atomic", "agent"),
			authStorage: AuthStorage.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		expect(services.modelRegistry.find("project-probe", "atomic-1995-reload-probe")?.name).toBe(
			"atomic-1995-reload-probe",
		);
	});

	it("layers Pi global/project before Atomic global/project and reloads raw IDs verbatim", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-layered-models-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		const cwd = join(home, "project");
		const agentDir = join(home, ".atomic", "agent");
		mkdirSync(cwd);
		const sharedId = "shared[raw]-model";
		const layers = [
			[join(home, ".pi", "agent", "models.json"), "pi-global", "Pi global"],
			[join(cwd, ".pi", "models.json"), "pi-project", "Pi project"],
			[join(agentDir, "models.json"), "atomic-global", "Atomic global"],
			[join(cwd, ".atomic", "models.json"), "atomic-project", "Atomic project"],
		] as const;
		for (const [path, uniqueId, sharedName] of layers) {
			writeCustomModels(path, [{ id: uniqueId }, { id: sharedId, name: sharedName }]);
		}

		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		expect(layers.map(([, id]) => services.modelRegistry.find("project-probe", id)?.id)).toEqual(
			layers.map(([, id]) => id),
		);
		expect(services.modelRegistry.find("project-probe", sharedId)?.name).toBe("Atomic project");

		writeCustomModels(join(cwd, ".atomic", "models.json"), [
			{ id: "atomic-project-after" },
			{ id: sharedId, name: "Atomic project after reload" },
		]);
		await services.modelRegistry.refresh({ allowNetwork: false });
		expect(services.modelRegistry.find("project-probe", "atomic-project")).toBeUndefined();
		expect(services.modelRegistry.find("project-probe", "atomic-project-after")?.id).toBe("atomic-project-after");
		expect(services.modelRegistry.find("project-probe", sharedId)?.name).toBe("Atomic project after reload");
	});

	it("does not load project models while the project is untrusted", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-untrusted-models-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		const cwd = join(home, "project");
		const agentDir = join(home, ".atomic", "agent");
		mkdirSync(cwd);
		writeCustomModel(join(cwd, ".atomic", "models.json"), "untrusted-project-model");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });

		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		expect(services.modelRegistry.find("project-probe", "untrusted-project-model")).toBeUndefined();
	});

	it("loads project models after startup trust resolution accepts the project", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-trusted-models-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		const cwd = join(home, "project");
		const agentDir = join(home, ".atomic", "agent");
		mkdirSync(cwd);
		writeCustomModel(join(cwd, ".atomic", "models.json"), "newly-trusted-project-model");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });

		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
			resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
		});

		expect(services.modelRegistry.find("project-probe", "newly-trusted-project-model")?.id).toBe(
			"newly-trusted-project-model",
		);
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
		const explicitRegistry = ModelRegistry.create(AuthStorage.inMemory(), explicitPath);

		const services = await createAgentSessionServices({
			cwd,
			agentDir: join(home, ".atomic", "agent"),
			modelRegistry: explicitRegistry,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		expect(services.modelRegistry).toBe(explicitRegistry);
		expect(services.modelRegistry.find("project-probe", "explicit-only")?.id).toBe("explicit-only");
		expect(services.modelRegistry.find("project-probe", "project-only")).toBeUndefined();
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
			authStorage: AuthStorage.inMemory(),
			modelsPath: explicitPath,
			allowModelNetwork: false,
		});

		expect(runtime.getModel("project-probe", "api-explicit-only")?.id).toBe("api-explicit-only");
		expect(runtime.getModel("project-probe", "project-default-only")).toBeUndefined();
	});

	it("keeps a custom agent directory isolated while still layering project models", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-custom-model-paths-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		writeLegacyOverride(home);
		const customAgentDir = join(home, "custom-agent");
		const cwd = join(home, "project");
		mkdirSync(cwd);
		writeCustomModel(join(customAgentDir, "models.json"), "custom-global");
		writeCustomModel(join(cwd, ".atomic", "models.json"), "custom-project");

		const services = await createAgentSessionServices({
			cwd,
			agentDir: customAgentDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		expect(services.modelRegistry.find("project-probe", "custom-global")?.id).toBe("custom-global");
		expect(services.modelRegistry.find("project-probe", "custom-project")?.id).toBe("custom-project");
		expect(services.modelRegistry.find("openrouter", "anthropic/claude-sonnet-4")?.name).not.toBe(
			"Legacy startup override",
		);
	});
});
