import { dirname, join, resolve } from "node:path";
import { getProjectConfigDirs } from "../config.ts";
import { getBaseDirsForScope, getHomeDir } from "./package-manager-paths.ts";
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
import type { PackageFilter, PackageManagerContext, PathMetadata, ResourceAccumulator, ResourceType } from "./package-manager-types.ts";
import type { SettingsManager } from "./settings-manager.ts";

export async function collectProjectLocalResources(
	sourceRoot: string,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
): Promise<boolean> {
	let found = false;
	const projectMetadata: PathMetadata = { ...metadata, origin: "top-level", borrowedProjectLocal: true };
	const addResources = (resourceType: ResourceType, paths: string[], resourceMetadata: PathMetadata, patterns: string[] | undefined): void => {
		if (paths.length === 0) return;
		found = true;
		const target = getTargetMap(accumulator, resourceType);
		const enabledPaths = patterns === undefined
			? new Set(paths)
			: patterns.length === 0
				? new Set<string>()
				: applyPatterns(paths, patterns, sourceRoot);
		for (const path of paths) addResource(target, path, resourceMetadata, enabledPaths.has(path));
	};
	for (const configDir of getProjectConfigDirs(sourceRoot)) {
		const configMetadata: PathMetadata = { ...projectMetadata, baseDir: configDir };
		addResources("extensions", await collectAutoExtensionEntries(join(configDir, "extensions")), configMetadata, filter?.extensions);
		addResources("skills", await collectAutoSkillEntries(join(configDir, "skills"), "pi"), configMetadata, filter?.skills);
		addResources("prompts", await collectAutoPromptEntries(join(configDir, "prompts")), configMetadata, filter?.prompts);
		addResources("themes", await collectAutoThemeEntries(join(configDir, "themes")), configMetadata, filter?.themes);
		addResources("workflows", await collectResourceFiles(join(configDir, "workflows"), "workflows"), configMetadata, filter?.workflows);
	}
	const agentsSkillsDir = join(sourceRoot, ".agents", "skills");
	addResources("skills", await collectAutoSkillEntries(agentsSkillsDir, "agents"), { ...projectMetadata, baseDir: dirname(agentsSkillsDir) }, filter?.skills);
	return found;
}

export async function addAutoDiscoveredResources(
	context: PackageManagerContext,
	accumulator: ResourceAccumulator,
	globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
	projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
	globalBaseDir: string,
	projectBaseDir: string,
): Promise<void> {
	const userMetadata: PathMetadata = { source: "auto", scope: "user", origin: "top-level", baseDir: globalBaseDir };
	const projectMetadata: PathMetadata = { source: "auto", scope: "project", origin: "top-level", baseDir: projectBaseDir };
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
		? (await collectAncestorAgentsSkillDirs(context.cwd)).filter((dir) => resolve(dir) !== resolve(userAgentsSkillsDir))
		: [];
	const addResources = (resourceType: ResourceType, paths: string[], metadata: PathMetadata, overrides: string[], baseDir: string): void => {
		const target = getTargetMap(accumulator, resourceType);
		for (const path of paths) addResource(target, path, metadata, isEnabledByOverrides(path, overrides, baseDir));
	};
	if (projectTrusted) {
		for (const configDir of projectConfigDirs) {
			const metadata: PathMetadata = { ...projectMetadata, baseDir: configDir };
			addResources("extensions", await collectAutoExtensionEntries(join(configDir, "extensions")), metadata, projectOverrides.extensions, configDir);
			addResources("skills", await collectAutoSkillEntries(join(configDir, "skills"), "pi"), metadata, projectOverrides.skills, configDir);
			addResources("prompts", await collectAutoPromptEntries(join(configDir, "prompts")), metadata, projectOverrides.prompts, configDir);
			addResources("themes", await collectAutoThemeEntries(join(configDir, "themes")), metadata, projectOverrides.themes, configDir);
			addResources("workflows", await collectResourceFiles(join(configDir, "workflows"), "workflows"), metadata, projectOverrides.workflows, configDir);
		}
	}
	for (const agentsSkillsDir of projectAgentsSkillDirs) {
		const agentsBaseDir = dirname(agentsSkillsDir);
		addResources("skills", await collectAutoSkillEntries(agentsSkillsDir, "agents"), { ...projectMetadata, baseDir: agentsBaseDir }, projectOverrides.skills, agentsBaseDir);
	}
	for (const configDir of userConfigDirs) {
		const metadata: PathMetadata = { ...userMetadata, baseDir: configDir };
		addResources("extensions", await collectAutoExtensionEntries(join(configDir, "extensions")), metadata, userOverrides.extensions, configDir);
		addResources("skills", await collectAutoSkillEntries(join(configDir, "skills"), "pi"), metadata, userOverrides.skills, configDir);
		addResources("prompts", await collectAutoPromptEntries(join(configDir, "prompts")), metadata, userOverrides.prompts, configDir);
		addResources("themes", await collectAutoThemeEntries(join(configDir, "themes")), metadata, userOverrides.themes, configDir);
		addResources("workflows", await collectResourceFiles(join(configDir, "workflows"), "workflows"), metadata, userOverrides.workflows, configDir);
	}
	const userAgentsBaseDir = dirname(userAgentsSkillsDir);
	addResources("skills", await collectAutoSkillEntries(userAgentsSkillsDir, "agents"), { ...userMetadata, baseDir: userAgentsBaseDir }, userOverrides.skills, userAgentsBaseDir);
}
