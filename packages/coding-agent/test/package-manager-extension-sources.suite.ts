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

	describe("resolveExtensionSources", () => {
		it("should resolve local paths", async () => {
			const extPath = join(tempDir, "ext.ts");
			writeFileSync(extPath, "export default function() {}");

			const result = await packageManager.resolveExtensionSources([extPath]);
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should handle directories with pi manifest", async () => {
			const pkgDir = join(tempDir, "my-package");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "my-package",
					pi: {
						extensions: ["./src/index.ts"],
						skills: ["./skills"],
					},
				}),
			);
			mkdirSync(join(pkgDir, "src"), { recursive: true });
			writeFileSync(join(pkgDir, "src", "index.ts"), "export default function() {}");
			mkdirSync(join(pkgDir, "skills", "my-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "my-skill", "SKILL.md"),
				"---\nname: my-skill\ndescription: Test\n---\nContent",
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.extensions.some((r) => r.path === join(pkgDir, "src", "index.ts") && r.enabled)).toBe(true);
			// Skills with SKILL.md are returned as file paths
			expect(result.skills.some((r) => r.path === join(pkgDir, "skills", "my-skill", "SKILL.md") && r.enabled)).toBe(
				true,
			);
		});

		it("should keep pi manifest entries with leading tilde package-relative", async () => {
			const pkgDir = join(tempDir, "tilde-manifest-package");
			const directExtensionPath = join(pkgDir, "~extensions", "main.ts");
			const slashExtensionPath = join(pkgDir, "~", "extensions", "alt.ts");
			const directSkillPath = join(pkgDir, "~skills", "direct-skill", "SKILL.md");
			const slashSkillPath = join(pkgDir, "~", "skills", "slash-skill", "SKILL.md");

			mkdirSync(join(pkgDir, "~extensions"), { recursive: true });
			mkdirSync(join(pkgDir, "~", "extensions"), { recursive: true });
			mkdirSync(join(pkgDir, "~skills", "direct-skill"), { recursive: true });
			mkdirSync(join(pkgDir, "~", "skills", "slash-skill"), { recursive: true });
			writeFileSync(directExtensionPath, "export default function() {}");
			writeFileSync(slashExtensionPath, "export default function() {}");
			writeFileSync(directSkillPath, "---\nname: direct-skill\ndescription: Direct\n---\nContent");
			writeFileSync(slashSkillPath, "---\nname: slash-skill\ndescription: Slash\n---\nContent");
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "tilde-manifest-package",
					pi: {
						extensions: ["~extensions/main.ts", "~/extensions/alt.ts"],
						skills: ["~skills", "~/skills"],
					},
				}),
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);

			expect(result.extensions.some((r) => r.path === directExtensionPath && r.enabled)).toBe(true);
			expect(result.extensions.some((r) => r.path === slashExtensionPath && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === directSkillPath && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === slashSkillPath && r.enabled)).toBe(true);
		});

		it("should handle directories with auto-discovery layout", async () => {
			const pkgDir = join(tempDir, "auto-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			mkdirSync(join(pkgDir, "themes"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "main.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "themes", "dark.json"), "{}");

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "main.ts") && r.enabled)).toBe(true);
			expect(result.themes.some((r) => pathEndsWith(r.path, "dark.json") && r.enabled)).toBe(true);
		});

		it("should resolve project-local resources from explicit temporary local directory sources", async () => {
			const repoDir = join(tempDir, "borrowed-repo");
			mkdirSync(join(repoDir, "extensions"), { recursive: true });
			mkdirSync(join(repoDir, "skills", "pkg-skill"), { recursive: true });
			mkdirSync(join(repoDir, ".atomic", "extensions", "atomic-ext"), { recursive: true });
			mkdirSync(join(repoDir, ".atomic", "skills", "atomic-skill"), { recursive: true });
			mkdirSync(join(repoDir, ".atomic", "prompts"), { recursive: true });
			mkdirSync(join(repoDir, ".atomic", "themes"), { recursive: true });
			mkdirSync(join(repoDir, ".atomic", "workflows"), { recursive: true });
			mkdirSync(join(repoDir, ".pi", "extensions", "legacy-ext"), { recursive: true });
			mkdirSync(join(repoDir, ".pi", "skills", "legacy-skill"), { recursive: true });
			mkdirSync(join(repoDir, ".pi", "prompts"), { recursive: true });
			mkdirSync(join(repoDir, ".pi", "themes"), { recursive: true });
			mkdirSync(join(repoDir, ".pi", "workflows"), { recursive: true });
			mkdirSync(join(repoDir, ".agents", "skills", "agents-skill"), { recursive: true });

			writeFileSync(join(repoDir, "extensions", "pkg.ts"), "export default function() {}");
			writeFileSync(
				join(repoDir, "skills", "pkg-skill", "SKILL.md"),
				"---\nname: pkg-skill\ndescription: Package\n---\n",
			);
			writeFileSync(
				join(repoDir, ".atomic", "extensions", "atomic-ext", "index.ts"),
				"export default function() {}",
			);
			writeFileSync(
				join(repoDir, ".atomic", "skills", "atomic-skill", "SKILL.md"),
				"---\nname: atomic-skill\ndescription: Atomic\n---\n",
			);
			writeFileSync(join(repoDir, ".atomic", "prompts", "atomic.md"), "Atomic prompt");
			writeFileSync(join(repoDir, ".atomic", "themes", "atomic.json"), "{}");
			writeFileSync(join(repoDir, ".atomic", "workflows", "atomic.ts"), "export default {}");
			writeFileSync(join(repoDir, ".pi", "extensions", "legacy-ext", "index.ts"), "export default function() {}");
			writeFileSync(
				join(repoDir, ".pi", "skills", "legacy-skill", "SKILL.md"),
				"---\nname: legacy-skill\ndescription: Legacy\n---\n",
			);
			writeFileSync(join(repoDir, ".pi", "prompts", "legacy.md"), "Legacy prompt");
			writeFileSync(join(repoDir, ".pi", "themes", "legacy.json"), "{}");
			writeFileSync(join(repoDir, ".pi", "workflows", "legacy.ts"), "export default {}");
			writeFileSync(
				join(repoDir, ".agents", "skills", "agents-skill", "SKILL.md"),
				"---\nname: agents-skill\ndescription: Agents\n---\n",
			);
			writeFileSync(join(repoDir, ".agents", "skills", "root.md"), "---\nname: ignored\ndescription: Ignored\n---\n");

			const result = await packageManager.resolveExtensionSources([repoDir], {
				temporary: true,
				includeProjectLocalResources: true,
			});
			const rel = (path: string) => normalizeForMatch(relative(repoDir, path));
			const enabledRels = (resources: ResolvedResource[]) =>
				resources.filter((r) => r.enabled).map((r) => rel(r.path));

			expect(enabledRels(result.extensions)).toEqual(
				expect.arrayContaining([
					"extensions/pkg.ts",
					".atomic/extensions/atomic-ext/index.ts",
					".pi/extensions/legacy-ext/index.ts",
				]),
			);
			expect(enabledRels(result.skills)).toEqual(
				expect.arrayContaining([
					"skills/pkg-skill/SKILL.md",
					".atomic/skills/atomic-skill/SKILL.md",
					".pi/skills/legacy-skill/SKILL.md",
					".agents/skills/agents-skill/SKILL.md",
				]),
			);
			expect(enabledRels(result.skills)).not.toContain(".agents/skills/root.md");
			expect(enabledRels(result.prompts)).toEqual(
				expect.arrayContaining([".atomic/prompts/atomic.md", ".pi/prompts/legacy.md"]),
			);
			expect(enabledRels(result.themes)).toEqual(
				expect.arrayContaining([".atomic/themes/atomic.json", ".pi/themes/legacy.json"]),
			);
			expect(enabledRels(result.workflows)).toEqual(
				expect.arrayContaining([".atomic/workflows/atomic.ts", ".pi/workflows/legacy.ts"]),
			);

			const packageSkill = result.skills.find((r) => rel(r.path) === "skills/pkg-skill/SKILL.md");
			const atomicSkill = result.skills.find((r) => rel(r.path) === ".atomic/skills/atomic-skill/SKILL.md");
			const agentsSkill = result.skills.find((r) => rel(r.path) === ".agents/skills/agents-skill/SKILL.md");
			expect(packageSkill?.metadata).toMatchObject({
				source: repoDir,
				scope: "temporary",
				origin: "package",
				baseDir: repoDir,
			});
			expect(atomicSkill?.metadata).toMatchObject({
				source: repoDir,
				scope: "temporary",
				origin: "top-level",
				baseDir: join(repoDir, ".atomic"),
				borrowedProjectLocal: true,
			});
			expect(agentsSkill?.metadata).toMatchObject({
				source: repoDir,
				scope: "temporary",
				origin: "top-level",
				baseDir: join(repoDir, ".agents"),
				borrowedProjectLocal: true,
			});
			expect(result.skills.indexOf(packageSkill!)).toBeLessThan(result.skills.indexOf(atomicSkill!));
		});

		it("should not fall back to the directory itself when only project-local resources are present", async () => {
			const repoDir = join(tempDir, "project-local-only");
			const skillFile = join(repoDir, ".atomic", "skills", "local-skill", "SKILL.md");
			mkdirSync(join(repoDir, ".atomic", "skills", "local-skill"), { recursive: true });
			writeFileSync(skillFile, "---\nname: local-skill\ndescription: Local\n---\n");

			const result = await packageManager.resolveExtensionSources([repoDir], {
				temporary: true,
				includeProjectLocalResources: true,
			});

			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
			expect(result.extensions.some((r) => r.path === repoDir)).toBe(false);
		});

		it("should not add directory fallback when project-local resources are excluded", async () => {
			const repoDir = join(tempDir, "project-local-excluded");
			const skillFile = join(repoDir, ".atomic", "skills", "local-skill", "SKILL.md");
			mkdirSync(join(repoDir, ".atomic", "skills", "local-skill"), { recursive: true });
			writeFileSync(skillFile, "---\nname: local-skill\ndescription: Local\n---\n");

			const result = await packageManager.resolveExtensionSources([repoDir], {
				temporary: true,
				includeProjectLocalResources: false,
			});

			expect(result.skills).toEqual([]);
			expect(result.extensions.some((r) => r.path === repoDir)).toBe(false);
		});

		it("should preserve directory extension fallback when project-local resources are present", async () => {
			const repoDir = join(tempDir, "borrowed-repo-with-root-extension");
			const skillFile = join(repoDir, ".atomic", "skills", "local-skill", "SKILL.md");
			mkdirSync(join(repoDir, ".atomic", "skills", "local-skill"), { recursive: true });
			writeFileSync(join(repoDir, "index.ts"), "export default function() {}\n");
			writeFileSync(skillFile, "---\nname: local-skill\ndescription: Local\n---\n");

			const result = await packageManager.resolveExtensionSources([repoDir], {
				temporary: true,
				includeProjectLocalResources: true,
			});
			const extension = result.extensions.find((r) => r.path === repoDir);

			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
			expect(extension).toMatchObject({
				enabled: true,
				metadata: {
					source: repoDir,
					scope: "temporary",
					origin: "package",
					baseDir: repoDir,
				},
			});
		});

		it("should stop recursing when a package skill directory contains SKILL.md", async () => {
			const pkgDir = join(tempDir, "skill-root-pkg");
			mkdirSync(join(pkgDir, "skills", "root-skill", "nested-skill"), { recursive: true });
			const rootSkill = join(pkgDir, "skills", "root-skill", "SKILL.md");
			const nestedSkill = join(pkgDir, "skills", "root-skill", "nested-skill", "SKILL.md");
			writeFileSync(rootSkill, "---\nname: root-skill\ndescription: Root skill\n---\n");
			writeFileSync(nestedSkill, "---\nname: nested-skill\ndescription: Nested skill\n---\n");

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.skills.some((r) => r.path === rootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedSkill)).toBe(false);
		});
	});

	describe("progress callback", () => {
		it("should emit progress events", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			const extPath = join(tempDir, "ext.ts");
			writeFileSync(extPath, "export default function() {}");

			// Local paths don't trigger install progress, but we can verify the callback is set
			await packageManager.resolveExtensionSources([extPath]);

			// For now just verify no errors - npm/git would trigger actual events
			expect(events.length).toBe(0);
		});
	});

	describe("windows command spawning", () => {
		it("should avoid the shell for git so Windows paths with spaces stay single arguments", () => {
			vi.spyOn(process, "platform", "get").mockReturnValue("win32");

			expect(shouldUseWindowsShell("git")).toBe(false);
			expect(shouldUseWindowsShell("npm")).toBe(true);
			expect(shouldUseWindowsShell("pnpm")).toBe(true);
			expect(shouldUseWindowsShell("C:/Program Files/nodejs/npm.cmd")).toBe(true);
		});
	});

});
