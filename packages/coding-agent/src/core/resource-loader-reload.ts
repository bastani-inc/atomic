import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isLocalPath } from "../utils/paths.ts";
import { clearExtensionCache, loadExtensionsCached } from "./extensions/loader.ts";
import type { LoadExtensionsResult } from "./extensions/types.ts";
import type { PathMetadata, ResolvedPaths } from "./package-manager.ts";
import { startTimingSpan, endTimingSpan } from "./timings.ts";
import { loadProjectContextFiles, resolvePromptInput } from "./resource-loader-context-files.ts";
import { discoverAppendSystemPromptFile, discoverSystemPromptFile } from "./resource-loader-discovery.ts";
import { loadExtensionFactories, loadFinalExtensionSet } from "./resource-loader-extensions.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";
import {
	collectWorkflowResources,
	createInheritanceSnapshotProvider,
	createWorkflowResourceProvider,
	resolvePackageResourcePaths,
	resolveTrustedBorrowedProjectLocalSources,
} from "./resource-loader-package-resources.ts";
import { applyExtensionSourceInfo } from "./resource-loader-source-info.ts";
import { updatePromptsFromPaths, updateSkillsFromPaths, updateThemesFromPaths } from "./resource-loader-assets.ts";
import { mergeResourcePaths, resolveResourcePath } from "./resource-loader-paths.ts";
import type { ResourceLoaderReloadOptions } from "./resource-loader-types.ts";

function getEnabledResources(
	resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
	metadataByPath: Map<string, PathMetadata>,
): Array<{ path: string; enabled: boolean; metadata: PathMetadata }> {
	for (const r of resources) {
		if (!metadataByPath.has(r.path)) {
			metadataByPath.set(r.path, r.metadata);
		}
	}
	return resources.filter((r) => r.enabled);
}

function getEnabledPaths(
	resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
	metadataByPath: Map<string, PathMetadata>,
): string[] {
	return getEnabledResources(resources, metadataByPath).map((r) => r.path);
}

function mapSkillPath(
	resource: { path: string; metadata: PathMetadata },
	metadataByPath: Map<string, PathMetadata>,
): string {
	if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
		return resource.path;
	}
	try {
		const stats = statSync(resource.path);
		if (!stats.isDirectory()) {
			return resource.path;
		}
	} catch {
		return resource.path;
	}
	const skillFile = join(resource.path, "SKILL.md");
	if (existsSync(skillFile)) {
		if (!metadataByPath.has(skillFile)) {
			metadataByPath.set(skillFile, resource.metadata);
		}
		return skillFile;
	}
	return resource.path;
}

function addCliMetadata(cliExtensionPaths: ResolvedPaths, metadataByPath: Map<string, PathMetadata>): void {
	for (const r of cliExtensionPaths.extensions) {
		if (!metadataByPath.has(r.path)) {
			metadataByPath.set(r.path, r.metadata);
		}
	}
	for (const r of cliExtensionPaths.skills) {
		if (!metadataByPath.has(r.path)) {
			metadataByPath.set(r.path, r.metadata);
		}
	}
}

export async function loadProjectTrustExtensions(loader: DefaultResourceLoader): Promise<LoadExtensionsResult> {
	const state = resourceInternals(loader);
	state.settingsManager.setProjectTrusted(false);
	await state.settingsManager.reload();
	const { resolvedPaths, cliExtensionPaths, builtinPackagePaths } = await resolvePackageResourcePaths(loader, {
		includeCliProjectLocalResources: false,
	});
	const metadataByPath = new Map<string, PathMetadata>();
	const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions, metadataByPath);
	const enabledExtensions = getEnabledPaths(resolvedPaths.extensions, metadataByPath);
	const builtinEnabledExtensions = state.noExtensions
		? []
		: getEnabledPaths(builtinPackagePaths.extensions, metadataByPath);
	const workflowResources = collectWorkflowResources(resolvedPaths, cliExtensionPaths, builtinPackagePaths);
	state.workflowResources = workflowResources;
	const workflowResourceProvider = createWorkflowResourceProvider(loader);
	const inheritanceSnapshotProvider = createInheritanceSnapshotProvider(loader);
	const extensionPaths = state.noExtensions
		? cliEnabledExtensions
		: mergeResourcePaths(state.cwd, cliEnabledExtensions, [...enabledExtensions, ...builtinEnabledExtensions]);
	const extensionsResult = await loadExtensionsCached(
		extensionPaths,
		state.cwd,
		state.eventBus,
		workflowResourceProvider,
		undefined,
		inheritanceSnapshotProvider,
	);
	const inlineExtensions = await loadExtensionFactories(
		loader,
		extensionsResult.runtime,
		workflowResourceProvider,
		inheritanceSnapshotProvider,
	);
	extensionsResult.extensions.push(...inlineExtensions.extensions);
	extensionsResult.errors.push(...inlineExtensions.errors);
	applyExtensionSourceInfo(loader, extensionsResult.extensions, metadataByPath);
	return extensionsResult;
}

