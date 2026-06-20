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

	describe("pattern filtering in package filters", () => {
		it("should apply user filters on top of manifest filters (not replace)", async () => {
			// Manifest excludes baz.ts, user excludes bar.ts
			// Result should exclude BOTH
			const pkgDir = join(tempDir, "layered-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "foo.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "bar.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "baz.ts"), "export default function() {}");
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "layered-pkg",
					pi: {
						extensions: ["extensions", "!**/baz.ts"],
					},
				}),
			);

			// User filter adds exclusion for bar.ts
			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["!**/bar.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			// foo.ts should be included (not excluded by anyone)
			expect(result.extensions.some((r) => isEnabled(r, "foo.ts"))).toBe(true);
			// bar.ts should be excluded (by user)
			expect(result.extensions.some((r) => isDisabled(r, "bar.ts"))).toBe(true);
			// baz.ts should be excluded (by manifest)
			expect(result.extensions.some((r) => pathEndsWith(r.path, "baz.ts"))).toBe(false);
		});

		it("should exclude extensions from package with ! pattern", async () => {
			const pkgDir = join(tempDir, "pattern-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "foo.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "bar.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "baz.ts"), "export default function() {}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["!**/baz.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "foo.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "bar.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "baz.ts"))).toBe(true);
		});

		it("should filter themes from package", async () => {
			const pkgDir = join(tempDir, "theme-pkg");
			mkdirSync(join(pkgDir, "themes"), { recursive: true });
			writeFileSync(join(pkgDir, "themes", "nice.json"), "{}");
			writeFileSync(join(pkgDir, "themes", "ugly.json"), "{}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: [],
					skills: [],
					prompts: [],
					themes: ["!ugly.json"],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.themes.some((r) => isEnabled(r, "nice.json"))).toBe(true);
			expect(result.themes.some((r) => isDisabled(r, "ugly.json"))).toBe(true);
		});

		it("should combine include and exclude patterns", async () => {
			const pkgDir = join(tempDir, "combo-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "alpha.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "beta.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "gamma.ts"), "export default function() {}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["**/alpha.ts", "**/beta.ts", "!**/beta.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "alpha.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "beta.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "gamma.ts"))).toBe(true);
		});

		it("should work with direct paths (no patterns)", async () => {
			const pkgDir = join(tempDir, "direct-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "one.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "two.ts"), "export default function() {}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["extensions/one.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "one.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "two.ts"))).toBe(true);
		});

		it("should not borrow project-local resources from configured local packages", async () => {
			const pkgDir = join(tempDir, "configured-local-pkg");
			const atomicExtension = join(pkgDir, ".atomic", "extensions", "atomic.ts");
			const piPrompt = join(pkgDir, ".pi", "prompts", "legacy.md");
			const agentsSkill = join(pkgDir, ".agents", "skills", "agents-skill", "SKILL.md");
			mkdirSync(join(pkgDir, ".atomic", "extensions"), { recursive: true });
			mkdirSync(join(pkgDir, ".pi", "prompts"), { recursive: true });
			mkdirSync(join(pkgDir, ".agents", "skills", "agents-skill"), { recursive: true });
			writeFileSync(atomicExtension, "export default function() {}");
			writeFileSync(piPrompt, "Legacy prompt");
			writeFileSync(agentsSkill, "---\nname: agents-skill\ndescription: Agents\n---\n");

			settingsManager.setPackages([pkgDir]);

			const result = await packageManager.resolve();
			const resources = [...result.extensions, ...result.skills, ...result.prompts, ...result.themes, ...result.workflows];
			expect(resources.some((r) => r.path === atomicExtension)).toBe(false);
			expect(resources.some((r) => r.path === piPrompt)).toBe(false);
			expect(resources.some((r) => r.path === agentsSkill)).toBe(false);
			expect(resources.some((r) => r.metadata.borrowedProjectLocal)).toBe(false);
		});

		it("should apply package filters to explicit project-local resources", async () => {
			const pkgDir = join(tempDir, "project-local-filter-pkg");
			mkdirSync(join(pkgDir, ".atomic", "extensions"), { recursive: true });
			mkdirSync(join(pkgDir, ".atomic", "skills", "keep-skill"), { recursive: true });
			mkdirSync(join(pkgDir, ".atomic", "skills", "skip-skill"), { recursive: true });
			mkdirSync(join(pkgDir, ".atomic", "prompts"), { recursive: true });
			writeFileSync(join(pkgDir, ".atomic", "extensions", "keep.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, ".atomic", "extensions", "skip.ts"), "export default function() {}");
			writeFileSync(
				join(pkgDir, ".atomic", "skills", "keep-skill", "SKILL.md"),
				"---\nname: keep-skill\ndescription: Keep\n---\n",
			);
			writeFileSync(
				join(pkgDir, ".atomic", "skills", "skip-skill", "SKILL.md"),
				"---\nname: skip-skill\ndescription: Skip\n---\n",
			);
			writeFileSync(join(pkgDir, ".atomic", "prompts", "disabled.md"), "Disabled prompt");

			const result = await packageManager.resolveExtensionSources(
				[
					{
						source: pkgDir,
						extensions: [".atomic/extensions/keep.ts"],
						skills: ["!.atomic/skills/skip-skill"],
						prompts: [],
						themes: [],
					},
				],
				{ temporary: true, includeProjectLocalResources: true },
			);
			expect(result.extensions.some((r) => isEnabled(r, "keep.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "skip.ts"))).toBe(true);
			expect(result.skills.some((r) => isEnabled(r, "keep-skill", "includes"))).toBe(true);
			expect(result.skills.some((r) => isDisabled(r, "skip-skill", "includes"))).toBe(true);
			expect(result.prompts.some((r) => isDisabled(r, "disabled.md"))).toBe(true);
		});
	});

});
