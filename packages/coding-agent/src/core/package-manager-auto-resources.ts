import { dirname, join, resolve } from "node:path";
import { getProjectConfigDirs } from "../config.ts";
import { getHomeDir, getBaseDirsForScope } from "./package-manager-paths.ts";
import { addResource, getTargetMap } from "./package-manager-resource-accumulator.ts";
import {
	collectAncestorAgentsSkillDirs,
	collectAutoExtensionEntries,
	collectAutoPromptEntries,
	collectAutoSkillEntries,
	collectAutoThemeEntries,
	collectResourceFiles,
} from "./package-manager-resource-files.ts";
import { applyPatterns, isEnabledByOverrides } from "./package-manager-resource-patterns.ts";
import type {
	PackageFilter,
	PackageManagerContext,
	PathMetadata,
	ResourceAccumulator,
	ResourceType,
} from "./package-manager-types.ts";
import type { SettingsManager } from "./settings-manager.ts";

export function collectProjectLocalResources(
	sourceRoot: string,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
): boolean {
	let found = false;
	const projectMetadata: PathMetadata = { ...metadata, origin: "top-level", borrowedProjectLocal: true };

	const addResources = (
		resourceType: ResourceType,
		paths: string[],
		resourceMetadata: PathMetadata,
		patterns: string[] | undefined,
	): void => {
		if (paths.length === 0) return;
		found = true;
		const target = getTargetMap(accumulator, resourceType);
		let enabledPaths: Set<string>;
		if (patterns === undefined) {
			enabledPaths = new Set(paths);
		} else if (patterns.length === 0) {
			enabledPaths = new Set();
		} else {
			enabledPaths = applyPatterns(paths, patterns, sourceRoot);
		}
		for (const path of paths) {
			addResource(target, path, resourceMetadata, enabledPaths.has(path));
		}
	};

	for (const configDir of getProjectConfigDirs(sourceRoot)) {
		const configMetadata: PathMetadata = { ...projectMetadata, baseDir: configDir };
		addResources("extensions", collectAutoExtensionEntries(join(configDir, "extensions")), configMetadata, filter?.extensions);
		addResources("skills", collectAutoSkillEntries(join(configDir, "skills"), "pi"), configMetadata, filter?.skills);
		addResources("prompts", collectAutoPromptEntries(join(configDir, "prompts")), configMetadata, filter?.prompts);
		addResources("themes", collectAutoThemeEntries(join(configDir, "themes")), configMetadata, filter?.themes);
		addResources("workflows", collectResourceFiles(join(configDir, "workflows"), "workflows"), configMetadata, filter?.workflows);
	}

	const agentsSkillsDir = join(sourceRoot, ".agents", "skills");
	addResources(
		"skills",
		collectAutoSkillEntries(agentsSkillsDir, "agents"),
		{ ...projectMetadata, baseDir: dirname(agentsSkillsDir) },
		filter?.skills,
	);

	return found;
}

export function addAutoDiscoveredResources(
	context: PackageManagerContext,
	accumulator: ResourceAccumulator,
	globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
	projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
	globalBaseDir: string,
	projectBaseDir: string,
): void {
	const userMetadata: PathMetadata = {
		source: "auto",
		scope: "user",
		origin: "top-level",
		baseDir: globalBaseDir,
	};
	const projectMetadata: PathMetadata = {
		source: "auto",
		scope: "project",
		origin: "top-level",
		baseDir: projectBaseDir,
	};

	const userOverrides = {
		extensions: (globalSettings.extensions ?? []) as string[],
		skills: (globalSettings.skills ?? []) as string[],
		prompts: (globalSettings.prompts ?? []) as string[],
		themes: (globalSettings.themes ?? []) as string[],
		workflows: (globalSettings.workflows ?? []) as string[],
	};
	const projectOverrides = {
		extensions: (projectSettings.extensions ?? []) as string[],
		skills: (projectSettings.skills ?? []) as string[],
		prompts: (projectSettings.prompts ?? []) as string[],
		themes: (projectSettings.themes ?? []) as string[],
		workflows: (projectSettings.workflows ?? []) as string[],
	};

	const userConfigDirs = getBaseDirsForScope(context, "user");
	const projectConfigDirs = getBaseDirsForScope(context, "project");
	const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
	const projectTrusted = context.settingsManager.isProjectTrusted();
	const projectAgentsSkillDirs = projectTrusted
		? collectAncestorAgentsSkillDirs(context.cwd).filter((dir) => resolve(dir) !== resolve(userAgentsSkillsDir))
		: [];

	const addResources = (
		resourceType: ResourceType,
		paths: string[],
		metadata: PathMetadata,
		overrides: string[],
		baseDir: string,
	) => {
		const target = getTargetMap(accumulator, resourceType);
		for (const path of paths) {
			const enabled = isEnabledByOverrides(path, overrides, baseDir);
			addResource(target, path, metadata, enabled);
		}
	};

	if (projectTrusted) {
		for (const configDir of projectConfigDirs) {
			const metadata: PathMetadata = { ...projectMetadata, baseDir: configDir };
			addResources("extensions", collectAutoExtensionEntries(join(configDir, "extensions")), metadata, projectOverrides.extensions, configDir);
			addResources("skills", collectAutoSkillEntries(join(configDir, "skills"), "pi"), metadata, projectOverrides.skills, configDir);
			addResources("prompts", collectAutoPromptEntries(join(configDir, "prompts")), metadata, projectOverrides.prompts, configDir);
			addResources("themes", collectAutoThemeEntries(join(configDir, "themes")), metadata, projectOverrides.themes, configDir);
			addResources("workflows", collectResourceFiles(join(configDir, "workflows"), "workflows"), metadata, projectOverrides.workflows, configDir);
		}
	}

	for (const agentsSkillsDir of projectAgentsSkillDirs) {
		const agentsBaseDir = dirname(agentsSkillsDir);
		const agentsMetadata: PathMetadata = { ...projectMetadata, baseDir: agentsBaseDir };
		addResources("skills", collectAutoSkillEntries(agentsSkillsDir, "agents"), agentsMetadata, projectOverrides.skills, agentsBaseDir);
	}

	for (const configDir of userConfigDirs) {
		const metadata: PathMetadata = { ...userMetadata, baseDir: configDir };
		addResources("extensions", collectAutoExtensionEntries(join(configDir, "extensions")), metadata, userOverrides.extensions, configDir);
		addResources("skills", collectAutoSkillEntries(join(configDir, "skills"), "pi"), metadata, userOverrides.skills, configDir);
		addResources("prompts", collectAutoPromptEntries(join(configDir, "prompts")), metadata, userOverrides.prompts, configDir);
		addResources("themes", collectAutoThemeEntries(join(configDir, "themes")), metadata, userOverrides.themes, configDir);
		addResources("workflows", collectResourceFiles(join(configDir, "workflows"), "workflows"), metadata, userOverrides.workflows, configDir);
	}

	const userAgentsBaseDir = dirname(userAgentsSkillsDir);
	const userAgentsMetadata: PathMetadata = { ...userMetadata, baseDir: userAgentsBaseDir };
	addResources(
		"skills",
		collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
		userAgentsMetadata,
		userOverrides.skills,
		userAgentsBaseDir,
	);
}
