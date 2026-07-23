import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { ResolvedResource } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

describe("DefaultResourceLoader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("reload", () => {
		it("should initialize with empty results before reload", () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			expect(loader.getExtensions().extensions).toEqual([]);
			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
			expect(loader.getThemes().themes).toEqual([]);
		});
		it("should refresh package workflow resources without reloading extensions", async () => {
			const settingsManager = SettingsManager.inMemory();
			const pkgDir = join(tempDir, "workflow-package");
			const workflowDir = join(pkgDir, "workflows");
			const workflowA = join(workflowDir, "a.ts");
			const workflowB = join(workflowDir, "b.ts");
			const manifestPath = join(pkgDir, "package.json");
			const writeManifest = (workflows: string[]): void => {
				writeFileSync(
					manifestPath,
					JSON.stringify({
						name: "workflow-package",
						atomic: { workflows },
					}),
				);
			};

			mkdirSync(workflowDir, { recursive: true });
			writeFileSync(workflowA, "export default {}");
			writeFileSync(workflowB, "export default {}");
			writeManifest(["workflows/a.ts"]);
			settingsManager.setPackages([pkgDir]);

			const preservedSkillDir = join(agentDir, "skills", "preserved-skill");
			const preservedPromptDir = join(agentDir, "prompts");
			const preservedThemeDir = join(agentDir, "themes");
			mkdirSync(preservedSkillDir, { recursive: true });
			mkdirSync(preservedPromptDir, { recursive: true });
			mkdirSync(preservedThemeDir, { recursive: true });
			writeFileSync(
				join(preservedSkillDir, "SKILL.md"),
				"---\nname: preserved-skill\ndescription: Reload preservation fixture\n---\n",
			);
			writeFileSync(join(preservedPromptDir, "preserved.md"), "Preserved prompt");
			const baseThemePath = fileURLToPath(new URL("../src/modes/interactive/theme/dark.json", import.meta.url));
			const preservedTheme = JSON.parse(readFileSync(baseThemePath, "utf8")) as { name: string };
			preservedTheme.name = "preserved-theme";
			writeFileSync(join(preservedThemeDir, "preserved.json"), JSON.stringify(preservedTheme));
			let factoryCalls = 0;
			let apiGetWorkflowResources: (() => ResolvedResource[]) | undefined;
			let apiRefreshWorkflowResources: (() => Promise<ResolvedResource[]>) | undefined;
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				extensionFactories: [
					(pi: ExtensionAPI) => {
						factoryCalls += 1;
						apiGetWorkflowResources = () => pi.getWorkflowResources();
						apiRefreshWorkflowResources = () => pi.refreshWorkflowResources();
					},
				],
			});

			await loader.reload();

			if (!apiGetWorkflowResources || !apiRefreshWorkflowResources) {
				throw new Error("expected extension factory to capture workflow resource APIs");
			}

			expect(factoryCalls).toBe(1);
			expect(apiGetWorkflowResources().map((resource) => resource.path)).toEqual([workflowA]);
			expect(loader.getWorkflowResources().map((resource) => resource.path)).toEqual([workflowA]);

			const preservedResources = {
				extensions: loader.getExtensions(),
				skills: loader.getSkills(),
				prompts: loader.getPrompts(),
				themes: loader.getThemes(),
				projectTrusted: settingsManager.isProjectTrusted(),
				inheritance: loader.getInheritanceSnapshot(),
			};
			expect(preservedResources.skills.skills.map((skill) => skill.name)).toContain("preserved-skill");
			expect(preservedResources.prompts.prompts.map((prompt) => prompt.name)).toContain("preserved");
			expect(preservedResources.themes.themes.map((theme) => theme.name)).toContain("preserved-theme");

			writeManifest(["workflows/a.ts", "workflows/b.ts"]);
			const refreshed = await apiRefreshWorkflowResources();

			expect(refreshed.map((resource) => resource.path)).toEqual([workflowA, workflowB]);
			expect(apiGetWorkflowResources().map((resource) => resource.path)).toEqual([workflowA, workflowB]);
			expect(loader.getWorkflowResources().map((resource) => resource.path)).toEqual([workflowA, workflowB]);
			expect(factoryCalls).toBe(1);
			expect(loader.getExtensions()).toEqual(preservedResources.extensions);
			expect(loader.getSkills()).toEqual(preservedResources.skills);
			expect(loader.getPrompts()).toEqual(preservedResources.prompts);
			expect(loader.getThemes()).toEqual(preservedResources.themes);
			expect(settingsManager.isProjectTrusted()).toBe(preservedResources.projectTrusted);
			expect(loader.getInheritanceSnapshot()).toEqual(preservedResources.inheritance);
		});
		it("should expose project-local workflows from additional extension paths", async () => {
			const repoDir = join(tempDir, "borrowed-repo");
			const atomicWorkflow = join(repoDir, ".atomic", "workflows", "atomic.ts");
			const legacyWorkflow = join(repoDir, ".pi", "workflows", "legacy.ts");
			mkdirSync(join(repoDir, ".atomic", "workflows"), { recursive: true });
			mkdirSync(join(repoDir, ".pi", "workflows"), { recursive: true });
			writeFileSync(atomicWorkflow, "export default {}");
			writeFileSync(legacyWorkflow, "export default {}");

			let apiGetWorkflowResources: (() => ResolvedResource[]) | undefined;
			let apiRefreshWorkflowResources: (() => Promise<ResolvedResource[]>) | undefined;
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				additionalExtensionPaths: [repoDir],
				extensionFactories: [
					(pi: ExtensionAPI) => {
						apiGetWorkflowResources = () => pi.getWorkflowResources();
						apiRefreshWorkflowResources = () => pi.refreshWorkflowResources();
					},
				],
			});

			await loader.reload();

			if (!apiGetWorkflowResources || !apiRefreshWorkflowResources) {
				throw new Error("expected extension factory to capture workflow resource APIs");
			}

			const expected = [
				expect.objectContaining({
					path: atomicWorkflow,
					enabled: true,
					metadata: expect.objectContaining({ origin: "top-level", scope: "temporary" }),
				}),
				expect.objectContaining({
					path: legacyWorkflow,
					enabled: true,
					metadata: expect.objectContaining({ origin: "top-level", scope: "temporary" }),
				}),
			];

			expect(loader.getWorkflowResources()).toEqual(expect.arrayContaining(expected));
			expect(apiGetWorkflowResources()).toEqual(expect.arrayContaining(expected));

			const refreshed = await apiRefreshWorkflowResources();
			expect(refreshed).toEqual(expect.arrayContaining(expected));
			expect(loader.getWorkflowResources()).toEqual(expect.arrayContaining(expected));
		});
		it("should preserve borrowed project-local skill provenance from additional extension paths", async () => {
			const repoDir = join(tempDir, "borrowed-skills-repo");
			const atomicSkillDir = join(repoDir, ".atomic", "skills", "atomic-skill");
			const agentsSkillDir = join(repoDir, ".agents", "skills", "agents-skill");
			const atomicSkillPath = join(atomicSkillDir, "SKILL.md");
			const agentsSkillPath = join(agentsSkillDir, "SKILL.md");
			mkdirSync(atomicSkillDir, { recursive: true });
			mkdirSync(agentsSkillDir, { recursive: true });
			writeFileSync(
				atomicSkillPath,
				`---
name: borrowed-atomic-skill
description: Atomic skill
---
Atomic skill content`,
			);
			writeFileSync(
				agentsSkillPath,
				`---
name: borrowed-agents-skill
description: Agents skill
---
Agents skill content`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				additionalExtensionPaths: [repoDir],
			});
			await loader.reload();

			const atomicSkill = loader.getSkills().skills.find((skill) => skill.name === "borrowed-atomic-skill");
			const agentsSkill = loader.getSkills().skills.find((skill) => skill.name === "borrowed-agents-skill");

			expect(atomicSkill?.sourceInfo).toEqual({
				path: atomicSkillPath,
				source: repoDir,
				scope: "temporary",
				origin: "top-level",
				baseDir: join(repoDir, ".atomic"),
			});
			expect(agentsSkill?.sourceInfo).toEqual({
				path: agentsSkillPath,
				source: repoDir,
				scope: "temporary",
				origin: "top-level",
				baseDir: join(repoDir, ".agents"),
			});
			expect(atomicSkill?.sourceInfo?.source).not.toBe("cli");
			expect(agentsSkill?.sourceInfo?.source).not.toBe("cli");
		});
		it("should preserve borrowed project-local extension provenance from additional extension paths", async () => {
			const repoDir = join(tempDir, "borrowed-extension-repo");
			const extensionsDir = join(repoDir, ".atomic", "extensions");
			const extensionPath = join(extensionsDir, "borrowed.ts");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(
				extensionPath,
				`import { Type } from "typebox";
export default function(pi) {
	pi.registerCommand("borrowed-command", {
		description: "borrowed command",
		handler: async () => {},
	});
	pi.registerTool({
		name: "borrowed_tool",
		label: "Borrowed tool",
		description: "borrowed tool",
		parameters: Type.Object({}),
		execute: async () => ({ result: "ok" }),
	});
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				additionalExtensionPaths: [repoDir],
			});
			await loader.reload();

			const extension = loader.getExtensions().extensions.find((ext) => ext.path === extensionPath);
			const expectedSourceInfo = {
				path: extensionPath,
				source: repoDir,
				scope: "temporary" as const,
				origin: "top-level" as const,
				baseDir: join(repoDir, ".atomic"),
			};

			expect(extension?.sourceInfo).toEqual(expectedSourceInfo);
			expect(extension?.sourceInfo.source).not.toBe("cli");
			expect(extension?.commands.get("borrowed-command")?.sourceInfo).toEqual(expectedSourceInfo);
			expect(extension?.tools.get("borrowed_tool")?.sourceInfo).toEqual(expectedSourceInfo);
		});
		it("does not load borrowed project-local extensions from additional paths before source trust", async () => {
			const repoDir = join(tempDir, "borrowed-trust-repo");
			const packageExtensionsDir = join(repoDir, "extensions");
			const borrowedExtensionsDir = join(repoDir, ".atomic", "extensions");
			const packageExtension = join(packageExtensionsDir, "pkg.ts");
			const borrowedExtension = join(borrowedExtensionsDir, "borrowed.ts");
			const markerPath = join(tempDir, "borrowed-loaded");
			mkdirSync(packageExtensionsDir, { recursive: true });
			mkdirSync(borrowedExtensionsDir, { recursive: true });
			writeFileSync(packageExtension, "export default function() {}\n");
			writeFileSync(
				borrowedExtension,
				`import { writeFileSync } from "node:fs";\nexport default function() { writeFileSync(${JSON.stringify(markerPath)}, "loaded"); }\n`,
			);

			let trustCalls = 0;
			let preTrustPaths: string[] = [];
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				additionalExtensionPaths: [repoDir],
			});

			await loader.reload({
				resolveBorrowedProjectTrust: ({ source, resources, extensionsResult }) => {
					trustCalls += 1;
					expect(source).toBe(repoDir);
					expect(resources.map((resource) => resource.path)).toContain(borrowedExtension);
					preTrustPaths = extensionsResult.extensions.map((extension) => extension.path);
					return false;
				},
			});

			expect(trustCalls).toBe(1);
			expect(preTrustPaths).toContain(packageExtension);
			expect(preTrustPaths).not.toContain(borrowedExtension);
			expect(loader.getExtensions().extensions.map((extension) => extension.path)).not.toContain(borrowedExtension);
			expect(existsSync(markerPath)).toBe(false);
		});
		it("preserves declined borrowed project-local trust across reloads without trust callbacks", async () => {
			const repoDir = join(tempDir, "declined-borrowed-reload-repo");
			const borrowedExtensionsDir = join(repoDir, ".atomic", "extensions");
			const borrowedExtension = join(borrowedExtensionsDir, "borrowed.ts");
			const markerPath = join(tempDir, "declined-borrowed-reload-loaded");
			mkdirSync(borrowedExtensionsDir, { recursive: true });
			writeFileSync(
				borrowedExtension,
				`import { writeFileSync } from "node:fs";\nexport default function() { writeFileSync(${JSON.stringify(markerPath)}, "loaded"); }\n`,
			);

			let trustCalls = 0;
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				additionalExtensionPaths: [repoDir],
			});

			await loader.reload({
				resolveBorrowedProjectTrust: () => {
					trustCalls += 1;
					return false;
				},
			});

			expect(loader.getExtensions().extensions.map((extension) => extension.path)).not.toContain(borrowedExtension);
			expect(existsSync(markerPath)).toBe(false);

			await loader.reload();

			expect(trustCalls).toBe(1);
			expect(loader.getExtensions().extensions.map((extension) => extension.path)).not.toContain(borrowedExtension);
			expect(existsSync(markerPath)).toBe(false);
		});
		it("does not preload a project-local-only additional path as a root extension", async () => {
			const repoDir = join(tempDir, "project-local-only-borrowed-repo");
			const skillDir = join(repoDir, ".atomic", "skills", "borrowed-skill");
			const promptsDir = join(repoDir, ".atomic", "prompts");
			const skillPath = join(skillDir, "SKILL.md");
			const promptPath = join(promptsDir, "borrowed.md");
			mkdirSync(skillDir, { recursive: true });
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(skillPath, "---\nname: borrowed-skill\ndescription: Borrowed skill\n---\n");
			writeFileSync(promptPath, "Borrowed prompt");

			let preTrustPaths: string[] = [];
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				additionalExtensionPaths: [repoDir],
			});

			await loader.reload({
				resolveBorrowedProjectTrust: ({ extensionsResult }) => {
					preTrustPaths = extensionsResult.extensions.map((extension) => extension.path);
					return true;
				},
			});

			expect(preTrustPaths).not.toContain(repoDir);
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getSkills().skills.some((skill) => skill.filePath === skillPath)).toBe(true);
			expect(loader.getPrompts().prompts.some((prompt) => prompt.filePath === promptPath)).toBe(true);
		});
		it("loads borrowed project-local extensions from additional paths after source trust", async () => {
			const repoDir = join(tempDir, "trusted-borrowed-repo");
			const packageExtensionsDir = join(repoDir, "extensions");
			const borrowedExtensionsDir = join(repoDir, ".atomic", "extensions");
			const packageExtension = join(packageExtensionsDir, "pkg.ts");
			const borrowedExtension = join(borrowedExtensionsDir, "borrowed.ts");
			const markerPath = join(tempDir, "trusted-borrowed-loaded");
			mkdirSync(packageExtensionsDir, { recursive: true });
			mkdirSync(borrowedExtensionsDir, { recursive: true });
			writeFileSync(packageExtension, "export default function() {}\n");
			writeFileSync(
				borrowedExtension,
				`import { writeFileSync } from "node:fs";\nexport default function() { writeFileSync(${JSON.stringify(markerPath)}, "loaded"); }\n`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				additionalExtensionPaths: [repoDir],
			});

			await loader.reload({
				resolveBorrowedProjectTrust: () => true,
			});

			expect(loader.getExtensions().extensions.map((extension) => extension.path)).toContain(borrowedExtension);
			expect(existsSync(markerPath)).toBe(true);
		});
		it("reuses pre-trust inline extensions for the final extension set", async () => {
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			let factoryCalls = 0;
			let preTrustExtensionCount = 0;
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				extensionFactories: [
					() => {
						factoryCalls += 1;
					},
				],
			});

			await loader.reload({
				resolveProjectTrust: ({ extensionsResult }) => {
					preTrustExtensionCount = extensionsResult.extensions.length;
					return true;
				},
			});

			expect(preTrustExtensionCount).toBe(1);
			expect(factoryCalls).toBe(1);
			expect(loader.getExtensions().extensions).toHaveLength(1);
		});
		it("should discover skills from agentDir", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Skill content here.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "test-skill")).toBe(true);
		});
		it("should ignore extra markdown files in auto-discovered skill dirs", async () => {
			const skillDir = join(agentDir, "skills", "pi-skills", "browser-tools");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: browser-tools
description: Browser tools
---
Skill content here.`,
			);
			writeFileSync(join(skillDir, "EFFICIENCY.md"), "No frontmatter here");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(skills.some((s) => s.name === "browser-tools")).toBe(true);
			expect(diagnostics.some((d) => d.path?.endsWith("EFFICIENCY.md"))).toBe(false);
		});
	});
});
