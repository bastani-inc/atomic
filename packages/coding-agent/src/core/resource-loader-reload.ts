import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { pathExists as exists } from "../utils/path-exists.ts";
import { canonicalizePathAsync, isLocalPath, resolvePath } from "../utils/paths.ts";
import { getAllBuiltinPackageLocations, getMandatoryBuiltinExtensionPaths } from "./builtin-packages.ts";
import { filterSupersededHerdrIntegrationPaths } from "./extensions/herdr-file-integration.ts";
import { clearExtensionCache, createExtensionRuntime, setExtensionRuntimeEventBus } from "./extensions/loader.ts";
import type { Extension, LoadExtensionsResult } from "./extensions/types.ts";
import { findLegacyWorkflowFiles } from "./legacy-workflow-files.js";
import { withMandatoryResourceLoader } from "./mandatory-resource-loader.ts";
import { isTrustedMandatoryRuntimeTool, markTrustedMandatoryRuntimeExtension } from "./mandatory-runtime-tools.ts";
import type { PathMetadata, ResolvedPaths } from "./package-manager.ts";
import { hostStoragePackagesRegistered } from "./package-manager-storage-adapters.js";
import {
	loadPromptsStageAsync,
	loadSkillsStageAsync,
	loadThemesStageAsync,
	preparePromptsCommitAsync,
	prepareSkillsCommitAsync,
	prepareThemesCommitAsync,
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
	bundledInlineFactories,
	loadExtensionFactories,
	loadExtensionPaths,
	loadFinalExtensionSet,
	omitInlineFactories,
	resolveInheritedExtensionOverlaps,
} from "./resource-loader-extensions.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import {
	collectMcpServerContributions,
	collectPackageAgentFiles,
	createInheritanceSnapshotProvider,
	createPackageMcpServerSource,
	resolvePackageResourcePaths,
	resolveTrustedBorrowedProjectLocalSources,
} from "./resource-loader-package-resources.ts";
import { mergeResourcePaths, resolveResourcePath } from "./resource-loader-paths.ts";
import { applyExtensionSourceInfo } from "./resource-loader-source-info.ts";
import type { ResourceLoaderReloadOptions } from "./resource-loader-types.ts";
import { buildSkillCatalogAsync } from "./skill-catalog.ts";
import { BUILTIN_PATH_PREFIX } from "./source-info.ts";
import { endTimingSpan, resetTimings, startTimingSpan } from "./timings.ts";

async function resolveDisabledBuiltinRoots(disabled: Set<string>): Promise<string[]> {
	if (disabled.size === 0) return [];
	return Promise.all(
		getAllBuiltinPackageLocations()
			.filter((location) => disabled.has(location.distDirName))
			.map((location) => canonicalizePathAsync(location.packageDir)),
	);
}

