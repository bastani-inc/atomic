import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager bash interceptor settings", () => {
	const testDir = join(process.cwd(), "test-settings-bash-interceptor-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => { rmSync(testDir, { recursive: true, force: true }); mkdirSync(agentDir, { recursive: true }); mkdirSync(join(projectDir, ".pi"), { recursive: true }); });
	afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

	it("defaults off and can be enabled from settings", async () => {
		const settingsPath = join(agentDir, "settings.json");
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getBashInterceptorEnabled()).toBe(false);
		manager.setBashInterceptorEnabled(true);
		await manager.flush();
		expect(manager.getBashInterceptorEnabled()).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ bashInterceptor: { enabled: true } });
	});
});
