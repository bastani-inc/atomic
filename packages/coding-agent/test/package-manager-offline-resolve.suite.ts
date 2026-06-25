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
		it("should skip installing missing package sources when offline", async () => {
			process.env.ATOMIC_OFFLINE = "1";
			settingsManager.setProjectPackages(["npm:missing-package", "git:github.com/example/missing-repo"]);

			const installParsedSourceSpy = vi.spyOn(packageManager as any, "installParsedSource");

			const result = await packageManager.resolve();
			const allResources = [...result.extensions, ...result.skills, ...result.prompts, ...result.themes];
			expect(allResources.some((r) => r.metadata.origin === "package")).toBe(false);
			expect(installParsedSourceSpy).not.toHaveBeenCalled();
		});

		it("should skip refreshing temporary git sources when offline", async () => {
			process.env.ATOMIC_OFFLINE = "1";
			const gitSource = "git:github.com/example/repo";
			const parsedGitSource = (packageManager as any).parseSource(gitSource);
			const installedPath = (packageManager as any).getGitInstallPath(parsedGitSource, "temporary") as string;

			mkdirSync(join(installedPath, "extensions"), { recursive: true });
			writeFileSync(join(installedPath, "extensions", "index.ts"), "export default function() {};");

			const refreshTemporaryGitSourceSpy = vi.spyOn(packageManager as any, "refreshTemporaryGitSource");

			const result = await packageManager.resolveExtensionSources([gitSource], { temporary: true });
			expect(result.extensions.some((r) => pathEndsWith(r.path, "extensions/index.ts") && r.enabled)).toBe(true);
			expect(refreshTemporaryGitSourceSpy).not.toHaveBeenCalled();
		});

		it("should not run npm view during resolve for installed unpinned packages", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(join(installedPath, "extensions"), { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			writeFileSync(join(installedPath, "extensions", "index.ts"), "export default function() {};");
			settingsManager.setProjectPackages(["npm:example"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture");

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => pathEndsWith(r.path, "extensions/index.ts") && r.enabled)).toBe(true);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
		});

		for (const tag of ["latest", "beta"] as const) {
			it(`should resolve installed npm ${tag} dist-tag packages offline without registry or install`, async () => {
				process.env.ATOMIC_OFFLINE = "1";
				const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
				const extensionPath = join(installedPath, "extensions", `${tag}.ts`);
				mkdirSync(join(installedPath, "extensions"), { recursive: true });
				writeFileSync(
					join(installedPath, "package.json"),
					JSON.stringify({
						name: "example",
						version: "1.0.0",
						atomic: { extensions: [`extensions/${tag}.ts`] },
					}),
				);
				writeFileSync(extensionPath, `export default function ${tag}() {};`);
				settingsManager.setProjectPackages([`npm:example@${tag}`]);

				const internals = packageManager as object as PackageManagerInternals;
				const runCommandCaptureSpy = vi.spyOn(internals, "runCommandCapture");
				const runCommandSpy = vi.spyOn(internals, "runCommand");

				const result = await packageManager.resolve();

				expect(result.extensions.some((r) => r.path === extensionPath && r.enabled)).toBe(true);
				expect(runCommandCaptureSpy).not.toHaveBeenCalled();
				expect(runCommandSpy).not.toHaveBeenCalled();
			});
		}

		it("should skip installed npm packages with mismatched semver selectors while offline", async () => {
			process.env.ATOMIC_OFFLINE = "1";
			const exactPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "exact-example");
			const rangePath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "range-example");
			const exactExtensionPath = join(exactPath, "extensions", "exact.ts");
			const rangeExtensionPath = join(rangePath, "extensions", "range.ts");
			mkdirSync(join(exactPath, "extensions"), { recursive: true });
			mkdirSync(join(rangePath, "extensions"), { recursive: true });
			writeFileSync(
				join(exactPath, "package.json"),
				JSON.stringify({
					name: "exact-example",
					version: "1.0.0",
					atomic: { extensions: ["extensions/exact.ts"] },
				}),
			);
			writeFileSync(
				join(rangePath, "package.json"),
				JSON.stringify({
					name: "range-example",
					version: "1.0.0",
					atomic: { extensions: ["extensions/range.ts"] },
				}),
			);
			writeFileSync(exactExtensionPath, "export default function exact() {};");
			writeFileSync(rangeExtensionPath, "export default function range() {};");
			settingsManager.setProjectPackages(["npm:exact-example@2.0.0", "npm:range-example@^2.0.0"]);

			const internals = packageManager as object as PackageManagerInternals;
			const runCommandCaptureSpy = vi.spyOn(internals, "runCommandCapture");
			const runCommandSpy = vi.spyOn(internals, "runCommand");

			const result = await packageManager.resolve();

			expect(result.extensions.some((r) => r.path === exactExtensionPath)).toBe(false);
			expect(result.extensions.some((r) => r.path === rangeExtensionPath)).toBe(false);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
			expect(runCommandSpy).not.toHaveBeenCalled();
		});

		it("should resolve installed npm packages that satisfy configured ranges without reinstalling", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			mkdirSync(join(installedPath, "extensions"), { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.2.0" }));
			writeFileSync(join(installedPath, "extensions", "index.ts"), "export default function() {};");
			settingsManager.setProjectPackages(["npm:example@^1.0.0"]);

			const runCommandSpy = vi.spyOn(packageManager as object as PackageManagerInternals, "runCommand");

			const result = await packageManager.resolve();

			expect(result.extensions.some((r) => pathEndsWith(r.path, "extensions/index.ts") && r.enabled)).toBe(true);
			expect(runCommandSpy).not.toHaveBeenCalled();
		});

		it("should reinstall stale managed npm dist-tag packages when the resolved tag target differs", async () => {
			const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
			const staleExtensionPath = join(installedPath, "extensions", "stale.ts");
			const managedExtensionPath = join(installedPath, "extensions", "managed.ts");
			mkdirSync(join(installedPath, "extensions"), { recursive: true });
			writeFileSync(
				join(installedPath, "package.json"),
				JSON.stringify({
					name: "example",
					version: "1.0.0",
					atomic: { extensions: ["extensions/stale.ts"] },
				}),
			);
			writeFileSync(staleExtensionPath, "export default function stale() {};");
			settingsManager.setProjectPackages(["npm:example@latest"]);

			const internals = packageManager as object as PackageManagerInternals;
			const runCommandCaptureSpy = vi.spyOn(internals, "runCommandCapture").mockResolvedValue('"2.0.0"');
			const runCommandSpy = vi.spyOn(internals, "runCommand").mockImplementation(async (command, args) => {
				expect(command).toBe("npm");
				expect(args).toEqual([
					"install",
					"example@latest",
					"--prefix",
					join(tempDir, CONFIG_DIR_NAME, "npm"),
					"--legacy-peer-deps",
				]);
				writeFileSync(
					join(installedPath, "package.json"),
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
			expect(result.extensions.some((r) => r.path === staleExtensionPath)).toBe(false);
			expect(runCommandCaptureSpy).toHaveBeenCalledTimes(2);
			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example@latest", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).toHaveBeenCalledTimes(1);
		});

	});
});
