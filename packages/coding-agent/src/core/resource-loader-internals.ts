import type { EventBus } from "./event-bus.ts";
import type { ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./extensions/types.ts";
import type { WorkflowResourceProvider } from "./extensions/loader.ts";
import type { DefaultPackageManager, ResolvedResource } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import type { SettingsManager, PackageSource } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import type { SourceInfo } from "./source-info.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import type { DefaultResourceLoaderInheritanceSnapshot } from "./resource-loader-types.ts";

export interface ResourceLoaderInternals {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	eventBus: EventBus;
	packageManager: DefaultPackageManager;
	additionalExtensionPaths: string[];
	additionalSkillPaths: string[];
	additionalPromptTemplatePaths: string[];
	additionalThemePaths: string[];
	builtinPackagePaths: PackageSource[];
	extensionFactories: ExtensionFactory[];
	noExtensions: boolean;
	noSkills: boolean;
	noPromptTemplates: boolean;
	noThemes: boolean;
	noContextFiles: boolean;
	systemPromptSource?: string;
	appendSystemPromptSource?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
	extensionsResult: LoadExtensionsResult;
	skills: Skill[];
	skillDiagnostics: ResourceDiagnostic[];
	prompts: PromptTemplate[];
	promptDiagnostics: ResourceDiagnostic[];
	themes: Theme[];
	themeDiagnostics: ResourceDiagnostic[];
	agentsFiles: Array<{ path: string; content: string }>;
	systemPrompt?: string;
	appendSystemPrompt: string[];
	workflowResources: ResolvedResource[];
	trustedBorrowedProjectLocalSources?: Set<string>;
	lastSkillPaths: string[];
	extensionSkillSourceInfos: Map<string, SourceInfo>;
	extensionPromptSourceInfos: Map<string, SourceInfo>;
	extensionThemeSourceInfos: Map<string, SourceInfo>;
	lastPromptPaths: string[];
	lastThemePaths: string[];
	getInheritanceSnapshot(): DefaultResourceLoaderInheritanceSnapshot;
	refreshWorkflowResources(): Promise<ResolvedResource[]>;
}

export interface ExtensionLoadDependencies {
	runtime: ExtensionRuntime;
	workflowResourceProvider: WorkflowResourceProvider;
	inheritanceSnapshotProvider: () => DefaultResourceLoaderInheritanceSnapshot;
}

export function resourceInternals(loader: object): ResourceLoaderInternals {
	return loader as unknown as ResourceLoaderInternals;
}
