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
		it("should update project npm packages using @latest when newer version is available", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update("npm:example");

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).toHaveBeenCalledWith(
				"npm",
				["install", "example@latest", "--prefix", join(tempDir, CONFIG_DIR_NAME, "npm"), "--legacy-peer-deps"],
				undefined,
			);
		});

		it("should update npm range packages using the configured spec", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example@^1.0.0"]);

			const internals = packageManager as object as PackageManagerInternals;
			const runCommandCaptureSpy = vi.spyOn(internals, "runCommandCapture").mockResolvedValue('["1.0.0","1.2.0"]');
			const runCommandSpy = vi.spyOn(internals, "runCommand").mockResolvedValue(undefined);

			await packageManager.update("npm:example");

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example@^1.0.0", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).toHaveBeenCalledWith(
				"npm",
				["install", "example@^1.0.0", "--prefix", join(tempDir, CONFIG_DIR_NAME, "npm"), "--legacy-peer-deps"],
				undefined,
			);
		});

		it("should update npm dist-tag packages using the configured tag spec", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example@beta"]);

			const internals = packageManager as object as PackageManagerInternals;
			const runCommandCaptureSpy = vi.spyOn(internals, "runCommandCapture").mockResolvedValue('"2.0.0"');
			const runCommandSpy = vi.spyOn(internals, "runCommand").mockResolvedValue(undefined);

			await packageManager.update("npm:example");

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example@beta", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).toHaveBeenCalledWith(
				"npm",
				["install", "example@beta", "--prefix", join(tempDir, CONFIG_DIR_NAME, "npm"), "--legacy-peer-deps"],
				undefined,
			);
		});

		it("should skip npm range package update when installed version matches the satisfying target", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.3.1" }));
			settingsManager.setProjectPackages(["npm:example@^1.0.0"]);

			const internals = packageManager as object as PackageManagerInternals;
			const runCommandCaptureSpy = vi
				.spyOn(internals, "runCommandCapture")
				.mockResolvedValue('["1.0.0","1.3.1","1.0.2"]');
			const runCommandSpy = vi.spyOn(internals, "runCommand").mockResolvedValue(undefined);

			await packageManager.update("npm:example");

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example@^1.0.0", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).not.toHaveBeenCalled();
		});

		it("should skip project npm update when installed version matches latest", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.2.3" }));
			settingsManager.setProjectPackages(["npm:example"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update("npm:example");

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).not.toHaveBeenCalled();
		});

		it("should migrate legacy user npm installs into the managed npm root during update", async () => {
			const legacyRoot = join(tempDir, "legacy-global", "node_modules");
			const legacyPath = join(legacyRoot, "legacy-pkg");
			const managedPath = join(agentDir, "npm", "node_modules", "legacy-pkg");
			mkdirSync(legacyPath, { recursive: true });
			writeFileSync(join(legacyPath, "package.json"), JSON.stringify({ name: "legacy-pkg", version: "1.0.0" }));
			settingsManager.setPackages(["npm:legacy-pkg"]);

			vi.spyOn(packageManager as any, "getGlobalNpmRoot").mockReturnValue(legacyRoot);
			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.0.0"');
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					expect(command).toBe("npm");
					expect(args).toEqual([
						"install",
						"legacy-pkg@latest",
						"--prefix",
						join(agentDir, "npm"),
						"--legacy-peer-deps",
					]);
					mkdirSync(managedPath, { recursive: true });
					writeFileSync(
						join(managedPath, "package.json"),
						JSON.stringify({ name: "legacy-pkg", version: "1.0.0" }),
					);
				});

			expect(packageManager.getInstalledPath("npm:legacy-pkg", "user")).toBe(legacyPath);

			await packageManager.update("npm:legacy-pkg");

			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
			expect(runCommandSpy).toHaveBeenCalledTimes(1);
			expect(packageManager.getInstalledPath("npm:legacy-pkg", "user")).toBe(managedPath);
		});

		it("should batch npm updates per scope and run git updates in parallel while skipping pinned npm and current packages", async () => {
			const userOldPath = join(agentDir, "npm", "node_modules", "user-old");
			const userCurrentPath = join(agentDir, "npm", "node_modules", "user-current");
			const userUnknownPath = join(agentDir, "npm", "node_modules", "user-unknown");
			const projectOldPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "project-old");
			const projectCurrentPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "project-current");
			const installPaths = [userOldPath, userCurrentPath, userUnknownPath, projectOldPath, projectCurrentPath];
			for (const installPath of installPaths) {
				mkdirSync(installPath, { recursive: true });
			}
			writeFileSync(join(userOldPath, "package.json"), JSON.stringify({ name: "user-old", version: "1.0.0" }));
			writeFileSync(
				join(userCurrentPath, "package.json"),
				JSON.stringify({ name: "user-current", version: "1.0.0" }),
			);
			writeFileSync(
				join(userUnknownPath, "package.json"),
				JSON.stringify({ name: "user-unknown", version: "1.0.0" }),
			);
			writeFileSync(join(projectOldPath, "package.json"), JSON.stringify({ name: "project-old", version: "1.0.0" }));
			writeFileSync(
				join(projectCurrentPath, "package.json"),
				JSON.stringify({ name: "project-current", version: "1.0.0" }),
			);

			settingsManager.setPackages([
				"npm:user-old",
				"npm:user-current",
				"npm:user-unknown",
				"npm:user-pinned@1.0.0",
				"git:github.com/example/user-repo-a",
				"git:github.com/example/user-repo-b",
				"git:github.com/example/user-repo-pinned@v1",
			]);
			settingsManager.setProjectPackages([
				"npm:project-old",
				"npm:project-current",
				"npm:project-missing",
				"git:github.com/example/project-repo-a",
			]);

			const runCommandCaptureSpy = vi
				.spyOn(packageManager as any, "runCommandCapture")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [_command, args] = callArgs as [string, string[]];
					if (args[0] !== "view") {
						throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
					}
					switch (args[1]) {
						case "user-old":
						case "project-old":
							return '"2.0.0"';
						case "user-current":
						case "project-current":
							return '"1.0.0"';
						case "user-unknown":
							throw new Error("registry unavailable");
						default:
							throw new Error(`Unexpected package lookup: ${args[1]}`);
					}
				});

			let activeNpmUpdates = 0;
			let maxConcurrentNpmUpdates = 0;
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command !== "npm") {
						throw new Error(`Unexpected runCommand call: ${command} ${args.join(" ")}`);
					}
					activeNpmUpdates += 1;
					maxConcurrentNpmUpdates = Math.max(maxConcurrentNpmUpdates, activeNpmUpdates);
					await new Promise((resolve) => setTimeout(resolve, 20));
					activeNpmUpdates -= 1;
				});

			let activeGitUpdates = 0;
			let maxConcurrentGitUpdates = 0;
			const updateGitSpy = vi.spyOn(packageManager as any, "updateGit").mockImplementation(async () => {
				activeGitUpdates += 1;
				maxConcurrentGitUpdates = Math.max(maxConcurrentGitUpdates, activeGitUpdates);
				await new Promise((resolve) => setTimeout(resolve, 20));
				activeGitUpdates -= 1;
			});

			await packageManager.update();

			expect(runCommandCaptureSpy).toHaveBeenCalledTimes(5);
			expect(runCommandSpy).toHaveBeenCalledTimes(2);
			expect(runCommandSpy).toHaveBeenNthCalledWith(
				1,
				"npm",
				[
					"install",
					"user-old@latest",
					"user-unknown@latest",
					"--prefix",
					join(agentDir, "npm"),
					"--legacy-peer-deps",
				],
				undefined,
			);
			expect(runCommandSpy).toHaveBeenNthCalledWith(
				2,
				"npm",
				[
					"install",
					"project-old@latest",
					"project-missing@latest",
					"--prefix",
					join(tempDir, CONFIG_DIR_NAME, "npm"),
					"--legacy-peer-deps",
				],
				undefined,
			);
			expect(updateGitSpy).toHaveBeenCalledTimes(4);
			expect(maxConcurrentNpmUpdates).toBeGreaterThan(1);
			expect(maxConcurrentGitUpdates).toBeGreaterThan(1);
		});

		it("should suggest npm source prefixes for update lookups", async () => {
			settingsManager.setProjectPackages(["npm:example"]);

			await expect(packageManager.update("example")).rejects.toThrow(
				"No matching package found for example. Did you mean npm:example?",
			);
		});

		it("should suggest git source prefixes for update lookups", async () => {
			settingsManager.setProjectPackages(["git:github.com/example/repo"]);

			await expect(packageManager.update("github.com/example/repo")).rejects.toThrow(
				"No matching package found for github.com/example/repo. Did you mean git:github.com/example/repo?",
			);
		});
	});
});