async function filterDisabledBuiltinPaths(
	paths: string[],
	disabled: Set<string>,
	roots?: readonly string[],
): Promise<string[]> {
	if (disabled.size === 0 || paths.length === 0) return paths;
	const resolvedRoots = roots ?? (await resolveDisabledBuiltinRoots(disabled));
	const kept = await Promise.all(
		paths.map(async (path) => {
			if (path.startsWith(BUILTIN_PATH_PREFIX)) return !disabled.has(path.slice(BUILTIN_PATH_PREFIX.length));
			if (resolvedRoots.length === 0) return true;
			const canonicalPath = await canonicalizePathAsync(path);
			return !resolvedRoots.some((root) => {
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

async function resolvePromptInputs(
	inputs: readonly string[],
	onWarning?: (message: string) => void,
): Promise<string[]> {
	const resolved: string[] = [];
	for (const input of inputs) {
		const prompt = await resolvePromptInput(input, "append system prompt", onWarning);
		if (prompt !== undefined) resolved.push(prompt);
	}
	return resolved;
}

export async function loadProjectTrustExtensions(
	loader: DefaultResourceLoader,
	only?: ResourceLoaderReloadOptions["preTrustExtensions"],
): Promise<LoadExtensionsResult> {
	const state = resourceInternals(loader);
	await state.settingsManager.setProjectTrustedAsync(false);
	await state.settingsManager.reload();
	const { resolvedPaths, cliExtensionPaths, builtinPackagePaths } = await resolvePackageResourcePaths(loader, {
		includeCliProjectLocalResources: false,
		...(only === "bundled" ? { withoutConfigured: true as const } : {}),
	});
	const metadataByPath = new Map<string, PathMetadata>();
	const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions, metadataByPath);
	const enabledExtensions = getEnabledPaths(resolvedPaths.extensions, metadataByPath);
	const builtinEnabledExtensions = getBuiltinExtensionPaths(
		builtinPackagePaths.extensions,
		metadataByPath,
		state.noExtensions || only === "voters",
	);
	state.mcpServerContributions = collectMcpServerContributions(resolvedPaths, cliExtensionPaths, builtinPackagePaths);
	const packageMcpServerSource = createPackageMcpServerSource(loader);
	const inheritanceSnapshotProvider = createInheritanceSnapshotProvider(loader);
	// The builtin Herdr reporter supersedes the installed file integration in a
	// Herdr pane; see extensions/herdr-file-integration.ts.
	const extensionPaths = await filterDisabledBuiltinPaths(
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
		packageMcpServerSource,
		inheritanceSnapshotProvider,
	);
	mergeExtensionWarnings(extensionsResult, [...installWarnings, ...packageWarnings]);
	const omitted = only === "voters" ? bundledInlineFactories(loader) : undefined;
	const inlineExtensions = await loadExtensionFactories(
		loader,
		extensionsResult.runtime,
		packageMcpServerSource,
		inheritanceSnapshotProvider,
		omitted && { except: omitted },
	);
	extensionsResult.extensions.push(...inlineExtensions.extensions);
	extensionsResult.errors.push(...inlineExtensions.errors);
	if (omitted) omitInlineFactories(extensionsResult, omitted);
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

/**
 * Complete an initial deferred startup load by discovering resources and loading only extensions not already present in
 * `preloadedExtensions`, preserving canonical extension order without clearing the extension module cache.
 */
export async function reloadDefaultResourceLoaderWithPreloaded(
	loader: DefaultResourceLoader,
	preloadedExtensions: LoadExtensionsResult,
	options?: Pick<ResourceLoaderReloadOptions, "useLoadedSettings">,
): Promise<void> {
	const complete = await prepareDefaultResourceLoaderReload(loader, options, undefined, preloadedExtensions);
	await complete();
}

/** Resolve trust without loading the approved project resources until continuation. */
export async function prepareDefaultResourceLoaderReload(
	loader: DefaultResourceLoader,
	options?: ResourceLoaderReloadOptions,
	startupSessionQuit?: () => boolean,
	preloadedStartupExtensions?: LoadExtensionsResult,
): Promise<() => Promise<void>> {
	const state = resourceInternals(loader);
	resetTimings("extensions");
	await hostStoragePackagesRegistered();
	if (state.loaded && preloadedStartupExtensions === undefined) {
		clearExtensionCache();
	}
	let preTrustExtensions: LoadExtensionsResult | undefined = preloadedStartupExtensions;
	const initialProjectTrusted = state.settingsManager.isProjectTrusted();
	if (
		preloadedStartupExtensions === undefined &&
		(options?.resolveProjectTrust || options?.resolveBorrowedProjectTrust)
	) {
		preTrustExtensions = await loadProjectTrustExtensions(loader, options.preTrustExtensions);
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
			const deferredRuntime = createExtensionRuntime();
			setExtensionRuntimeEventBus(deferredRuntime, state.eventBus);
			const deferredExtensions: LoadExtensionsResult = {
				extensions: [],
				errors: [],
				runtime: deferredRuntime,
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
			state.legacyWorkflowFiles = undefined;
			state.packageAgents = [];
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
			state.deferredInitialLoad = true;
			state.deferredInitialSettings = {
				projectTrusted: state.settingsManager.isProjectTrusted(),
				globalSettings: state.settingsManager.getGlobalSettings(),
				projectSettings: state.settingsManager.getProjectSettings(),
				settings: state.settingsManager.getSettings(),
			};
			return;
		}
		const resolveSpan = startTimingSpan("DefaultResourceLoader.reload.resolvePackageResourcePaths");
		const { resolvedPaths, cliExtensionPaths, builtinPackagePaths } = await resolvePackageResourcePaths(loader, {
			trustedBorrowedProjectLocalSources: state.trustedBorrowedProjectLocalSources,
			useLoadedSettings: options?.useLoadedSettings,
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
		state.legacyWorkflowFiles = findLegacyWorkflowFiles(
			{
				cwd: state.cwd,
				agentDir: state.agentDir,
				projectTrusted: state.settingsManager.isProjectTrusted(),
				trustedBorrowedSources: state.trustedBorrowedProjectLocalSources,
			},
			resolvedPaths.legacyWorkflowFiles,
			cliExtensionPaths.legacyWorkflowFiles,
		);
		state.packageAgents = await collectPackageAgentFiles(cliExtensionPaths.agents, resolvedPaths.agents);
		state.mcpServerContributions = collectMcpServerContributions(
			resolvedPaths,
			cliExtensionPaths,
			builtinPackagePaths,
		);
		const packageMcpServerSource = createPackageMcpServerSource(loader);

		// The builtin Herdr reporter supersedes the installed file integration in a
		// Herdr pane; see extensions/herdr-file-integration.ts.
		const disabledBuiltinRoots = await resolveDisabledBuiltinRoots(state.disabledBuiltinExtensions);
		const extensionPaths = await filterDisabledBuiltinPaths(
			filterSupersededHerdrIntegrationPaths(
				await mergeResourcePaths(
					state.cwd,
					cliEnabledExtensions,
					state.noExtensions ? builtinEnabledExtensions : [...enabledExtensions, ...builtinEnabledExtensions],
				),
			),
			state.disabledBuiltinExtensions,
			disabledBuiltinRoots,
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
					packageMcpServerSource,
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

		const assetsStartedAt = Date.now();
		// Phase 1: Pure concurrent I/O with zero loader state mutations, override calls, or stderr writes.
		const loadSkillsIo = async () => {
			const skillPaths = await filterDisabledBuiltinPaths(
				state.noSkills
					? await mergeResourcePaths(state.cwd, cliEnabledSkills, state.additionalSkillPaths)
					: await mergeResourcePaths(
							state.cwd,
							[...cliEnabledSkills, ...enabledSkills, ...builtinEnabledSkills],
							state.additionalSkillPaths,
						),
				state.disabledBuiltinExtensions,
				disabledBuiltinRoots,
			);
			const skillsSpan = startTimingSpan("DefaultResourceLoader.reload.updateSkillsFromPathsAsync");
			const stage = await loadSkillsStageAsync(loader, skillPaths, metadataByPath);
			endTimingSpan(skillsSpan);
			const missingSkills = (
				await Promise.all(
					state.additionalSkillPaths.map(async (p) => {
						if (!isLocalPath(p)) return undefined;
						const resolved = resolveResourcePath(state.cwd, p);
						return (await exists(resolved)) ? undefined : resolved;
					}),
				)
			).filter((p): p is string => p !== undefined);
			return { stage, missingSkills };
		};

		const loadPromptsIo = async () => {
			const promptPaths = await filterDisabledBuiltinPaths(
				state.noPromptTemplates
					? await mergeResourcePaths(state.cwd, cliEnabledPrompts, state.additionalPromptTemplatePaths)
					: await mergeResourcePaths(
							state.cwd,
							[...cliEnabledPrompts, ...enabledPrompts, ...builtinEnabledPrompts],
							state.additionalPromptTemplatePaths,
						),
				state.disabledBuiltinExtensions,
				disabledBuiltinRoots,
			);
			const promptsSpan = startTimingSpan("DefaultResourceLoader.reload.updatePromptsFromPathsAsync");
			const stage = await loadPromptsStageAsync(loader, promptPaths, metadataByPath);
			endTimingSpan(promptsSpan);
			const missingPrompts = (
				await Promise.all(
					state.additionalPromptTemplatePaths.map(async (p) => {
						if (!isLocalPath(p)) return undefined;
						const resolved = resolveResourcePath(state.cwd, p);
						return (await exists(resolved)) ? undefined : resolved;
					}),
				)
			).filter((p): p is string => p !== undefined);
			return { stage, missingPrompts };
		};

		const loadThemesIo = async () => {
			const themePaths = await filterDisabledBuiltinPaths(
				state.noThemes
					? await mergeResourcePaths(state.cwd, cliEnabledThemes, state.additionalThemePaths)
					: await mergeResourcePaths(
							state.cwd,
							[...cliEnabledThemes, ...enabledThemes, ...builtinEnabledThemes],
							state.additionalThemePaths,
						),
				state.disabledBuiltinExtensions,
				disabledBuiltinRoots,
			);
			const themesSpan = startTimingSpan("DefaultResourceLoader.reload.updateThemesFromPathsAsync");
			const stage = await loadThemesStageAsync(loader, themePaths);
			endTimingSpan(themesSpan);
			const missingThemes = (
				await Promise.all(
					state.additionalThemePaths.map(async (p) => {
						const resolved = resolveResourcePath(state.cwd, p);
						return (await exists(resolved)) ? undefined : resolved;
					}),
				)
			).filter((p): p is string => p !== undefined);
			return { stage, missingThemes };
		};

		const loadContextFilesIo = async () => {
			const contextFilesSpan = startTimingSpan("DefaultResourceLoader.reload.loadProjectContextFiles");
			const warnings: string[] = [];
			const agentsFiles = {
				agentsFiles: state.noContextFiles
					? []
					: await loadProjectContextFilesAsync(
							{
								cwd: state.cwd,
								agentDir: state.agentDir,
								projectTrusted: state.settingsManager.isProjectTrusted(),
							},
							(msg) => warnings.push(msg),
						),
			};
			endTimingSpan(contextFilesSpan);
			return { agentsFiles, warnings };
		};

		const loadPromptFilesIo = async () => {
			const promptFilesSpan = startTimingSpan("DefaultResourceLoader.reload.resolvePromptFiles");
			const [sysSourceRes, appendDiscoveredRes] = await Promise.allSettled([
				state.systemPromptSource !== undefined
					? Promise.resolve(state.systemPromptSource)
					: discoverSystemPromptFile(loader),
				discoverAppendSystemPromptFile(loader),
			]);
			if (sysSourceRes.status === "rejected") throw sysSourceRes.reason;
			if (appendDiscoveredRes.status === "rejected") throw appendDiscoveredRes.reason;
			const systemPromptSource = sysSourceRes.value;
			const discoveredAppend = appendDiscoveredRes.value;
			const appendSources = state.appendSystemPromptSource ?? (discoveredAppend ? [discoveredAppend] : []);
			const systemWarnings: string[] = [];
			const appendWarnings: string[] = [];
			const [baseSystemRes, systemPathRes, baseAppendRes, appendPathsRes] = await Promise.allSettled([
				resolvePromptInput(systemPromptSource, "system prompt", (msg) => systemWarnings.push(msg)),
				resolveExistingPromptSourcePath(systemPromptSource),
				resolvePromptInputs(appendSources, (msg) => appendWarnings.push(msg)),
				resolveExistingPromptSourcePaths(appendSources),
			]);
			endTimingSpan(promptFilesSpan);
			if (baseSystemRes.status === "rejected") throw baseSystemRes.reason;
			if (systemPathRes.status === "rejected") throw systemPathRes.reason;
			if (baseAppendRes.status === "rejected") throw baseAppendRes.reason;
			if (appendPathsRes.status === "rejected") throw appendPathsRes.reason;
			return {
				baseSystemPrompt: baseSystemRes.value,
				systemPromptSourcePath: systemPathRes.value,
				baseAppend: baseAppendRes.value,
				appendSystemPromptSourcePaths: appendPathsRes.value,
				warnings: [...systemWarnings, ...appendWarnings],
			};
		};

		const [skillsIoRes, promptsIoRes, themesIoRes, contextIoRes, promptFilesIoRes] = await Promise.allSettled([
			loadSkillsIo(),
			loadPromptsIo(),
			loadThemesIo(),
			loadContextFilesIo(),
			loadPromptFilesIo(),
		]);
		// Phase 2: All I/O branches have settled; throw the first I/O failure in main's exact order.
		if (skillsIoRes.status === "rejected") throw skillsIoRes.reason;
		if (promptsIoRes.status === "rejected") throw promptsIoRes.reason;
		if (themesIoRes.status === "rejected") throw themesIoRes.reason;
		if (contextIoRes.status === "rejected") throw contextIoRes.reason;
		if (promptFilesIoRes.status === "rejected") throw promptFilesIoRes.reason;

		// Phase 3: Run overrides and emit warnings sequentially into locals in main's exact order:
		// skills -> prompts -> themes -> context -> promptFiles.
		const skillsCommit = await prepareSkillsCommitAsync(
			loader,
			skillsIoRes.value.stage,
			metadataByPath,
			skillsIoRes.value.missingSkills,
		);
		const promptsCommit = await preparePromptsCommitAsync(
			loader,
			promptsIoRes.value.stage,
			metadataByPath,
			promptsIoRes.value.missingPrompts,
		);
		const themesCommit = await prepareThemesCommitAsync(
			loader,
			themesIoRes.value.stage,
			metadataByPath,
			themesIoRes.value.missingThemes,
		);
		for (const warning of contextIoRes.value.warnings) console.error(warning);
		const resolvedAgentsFiles = state.agentsFilesOverride
			? state.agentsFilesOverride(contextIoRes.value.agentsFiles)
			: contextIoRes.value.agentsFiles;
		for (const warning of promptFilesIoRes.value.warnings) console.error(warning);
		const resolvedSystemPrompt = state.systemPromptOverride
			? state.systemPromptOverride(promptFilesIoRes.value.baseSystemPrompt)
			: promptFilesIoRes.value.baseSystemPrompt;
		const resolvedAppendSystemPrompt = state.appendSystemPromptOverride
			? state.appendSystemPromptOverride(promptFilesIoRes.value.baseAppend)
			: promptFilesIoRes.value.baseAppend;

		// Phase 4: All I/O and overrides succeeded; commit loader state synchronously.
		state.lastSkillPaths = skillsCommit.lastSkillPaths;
		state.skills = skillsCommit.skills;
		state.skillCatalog = skillsCommit.skillCatalog;
		state.skillDiagnostics = skillsCommit.skillDiagnostics;

		state.lastPromptPaths = promptsCommit.lastPromptPaths;
		for (const [filePath, info] of promptsCommit.promptSourceInfos) {
			state.extensionPromptSourceInfos.set(filePath, info);
		}
		state.extensionsResult.overlaps ??= [];
		const overlaps = state.extensionsResult.overlaps;
		const extensionOverlaps = overlaps.filter((overlap) => overlap.resourceType !== "prompt");
		overlaps.splice(0, overlaps.length, ...extensionOverlaps, ...promptsCommit.promptOverlaps);
		state.prompts = promptsCommit.prompts;
		state.promptDiagnostics = promptsCommit.promptDiagnostics;

		state.lastThemePaths = themesCommit.lastThemePaths;
		state.themes = themesCommit.themes;
		state.themeDiagnostics = themesCommit.themeDiagnostics;

		state.agentsFiles = resolvedAgentsFiles.agentsFiles;
		state.systemPrompt = resolvedSystemPrompt;
		state.systemPromptSourcePath = promptFilesIoRes.value.systemPromptSourcePath;
		state.appendSystemPrompt = resolvedAppendSystemPrompt;
		state.appendSystemPromptSourcePaths = promptFilesIoRes.value.appendSystemPromptSourcePaths;
		state.loaded = true;
		state.deferredInitialLoad = false;
		state.deferredInitialSettings = undefined;
		await yieldToEventLoopIfSlow(assetsStartedAt);
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
