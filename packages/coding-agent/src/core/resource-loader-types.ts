import type { EventBus } from "./event-bus.ts";
import type { ExtensionFactory, LoadExtensionsResult } from "./extensions/types.ts";
import type { PathMetadata, ResolvedResource } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import type { SettingsManager, PackageSource } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoaderReloadOptions {
	/**
	 * Skip loading extension code during this reload, leaving the loader with an
	 * empty extension set. Skills, prompts, themes, context files, and prompt
	 * files still load. A later full reload() picks up extensions.
	 */
	deferExtensions?: boolean;
	/**
	 * Skip all resource discovery and loading during this reload. This is used by
	 * interactive first-paint startup only when no CLI/startup input can observe
	 * resources before a later full reload() completes.
	 */
	deferResources?: boolean;
	resolveProjectTrust?: (options: { extensionsResult: LoadExtensionsResult }) => boolean | Promise<boolean>;
	resolveBorrowedProjectTrust?: (options: {
		source: string;
		resources: ResolvedResource[];
		extensionsResult: LoadExtensionsResult;
	}) => boolean | Promise<boolean>;
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	getEventBus?(): EventBus;
	extendResources(paths: ResourceExtensionPaths): Promise<void>;
	reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

export interface DefaultResourceLoaderInheritanceSnapshot {
	readonly projectTrusted?: boolean;
	readonly additionalExtensionPaths?: readonly string[];
	readonly additionalSkillPaths?: readonly string[];
	readonly additionalPromptTemplatePaths?: readonly string[];
	readonly additionalThemePaths?: readonly string[];
	readonly builtinPackagePaths?: readonly PackageSource[];
	readonly extensionFactories?: readonly ExtensionFactory[];
	readonly noExtensions?: boolean;
	readonly noSkills?: boolean;
	readonly noPromptTemplates?: boolean;
	readonly noThemes?: boolean;
	readonly noContextFiles?: boolean;
	readonly systemPrompt?: string;
	readonly appendSystemPrompt?: readonly string[];
	readonly trustedBorrowedProjectLocalSources?: readonly string[];
}

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	resourceLoaderInheritanceSnapshot?: DefaultResourceLoaderInheritanceSnapshot;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	builtinPackagePaths?: PackageSource[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
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
}
