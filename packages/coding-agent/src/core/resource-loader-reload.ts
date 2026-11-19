import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { pathExists as exists } from "../utils/path-exists.ts";
import { canonicalizePathAsync, isLocalPath, resolvePath } from "../utils/paths.ts";
import { getAllBuiltinPackageLocations, getMandatoryBuiltinExtensionPaths } from "./builtin-packages.ts";
import { filterSupersededHerdrIntegrationPaths } from "./extensions/herdr-file-integration.ts";
import { clearExtensionCache, createExtensionRuntime } from "./extensions/loader.ts";
import type { Extension, LoadExtensionsResult } from "./extensions/types.ts";
import { withMandatoryResourceLoader } from "./mandatory-resource-loader.ts";
import { isTrustedMandatoryRuntimeTool, markTrustedMandatoryRuntimeExtension } from "./mandatory-runtime-tools.ts";
import type { PathMetadata, ResolvedPaths } from "./package-manager.ts";
import { hostStoragePackagesRegistered } from "./package-manager-storage-adapters.js";
import {
	updatePromptsFromPathsAsync,
	updateSkillsFromPathsAsync,
	updateThemesFromPathsAsync,
} from "./resource-loader-assets.ts";
import {
	loadProjectContextFilesAsync,
	resolveExistingPromptSourcePath,
	resolveExistingPromptSourcePaths,
	resolvePromptInput,
} from "./resource-loader-context-files.ts";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";
import { discoverAppendSystemPromptFile, discoverSystemPromptFile } from "./resource-loader-discovery.ts";
import {
	collectExtensionPackageWarnings,
	collectPackageInstallWarnings,
	mergeExtensionWarnings,
} from "./resource-loader-extension-warnings.ts";
import {
	loadExtensionFactories,
	loadExtensionPaths,
	loadFinalExtensionSet,
	resolveInheritedExtensionOverlaps,
} from "./resource-loader-extensions.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import {
	collectMcpServerContributions,
	collectWorkflowResources,
	createInheritanceSnapshotProvider,
	createWorkflowResourceProvider,
	resolvePackageResourcePaths,
	resolveTrustedBorrowedProjectLocalSources,
} from "./resource-loader-package-resources.ts";
import { mergeResourcePaths, resolveResourcePath } from "./resource-loader-paths.ts";
import { applyExtensionSourceInfo } from "./resource-loader-source-info.ts";
import type { ResourceLoaderReloadOptions } from "./resource-loader-types.ts";
import { buildSkillCatalogAsync } from "./skill-catalog.ts";
import { BUILTIN_PATH_PREFIX } from "./source-info.ts";
import { endTimingSpan, resetTimings, startTimingSpan } from "./timings.ts";

async function filterDisabledBuiltinExtensionPaths(paths: string[], disabled: Set<string>): Promise<string[]> {
	if (disabled.size === 0) return paths;
	const roots = await Promise.all(
		getAllBuiltinPackageLocations()
			.filter((location) => disabled.has(location.distDirName))
			.map((location) => canonicalizePathAsync(location.packageDir)),
	);
	const kept = await Promise.all(
		paths.map(async (path) => {
			if (path.startsWith(BUILTIN_PATH_PREFIX)) return !disabled.has(path.slice(BUILTIN_PATH_PREFIX.length));
			if (roots.length === 0) return true;
			const canonicalPath = await canonicalizePathAsync(path);
			return !roots.some((root) => {
				const child = relative(root, canonicalPath);
				return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
			});
		}),
	);
	return paths.filter((_path, index) => kept[index]);
}

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

function getBuiltinExtensionPaths(
	resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
	metadataByPath: Map<string, PathMetadata>,
	noExtensions: boolean,
): string[] {
	for (const resource of resources) {
		if (!metadataByPath.has(resource.path)) metadataByPath.set(resource.path, resource.metadata);
	}
	return noExtensions ? [] : resources.filter((resource) => resource.enabled).map((resource) => resource.path);
}