export async function reloadDefaultResourceLoader(
	loader: DefaultResourceLoader,
	options?: ResourceLoaderReloadOptions,
): Promise<void> {
	const state = resourceInternals(loader);
	if (state.loaded) {
		clearExtensionCache();
	}
	let preTrustExtensions: LoadExtensionsResult | undefined;
	const initialProjectTrusted = state.settingsManager.isProjectTrusted();
	if (options?.resolveProjectTrust || options?.resolveBorrowedProjectTrust) {
		preTrustExtensions = await loadProjectTrustExtensions(loader);
	}
	if (options?.resolveProjectTrust && preTrustExtensions) {
		const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
		state.settingsManager.setProjectTrusted(projectTrusted);
	} else if (preTrustExtensions) {
		state.settingsManager.setProjectTrusted(initialProjectTrusted);
	}
	if (options?.resolveBorrowedProjectTrust) {
		state.trustedBorrowedProjectLocalSources = await resolveTrustedBorrowedProjectLocalSources(
			loader,
			options.resolveBorrowedProjectTrust,
			preTrustExtensions,
		);
	}
	const resolveSpan = startTimingSpan("DefaultResourceLoader.reload.resolvePackageResourcePaths");
	const { resolvedPaths, cliExtensionPaths, builtinPackagePaths } = await resolvePackageResourcePaths(loader, {
		trustedBorrowedProjectLocalSources: state.trustedBorrowedProjectLocalSources,
	});
	endTimingSpan(resolveSpan);
	const metadataByPath = new Map<string, PathMetadata>();

	state.extensionSkillSourceInfos = new Map();
	state.extensionPromptSourceInfos = new Map();
	state.extensionThemeSourceInfos = new Map();

	const enabledExtensions = getEnabledPaths(resolvedPaths.extensions, metadataByPath);
	const enabledSkillResources = getEnabledResources(resolvedPaths.skills, metadataByPath);
	const enabledPrompts = getEnabledPaths(resolvedPaths.prompts, metadataByPath);
	const enabledThemes = getEnabledPaths(resolvedPaths.themes, metadataByPath);

	const builtinEnabledExtensions = state.noExtensions
		? []
		: getEnabledPaths(builtinPackagePaths.extensions, metadataByPath);
	const builtinEnabledSkillResources = state.noSkills
		? []
		: getEnabledResources(builtinPackagePaths.skills, metadataByPath);
	const builtinEnabledPrompts = state.noPromptTemplates
		? []
		: getEnabledPaths(builtinPackagePaths.prompts, metadataByPath);
	const builtinEnabledThemes = state.noThemes
		? []
		: getEnabledPaths(builtinPackagePaths.themes, metadataByPath);

	const enabledSkills = enabledSkillResources.map((resource) => mapSkillPath(resource, metadataByPath));
	const builtinEnabledSkills = builtinEnabledSkillResources.map((resource) => mapSkillPath(resource, metadataByPath));

	addCliMetadata(cliExtensionPaths, metadataByPath);

	const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions, metadataByPath);
	const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills, metadataByPath);
	const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts, metadataByPath);
	const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes, metadataByPath);
	const workflowResources = collectWorkflowResources(resolvedPaths, cliExtensionPaths, builtinPackagePaths);
	state.workflowResources = workflowResources;
	const workflowResourceProvider = createWorkflowResourceProvider(loader);

	const extensionPaths = state.noExtensions
		? cliEnabledExtensions
		: mergeResourcePaths(state.cwd, cliEnabledExtensions, [...enabledExtensions, ...builtinEnabledExtensions]);

	const inheritanceSnapshotProvider = createInheritanceSnapshotProvider(loader);
	const extensionsResult = await loadFinalExtensionSet(
		loader,
		extensionPaths,
		preTrustExtensions,
		workflowResourceProvider,
		inheritanceSnapshotProvider,
	);

	for (const p of state.additionalExtensionPaths) {
		if (isLocalPath(p)) {
			const resolved = resolveResourcePath(state.cwd, p);
			if (!existsSync(resolved)) {
				extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
			}
		}
	}
	state.extensionsResult = state.extensionsOverride ? state.extensionsOverride(extensionsResult) : extensionsResult;
	applyExtensionSourceInfo(loader, state.extensionsResult.extensions, metadataByPath);

	const skillPaths = state.noSkills
		? mergeResourcePaths(state.cwd, cliEnabledSkills, state.additionalSkillPaths)
		: mergeResourcePaths(state.cwd, [...cliEnabledSkills, ...enabledSkills, ...builtinEnabledSkills], state.additionalSkillPaths);

	state.lastSkillPaths = skillPaths;
	const skillsSpan = startTimingSpan("DefaultResourceLoader.reload.updateSkillsFromPaths");
	updateSkillsFromPaths(loader, skillPaths, metadataByPath);
	endTimingSpan(skillsSpan);
	for (const p of state.additionalSkillPaths) {
		if (isLocalPath(p)) {
			const resolved = resolveResourcePath(state.cwd, p);
			if (!existsSync(resolved) && !state.skillDiagnostics.some((d) => d.path === resolved)) {
				state.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
			}
		}
	}

	const promptPaths = state.noPromptTemplates
		? mergeResourcePaths(state.cwd, cliEnabledPrompts, state.additionalPromptTemplatePaths)
		: mergeResourcePaths(state.cwd, [...cliEnabledPrompts, ...enabledPrompts, ...builtinEnabledPrompts], state.additionalPromptTemplatePaths);

	state.lastPromptPaths = promptPaths;
	const promptsSpan = startTimingSpan("DefaultResourceLoader.reload.updatePromptsFromPaths");
	updatePromptsFromPaths(loader, promptPaths, metadataByPath);
	endTimingSpan(promptsSpan);
	for (const p of state.additionalPromptTemplatePaths) {
		if (isLocalPath(p)) {
			const resolved = resolveResourcePath(state.cwd, p);
			if (!existsSync(resolved) && !state.promptDiagnostics.some((d) => d.path === resolved)) {
				state.promptDiagnostics.push({
					type: "error",
					message: "Prompt template path does not exist",
					path: resolved,
				});
			}
		}
	}

	const themePaths = state.noThemes
		? mergeResourcePaths(state.cwd, cliEnabledThemes, state.additionalThemePaths)
		: mergeResourcePaths(state.cwd, [...cliEnabledThemes, ...enabledThemes, ...builtinEnabledThemes], state.additionalThemePaths);

	state.lastThemePaths = themePaths;
	const themesSpan = startTimingSpan("DefaultResourceLoader.reload.updateThemesFromPaths");
	updateThemesFromPaths(loader, themePaths, metadataByPath);
	endTimingSpan(themesSpan);
	for (const p of state.additionalThemePaths) {
		const resolved = resolveResourcePath(state.cwd, p);
		if (!existsSync(resolved) && !state.themeDiagnostics.some((d) => d.path === resolved)) {
			state.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
		}
	}

	const contextFilesSpan = startTimingSpan("DefaultResourceLoader.reload.loadProjectContextFiles");
	const agentsFiles = {
		agentsFiles: state.noContextFiles
			? []
			: loadProjectContextFiles({
					cwd: state.cwd,
					agentDir: state.agentDir,
					projectTrusted: state.settingsManager.isProjectTrusted(),
				}),
	};
	endTimingSpan(contextFilesSpan);
	const resolvedAgentsFiles = state.agentsFilesOverride ? state.agentsFilesOverride(agentsFiles) : agentsFiles;
	state.agentsFiles = resolvedAgentsFiles.agentsFiles;

	const promptFilesSpan = startTimingSpan("DefaultResourceLoader.reload.resolvePromptFiles");
	const baseSystemPrompt = resolvePromptInput(
		state.systemPromptSource ?? discoverSystemPromptFile(loader),
		"system prompt",
	);
	state.systemPrompt = state.systemPromptOverride ? state.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;

	const discoveredAppend = discoverAppendSystemPromptFile(loader);
	const appendSources = state.appendSystemPromptSource ?? (discoveredAppend ? [discoveredAppend] : []);
	const baseAppend = appendSources
		.map((s) => resolvePromptInput(s, "append system prompt"))
		.filter((s): s is string => s !== undefined);
	state.appendSystemPrompt = state.appendSystemPromptOverride
		? state.appendSystemPromptOverride(baseAppend)
		: baseAppend;
	state.loaded = true;
	endTimingSpan(promptFilesSpan);
}
