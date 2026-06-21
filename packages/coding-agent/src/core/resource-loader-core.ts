import { resolvePath } from "../utils/paths.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import { createExtensionRuntime } from "./extensions/loader.ts";
import type { ExtensionFactory, LoadExtensionsResult } from "./extensions/types.ts";
import { DefaultPackageManager, type ResolvedResource } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { SettingsManager, type PackageSource } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import type { SourceInfo } from "./source-info.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { updatePromptsFromPaths, updateSkillsFromPaths, updateThemesFromPaths } from "./resource-loader-assets.ts";
import { clonePackageSources, mergeInheritedStrings } from "./resource-loader-helpers.ts";
import {
	collectWorkflowResources,
	normalizeExtensionPaths,
	recordExtensionSourceInfo,
	resolvePackageResourcePaths,
} from "./resource-loader-package-resources.ts";
import { mergeResourcePaths } from "./resource-loader-paths.ts";
import { loadProjectTrustExtensions, reloadDefaultResourceLoader } from "./resource-loader-reload.ts";
import type {
	DefaultResourceLoaderInheritanceSnapshot,
	DefaultResourceLoaderOptions,
	ResourceExtensionPaths,
	ResourceLoader,
	ResourceLoaderReloadOptions,
} from "./resource-loader-types.ts";

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private builtinPackagePaths: PackageSource[];
	private extensionFactories: ExtensionFactory[];
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];
	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private appendSystemPrompt: string[];
	private workflowResources: ResolvedResource[];
	private trustedBorrowedProjectLocalSources?: Set<string>;
	private lastSkillPaths: string[];
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	private lastPromptPaths: string[];
	private lastThemePaths: string[];

	constructor(options: DefaultResourceLoaderOptions) {
		const inheritanceSnapshot = options.resourceLoaderInheritanceSnapshot;
		const inheritedSettingsOptions = inheritanceSnapshot?.projectTrusted === undefined
			? undefined
			: { projectTrusted: inheritanceSnapshot.projectTrusted };
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(
			this.cwd,
			this.agentDir,
			inheritedSettingsOptions,
		);
		this.eventBus = options.eventBus ?? createEventBus();
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
		this.additionalExtensionPaths = mergeInheritedStrings(
			inheritanceSnapshot?.additionalExtensionPaths,
			options.additionalExtensionPaths,
		);
		this.additionalSkillPaths = mergeInheritedStrings(inheritanceSnapshot?.additionalSkillPaths, options.additionalSkillPaths);
		this.additionalPromptTemplatePaths = mergeInheritedStrings(
			inheritanceSnapshot?.additionalPromptTemplatePaths,
			options.additionalPromptTemplatePaths,
		);
		this.additionalThemePaths = mergeInheritedStrings(inheritanceSnapshot?.additionalThemePaths, options.additionalThemePaths);
		this.builtinPackagePaths = options.builtinPackagePaths !== undefined
			? clonePackageSources(options.builtinPackagePaths)
			: clonePackageSources(inheritanceSnapshot?.builtinPackagePaths);
		this.extensionFactories = [...(inheritanceSnapshot?.extensionFactories ?? []), ...(options.extensionFactories ?? [])];
		this.noExtensions = options.noExtensions ?? inheritanceSnapshot?.noExtensions ?? false;
		this.noSkills = options.noSkills ?? inheritanceSnapshot?.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? inheritanceSnapshot?.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? inheritanceSnapshot?.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? inheritanceSnapshot?.noContextFiles ?? false;
		this.systemPromptSource = options.systemPrompt ?? inheritanceSnapshot?.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt !== undefined
			? [...options.appendSystemPrompt]
			: inheritanceSnapshot?.appendSystemPrompt === undefined
				? undefined
				: [...inheritanceSnapshot.appendSystemPrompt];
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;
		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.workflowResources = [];
		this.trustedBorrowedProjectLocalSources = inheritanceSnapshot?.trustedBorrowedProjectLocalSources === undefined
			? undefined
			: new Set(inheritanceSnapshot.trustedBorrowedProjectLocalSources);
		this.lastSkillPaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
		this.touchInternalFieldsForSplit();
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	getWorkflowResources(): ResolvedResource[] {
		return [...this.workflowResources];
	}

	getInheritanceSnapshot(): DefaultResourceLoaderInheritanceSnapshot {
		return {
			projectTrusted: this.settingsManager.isProjectTrusted(),
			additionalExtensionPaths: [...this.additionalExtensionPaths],
			additionalSkillPaths: [...this.additionalSkillPaths],
			additionalPromptTemplatePaths: [...this.additionalPromptTemplatePaths],
			additionalThemePaths: [...this.additionalThemePaths],
			builtinPackagePaths: clonePackageSources(this.builtinPackagePaths),
			extensionFactories: [...this.extensionFactories],
			noExtensions: this.noExtensions,
			noSkills: this.noSkills,
			noPromptTemplates: this.noPromptTemplates,
			noThemes: this.noThemes,
			noContextFiles: this.noContextFiles,
			...(this.systemPromptSource === undefined ? {} : { systemPrompt: this.systemPromptSource }),
			...(this.appendSystemPromptSource === undefined ? {} : { appendSystemPrompt: [...this.appendSystemPromptSource] }),
			...(this.trustedBorrowedProjectLocalSources === undefined
				? {}
				: { trustedBorrowedProjectLocalSources: [...this.trustedBorrowedProjectLocalSources] }),
		};
	}

	async refreshWorkflowResources(): Promise<ResolvedResource[]> {
		const { resolvedPaths, cliExtensionPaths, builtinPackagePaths } = await resolvePackageResourcePaths(this, {
			trustedBorrowedProjectLocalSources: this.trustedBorrowedProjectLocalSources,
		});
		const workflowResources = collectWorkflowResources(resolvedPaths, cliExtensionPaths, builtinPackagePaths);
		this.workflowResources = workflowResources;
		return [...this.workflowResources];
	}

	extendResources(paths: ResourceExtensionPaths): void {
		const skillPaths = normalizeExtensionPaths(this, paths.skillPaths ?? []);
		const promptPaths = normalizeExtensionPaths(this, paths.promptPaths ?? []);
		const themePaths = normalizeExtensionPaths(this, paths.themePaths ?? []);
		recordExtensionSourceInfo(this, skillPaths, "skill");
		recordExtensionSourceInfo(this, promptPaths, "prompt");
		recordExtensionSourceInfo(this, themePaths, "theme");

		if (skillPaths.length > 0) {
			this.lastSkillPaths = mergeResourcePaths(this.cwd, this.lastSkillPaths, skillPaths.map((entry) => entry.path));
			updateSkillsFromPaths(this, this.lastSkillPaths);
		}
		if (promptPaths.length > 0) {
			this.lastPromptPaths = mergeResourcePaths(this.cwd, this.lastPromptPaths, promptPaths.map((entry) => entry.path));
			updatePromptsFromPaths(this, this.lastPromptPaths);
		}
		if (themePaths.length > 0) {
			this.lastThemePaths = mergeResourcePaths(this.cwd, this.lastThemePaths, themePaths.map((entry) => entry.path));
			updateThemesFromPaths(this, this.lastThemePaths);
		}
	}

	async loadProjectTrustExtensions(): Promise<LoadExtensionsResult> {
		return loadProjectTrustExtensions(this);
	}

	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		return reloadDefaultResourceLoader(this, options);
	}

	private touchInternalFieldsForSplit(): void {
		void this.eventBus;
		void this.packageManager;
		void this.noContextFiles;
		void this.extensionsOverride;
		void this.skillsOverride;
		void this.promptsOverride;
		void this.themesOverride;
		void this.agentsFilesOverride;
		void this.systemPromptOverride;
		void this.appendSystemPromptOverride;
		void this.extensionSkillSourceInfos;
		void this.extensionPromptSourceInfos;
		void this.extensionThemeSourceInfos;
	}
}
