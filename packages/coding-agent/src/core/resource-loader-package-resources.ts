import { createExtensionRuntime, type WorkflowResourceProvider } from "./extensions/loader.ts";
import type { LoadExtensionsResult } from "./extensions/types.ts";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "./package-manager.ts";
import { createSourceInfo } from "./source-info.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import { resolveResourcePath } from "./resource-loader-paths.ts";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";
import type { DefaultResourceLoaderInheritanceSnapshot, ResourceLoaderReloadOptions } from "./resource-loader-types.ts";

export function emptyResolvedPaths(): ResolvedPaths {
	return { extensions: [], skills: [], prompts: [], themes: [], workflows: [] };
}

export async function resolvePackageResourcePaths(
	loader: DefaultResourceLoader,
	options?: {
		includeCliProjectLocalResources?: boolean;
		trustedBorrowedProjectLocalSources?: Set<string>;
	},
): Promise<{
	resolvedPaths: ResolvedPaths;
	cliExtensionPaths: ResolvedPaths;
	builtinPackagePaths: ResolvedPaths;
}> {
	const state = resourceInternals(loader);
	await state.settingsManager.reload();
	const resolvedPaths = await state.packageManager.resolve();
	const includeCliProjectLocalResources = options?.includeCliProjectLocalResources ?? true;
	let cliExtensionPaths = await state.packageManager.resolveExtensionSources(state.additionalExtensionPaths, {
		temporary: true,
		includeProjectLocalResources: includeCliProjectLocalResources,
	});
	if (includeCliProjectLocalResources && options?.trustedBorrowedProjectLocalSources) {
		cliExtensionPaths = filterBorrowedProjectLocalResources(
			cliExtensionPaths,
			options.trustedBorrowedProjectLocalSources,
		);
	}
	const builtinPackagePaths = state.builtinPackagePaths.length > 0
		? markBundledResources(await state.packageManager.resolveExtensionSources(state.builtinPackagePaths, { temporary: true }))
		: emptyResolvedPaths();
	return { resolvedPaths, cliExtensionPaths, builtinPackagePaths };
}

function markBundledResources(paths: ResolvedPaths): ResolvedPaths {
	const mark = (resources: ResolvedResource[]): ResolvedResource[] => resources.map((resource) => ({
		...resource,
		metadata: { ...resource.metadata, configurationOrigin: "bundled" },
	}));
	return {
		extensions: mark(paths.extensions),
		skills: mark(paths.skills),
		prompts: mark(paths.prompts),
		themes: mark(paths.themes),
		workflows: mark(paths.workflows),
	};
}

export async function resolveTrustedBorrowedProjectLocalSources(
	loader: DefaultResourceLoader,
	resolveBorrowedProjectTrust: NonNullable<ResourceLoaderReloadOptions["resolveBorrowedProjectTrust"]>,
	preTrustExtensions: LoadExtensionsResult | undefined,
): Promise<Set<string>> {
	const state = resourceInternals(loader);
	const cliExtensionPaths = await state.packageManager.resolveExtensionSources(state.additionalExtensionPaths, {
		temporary: true,
		includeProjectLocalResources: true,
	});
	const resourcesBySource = new Map<string, ResolvedResource[]>();
	for (const resources of Object.values(cliExtensionPaths)) {
		for (const resource of resources) {
			if (!resource.metadata.borrowedProjectLocal) {
				continue;
			}
			const sourceResources = resourcesBySource.get(resource.metadata.source) ?? [];
			sourceResources.push(resource);
			resourcesBySource.set(resource.metadata.source, sourceResources);
		}
	}

	const trustedSources = new Set<string>();
	for (const [source, resources] of resourcesBySource) {
		const trusted = await resolveBorrowedProjectTrust({
			source,
			resources,
			extensionsResult: preTrustExtensions ?? { extensions: [], errors: [], runtime: createExtensionRuntime() },
		});
		if (trusted) {
			trustedSources.add(source);
		}
	}
	return trustedSources;
}

export function filterBorrowedProjectLocalResources(paths: ResolvedPaths, trustedSources: Set<string>): ResolvedPaths {
	const filterResources = (resources: ResolvedResource[]): ResolvedResource[] =>
		resources.filter(
			(resource) => !resource.metadata.borrowedProjectLocal || trustedSources.has(resource.metadata.source),
		);
	return {
		extensions: filterResources(paths.extensions),
		skills: filterResources(paths.skills),
		prompts: filterResources(paths.prompts),
		themes: filterResources(paths.themes),
		workflows: filterResources(paths.workflows),
	};
}

function enabledWorkflowResources(resources: ResolvedResource[]): ResolvedResource[] {
	return resources.filter((resource) => resource.enabled);
}

function enabledPackageWorkflowResources(resources: ResolvedResource[]): ResolvedResource[] {
	return resources.filter((resource) => resource.enabled && resource.metadata.origin === "package");
}

export function collectWorkflowResources(
	resolvedPaths: ResolvedPaths,
	cliExtensionPaths: ResolvedPaths,
	builtinPackagePaths: ResolvedPaths,
): ResolvedResource[] {
	return [
		...enabledWorkflowResources(cliExtensionPaths.workflows),
		...enabledPackageWorkflowResources(resolvedPaths.workflows),
		...enabledPackageWorkflowResources(builtinPackagePaths.workflows),
	];
}

export function createWorkflowResourceProvider(loader: DefaultResourceLoader): WorkflowResourceProvider {
	const state = resourceInternals(loader);
	return {
		get: () => state.workflowResources,
		refresh: () => state.refreshWorkflowResources(),
	};
}

export function createInheritanceSnapshotProvider(
	loader: DefaultResourceLoader,
): () => DefaultResourceLoaderInheritanceSnapshot {
	const state = resourceInternals(loader);
	return () => state.getInheritanceSnapshot();
}

export function normalizeExtensionPaths(
	loader: DefaultResourceLoader,
	entries: Array<{ path: string; metadata: PathMetadata }>,
): Array<{ path: string; metadata: PathMetadata }> {
	const state = resourceInternals(loader);
	return entries.map((entry) => {
		const metadata = entry.metadata.baseDir
			? { ...entry.metadata, baseDir: resolveResourcePath(state.cwd, entry.metadata.baseDir) }
			: entry.metadata;
		return {
			path: resolveResourcePath(state.cwd, entry.path),
			metadata,
		};
	});
}

export function recordExtensionSourceInfo(
	loader: DefaultResourceLoader,
	paths: Array<{ path: string; metadata: PathMetadata }>,
	kind: "skill" | "prompt" | "theme",
): void {
	const state = resourceInternals(loader);
	const target =
		kind === "skill"
			? state.extensionSkillSourceInfos
			: kind === "prompt"
				? state.extensionPromptSourceInfos
				: state.extensionThemeSourceInfos;
	for (const entry of paths) {
		target.set(entry.path, createSourceInfo(entry.path, entry.metadata));
	}
}
