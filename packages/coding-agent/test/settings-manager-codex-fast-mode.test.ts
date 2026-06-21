import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_CODEX_FAST_MODE } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager codexFastMode", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let previousCodexFastModeEnv: string | undefined;

	beforeEach(() => {
		previousCodexFastModeEnv = process.env[ENV_CODEX_FAST_MODE];
		delete process.env[ENV_CODEX_FAST_MODE];
		tempDir = join(tmpdir(), `atomic-codex-fast-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		if (previousCodexFastModeEnv === undefined) {
			delete process.env[ENV_CODEX_FAST_MODE];
		} else {
			process.env[ENV_CODEX_FAST_MODE] = previousCodexFastModeEnv;
		}
	});

	it("defaults chat and workflow fast mode to disabled", () => {
		const manager = SettingsManager.inMemory();

		expect(manager.getCodexFastModeSettings()).toEqual({ chat: false, workflow: false });
	});

	it("persists chat and workflow fast mode settings", async () => {
		const manager = SettingsManager.create(cwd, agentDir);

		manager.setCodexFastModeSettings({ chat: true, workflow: false });
		await manager.flush();

		expect(manager.getCodexFastModeSettings()).toEqual({ chat: true, workflow: false });
		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(saved.codexFastMode).toEqual({ chat: true, workflow: false });
	});

	it("merges missing nested fields from global and project settings", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ codexFastMode: { chat: true } }, null, 2),
		);
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(
			join(cwd, ".atomic", "settings.json"),
			JSON.stringify({ codexFastMode: { workflow: true } }, null, 2),
		);

		const manager = SettingsManager.create(cwd, agentDir);

		expect(manager.getCodexFastModeSettings()).toEqual({ chat: true, workflow: true });
	});

	it("updates project overrides that would otherwise mask fast mode changes", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ codexFastMode: { chat: false, workflow: false } }, null, 2),
		);
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(
			join(cwd, ".atomic", "settings.json"),
			JSON.stringify({ codexFastMode: { workflow: false } }, null, 2),
		);
		const manager = SettingsManager.create(cwd, agentDir);

		manager.setCodexFastModeSettings({ chat: false, workflow: true });
		await manager.flush();

		expect(manager.getCodexFastModeSettings()).toEqual({ chat: false, workflow: true });
		const savedGlobal = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		const savedProject = JSON.parse(readFileSync(join(cwd, ".atomic", "settings.json"), "utf-8"));
		expect(savedGlobal.codexFastMode).toEqual({ chat: false, workflow: true });
		expect(savedProject.codexFastMode).toEqual({ workflow: true });
	});

	it("honors inherited runtime fast mode settings over persisted settings", () => {
		const previous = process.env[ENV_CODEX_FAST_MODE];
		process.env[ENV_CODEX_FAST_MODE] = "chat=1;workflow=0";
		try {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ codexFastMode: { chat: false, workflow: true } }, null, 2),
			);

			const manager = SettingsManager.create(cwd, agentDir);

			expect(manager.getCodexFastModeSettings()).toEqual({ chat: true, workflow: false });
		} finally {
			if (previous === undefined) {
				delete process.env[ENV_CODEX_FAST_MODE];
			} else {
				process.env[ENV_CODEX_FAST_MODE] = previous;
			}
		}
	});

	it("updates runtime fast mode overrides when settings change", async () => {
		const previous = process.env[ENV_CODEX_FAST_MODE];
		process.env[ENV_CODEX_FAST_MODE] = "chat=0;workflow=0";
		try {
			const manager = SettingsManager.inMemory();

			manager.setCodexFastModeSettings({ chat: true });
			await manager.flush();

			expect(manager.getCodexFastModeSettings()).toEqual({ chat: true, workflow: false });
		} finally {
			if (previous === undefined) {
				delete process.env[ENV_CODEX_FAST_MODE];
			} else {
				process.env[ENV_CODEX_FAST_MODE] = previous;
			}
		}
	});

	it("does not clobber untouched global fast mode fields with project overrides", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ codexFastMode: { chat: false, workflow: true } }, null, 2),
		);
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(
			join(cwd, ".atomic", "settings.json"),
			JSON.stringify({ codexFastMode: { workflow: false } }, null, 2),
		);
		const manager = SettingsManager.create(cwd, agentDir);

		manager.setCodexFastModeSettings({ chat: true });
		await manager.flush();

		expect(manager.getCodexFastModeSettings()).toEqual({ chat: true, workflow: false });
		const savedGlobal = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		const savedProject = JSON.parse(readFileSync(join(cwd, ".atomic", "settings.json"), "utf-8"));
		expect(savedGlobal.codexFastMode).toEqual({ chat: true, workflow: true });
		expect(savedProject.codexFastMode).toEqual({ workflow: false });
	});
});
