import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("package settings updates (#4966)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-package-settings-${process.pid}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "agent"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function managerFor(settingsManager: SettingsManager): DefaultPackageManager {
		return new DefaultPackageManager({ cwd: tempDir, agentDir: join(tempDir, "agent"), settingsManager });
	}

	it("keeps packages another process added to the settings file since startup (#4966)", async () => {
		const first = SettingsManager.create(tempDir, join(tempDir, "agent"));
		const second = SettingsManager.create(tempDir, join(tempDir, "agent"));

		assert.equal(managerFor(first).addSourceToSettings("npm:pkg-a"), true);
		await first.flush();
		assert.equal(managerFor(second).addSourceToSettings("npm:pkg-b"), true);
		await second.flush();
		assert.equal(managerFor(first).removeSourceFromSettings("npm:pkg-a"), true);
		await first.flush();

		const file = JSON.parse(readFileSync(join(tempDir, "agent", "settings.json"), "utf-8")) as { packages: string[] };
		assert.deepEqual(file.packages, ["npm:pkg-b"]);
	});

	it("writes project packages to project settings only, and removes only the matching one (#4966)", async () => {
		const storage = new InMemorySettingsStorage();
		const settingsManager = SettingsManager.fromStorage(storage);
		const manager = managerFor(settingsManager);
		settingsManager.setPackages(["npm:global"]);

		assert.equal(manager.addSourceToSettings("npm:a", { local: true }), true);
		assert.equal(manager.addSourceToSettings("npm:b", { local: true }), true);
		assert.equal(manager.addSourceToSettings("npm:b", { local: true }), false);
		assert.equal(manager.removeSourceFromSettings("npm:a", { local: true }), true);
		assert.equal(manager.removeSourceFromSettings("npm:a", { local: true }), false);
		await settingsManager.flush();

		assert.deepEqual(settingsManager.getProjectSettings().packages, ["npm:b"]);
		assert.deepEqual(settingsManager.getGlobalSettings().packages, ["npm:global"]);
		const reloaded = SettingsManager.fromStorage(storage);
		assert.deepEqual(reloaded.getProjectSettings().packages, ["npm:b"]);
		assert.deepEqual(reloaded.getGlobalSettings().packages, ["npm:global"]);
	});

	it("refuses to change project packages of an untrusted project (#4966)", () => {
		const settingsManager = SettingsManager.fromStorage(new InMemorySettingsStorage(), { projectTrusted: false });

		assert.throws(() => managerFor(settingsManager).addSourceToSettings("npm:a", { local: true }), /not trusted/);
	});

	it("leaves a settings file it could not parse unchanged (#4966)", async () => {
		const path = join(tempDir, "agent", "settings.json");
		writeFileSync(path, "{ not json");
		const settingsManager = SettingsManager.create(tempDir, join(tempDir, "agent"));

		assert.equal(managerFor(settingsManager).addSourceToSettings("npm:a"), true);
		await settingsManager.flush();

		assert.deepEqual(settingsManager.getGlobalSettings().packages, ["npm:a"]);
		assert.equal(readFileSync(path, "utf-8"), "{ not json");
	});

	it("flushes settings to disk before installAndPersist and removeAndPersist resolve (#5315)", async () => {
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		const extDir = join(tempDir, "local-ext");
		mkdirSync(extDir, { recursive: true });

		await managerFor(SettingsManager.create(tempDir, agentDir)).installAndPersist(extDir);
		assert.deepEqual((JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] }).packages, [
			join("..", "local-ext"),
		]);

		const removed = await managerFor(SettingsManager.create(tempDir, agentDir)).removeAndPersist(extDir);
		assert.equal(removed, true);
		assert.deepEqual((JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] }).packages, []);
	});
});