async function mapSkillPath(
	resource: { path: string; metadata: PathMetadata },
	metadataByPath: Map<string, PathMetadata>,
): Promise<string> {
	if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
		return resource.path;
	}
	try {
		const stats = await stat(resource.path);
		if (!stats.isDirectory()) {
			return resource.path;
		}
	} catch {
		return resource.path;
	}
	const skillFile = join(resource.path, "SKILL.md");
	if (await exists(skillFile)) {
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

async function resolvePromptInputs(inputs: readonly string[]): Promise<string[]> {
	const resolved: string[] = [];
	for (const input of inputs) {
		const prompt = await resolvePromptInput(input, "append system prompt");
		if (prompt !== undefined) resolved.push(prompt);
	}
	return resolved;
}

export async function loadProjectTrustExtensions(loader: DefaultResourceLoader): Promise<LoadExtensionsResult> {
	const state = resourceInternals(loader);
	await state.settingsManager.setProjectTrustedAsync(false);
	await state.settingsManager.reload();
	const { resolvedPaths, cliExtensionPaths, builtinPackagePaths } = await resolvePackageResourcePaths(loader, {
		includeCliProjectLocalResources: false,
	});
	const metadataByPath = new Map<string, PathMetadata>();
	const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions, metadataByPath);
	const enabledExtensions = getEnabledPaths(resolvedPaths.extensions, metadataByPath);
	const builtinEnabledExtensions = getBuiltinExtensionPaths(
		builtinPackagePaths.extensions,
		metadataByPath,
		state.noExtensions,
	);
	const workflowResources = collectWorkflowResources(resolvedPaths, cliExtensionPaths, builtinPackagePaths);
	state.workflowResources = workflowResources;
	state.mcpServerContributions = collectMcpServerContributions(resolvedPaths, cliExtensionPaths, builtinPackagePaths);
	const workflowResourceProvider = createWorkflowResourceProvider(loader);
	const inheritanceSnapshotProvider = createInheritanceSnapshotProvider(loader);
	// The builtin Herdr reporter supersedes the installed file integration in a
	// Herdr pane; see extensions/herdr-file-integration.ts.
	const extensionPaths = await filterDisabledBuiltinExtensionPaths(
		filterSupersededHerdrIntegrationPaths(
			await mergeResourcePaths(
				state.cwd,
				cliEnabledExtensions,
				state.noExtensions ? builtinEnabledExtensions : [...enabledExtensions, ...builtinEnabledExtensions],
			),
		).filter((path) => !path.startsWith(BUILTIN_PATH_PREFIX)),
		state.disabledBuiltinExtensions,
	);
	const packageWarnings = await collectExtensionPackageWarnings(extensionPaths, metadataByPath);
	const installWarnings = collectPackageInstallWarnings(
		resolvedPaths.installFailures,
		cliExtensionPaths.installFailures,
	);
	const extensionsResult = await loadExtensionPaths(
		loader,
		extensionPaths,
		workflowResourceProvider,
		inheritanceSnapshotProvider,
	);
	mergeExtensionWarnings(extensionsResult, [...installWarnings, ...packageWarnings]);
	const inlineExtensions = await loadExtensionFactories(
		loader,
		extensionsResult.runtime,
		workflowResourceProvider,
		inheritanceSnapshotProvider,
	);
	extensionsResult.extensions.push(...inlineExtensions.extensions);
	extensionsResult.errors.push(...inlineExtensions.errors);
	const mandatoryPaths = new Set(getMandatoryBuiltinExtensionPaths().map((path) => resolvePath(path, state.cwd)));
	for (const extension of extensionsResult.extensions) {
		if (mandatoryPaths.has(extension.resolvedPath)) markTrustedMandatoryRuntimeExtension(extension);
	}
	await applyExtensionSourceInfo(loader, extensionsResult.extensions, metadataByPath);
	return extensionsResult;
}

export async function reloadDefaultResourceLoader(
	loader: DefaultResourceLoader,
	options?: ResourceLoaderReloadOptions,
): Promise<void> {
	const complete = await prepareDefaultResourceLoaderReload(loader, options);
	await complete();
}

