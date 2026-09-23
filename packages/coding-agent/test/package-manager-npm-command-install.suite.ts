import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { DefaultPackageManager, type ResolvedResource } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function normalizeForMatch(value: string): string {
	return value.replace(/\\/g, "/");
}

function _pathEndsWith(actualPath: string, suffix: string): boolean {
	return normalizeForMatch(actualPath).endsWith(normalizeForMatch(suffix));
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

interface CallRecorder {
	mock: { calls: unknown[][] };
}

function withoutTrailingUndefined(args: readonly unknown[]): unknown[] {
	const trimmed = [...args];
	while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop();
	return trimmed;
}

function wasCalledWith(spy: CallRecorder, expected: readonly unknown[]): boolean {
	const wanted = withoutTrailingUndefined(expected);
	return spy.mock.calls.some((call) => isDeepStrictEqual(withoutTrailingUndefined(call), wanted));
}

function assertCalledWith(spy: CallRecorder, ...expected: unknown[]): void {
	assert.ok(
		wasCalledWith(spy, expected),
		`expected call ${JSON.stringify(expected)}, got ${JSON.stringify(spy.mock.calls)}`,
	);
}

function assertNotCalledWith(spy: CallRecorder, ...unexpected: unknown[]): void {
	assert.ok(!wasCalledWith(spy, unexpected), `unexpected call ${JSON.stringify(unexpected)}`);
}

function rejectsWithMessage(fragment: string): (error: Error) => boolean {
	return (error) => error.message.includes(fragment);
}

// Helper to check if a resource is enabled
const _isEnabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && r.enabled
		: normalizedPath.includes(normalizedMatch) && r.enabled;
};

