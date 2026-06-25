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
		it("should use npmCommand argv for npm root lookup and invalidate cached root when npmCommand changes", () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "npm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const root20 = join(tempDir, "node20", "lib", "node_modules");
			const root22 = join(tempDir, "node22", "lib", "node_modules");
			mkdirSync(join(root20, "@scope", "pkg"), { recursive: true });

			const runCommandSyncSpy = vi
				.spyOn(packageManager as any, "runCommandSync")
				.mockImplementation((...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command !== "mise") {
						throw new Error(`unexpected command ${command}`);
					}
					if (args[1] === "node@20") {
						return root20;
					}
					if (args[1] === "node@22") {
						return root22;
					}
					throw new Error(`unexpected args ${args.join(" ")}`);
				});

			expect(packageManager.getInstalledPath("npm:@scope/pkg", "user")).toBe(join(root20, "@scope", "pkg"));
			expect(runCommandSyncSpy).toHaveBeenNthCalledWith(1, "mise", ["exec", "node@20", "--", "npm", "root", "-g"]);

			settingsManager.setNpmCommand(["mise", "exec", "node@22", "--", "npm"]);

			expect(packageManager.getInstalledPath("npm:@scope/pkg", "user")).toBeUndefined();
			expect(runCommandSyncSpy).toHaveBeenNthCalledWith(2, "mise", ["exec", "node@22", "--", "npm", "root", "-g"]);
		});

		it("should install user npm packages into the pi-managed npm root", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["pnpm"],
				packages: ["npm:pnpm-pkg"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const packagePath = join(agentDir, "npm", "node_modules", "pnpm-pkg");
			vi.spyOn(packageManager as any, "runCommandSync").mockImplementation(() => {
				throw new Error("legacy lookup unavailable");
			});
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					expect(command).toBe("pnpm");
					expect(args).toEqual([
						"install",
						"pnpm-pkg",
						"--prefix",
						join(agentDir, "npm"),
						"--config.auto-install-peers=false",
						"--config.strict-peer-dependencies=false",
						"--config.strict-dep-builds=false",
					]);
					mkdirSync(join(packagePath, "extensions"), { recursive: true });
					writeFileSync(join(packagePath, "package.json"), JSON.stringify({ name: "pnpm-pkg", version: "1.0.0" }));
					writeFileSync(join(packagePath, "extensions", "index.ts"), "export default function() {};");
				});

			const first = await packageManager.resolve();
			const second = await packageManager.resolve();

			expect(first.extensions.some((r) => r.path === join(packagePath, "extensions", "index.ts") && r.enabled)).toBe(
				true,
			);
			expect(
				second.extensions.some((r) => r.path === join(packagePath, "extensions", "index.ts") && r.enabled),
			).toBe(true);
			expect(runCommandSpy).toHaveBeenCalledTimes(1);
			expect(packageManager.getInstalledPath("npm:pnpm-pkg", "user")).toBe(packagePath);
		});

		it("should load the managed npm package after installing a range over a stale legacy global package", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["npm"],
				packages: ["npm:example@^2.0.0"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const legacyRoot = join(tempDir, "legacy-global", "node_modules");
			const legacyPath = join(legacyRoot, "example");
			const managedPath = join(agentDir, "npm", "node_modules", "example");
			const legacyExtensionPath = join(legacyPath, "extensions", "legacy.ts");
			const managedExtensionPath = join(managedPath, "extensions", "managed.ts");

			mkdirSync(join(legacyPath, "extensions"), { recursive: true });
			writeFileSync(
				join(legacyPath, "package.json"),
				JSON.stringify({
					name: "example",
					version: "1.0.0",
					atomic: { extensions: ["extensions/legacy.ts"] },
				}),
			);
			writeFileSync(legacyExtensionPath, "export default function legacy() {};");

			const managerWithInternals = packageManager as object as PackageManagerInternals;
			vi.spyOn(managerWithInternals, "runCommandSync").mockImplementation((command, args) => {
				expect(command).toBe("npm");
				expect(args).toEqual(["root", "-g"]);
				return legacyRoot;
			});
			const runCommandSpy = vi.spyOn(managerWithInternals, "runCommand").mockImplementation(async (command, args) => {
				expect(command).toBe("npm");
				expect(args).toEqual([
					"install",
					"example@^2.0.0",
					"--prefix",
					join(agentDir, "npm"),
					"--legacy-peer-deps",
				]);
				mkdirSync(join(managedPath, "extensions"), { recursive: true });
				writeFileSync(
					join(managedPath, "package.json"),
					JSON.stringify({
						name: "example",
						version: "2.0.0",
						atomic: { extensions: ["extensions/managed.ts"] },
					}),
				);
				writeFileSync(managedExtensionPath, "export default function managed() {};");
			});

			const result = await packageManager.resolve();

			expect(result.extensions.some((r) => r.path === managedExtensionPath && r.enabled)).toBe(true);
			expect(result.extensions.some((r) => r.path === legacyExtensionPath)).toBe(false);
			expect(result.extensions.find((r) => r.path === managedExtensionPath)?.metadata.baseDir).toBe(managedPath);
			expect(runCommandSpy).toHaveBeenCalledTimes(1);
		});

		it("should load the managed npm package after a stale legacy global dist-tag install resolves newer", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["npm"],
				packages: ["npm:example@beta"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const legacyRoot = join(tempDir, "legacy-global", "node_modules");
			const legacyPath = join(legacyRoot, "example");
			const managedPath = join(agentDir, "npm", "node_modules", "example");
			const legacyExtensionPath = join(legacyPath, "extensions", "legacy.ts");
			const managedExtensionPath = join(managedPath, "extensions", "managed.ts");

			mkdirSync(join(legacyPath, "extensions"), { recursive: true });
			writeFileSync(
				join(legacyPath, "package.json"),
				JSON.stringify({
					name: "example",
					version: "1.0.0",
					atomic: { extensions: ["extensions/legacy.ts"] },
				}),
			);
			writeFileSync(legacyExtensionPath, "export default function legacy() {};");

			const managerWithInternals = packageManager as object as PackageManagerInternals;
			vi.spyOn(managerWithInternals, "runCommandSync").mockImplementation((command, args) => {
				expect(command).toBe("npm");
				expect(args).toEqual(["root", "-g"]);
				return legacyRoot;
			});
			const runCommandCaptureSpy = vi
				.spyOn(managerWithInternals, "runCommandCapture")
				.mockResolvedValue('"2.0.0"');
			const runCommandSpy = vi.spyOn(managerWithInternals, "runCommand").mockImplementation(async (command, args) => {
				expect(command).toBe("npm");
				expect(args).toEqual([
					"install",
					"example@beta",
					"--prefix",
					join(agentDir, "npm"),
					"--legacy-peer-deps",
				]);
				mkdirSync(join(managedPath, "extensions"), { recursive: true });
				writeFileSync(
					join(managedPath, "package.json"),
					JSON.stringify({
						name: "example",
						version: "2.0.0",
						atomic: { extensions: ["extensions/managed.ts"] },
					}),
				);
				writeFileSync(managedExtensionPath, "export default function managed() {};");
			});

			const result = await packageManager.resolve();

			expect(result.extensions.some((r) => r.path === managedExtensionPath && r.enabled)).toBe(true);
			expect(result.extensions.some((r) => r.path === legacyExtensionPath)).toBe(false);
			expect(result.extensions.find((r) => r.path === managedExtensionPath)?.metadata.baseDir).toBe(managedPath);
			expect(runCommandCaptureSpy).toHaveBeenCalledTimes(2);
			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example@beta", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).toHaveBeenCalledTimes(1);
		});

		it("should load legacy pnpm global package paths from pnpm list output", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["pnpm"],
				packages: ["npm:pnpm-pkg"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const pnpmRoot = join(tempDir, "pnpm", "global", "v11");
			const packagePath = join(pnpmRoot, "20-hash", "node_modules", "pnpm-pkg");
			mkdirSync(join(packagePath, "extensions"), { recursive: true });
			writeFileSync(join(packagePath, "package.json"), JSON.stringify({ name: "pnpm-pkg", version: "1.0.0" }));
			writeFileSync(join(packagePath, "extensions", "index.ts"), "export default function() {};");

			vi.spyOn(packageManager as any, "runCommandSync").mockImplementation((...callArgs: unknown[]) => {
				const [command, args] = callArgs as [string, string[]];
				if (command !== "pnpm") {
					throw new Error(`unexpected command ${command}`);
				}
				if (args.join(" ") === "list -g --depth 0 --json") {
					return JSON.stringify([
						{
							path: pnpmRoot,
							dependencies: { "pnpm-pkg": { version: "1.0.0", path: packagePath } },
						},
					]);
				}
				throw new Error(`unexpected args ${args.join(" ")}`);
			});
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			const result = await packageManager.resolve();

			expect(
				result.extensions.some((r) => r.path === join(packagePath, "extensions", "index.ts") && r.enabled),
			).toBe(true);
			expect(runCommandSpy).not.toHaveBeenCalled();
			expect(packageManager.getInstalledPath("npm:pnpm-pkg", "user")).toBe(packagePath);
		});

		it("should resolve wrapped pnpm global package paths from pnpm list output", () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "pnpm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const pnpmRoot = join(tempDir, "pnpm", "global", "v11");
			const packagePath = join(pnpmRoot, "20-hash", "node_modules", "pnpm-pkg");
			mkdirSync(packagePath, { recursive: true });

			vi.spyOn(packageManager as any, "runCommandSync").mockImplementation((...callArgs: unknown[]) => {
				const [command, args] = callArgs as [string, string[]];
				expect(command).toBe("mise");
				if (args.join(" ") === "exec node@20 -- pnpm list -g --depth 0 --json") {
					return JSON.stringify([{ path: pnpmRoot, dependencies: { "pnpm-pkg": { path: packagePath } } }]);
				}
				throw new Error(`unexpected args ${args.join(" ")}`);
			});

			expect(packageManager.getInstalledPath("npm:pnpm-pkg", "user")).toBe(packagePath);
		});

		it("should ignore malformed legacy pnpm global package lists", () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["pnpm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			vi.spyOn(packageManager as any, "runCommandSync").mockReturnValue("not json");

			expect(packageManager.getInstalledPath("npm:pnpm-pkg", "user")).toBeUndefined();
		});
	});

});