/** Resolve trust without loading the approved project resources until continuation. */
export async function prepareDefaultResourceLoaderReload(
	loader: DefaultResourceLoader,
	options?: ResourceLoaderReloadOptions,
	startupSessionQuit?: () => boolean,
): Promise<() => Promise<void>> {
	const state = resourceInternals(loader);
	resetTimings("extensions");
	await hostStoragePackagesRegistered();
	if (state.loaded) {
		clearExtensionCache();
	}
	let preTrustExtensions: LoadExtensionsResult | undefined;
	const initialProjectTrusted = state.settingsManager.isProjectTrusted();
	if (options?.resolveProjectTrust || options?.resolveBorrowedProjectTrust) {
		preTrustExtensions = await loadProjectTrustExtensions(loader);
	}
	const resolveTrust = async () => {
		if (options?.resolveProjectTrust && preTrustExtensions) {
			const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
			await state.settingsManager.setProjectTrustedAsync(projectTrusted);
		} else if (preTrustExtensions) {
			await state.settingsManager.setProjectTrustedAsync(initialProjectTrusted);
		}
		if (options?.resolveBorrowedProjectTrust) {
			state.trustedBorrowedProjectLocalSources = await resolveTrustedBorrowedProjectLocalSources(
				loader,
				options.resolveBorrowedProjectTrust,
				preTrustExtensions,
			);
		}
		await options?.onProjectTrustResolved?.();
	};
	if (!options?.deferProjectTrust) await resolveTrust();
	const complete = async () => {
		if (options?.deferResources && !options.resolveProjectTrust && !options.resolveBorrowedProjectTrust) {
			await state.settingsManager.reload();
			const deferredExtensions: LoadExtensionsResult = {
				extensions: [],
				errors: [],
				runtime: createExtensionRuntime(),
			};
			const extensionsResult = state.extensionsOverride
				? state.extensionsOverride(deferredExtensions)
				: deferredExtensions;
			const emptySkills = state.skillsOverride ? state.skillsOverride({ skills: [], diagnostics: [] }) : undefined;
			const skills = emptySkills?.skills ?? [];
			const skillCatalog = await buildSkillCatalogAsync(skills);
			state.extensionsResult = extensionsResult;
			state.extensionSkillSourceInfos = new Map();
			state.extensionPromptSourceInfos = new Map();
			state.extensionThemeSourceInfos = new Map();
			state.workflowResources = [];
			state.mcpServerContributions = [];
			state.resourceMetadataByPath = new Map();
			state.lastSkillPaths = [];
			state.skills = skills;
			state.skillDiagnostics = emptySkills?.diagnostics ?? [];
			state.skillCatalog = skillCatalog;
			state.lastPromptPaths = [];
			const emptyPrompts = state.promptsOverride
				? state.promptsOverride({ prompts: [], diagnostics: [] })
				: undefined;
			state.prompts = emptyPrompts?.prompts ?? [];
			state.promptDiagnostics = emptyPrompts?.diagnostics ?? [];
			state.lastThemePaths = [];
			const emptyThemes = state.themesOverride ? state.themesOverride({ themes: [], diagnostics: [] }) : undefined;
			state.themes = emptyThemes?.themes ?? [];
			state.themeDiagnostics = emptyThemes?.diagnostics ?? [];
			const emptyAgentsFiles = { agentsFiles: [] };
			state.agentsFiles = state.agentsFilesOverride
				? state.agentsFilesOverride(emptyAgentsFiles).agentsFiles
				: emptyAgentsFiles.agentsFiles;
			const baseSystemPrompt = state.systemPromptSource
				? await resolvePromptInput(state.systemPromptSource, "system prompt")
				: undefined;
			const systemPromptSourcePath = await resolveExistingPromptSourcePath(state.systemPromptSource);
			const appendSources = state.appendSystemPromptSource ?? [];
			const baseAppend = await resolvePromptInputs(appendSources);
			const appendSystemPromptSourcePaths = await resolveExistingPromptSourcePaths(appendSources);
			state.systemPrompt = state.systemPromptOverride
				? state.systemPromptOverride(baseSystemPrompt)
				: baseSystemPrompt;
			state.systemPromptSourcePath = systemPromptSourcePath;
			state.appendSystemPrompt = state.appendSystemPromptOverride
				? state.appendSystemPromptOverride(baseAppend)
				: baseAppend;
			state.appendSystemPromptSourcePaths = appendSystemPromptSourcePaths;
			state.loaded = true;
			return;
		}
		const resolveSpan = startTimingSpan("DefaultResourceLoader.reload.resolvePackageResourcePaths");
		const { resolvedPaths, cliExtensionPaths, builtinPackagePaths } = await resolvePackageResourcePaths(loader, {
			trustedBorrowedProjectLocalSources: state.trustedBorrowedProjectLocalSources,
		});
		endTimingSpan(resolveSpan);
		// Kept on the loader so post-reload passes (extendResources) can still resolve
		// package metadata for paths this reload discovered.
		state.resourceMetadataByPath = new Map();
		const metadataByPath = state.resourceMetadataByPath;

		state.extensionSkillSourceInfos = new Map();
		state.extensionPromptSourceInfos = new Map();
		state.extensionThemeSourceInfos = new Map();

		const enabledExtensions = getEnabledPaths(resolvedPaths.extensions, metadataByPath);
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills, metadataByPath);
		const enabledPrompts = getEnabledPaths(resolvedPaths.prompts, metadataByPath);
		const enabledThemes = getEnabledPaths(resolvedPaths.themes, metadataByPath);

		const builtinEnabledExtensions = getBuiltinExtensionPaths(
			builtinPackagePaths.extensions,
			metadataByPath,
			state.noExtensions,
		);
		const builtinEnabledSkillResources = state.noSkills
			? []
			: getEnabledResources(builtinPackagePaths.skills, metadataByPath);
		const builtinEnabledPrompts = state.noPromptTemplates
			? []
			: getEnabledPaths(builtinPackagePaths.prompts, metadataByPath);
		const builtinEnabledThemes = state.noThemes ? [] : getEnabledPaths(builtinPackagePaths.themes, metadataByPath);

		const enabledSkills: string[] = [];
		for (const resource of enabledSkillResources) enabledSkills.push(await mapSkillPath(resource, metadataByPath));
		const builtinEnabledSkills: string[] = [];
		for (const resource of builtinEnabledSkillResources) {
			builtinEnabledSkills.push(await mapSkillPath(resource, metadataByPath));
		}

		addCliMetadata(cliExtensionPaths, metadataByPath);

		const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions, metadataByPath);
		const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills, metadataByPath);
		const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts, metadataByPath);
		const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes, metadataByPath);
		const workflowResources = collectWorkflowResources(resolvedPaths, cliExtensionPaths, builtinPackagePaths);
		state.workflowResources = workflowResources;
		state.mcpServerContributions = collectMcpServerContributions(
			resolvedPaths,
			cliExtensionPaths,
			builtinPackagePaths,
		);
		const workflowResourceProvider = createWorkflowResourceProvider(loader);

		// The builtin Herdr reporter supersedes the installed file integration in a
		// Herdr pane; see extensions/herdr-file-integration.ts.
		const extensionPaths = await filterDisabledBuiltinExtensionPaths(
			filterSupersededHerdrIntegrationPaths(
				await mergeResourcePaths(
					state.cwd,
					cliEnabledExtensions,
					state.noExtensions ? builtinEnabledExtensions : [...enabledExtensions, ...builtinEnabledExtensions],
				),
			),
			state.disabledBuiltinExtensions,
		);

		const inheritanceSnapshotProvider = createInheritanceSnapshotProvider(loader);
		const packageWarnings = await collectExtensionPackageWarnings(extensionPaths, metadataByPath);
		const installWarnings = collectPackageInstallWarnings(
			resolvedPaths.installFailures,
			cliExtensionPaths.installFailures,
		);
		const extensionsResult: LoadExtensionsResult = options?.deferExtensions
			? { extensions: [], errors: [], runtime: createExtensionRuntime() }
			: await loadFinalExtensionSet(
					loader,
					extensionPaths,
					preTrustExtensions,
					workflowResourceProvider,
					inheritanceSnapshotProvider,
					startupSessionQuit,
				);
		if (!options?.deferExtensions) mergeExtensionWarnings(extensionsResult, [...installWarnings, ...packageWarnings]);
		const mandatoryExtensionPaths = new Set(
			getMandatoryBuiltinExtensionPaths().map((path) =>
				resolvePath(path, state.cwd, { normalizeUnicodeSpaces: true }),
			),
		);
		const loadedMandatoryExtensions = new Set<Extension>(
			extensionsResult.extensions.filter((extension) =>
				mandatoryExtensionPaths.has(
					resolvePath(extension.resolvedPath, state.cwd, { normalizeUnicodeSpaces: true }),
				),
			),
		);
		for (const extension of loadedMandatoryExtensions) markTrustedMandatoryRuntimeExtension(extension);

		for (const p of state.additionalExtensionPaths) {
			if (isLocalPath(p)) {
				const resolved = resolveResourcePath(state.cwd, p);
				if (!(await exists(resolved))) {
					extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
				}
			}
		}
		const resolvedExtensionsResult = state.extensionsOverride
			? state.extensionsOverride(extensionsResult)
			: extensionsResult;
		await applyExtensionSourceInfo(loader, resolvedExtensionsResult.extensions, metadataByPath);
		state.extensionsResult = resolvedExtensionsResult;
		if (options?.deferProjectTrust && preTrustExtensions) {
			for (const extension of preTrustExtensions.extensions) {
				if (!extensionsResult.extensions.includes(extension)) extensionsResult.extensions.push(extension);
			}
		}
		for (const extension of state.extensionsResult.extensions) {
			const registration = extension.tools.get("intercom");
			if (loadedMandatoryExtensions.has(extension) && registration && isTrustedMandatoryRuntimeTool(registration)) {
				markTrustedMandatoryRuntimeExtension(extension);
			}
		}
		resolveInheritedExtensionOverlaps(state.extensionsResult);

		const skillPaths = state.noSkills
			? await mergeResourcePaths(state.cwd, cliEnabledSkills, state.additionalSkillPaths)
			: await mergeResourcePaths(
					state.cwd,
					[...cliEnabledSkills, ...enabledSkills, ...builtinEnabledSkills],
					state.additionalSkillPaths,
				);

		state.lastSkillPaths = skillPaths;
		const skillsStartedAt = Date.now();
		const skillsSpan = startTimingSpan("DefaultResourceLoader.reload.updateSkillsFromPathsAsync");
		await updateSkillsFromPathsAsync(loader, skillPaths, metadataByPath);
		endTimingSpan(skillsSpan);
		await yieldToEventLoopIfSlow(skillsStartedAt);
		for (const p of state.additionalSkillPaths) {
			if (isLocalPath(p)) {
				const resolved = resolveResourcePath(state.cwd, p);
				if (!(await exists(resolved)) && !state.skillDiagnostics.some((d) => d.path === resolved)) {
					state.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
				}
			}
		}

		const promptPaths = state.noPromptTemplates
			? await mergeResourcePaths(state.cwd, cliEnabledPrompts, state.additionalPromptTemplatePaths)
			: await mergeResourcePaths(
					state.cwd,
					[...cliEnabledPrompts, ...enabledPrompts, ...builtinEnabledPrompts],
					state.additionalPromptTemplatePaths,
				);

		state.lastPromptPaths = promptPaths;
		const promptsStartedAt = Date.now();
		const promptsSpan = startTimingSpan("DefaultResourceLoader.reload.updatePromptsFromPathsAsync");
		await updatePromptsFromPathsAsync(loader, promptPaths, metadataByPath);
		endTimingSpan(promptsSpan);
		await yieldToEventLoopIfSlow(promptsStartedAt);
		for (const p of state.additionalPromptTemplatePaths) {
			if (isLocalPath(p)) {
				const resolved = resolveResourcePath(state.cwd, p);
				if (!(await exists(resolved)) && !state.promptDiagnostics.some((d) => d.path === resolved)) {
					state.promptDiagnostics.push({
						type: "error",
						message: "Prompt template path does not exist",
						path: resolved,
					});
				}
			}
		}

		const themePaths = state.noThemes
			? await mergeResourcePaths(state.cwd, cliEnabledThemes, state.additionalThemePaths)
			: await mergeResourcePaths(
					state.cwd,
					[...cliEnabledThemes, ...enabledThemes, ...builtinEnabledThemes],
					state.additionalThemePaths,
				);

		state.lastThemePaths = themePaths;
		const themesStartedAt = Date.now();
		const themesSpan = startTimingSpan("DefaultResourceLoader.reload.updateThemesFromPathsAsync");
		await updateThemesFromPathsAsync(loader, themePaths, metadataByPath);
		endTimingSpan(themesSpan);
		await yieldToEventLoopIfSlow(themesStartedAt);
		for (const p of state.additionalThemePaths) {
			const resolved = resolveResourcePath(state.cwd, p);
			if (!(await exists(resolved)) && !state.themeDiagnostics.some((d) => d.path === resolved)) {
				state.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
			}
		}

		const contextFilesStartedAt = Date.now();
		const contextFilesSpan = startTimingSpan("DefaultResourceLoader.reload.loadProjectContextFiles");
		const agentsFiles = {
			agentsFiles: state.noContextFiles
				? []
				: await loadProjectContextFilesAsync({
						cwd: state.cwd,
						agentDir: state.agentDir,
						projectTrusted: state.settingsManager.isProjectTrusted(),
					}),
		};
		endTimingSpan(contextFilesSpan);
		await yieldToEventLoopIfSlow(contextFilesStartedAt);
		const resolvedAgentsFiles = state.agentsFilesOverride ? state.agentsFilesOverride(agentsFiles) : agentsFiles;
		state.agentsFiles = resolvedAgentsFiles.agentsFiles;

		const promptFilesStartedAt = Date.now();
		const promptFilesSpan = startTimingSpan("DefaultResourceLoader.reload.resolvePromptFiles");
		const systemPromptSource = state.systemPromptSource ?? (await discoverSystemPromptFile(loader));
		const baseSystemPrompt = await resolvePromptInput(systemPromptSource, "system prompt");
		const systemPromptSourcePath = await resolveExistingPromptSourcePath(systemPromptSource);

		const discoveredAppend = await discoverAppendSystemPromptFile(loader);
		const appendSources = state.appendSystemPromptSource ?? (discoveredAppend ? [discoveredAppend] : []);
		const baseAppend = await resolvePromptInputs(appendSources);
		const appendSystemPromptSourcePaths = await resolveExistingPromptSourcePaths(appendSources);
		state.systemPrompt = state.systemPromptOverride ? state.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;
		state.systemPromptSourcePath = systemPromptSourcePath;
		state.appendSystemPrompt = state.appendSystemPromptOverride
			? state.appendSystemPromptOverride(baseAppend)
			: baseAppend;
		state.appendSystemPromptSourcePaths = appendSystemPromptSourcePaths;
		state.loaded = true;
		endTimingSpan(promptFilesSpan);
		await yieldToEventLoopIfSlow(promptFilesStartedAt);
	};
	if (options?.deferProjectTrust && preTrustExtensions) {
		state.extensionsResult = preTrustExtensions;
		preTrustExtensions = (await withMandatoryResourceLoader(loader, state.cwd, state.agentDir)).getExtensions();
		state.extensionsResult = preTrustExtensions;
		let trustResolution: Promise<void> | undefined;
		options.deferProjectTrust(async () => {
			trustResolution ??= resolveTrust();
			await trustResolution;
			await complete();
		});
		return async () => {};
	}
	return complete;
}