const _isDisabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
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

			assertCalledWith(
				runCommandSpy,
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

			assertCalledWith(
				runCommandSpy,
				"mise",
				["exec", "bun@1", "--", "bun", "install", "@scope/pkg", "--cwd", join(agentDir, "npm"), "--omit=peer"],
				undefined,
			);
		});

		it("should install git package dependencies without auto-installing peers", async () => {
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

			assertCalledWith(runCommandSpy, "npm", ["install", "--omit=dev", "--legacy-peer-deps"], {
				cwd: targetDir,
			});
		});

		it("should reject unsafe pinned git refs before invoking git", async () => {
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			mkdirSync(targetDir, { recursive: true });
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await assert.rejects(
				packageManager.install("git:github.com/user/repo@--upload-pack=sh"),
				rejectsWithMessage("Invalid git ref"),
			);

			assert.equal(runCommandSpy.mock.calls.length, 0);
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

			assertCalledWith(runCommandSpy, "git", ["fetch", "origin", "--", "v2"], { cwd: targetDir });
			assertCalledWith(runCommandSpy, "git", ["reset", "--hard", "FETCH_HEAD^{commit}"], {
				cwd: targetDir,
			});
			assertCalledWith(runCommandSpy, "git", ["clean", "-fdx"], { cwd: targetDir });
			assertCalledWith(runCommandSpy, "npm", ["install", "--omit=dev", "--legacy-peer-deps"], {
				cwd: targetDir,
			});
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

			assertCalledWith(runCommandSpy, "git", fetchArgs, { cwd: targetDir });
			assertCalledWith(runCommandSpy, "git", ["reset", "--hard", "origin/HEAD^{commit}"], {
				cwd: targetDir,
			});
			assertCalledWith(runCommandSpy, "git", ["clean", "-fdx"], { cwd: targetDir });
		});

		it("should prefer the package manager after a separator over the outer executable (#9863)", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["npm", "exec", "--", "pnpm"],
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

			assertCalledWith(
				runCommandSpy,
				"npm",
				[
					"exec",
					"--",
					"pnpm",
					"install",
					"--prod",
					"--config.auto-install-peers=false",
					"--config.strict-peer-dependencies=false",
					"--config.strict-dep-builds=false",
				],
				{ cwd: targetDir },
			);
		});

		it("should detect pnpm through a corepack wrapper without a separator (#9863)", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["corepack", "pnpm"],
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

			assertCalledWith(
				runCommandSpy,
				"corepack",
				[
					"pnpm",
					"install",
					"--prod",
					"--config.auto-install-peers=false",
					"--config.strict-peer-dependencies=false",
					"--config.strict-dep-builds=false",
				],
				{ cwd: targetDir },
			);
		});

		it("should reject npmCommand wrappers that name more than one package manager", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["corepack", "pnpm", "bun"],
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

			await assert.rejects(
				packageManager.install(source),
				rejectsWithMessage("Ambiguous npmCommand package managers: pnpm, bun"),
			);

			assert.ok(
				!runCommandSpy.mock.calls.some(
					([command, , options]) => command === "corepack" && isDeepStrictEqual(options, { cwd: targetDir }),
				),
			);
		});

		it("should disable peer installation for git package dependencies with bun", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["bun"],
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

			assertCalledWith(runCommandSpy, "bun", ["install", "--omit=dev", "--omit=peer"], {
				cwd: targetDir,
			});
		});

		it("should update git package dependencies without auto-installing peers", async () => {
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

			assertCalledWith(runCommandSpy, "npm", ["install", "--omit=dev", "--legacy-peer-deps"], {
				cwd: targetDir,
			});
		});

		it("repairs missing git dependencies when the checkout is already current", async () => {
			const source = "git:github.com/user/repo";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			const fetchArgs = ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(
				join(targetDir, "package.json"),
				JSON.stringify({ name: "repo", version: "1.0.0", dependencies: { dependency: "1.0.0" } }),
			);
			settingsManager.setPackages([source]);

			const managerWithInternals = packageManager as unknown as PackageManagerInternals;
			vi.spyOn(managerWithInternals, "getLocalGitUpdateTarget").mockResolvedValue({
				ref: "@{upstream}",
				head: "current-head",
				fetchArgs,
			});
			vi.spyOn(managerWithInternals, "runCommandCapture").mockResolvedValue("current-head");
			const runCommandSpy = vi.spyOn(managerWithInternals, "runCommand").mockResolvedValue(undefined);

			await packageManager.update(source);

			assertCalledWith(runCommandSpy, "npm", ["install", "--omit=dev", "--legacy-peer-deps"], {
				cwd: targetDir,
			});
			assertNotCalledWith(runCommandSpy, "git", ["clean", "-fdx"], { cwd: targetDir });
		});

		it("retries an incomplete git update before clearing its repair marker", async () => {
			const source = "git:github.com/user/repo";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			const markerPath = join(dirname(targetDir), `.repo.${APP_NAME}-update-incomplete`);
			const fetchArgs = ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(
				join(targetDir, "package.json"),
				JSON.stringify({ name: "repo", version: "1.0.0", dependencies: { dependency: "1.0.0" } }),
			);
			settingsManager.setPackages([source]);

			const managerWithInternals = packageManager as unknown as PackageManagerInternals;
			vi.spyOn(managerWithInternals, "getLocalGitUpdateTarget").mockResolvedValue({
				ref: "@{upstream}",
				head: "new-head",
				fetchArgs,
			});
			let localHead = "old-head";
			vi.spyOn(managerWithInternals, "runCommandCapture").mockImplementation(async (_command, args) =>
				args[1] === "HEAD" ? localHead : "new-head",
			);
			let failedClean = false;
			const runCommandSpy = vi
				.spyOn(managerWithInternals, "runCommand")
				.mockImplementation(async (_command, args) => {
					if (args[0] === "reset") localHead = "new-head";
					if (args[0] === "clean" && !failedClean) {
						failedClean = true;
						assert.equal(existsSync(markerPath), true);
						throw new Error("simulated clean failure");
					}
				});

			await assert.rejects(packageManager.update(source), rejectsWithMessage("simulated clean failure"));
			assert.equal(existsSync(markerPath), true);

			await packageManager.update(source);

			assertCalledWith(runCommandSpy, "git", ["clean", "-fdx"], { cwd: targetDir });
			assert.equal(existsSync(markerPath), false);
		});

		it("repairs deleted git dependencies when cleaning fails", async () => {
			const source = "git:github.com/user/repo";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			const fetchArgs = ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(
				join(targetDir, "package.json"),
				JSON.stringify({ name: "repo", version: "1.0.0", dependencies: { dependency: "1.0.0" } }),
			);
			settingsManager.setPackages([source]);

			const managerWithInternals = packageManager as unknown as PackageManagerInternals;
			vi.spyOn(managerWithInternals, "getLocalGitUpdateTarget").mockResolvedValue({
				ref: "@{upstream}",
				head: "new-head",
				fetchArgs,
			});
			vi.spyOn(managerWithInternals, "runCommandCapture").mockImplementation(async (_command, args) =>
				args[1] === "HEAD" ? "old-head" : "new-head",
			);
			const runCommandSpy = vi
				.spyOn(managerWithInternals, "runCommand")
				.mockImplementation(async (_command, args) => {
					if (args[0] === "clean") throw new Error("simulated clean failure");
				});

			await assert.rejects(packageManager.update(source), rejectsWithMessage("simulated clean failure"));

			assertCalledWith(runCommandSpy, "npm", ["install", "--omit=dev", "--legacy-peer-deps"], {
				cwd: targetDir,
			});
		});
		it("should disable peer installation through wrapped pnpm when updating git dependencies", async () => {
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

			assertCalledWith(
				runCommandSpy,
				"mise",
				[
					"exec",
					"node@20",
					"--",
					"pnpm",
					"install",
					"--prod",
					"--config.auto-install-peers=false",
					"--config.strict-peer-dependencies=false",
					"--config.strict-dep-builds=false",
				],
				{ cwd: targetDir },
			);
		});
	});
});
