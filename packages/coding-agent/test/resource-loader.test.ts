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

			writeManifest(["workflows/a.ts", "workflows/b.ts"]);
			const refreshed = await apiRefreshWorkflowResources();

			expect(refreshed.map((resource) => resource.path)).toEqual([workflowA, workflowB]);
			expect(apiGetWorkflowResources().map((resource) => resource.path)).toEqual([workflowA, workflowB]);
			expect(loader.getWorkflowResources().map((resource) => resource.path)).toEqual([workflowA, workflowB]);
			expect(factoryCalls).toBe(1);
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

		it("should discover prompts from agentDir", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(
				join(promptsDir, "test-prompt.md"),
				`---
description: A test prompt
---
Prompt content.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { prompts } = loader.getPrompts();
			expect(prompts.some((p) => p.name === "test-prompt")).toBe(true);
		});

		it("should prefer project resources over user on name collisions", async () => {
			const userPromptsDir = join(agentDir, "prompts");
			const projectPromptsDir = join(cwd, ".pi", "prompts");
			mkdirSync(userPromptsDir, { recursive: true });
			mkdirSync(projectPromptsDir, { recursive: true });
			const userPromptPath = join(userPromptsDir, "commit.md");
			const projectPromptPath = join(projectPromptsDir, "commit.md");
			writeFileSync(userPromptPath, "User prompt");
			writeFileSync(projectPromptPath, "Project prompt");

			const userSkillDir = join(agentDir, "skills", "collision-skill");
			const projectSkillDir = join(cwd, ".pi", "skills", "collision-skill");
			mkdirSync(userSkillDir, { recursive: true });
			mkdirSync(projectSkillDir, { recursive: true });
			const userSkillPath = join(userSkillDir, "SKILL.md");
			const projectSkillPath = join(projectSkillDir, "SKILL.md");
			writeFileSync(
				userSkillPath,
				`---
name: collision-skill
description: user
---
User skill`,
			);
			writeFileSync(
				projectSkillPath,
				`---
name: collision-skill
description: project
---
Project skill`,
			);

			const baseThemePath = fileURLToPath(new URL("../src/modes/interactive/theme/dark.json", import.meta.url));
			const baseTheme = JSON.parse(readFileSync(baseThemePath, "utf-8")) as {
				name: string;
				vars?: Record<string, string>;
			};
			baseTheme.name = "collision-theme";
			const userThemePath = join(agentDir, "themes", "collision.json");
			const projectThemePath = join(cwd, ".pi", "themes", "collision.json");
			mkdirSync(join(agentDir, "themes"), { recursive: true });
			mkdirSync(join(cwd, ".pi", "themes"), { recursive: true });
			writeFileSync(userThemePath, JSON.stringify(baseTheme, null, 2));
			if (baseTheme.vars) {
				baseTheme.vars.accent = "#ff00ff";
			}
			writeFileSync(projectThemePath, JSON.stringify(baseTheme, null, 2));

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const prompt = loader.getPrompts().prompts.find((p) => p.name === "commit");
			expect(prompt?.filePath).toBe(projectPromptPath);

			const skill = loader.getSkills().skills.find((s) => s.name === "collision-skill");
			expect(skill?.filePath).toBe(projectSkillPath);

			const theme = loader.getThemes().themes.find((t) => t.name === "collision-theme");
			expect(theme?.sourcePath).toBe(projectThemePath);
		});

		it("should load symlinked user and project extensions once", async () => {
			const sharedExtDir = join(tempDir, "shared-extensions");
			mkdirSync(sharedExtDir, { recursive: true });
			writeFileSync(
				join(sharedExtDir, "shared.ts"),
				`export default function(pi) {
	pi.registerCommand("shared", {
		description: "shared command",
		handler: async () => {},
	});
}`,
			);

			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			symlinkSync(sharedExtDir, join(agentDir, "extensions"), "dir");
			symlinkSync(sharedExtDir, join(cwd, ".pi", "extensions"), "dir");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(1);
			expect(extensionsResult.errors).toEqual([]);

			// mergePaths processes project paths before user paths, so the project
			// alias is the canonical survivor.
			expect(extensionsResult.extensions[0].path).toBe(join(cwd, ".pi", "extensions", "shared.ts"));
		});

		it("should keep both extensions loaded when command names collide", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(cwd, ".pi", "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });

			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "project deploy",
		handler: async () => {},
	});
	pi.registerCommand("project-only", {
		description: "project only",
		handler: async () => {},
	});
}`,
			);

			writeFileSync(
				join(userExtDir, "user.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "user deploy",
		handler: async () => {},
	});
	pi.registerCommand("user-only", {
		description: "user only",
		handler: async () => {},
	});
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(2);
			expect(extensionsResult.errors.some((e) => e.error.includes('Command "/deploy" conflicts'))).toBe(false);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("project deploy");
			expect(runner.getCommand("deploy:2")?.description).toBe("user deploy");
			expect(runner.getCommand("project-only")?.description).toBe("project only");
			expect(runner.getCommand("user-only")?.description).toBe("user only");

			const commands = runner.getRegisteredCommands();
			expect(commands.map((command) => command.invocationName)).toEqual([
				"deploy:1",
				"project-only",
				"deploy:2",
				"user-only",
			]);
		});

		it("should honor overrides for auto-discovered resources", async () => {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setExtensionPaths(["-extensions/disabled.ts"]);
			settingsManager.setSkillPaths(["-skills/skip-skill"]);
			settingsManager.setPromptTemplatePaths(["-prompts/skip.md"]);
			settingsManager.setThemePaths(["-themes/skip.json"]);

			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "disabled.ts"), "export default function() {}");

			const skillDir = join(agentDir, "skills", "skip-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: skip-skill
description: Skip me
---
Content`,
			);

			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "skip.md"), "Skip prompt");

			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "skip.json"), "{}");

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			const { extensions } = loader.getExtensions();
			const { skills } = loader.getSkills();
			const { prompts } = loader.getPrompts();
			const { themes } = loader.getThemes();

			expect(extensions.some((e) => e.path.endsWith("disabled.ts"))).toBe(false);
			expect(skills.some((s) => s.name === "skip-skill")).toBe(false);
			expect(prompts.some((p) => p.name === "skip")).toBe(false);
			expect(themes.some((t) => t.sourcePath?.endsWith("skip.json"))).toBe(false);
		});

		it("should discover AGENTS.md context files", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles.some((f) => f.path.includes("AGENTS.md"))).toBe(true);
		});

		it("should skip AGENTS.md and CLAUDE.md discovery when noContextFiles is true", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "CLAUDE.md"), "# Claude Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles).toEqual([]);
		});

		it("should discover SYSTEM.md from cwd/.pi", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "You are a helpful assistant.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("You are a helpful assistant.");
		});

		it("should discover APPEND_SYSTEM.md", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "Additional instructions.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toContain("Additional instructions.");
		});
	});

	describe("extendResources", () => {
		it("should load skills and prompts with extension metadata", async () => {
			const extraSkillDir = join(tempDir, "extra-skills", "extra-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: extra-skill
description: Extra skill
---
Extra content`,
			);

			const extraPromptDir = join(tempDir, "extra-prompts");
			mkdirSync(extraPromptDir, { recursive: true });
			const promptPath = join(extraPromptDir, "extra.md");
			writeFileSync(
				promptPath,
				`---
description: Extra prompt
---
Extra prompt content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: extraSkillDir,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
				promptPaths: [
					{
						path: promptPath,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraPromptDir,
						},
					},
				],
			});

			const { skills } = loader.getSkills();
			const loadedSkill = skills.find((skill) => skill.name === "extra-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedSkill?.sourceInfo?.path).toBe(skillPath);

			const { prompts } = loader.getPrompts();
			const loadedPrompt = prompts.find((prompt) => prompt.name === "extra");
			expect(loadedPrompt).toBeDefined();
			expect(loadedPrompt?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedPrompt?.sourceInfo?.path).toBe(promptPath);
		});

		it("should load extension resources returned as file URLs", async () => {
			const extraSkillDir = join(tempDir, "extra skills", "file-url-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: file-url-skill
description: File URL skill
---
Extra content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: pathToFileURL(extraSkillDir).href,
						metadata: {
							source: "extension:file-url",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
			});

			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const loadedSkill = skills.find((skill) => skill.name === "file-url-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.filePath).toBe(skillPath);
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:file-url");
		});
	});

	describe("noSkills option", () => {
		it("should skip skill discovery when noSkills is true", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toEqual([]);
		});

		it("should still load additional skill paths when noSkills is true", async () => {
			const customSkillDir = join(tempDir, "custom-skills");
			mkdirSync(customSkillDir, { recursive: true });
			writeFileSync(
				join(customSkillDir, "custom.md"),
				`---
name: custom
description: Custom skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				additionalSkillPaths: [customSkillDir],
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "custom")).toBe(true);
		});
	});

	describe("override functions", () => {
		it("should apply skillsOverride", async () => {
			const injectedSkill: Skill = {
				name: "injected",
				description: "Injected skill",
				filePath: "/fake/path",
				baseDir: "/fake",
				sourceInfo: createSyntheticSourceInfo("/fake/path", { source: "custom" }),
				disableModelInvocation: false,
			};
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				skillsOverride: () => ({
					skills: [injectedSkill],
					diagnostics: [],
				}),
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("injected");
		});

		it("should apply systemPromptOverride", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				systemPromptOverride: () => "Custom system prompt",
			});
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Custom system prompt");
		});
	});

	describe("extension conflict detection", () => {
		it("should detect tool conflicts between extensions", async () => {
			// Create two extensions that register the same tool
			const ext1Dir = join(agentDir, "extensions", "ext1");
			const ext2Dir = join(agentDir, "extensions", "ext2");
			mkdirSync(ext1Dir, { recursive: true });
			mkdirSync(ext2Dir, { recursive: true });

			writeFileSync(
				join(ext1Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "First",
    parameters: Type.Object({}),
    execute: async () => ({ result: "1" }),
  });
}`,
			);

			writeFileSync(
				join(ext2Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "Second",
    parameters: Type.Object({}),
    execute: async () => ({ result: "2" }),
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { errors } = loader.getExtensions();
			expect(errors.some((e) => e.error.includes("duplicate-tool") && e.error.includes("conflicts"))).toBe(true);
		});

		it("should prefer explicit CLI extensions over discovered extensions when commands and tools conflict", async () => {
			const globalExtDir = join(agentDir, "extensions");
			mkdirSync(globalExtDir, { recursive: true });
			const explicitExtPath = join(tempDir, "explicit-extension.ts");

			writeFileSync(
				join(globalExtDir, "global.ts"),
				`
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "global tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "global" }),
  });
  pi.registerCommand("deploy", {
    description: "global command",
    handler: async () => {},
  });
}`,
			);

			writeFileSync(
				explicitExtPath,
				`
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "explicit tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "explicit" }),
  });
  pi.registerCommand("deploy", {
    description: "explicit command",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalExtensionPaths: [explicitExtPath],
			});
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions[0]?.path).toBe(explicitExtPath);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth-explicit.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("explicit command");
			expect(runner.getCommand("deploy:2")?.description).toBe("global command");
			expect(runner.getToolDefinition("duplicate-tool")?.description).toBe("explicit tool");
		});
	});
});
