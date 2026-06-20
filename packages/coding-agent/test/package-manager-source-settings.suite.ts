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

	describe("source parsing", () => {
		it("should emit progress events on install attempt", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			// Use public install method which emits progress events
			try {
				await packageManager.install("npm:nonexistent-package@1.0.0");
			} catch {
				// Expected to fail - package doesn't exist
			}

			// Should have emitted start event before failure
			expect(events.some((e) => e.type === "start" && e.action === "install")).toBe(true);
			// Should have emitted error event
			expect(events.some((e) => e.type === "error")).toBe(true);
		});

		it("should recognize github URLs without git: prefix", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));
			const previousGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
			process.env.GIT_TERMINAL_PROMPT = "0";

			try {
				// This should be parsed as a git source, not throw "unsupported"
				try {
					await packageManager.install("https://github.com/nonexistent/repo");
				} catch {
					// Expected to fail - repo doesn't exist
				}
			} finally {
				if (previousGitTerminalPrompt === undefined) {
					delete process.env.GIT_TERMINAL_PROMPT;
				} else {
					process.env.GIT_TERMINAL_PROMPT = previousGitTerminalPrompt;
				}
			}

			// Should have attempted clone, not thrown unsupported error
			expect(events.some((e) => e.type === "start" && e.action === "install")).toBe(true);
		});

		it("should parse package source types from docs examples", () => {
			const parseSource = Reflect.get(packageManager, "parseSource") as (source: string) => {
				type: string;
				pinned?: boolean;
			};
			const parseNpm = (source: string) => {
				const parsed = parseSource.call(packageManager, source);
				if (parsed.type !== "npm") {
					throw new Error(`Expected npm source: ${source}`);
				}
				return parsed;
			};

			expect(parseNpm("npm:@scope/pkg@1.2.3").pinned).toBe(true);
			expect(parseNpm("npm:@scope/pkg@^1.2.3").pinned).toBe(false);
			expect(parseNpm("npm:pkg").pinned).toBe(false);

			expect((packageManager as any).parseSource("git:github.com/user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("https://github.com/user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("git:git@github.com:user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("ssh://git@github.com/user/repo@v1").type).toBe("git");

			expect((packageManager as any).parseSource("/absolute/path/to/package").type).toBe("local");
			expect((packageManager as any).parseSource("./relative/path/to/package").type).toBe("local");
			expect((packageManager as any).parseSource("../relative/path/to/package").type).toBe("local");
		});

		it("should parse explicit npm dist-tag selectors without treating them as pinned ranges", () => {
			const internals = packageManager as object as PackageManagerInternals;
			const parseNpm = (source: string): ParsedNpmSourceForTest => {
				const parsed = internals.parseSource(source);
				if (parsed.type !== "npm") {
					throw new Error(`Expected npm source: ${source}`);
				}
				return parsed;
			};

			expect(parseNpm("npm:pkg@beta")).toMatchObject({
				type: "npm",
				spec: "pkg@beta",
				name: "pkg",
				version: "beta",
				pinned: false,
			});
			expect(parseNpm("npm:pkg@beta").range).toBeUndefined();
			expect(parseNpm("npm:pkg@latest")).toMatchObject({
				type: "npm",
				spec: "pkg@latest",
				name: "pkg",
				version: "latest",
				pinned: false,
			});
			expect(parseNpm("npm:pkg@latest").range).toBeUndefined();
		});

		it("should never parse dot-relative paths as git", () => {
			const dotSlash = (packageManager as any).parseSource("./packages/agent-timers");
			expect(dotSlash.type).toBe("local");
			expect(dotSlash.path).toBe("./packages/agent-timers");

			const dotDotSlash = (packageManager as any).parseSource("../packages/agent-timers");
			expect(dotDotSlash.type).toBe("local");
			expect(dotDotSlash.path).toBe("../packages/agent-timers");
		});
	});

	describe("settings source normalization", () => {
		it("should store global local packages relative to agent settings base", () => {
			const pkgDir = join(tempDir, "packages", "local-global-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "index.ts"), "export default function() {}");

			const added = packageManager.addSourceToSettings("./packages/local-global-pkg");
			expect(added).toBe(true);

			const settings = settingsManager.getGlobalSettings();
			const rel = relative(agentDir, pkgDir);
			const expected = rel.startsWith(".") ? rel : `./${rel}`;
			expect(settings.packages?.[0]).toBe(expected);
		});

		it("should store project local packages relative to .pi settings base", () => {
			const projectPkgDir = join(tempDir, "project-local-pkg");
			mkdirSync(join(projectPkgDir, "extensions"), { recursive: true });
			writeFileSync(join(projectPkgDir, "extensions", "index.ts"), "export default function() {}");

			const added = packageManager.addSourceToSettings("./project-local-pkg", { local: true });
			expect(added).toBe(true);

			const settings = settingsManager.getProjectSettings();
			const rel = relative(join(tempDir, ".pi"), projectPkgDir);
			const expected = rel.startsWith(".") ? rel : `./${rel}`;
			expect(settings.packages?.[0]).toBe(expected);
		});

		it("should remove local package entries using equivalent path forms", () => {
			const pkgDir = join(tempDir, "remove-local-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "index.ts"), "export default function() {}");

			packageManager.addSourceToSettings("./remove-local-pkg");
			const removed = packageManager.removeSourceFromSettings(`${pkgDir}/`);
			expect(removed).toBe(true);
			expect(settingsManager.getGlobalSettings().packages ?? []).toHaveLength(0);
		});

		it("should return false when adding the same git source with the same ref", () => {
			const first = packageManager.addSourceToSettings("git:github.com/user/repo@v1");
			expect(first).toBe(true);

			const second = packageManager.addSourceToSettings("git:github.com/user/repo@v1");
			expect(second).toBe(false);
			expect(settingsManager.getGlobalSettings().packages).toEqual(["git:github.com/user/repo@v1"]);
		});

		it("should update the ref when adding the same git source with a different ref", () => {
			packageManager.addSourceToSettings("git:github.com/user/repo@v1");

			const updated = packageManager.addSourceToSettings("git:github.com/user/repo@v2");
			expect(updated).toBe(true);
			expect(settingsManager.getGlobalSettings().packages).toEqual(["git:github.com/user/repo@v2"]);
		});

		it("should preserve package filters when replacing a package source ref", () => {
			settingsManager.setPackages([
				{
					source: "git:github.com/user/repo@v1",
					extensions: ["extensions/main.ts"],
					skills: [],
					prompts: ["prompts/review.md"],
					themes: ["themes/dark.json"],
				},
			]);

			const updated = packageManager.addSourceToSettings("git:github.com/user/repo@v2");
			expect(updated).toBe(true);
			expect(settingsManager.getGlobalSettings().packages).toEqual([
				{
					source: "git:github.com/user/repo@v2",
					extensions: ["extensions/main.ts"],
					skills: [],
					prompts: ["prompts/review.md"],
					themes: ["themes/dark.json"],
				},
			]);
		});
	});

	describe("HTTPS git URL parsing (old behavior)", () => {
		it("should parse HTTPS GitHub URLs correctly", async () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.pinned).toBe(false);
		});

		it("should parse HTTPS URLs with git: prefix", async () => {
			const parsed = (packageManager as any).parseSource("git:https://github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse HTTPS URLs with ref", async () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo@v1.2.3");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.ref).toBe("v1.2.3");
			expect(parsed.pinned).toBe(true);
		});

		it("should parse host/path shorthand only with git: prefix", async () => {
			const parsed = (packageManager as any).parseSource("git:github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should treat host/path shorthand as local without git: prefix", async () => {
			const parsed = (packageManager as any).parseSource("github.com/user/repo");
			expect(parsed.type).toBe("local");
		});

		it("should parse HTTPS URLs with .git suffix", async () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo.git");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse GitLab HTTPS URLs", async () => {
			const parsed = (packageManager as any).parseSource("https://gitlab.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("gitlab.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse Bitbucket HTTPS URLs", async () => {
			const parsed = (packageManager as any).parseSource("https://bitbucket.org/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("bitbucket.org");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse Codeberg HTTPS URLs", async () => {
			const parsed = (packageManager as any).parseSource("https://codeberg.org/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("codeberg.org");
			expect(parsed.path).toBe("user/repo");
		});

		it("should generate correct package identity for protocol and git:-prefixed URLs", async () => {
			const identity1 = (packageManager as any).getPackageIdentity("https://github.com/user/repo");
			const identity2 = (packageManager as any).getPackageIdentity("https://github.com/user/repo@v1.0.0");
			const identity3 = (packageManager as any).getPackageIdentity("git:github.com/user/repo");
			const identity4 = (packageManager as any).getPackageIdentity("https://github.com/user/repo.git");

			// All should have the same identity (normalized)
			expect(identity1).toBe("git:github.com/user/repo");
			expect(identity2).toBe("git:github.com/user/repo");
			expect(identity3).toBe("git:github.com/user/repo");
			expect(identity4).toBe("git:github.com/user/repo");
		});

		it("should deduplicate git URLs with different supported formats", async () => {
			const pkgDir = join(tempDir, "https-dedup-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "test.ts"), "export default function() {}");

			// Mock the package as if it were cloned from different URL formats
			// In reality, these would all point to the same local dir after install
			settingsManager.setPackages([
				"https://github.com/user/repo",
				"git:github.com/user/repo",
				"https://github.com/user/repo.git",
			]);

			// Since these URLs don't actually exist and we can't clone them,
			// we verify they produce the same identity
			const id1 = (packageManager as any).getPackageIdentity("https://github.com/user/repo");
			const id2 = (packageManager as any).getPackageIdentity("git:github.com/user/repo");
			const id3 = (packageManager as any).getPackageIdentity("https://github.com/user/repo.git");

			expect(id1).toBe(id2);
			expect(id2).toBe(id3);
		});

		it("should handle HTTPS URLs with refs in resolve", async () => {
			// This tests that the ref is properly extracted and stored
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo@main");
			expect(parsed.ref).toBe("main");
			expect(parsed.pinned).toBe(true);

			const parsed2 = (packageManager as any).parseSource("https://github.com/user/repo@feature/branch");
			expect(parsed2.ref).toBe("feature/branch");
		});
	});

});
