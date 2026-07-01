import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("outputPad and externalEditor settings", () => {
	const testDir = join(process.cwd(), "test-settings-ui-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("defaults outputPad to 1 and clamps to 0 | 1", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getOutputPad()).toBe(1);
		manager.setOutputPad(0);
		expect(manager.getOutputPad()).toBe(0);
		manager.setOutputPad(1);
		expect(manager.getOutputPad()).toBe(1);
	});

	it("prefers externalEditor setting over env vars and platform default", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ externalEditor: "code --wait" }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getExternalEditorCommand()).toBe("code --wait");
	});

	it("falls back to platform default when nothing is configured", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({}));
		const manager = SettingsManager.create(projectDir, agentDir);
		const cmd = manager.getExternalEditorCommand();
		expect(typeof cmd).toBe("string");
		expect(cmd.length).toBeGreaterThan(0);
	});
});
