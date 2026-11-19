import { dirname, join } from "node:path";
import { getProjectConfigDirs } from "../config.js";
import { pathsEqual } from "../utils/paths.ts";
import { legacyWorkflowFilePatterns } from "./package-manager-manifest.ts";
import { getBaseDirsForScope, getHomeDir } from "./package-manager-paths.ts";
import { addResource } from "./package-manager-resource-accumulator.ts";
import {
	collectAncestorAgentsSkillDirs,
	collectAutoExtensionEntries,
	collectAutoLegacyWorkflowFiles,
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
	ResourceMap,
} from "./package-manager-types.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { legacyWorkflowFilePaths } from "./settings-manager-internals.ts";

export async function collectProjectLocalResources(
	sourceRoot: string,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
): Promise<boolean> {
	let found = false;
	const projectMetadata: PathMetadata = { ...metadata, origin: "top-level", borrowedProjectLocal: true };
	const addResources = (
		target: ResourceMap,
		paths: string[],
		resourceMetadata: PathMetadata,
		patterns: string[] | undefined,
	): void => {
		if (paths.length === 0) return;
		found = true;
		const enabledPaths =
			patterns === undefined
				? new Set(paths)
				: patterns.length === 0
					? new Set<string>()
					: applyPatterns(paths, patterns, sourceRoot);
		for (const path of paths) addResource(target, path, resourceMetadata, enabledPaths.has(path));
	};
	for (const configDir of getProjectConfigDirs(sourceRoot)) {
		const configMetadata: PathMetadata = { ...projectMetadata, baseDir: configDir };
		addResources(
			accumulator.extensions,
			await collectAutoExtensionEntries(join(configDir, "extensions")),
			configMetadata,
			filter?.extensions,
		);
		addResources(
			accumulator.skills,
			await collectAutoSkillEntries(join(configDir, "skills"), "pi"),
			configMetadata,
			filter?.skills,
		);
		addResources(
			accumulator.prompts,
			await collectAutoPromptEntries(join(configDir, "prompts")),
			configMetadata,
			filter?.prompts,
		);
		addResources(
			accumulator.themes,
			await collectAutoThemeEntries(join(configDir, "themes")),
			configMetadata,
			filter?.themes,
		);
		addResources(
			accumulator.legacyWorkflowFiles,
			await collectResourceFiles(join(configDir, "workflows"), "legacyWorkflowFiles"),
			configMetadata,
			legacyWorkflowFilePatterns(filter),
		);
	}
	const agentsSkillsDir = join(sourceRoot, ".agents", "skills");
	addResources(
		accumulator.skills,
		await collectAutoSkillEntries(agentsSkillsDir, "agents"),
		{ ...projectMetadata, baseDir: dirname(agentsSkillsDir) },
		filter?.skills,
	);
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
		legacyWorkflowFiles: legacyWorkflowFilePaths(context.settingsManager, "global"),
	};
	const projectOverrides = {
		extensions: (projectSettings.extensions ?? []) as string[],
		skills: (projectSettings.skills ?? []) as string[],
		prompts: (projectSettings.prompts ?? []) as string[],
		themes: (projectSettings.themes ?? []) as string[],
		legacyWorkflowFiles: legacyWorkflowFilePaths(context.settingsManager, "project"),
	};
	const userConfigDirs = getBaseDirsForScope(context, "user");
	const projectConfigDirs = getBaseDirsForScope(context, "project");
	const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
	const projectTrusted = context.settingsManager.isProjectTrusted();
	const projectAgentsSkillDirs = projectTrusted
		? (await collectAncestorAgentsSkillDirs(context.cwd)).filter((dir) => !pathsEqual(dir, userAgentsSkillsDir))
		: [];
	const addResources = (
		target: ResourceMap,
		paths: string[],
		metadata: PathMetadata,
		overrides: string[],
		baseDir: string,
	): void => {
		for (const path of paths) addResource(target, path, metadata, isEnabledByOverrides(path, overrides, baseDir));
	};
	if (projectTrusted) {
		for (const [index, configDir] of projectConfigDirs.entries()) {
			const metadata: PathMetadata = {
				...projectMetadata,
				baseDir: configDir,
				configurationOrigin: index === 0 ? "atomic" : "inherited-pi",
			};
			addResources(
				accumulator.extensions,
				await collectAutoExtensionEntries(join(configDir, "extensions")),
				metadata,
				projectOverrides.extensions,
				configDir,
			);
			addResources(
				accumulator.skills,
				await collectAutoSkillEntries(join(configDir, "skills"), "pi"),
				metadata,
				projectOverrides.skills,
				configDir,
			);
			addResources(
				accumulator.prompts,
				await collectAutoPromptEntries(join(configDir, "prompts")),
				metadata,
				projectOverrides.prompts,
				configDir,
			);
			addResources(
				accumulator.themes,
				await collectAutoThemeEntries(join(configDir, "themes")),
				metadata,
				projectOverrides.themes,
				configDir,
			);
			addResources(
				accumulator.legacyWorkflowFiles,
				await collectAutoLegacyWorkflowFiles(join(configDir, "workflows")),
				metadata,
				projectOverrides.legacyWorkflowFiles,
				configDir,
			);
		}
	}
	const projectAgentsSkills = await Promise.all(
		projectAgentsSkillDirs.map((dir) => collectAutoSkillEntries(dir, "agents")),
	);
	for (const [index, agentsSkillsDir] of projectAgentsSkillDirs.entries()) {
		const agentsBaseDir = dirname(agentsSkillsDir);
		addResources(
			accumulator.skills,
			projectAgentsSkills[index],
			{ ...projectMetadata, baseDir: agentsBaseDir },
			projectOverrides.skills,
			agentsBaseDir,
		);
	}
	for (const [index, configDir] of userConfigDirs.entries()) {
		const metadata: PathMetadata = {
			...userMetadata,
			baseDir: configDir,
			configurationOrigin: index === 0 ? "atomic" : "inherited-pi",
		};
		addResources(
			accumulator.extensions,
			await collectAutoExtensionEntries(join(configDir, "extensions")),
			metadata,
			userOverrides.extensions,
			configDir,
		);
		addResources(
			accumulator.skills,
			await collectAutoSkillEntries(join(configDir, "skills"), "pi"),
			metadata,
			userOverrides.skills,
			configDir,
		);
		addResources(
			accumulator.prompts,
			await collectAutoPromptEntries(join(configDir, "prompts")),
			metadata,
			userOverrides.prompts,
			configDir,
		);
		addResources(
			accumulator.themes,
			await collectAutoThemeEntries(join(configDir, "themes")),
			metadata,
			userOverrides.themes,
			configDir,
		);
		addResources(
			accumulator.legacyWorkflowFiles,
			await collectAutoLegacyWorkflowFiles(join(configDir, "workflows")),
			metadata,
			userOverrides.legacyWorkflowFiles,
			configDir,
		);
	}
	const userAgentsBaseDir = dirname(userAgentsSkillsDir);
	addResources(
		accumulator.skills,
		await collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
		{ ...userMetadata, baseDir: userAgentsBaseDir },
		userOverrides.skills,
		userAgentsBaseDir,
	);
}
