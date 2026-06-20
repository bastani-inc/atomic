import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultPackageManager, type ProgressEvent, type ResolvedResource } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { shouldUseWindowsShell } from "../src/utils/child-process.ts";

function normalizeForMatch(value: string): string {
	return value.replace(/\\/g, "/");
}

function pathEndsWith(actualPath: string, suffix: string): boolean {
	return normalizeForMatch(actualPath).endsWith(normalizeForMatch(suffix));
}

class MockSpawnedProcess extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();

	kill(): boolean {
		this.emit("close", null, "SIGTERM");
		return true;
	}
}

interface ParsedNpmSourceForTest {
	type: "npm";
	spec: string;
	name: string;
	version?: string;
	range?: string;
	pinned: boolean;
}

type ParsedSourceForTest = ParsedNpmSourceForTest | { type: "git" | "local" };

interface PackageManagerInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runCommandSync(command: string, args: string[]): string;
	runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string>;
	parseSource(source: string): ParsedSourceForTest;
	getLocalGitUpdateTarget(installedPath: string): Promise<{ ref: string; head: string; fetchArgs: string[] }>;
}

// Helper to check if a resource is enabled
const isEnabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && r.enabled
		: normalizedPath.includes(normalizedMatch) && r.enabled;
};

const isDisabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && !r.enabled
		: normalizedPath.includes(normalizedMatch) && !r.enabled;
};

describe("DefaultPackageManager", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let previousOfflineEnv: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.ATOMIC_OFFLINE;
		delete process.env.ATOMIC_OFFLINE;
		tempDir = join(tmpdir(), `pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (previousOfflineEnv === undefined) {
			delete process.env.ATOMIC_OFFLINE;
		} else {
			process.env.ATOMIC_OFFLINE = previousOfflineEnv;
		}
		vi.restoreAllMocks();
		const viWithUnstub = vi as typeof vi & { unstubAllGlobals?: () => void };
		viWithUnstub.unstubAllGlobals?.();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("offline mode and network timeouts", () => {
		it("should reinstall pinned npm packages when installed version does not match", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example@2.0.0"]);

			const installParsedSourceSpy = vi
				.spyOn(packageManager as any, "installParsedSource")
				.mockResolvedValue(undefined);

			await packageManager.resolve();
			expect(installParsedSourceSpy).toHaveBeenCalledTimes(1);
		});

		it("should not check package updates when offline", async () => {
			process.env.ATOMIC_OFFLINE = "1";
			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture");

			const updates = await packageManager.checkForAvailableUpdates();
			expect(updates).toEqual([]);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
		});

		it("should report updates for installed unpinned npm packages", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example"]);

			vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');

			const updates = await packageManager.checkForAvailableUpdates();
			expect(updates).toEqual([
				{
					source: "npm:example",
					displayName: "example",
					type: "npm",
					scope: "project",
				},
			]);
		});

		it("should report available updates for installed npm dist-tag packages", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example@beta"]);

			const internals = packageManager as object as PackageManagerInternals;
			const runCommandCaptureSpy = vi.spyOn(internals, "runCommandCapture").mockResolvedValue('"2.0.0"');

			const updates = await packageManager.checkForAvailableUpdates();

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example@beta", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(updates).toEqual([
				{
					source: "npm:example@beta",
					displayName: "example",
					type: "npm",
					scope: "project",
				},
			]);
		});

		it("should skip pinned packages when checking for updates", async () => {
			const installedNpmPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(installedNpmPath, { recursive: true });
			writeFileSync(join(installedNpmPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			const parsedGitSource = (packageManager as any).parseSource("git:github.com/example/repo@v1");
			const installedGitPath = (packageManager as any).getGitInstallPath(parsedGitSource, "project") as string;
			mkdirSync(installedGitPath, { recursive: true });

			settingsManager.setProjectPackages(["npm:example@1.0.0", "git:github.com/example/repo@v1"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture");
			const gitUpdateSpy = vi.spyOn(packageManager as any, "gitHasAvailableUpdate");

			const updates = await packageManager.checkForAvailableUpdates();
			expect(updates).toEqual([]);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
			expect(gitUpdateSpy).not.toHaveBeenCalled();
		});

		it("should use npm view to fetch latest version", async () => {
			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');

			const latest = await (packageManager as any).getLatestNpmVersion("example");
			expect(latest).toBe("1.2.3");
			expect(runCommandCaptureSpy).toHaveBeenCalledTimes(1);
			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
		});

		it("should use npmCommand argv for npm update checks", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "npm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');

			const latest = await (packageManager as any).getLatestNpmVersion("@scope/pkg");
			expect(latest).toBe("1.2.3");
			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"mise",
				["exec", "node@20", "--", "npm", "view", "@scope/pkg", "version", "--json"],
				expect.objectContaining({ cwd: tempDir }),
			);
		});

		it("should wait for close before resolving captured stdout", async () => {
			const managerWithInternals = packageManager as unknown as {
				spawnCaptureCommand(
					command: string,
					args: string[],
					options?: { cwd?: string; env?: Record<string, string> },
				): MockSpawnedProcess;
				runCommandCapture(
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				): Promise<string>;
			};
			const child = new MockSpawnedProcess();
			vi.spyOn(managerWithInternals, "spawnCaptureCommand").mockReturnValue(child);

			let settled = false;
			const capturePromise = managerWithInternals.runCommandCapture("git", ["rev-parse", "HEAD"]).then((value) => {
				settled = true;
				return value;
			});

			child.emit("exit", 0, null);
			await Promise.resolve();
			expect(settled).toBe(false);

			child.stdout.write("abc123\n");
			child.stdout.end();
			child.emit("close", 0, null);

			await expect(capturePromise).resolves.toBe("abc123");
		});
	});
});
