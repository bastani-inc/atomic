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

	describe("npmCommand", () => {
		it("should use npmCommand argv for npm installs", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "npm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.install("npm:@scope/pkg");

			expect(runCommandSpy).toHaveBeenCalledWith(
				"mise",
				[
					"exec",
					"node@20",
					"--",
					"npm",
					"install",
					"@scope/pkg",
					"--prefix",
					join(agentDir, "npm"),
					"--legacy-peer-deps",
				],
				undefined,
			);
		});

		it("should use bun --cwd for npm package installs", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "bun@1", "--", "bun"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.install("npm:@scope/pkg");

			expect(runCommandSpy).toHaveBeenCalledWith(
				"mise",
				["exec", "bun@1", "--", "bun", "install", "@scope/pkg", "--cwd", join(agentDir, "npm"), "--omit=peer"],
				undefined,
			);
		});

		it("should install git package dependencies with --omit=dev", async () => {
			const source = "git:github.com/user/repo";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command === "git" && args[0] === "clone") {
						mkdirSync(targetDir, { recursive: true });
						writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
					}
				});

			await packageManager.install(source);

			expect(runCommandSpy).toHaveBeenCalledWith("npm", ["install", "--omit=dev"], { cwd: targetDir });
		});

		it("should reject unsafe pinned git refs before invoking git", async () => {
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			mkdirSync(targetDir, { recursive: true });
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await expect(packageManager.install("git:github.com/user/repo@--upload-pack=sh")).rejects.toThrow(
				"Invalid git ref",
			);

			expect(runCommandSpy).not.toHaveBeenCalled();
		});

		it("should reconcile an existing git checkout to a pinned ref during install", async () => {
			const source = "git:github.com/user/repo@v2";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));

			const managerWithInternals = packageManager as unknown as PackageManagerInternals;
			vi.spyOn(managerWithInternals, "runCommandCapture").mockImplementation(async (_command, args) => {
				if (args[0] === "rev-parse" && args[1] === "HEAD") {
					return "old-head";
				}
				if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD^{commit}") {
					return "new-head";
				}
				throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
			});
			const runCommandSpy = vi.spyOn(managerWithInternals, "runCommand").mockResolvedValue(undefined);

			await packageManager.install(source);

			expect(runCommandSpy).toHaveBeenCalledWith("git", ["fetch", "origin", "--", "v2"], { cwd: targetDir });
			expect(runCommandSpy).toHaveBeenCalledWith("git", ["reset", "--hard", "FETCH_HEAD^{commit}"], {
				cwd: targetDir,
			});
			expect(runCommandSpy).toHaveBeenCalledWith("git", ["clean", "-fdx"], { cwd: targetDir });
			expect(runCommandSpy).toHaveBeenCalledWith("npm", ["install", "--omit=dev"], { cwd: targetDir });
		});

		it("should reconcile an existing git checkout to its update target when installing without a ref", async () => {
			const source = "git:github.com/user/repo";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			const fetchArgs = ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
			mkdirSync(targetDir, { recursive: true });

			const managerWithInternals = packageManager as unknown as PackageManagerInternals;
			vi.spyOn(managerWithInternals, "getLocalGitUpdateTarget").mockResolvedValue({
				ref: "origin/HEAD",
				head: "new-head",
				fetchArgs,
			});
			vi.spyOn(managerWithInternals, "runCommandCapture").mockImplementation(async (_command, args) => {
				if (args[0] === "rev-parse" && args[1] === "HEAD") {
					return "old-head";
				}
				if (args[0] === "rev-parse" && args[1] === "origin/HEAD^{commit}") {
					return "new-head";
				}
				throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
			});
			const runCommandSpy = vi.spyOn(managerWithInternals, "runCommand").mockResolvedValue(undefined);

			await packageManager.install(source);

			expect(runCommandSpy).toHaveBeenCalledWith("git", fetchArgs, { cwd: targetDir });
			expect(runCommandSpy).toHaveBeenCalledWith("git", ["reset", "--hard", "origin/HEAD^{commit}"], {
				cwd: targetDir,
			});
			expect(runCommandSpy).toHaveBeenCalledWith("git", ["clean", "-fdx"], { cwd: targetDir });
		});

		it("should use plain install for git package dependencies when npmCommand is configured", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["pnpm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const source = "git:github.com/user/repo";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command === "git" && args[0] === "clone") {
						mkdirSync(targetDir, { recursive: true });
						writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
					}
				});

			await packageManager.install(source);

			expect(runCommandSpy).toHaveBeenCalledWith("pnpm", ["install"], { cwd: targetDir });
		});

		it("should update git package dependencies with --omit=dev", async () => {
			const source = "git:github.com/user/repo";
			const targetDir = join(tempDir, ".pi", "git", "github.com", "user", "repo");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
			settingsManager.setProjectPackages([source]);

			vi.spyOn(packageManager as any, "runCommandCapture").mockImplementation(async (...callArgs: unknown[]) => {
				const [_command, args] = callArgs as [string, string[]];
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") {
					return "origin/main";
				}
				if (args[0] === "rev-parse" && (args[1] === "@{upstream}" || args[1] === "@{upstream}^{commit}")) {
					return "remote-head";
				}
				if (args[0] === "rev-parse" && args[1] === "HEAD") {
					return "local-head";
				}
				throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
			});
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update(source);

			expect(runCommandSpy).toHaveBeenCalledWith("npm", ["install", "--omit=dev"], { cwd: targetDir });
		});

		it("should use plain install through npmCommand argv when updating git package dependencies", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "pnpm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const source = "git:github.com/user/repo";
			const targetDir = join(tempDir, ".pi", "git", "github.com", "user", "repo");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
			settingsManager.setProjectPackages([source]);

			vi.spyOn(packageManager as any, "runCommandCapture").mockImplementation(async (...callArgs: unknown[]) => {
				const [_command, args] = callArgs as [string, string[]];
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") {
					return "origin/main";
				}
				if (args[0] === "rev-parse" && (args[1] === "@{upstream}" || args[1] === "@{upstream}^{commit}")) {
					return "remote-head";
				}
				if (args[0] === "rev-parse" && args[1] === "HEAD") {
					return "local-head";
				}
				throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
			});
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update(source);

			expect(runCommandSpy).toHaveBeenCalledWith("mise", ["exec", "node@20", "--", "pnpm", "install"], {
				cwd: targetDir,
			});
		});
	});
});
