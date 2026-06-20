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

	describe("project trust", () => {
		it("blocks project-scoped install/remove operations before mutating package storage", async () => {
			settingsManager.setProjectTrusted(false);

			await expect(packageManager.installAndPersist("./local-extension", { local: true })).rejects.toThrow(
				"Project is not trusted; refusing to access project package storage",
			);
			await expect(packageManager.removeAndPersist("./local-extension", { local: true })).rejects.toThrow(
				"Project is not trusted; refusing to access project package storage",
			);
		});
	});

	describe("resolve", () => {
		it("should return no package-sourced paths when no sources configured", async () => {
			const result = await packageManager.resolve();
			expect(result.extensions).toEqual([]);
			expect(result.prompts).toEqual([]);
			expect(result.themes).toEqual([]);
			expect(result.skills.every((r) => r.metadata.source === "auto" && r.metadata.origin === "top-level")).toBe(
				true,
			);
		});

		it("should resolve local extension paths from settings", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "my-extension.ts");
			writeFileSync(extPath, "export default function() {}");
			settingsManager.setExtensionPaths(["extensions/my-extension.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should resolve skill paths from settings", async () => {
			const skillDir = join(agentDir, "skills", "my-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillFile = join(skillDir, "SKILL.md");
			writeFileSync(
				skillFile,
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			settingsManager.setSkillPaths(["skills"]);

			const result = await packageManager.resolve();
			// Skills with SKILL.md are returned as file paths
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should auto-discover root markdown skills from .pi skill dirs", async () => {
			const skillFile = join(agentDir, "skills", "single-file.md");
			mkdirSync(join(agentDir, "skills"), { recursive: true });
			writeFileSync(
				skillFile,
				`---
name: single-file
description: A root markdown skill
---
Content`,
			);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should resolve project paths relative to .pi", async () => {
			const extDir = join(tempDir, ".pi", "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "project-ext.ts");
			writeFileSync(extPath, "export default function() {}");

			settingsManager.setProjectExtensionPaths(["extensions/project-ext.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should auto-discover user prompts with overrides", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "auto.md");
			writeFileSync(promptPath, "Auto prompt");

			settingsManager.setPromptTemplatePaths(["!prompts/auto.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});

		it("should resolve symlinked user and project resources once", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const sharedDir = join(tempDir, "shared-resources");
				const sharedExtensionsDir = join(sharedDir, "extensions");
				const sharedSkillsDir = join(sharedDir, "skills");
				const sharedPromptsDir = join(sharedDir, "prompts");
				const sharedThemesDir = join(sharedDir, "themes");
				mkdirSync(sharedExtensionsDir, { recursive: true });
				mkdirSync(sharedSkillsDir, { recursive: true });
				mkdirSync(sharedPromptsDir, { recursive: true });
				mkdirSync(sharedThemesDir, { recursive: true });

				writeFileSync(join(sharedExtensionsDir, "shared.ts"), "export default function() {}");
				mkdirSync(join(sharedSkillsDir, "shared-skill"), { recursive: true });
				writeFileSync(
					join(sharedSkillsDir, "shared-skill", "SKILL.md"),
					`---
name: shared-skill
description: Shared skill
---
Content`,
				);
				writeFileSync(join(sharedPromptsDir, "shared.md"), "Shared prompt");
				writeFileSync(join(sharedThemesDir, "shared.json"), JSON.stringify({ name: "shared-theme" }));

				mkdirSync(join(agentDir), { recursive: true });
				mkdirSync(join(tempDir, ".pi"), { recursive: true });
				symlinkSync(sharedExtensionsDir, join(agentDir, "extensions"), "dir");
				symlinkSync(sharedSkillsDir, join(agentDir, "skills"), "dir");
				symlinkSync(sharedPromptsDir, join(agentDir, "prompts"), "dir");
				symlinkSync(sharedThemesDir, join(agentDir, "themes"), "dir");
				symlinkSync(sharedExtensionsDir, join(tempDir, ".pi", "extensions"), "dir");
				symlinkSync(sharedSkillsDir, join(tempDir, ".pi", "skills"), "dir");
				symlinkSync(sharedPromptsDir, join(tempDir, ".pi", "prompts"), "dir");
				symlinkSync(sharedThemesDir, join(tempDir, ".pi", "themes"), "dir");

				const result = await packageManager.resolve();

				expect({
					extensions: result.extensions.length,
					skills: result.skills.length,
					prompts: result.prompts.length,
					themes: result.themes.length,
				}).toEqual({
					extensions: 1,
					skills: 1,
					prompts: 1,
					themes: 1,
				});

				// Project auto-discovered has higher precedence than user auto-discovered,
				// so the surviving entry should be scoped to project.
				expect(result.extensions[0].metadata.scope).toBe("project");
				expect(result.skills[0].metadata.scope).toBe("project");
				expect(result.prompts[0].metadata.scope).toBe("project");
				expect(result.themes[0].metadata.scope).toBe("project");
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should auto-discover project prompts with overrides", async () => {
			const promptsDir = join(tempDir, ".pi", "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "is.md");
			writeFileSync(promptPath, "Is prompt");

			settingsManager.setProjectPromptTemplatePaths(["!prompts/is.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});

		it("should resolve directory with package.json pi.extensions in extensions setting", async () => {
			// Create a package with pi.extensions in package.json
			const pkgDir = join(tempDir, "my-extensions-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "my-extensions-pkg",
					pi: {
						extensions: ["./extensions/clip.ts", "./extensions/cost.ts"],
					},
				}),
			);
			writeFileSync(join(pkgDir, "extensions", "clip.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "cost.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "helper.ts"), "export const x = 1;"); // Not in manifest, shouldn't be loaded

			// Add the directory to extensions setting (not packages setting)
			settingsManager.setExtensionPaths([pkgDir]);

			const result = await packageManager.resolve();

			// Should find the extensions declared in package.json pi.extensions
			expect(result.extensions.some((r) => r.path === join(pkgDir, "extensions", "clip.ts") && r.enabled)).toBe(
				true,
			);
			expect(result.extensions.some((r) => r.path === join(pkgDir, "extensions", "cost.ts") && r.enabled)).toBe(
				true,
			);

			// Should NOT find helper.ts (not declared in manifest)
			expect(result.extensions.some((r) => pathEndsWith(r.path, "helper.ts"))).toBe(false);
		});

		it("should resolve package-declared workflows from atomic and legacy manifests", async () => {
			const atomicPkg = join(tempDir, "atomic-workflows-pkg");
			const piPkg = join(tempDir, "pi-workflows-pkg");
			const singularPkg = join(tempDir, "pi-workflow-singular-pkg");

			mkdirSync(join(atomicPkg, "workflows"), { recursive: true });
			mkdirSync(join(piPkg, "workflows"), { recursive: true });
			mkdirSync(join(singularPkg, "workflow"), { recursive: true });
			writeFileSync(join(atomicPkg, "workflows", "atomic.ts"), "export default {}");
			writeFileSync(join(piPkg, "workflows", "legacy.ts"), "export default {}");
			writeFileSync(join(singularPkg, "workflow", "singular.ts"), "export default {}");
			writeFileSync(
				join(atomicPkg, "package.json"),
				JSON.stringify({
					name: "atomic-workflows-pkg",
					atomic: { workflows: ["workflows/atomic.ts"] },
				}),
			);
			writeFileSync(
				join(piPkg, "package.json"),
				JSON.stringify({
					name: "pi-workflows-pkg",
					pi: { workflows: ["workflows/legacy.ts"] },
				}),
			);
			writeFileSync(
				join(singularPkg, "package.json"),
				JSON.stringify({
					name: "pi-workflow-singular-pkg",
					pi: { workflow: ["workflow/singular.ts"] },
				}),
			);

			settingsManager.setPackages([atomicPkg, piPkg, singularPkg]);

			const result = await packageManager.resolve();

			expect(result.workflows.some((r) => isEnabled(r, join("workflows", "atomic.ts")))).toBe(true);
			expect(result.workflows.some((r) => isEnabled(r, join("workflows", "legacy.ts")))).toBe(true);
			expect(result.workflows.some((r) => isEnabled(r, join("workflow", "singular.ts")))).toBe(true);
			expect(result.workflows.every((r) => r.metadata.origin === "package")).toBe(true);
		});
	});

});
