import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
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

	it("keeps an explicitly configured agent directory isolated", async () => {
		const home = mkdtempSync(join(tmpdir(), "atomic-service-custom-model-paths-"));
		tempDirs.push(home);
		configureTemporaryHome(home);
		writeLegacyOverride(home);
		const customAgentDir = join(home, "custom-agent");
		mkdirSync(customAgentDir, { recursive: true });

		const services = await createAgentSessionServices({
			cwd: home,
			agentDir: customAgentDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager: SettingsManager.inMemory(),
		});

		expect(services.modelRegistry.find("openrouter", "anthropic/claude-sonnet-4")?.name).not.toBe(
			"Legacy startup override",
		);
	});
});
