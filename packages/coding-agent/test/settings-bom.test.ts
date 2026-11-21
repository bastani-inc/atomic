import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager BOM-prefixed settings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "settings-bom-"));
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("parses enabledModels identically to a BOM-less settings.json", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, `\uFEFF${JSON.stringify({ enabledModels: ["claude-*"], theme: "dark" })}`);

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getEnabledModels()).toEqual(["claude-*"]);
		expect(manager.getTheme()).toBe("dark");
		expect(manager.drainErrors()).toEqual([]);
	});
});
