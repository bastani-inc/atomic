import { createExtensionRuntime, type PackageMcpServerSource } from "./extensions/loader.ts";
import type { LoadExtensionsResult } from "./extensions/types.ts";
import type { McpServerContribution } from "./mcp-servers.ts";
import type {
	PackageDiscovery,
	PathMetadata,
	ResolvedMcpServer,
	ResolvedPaths,
	ResolvedResource,
} from "./package-manager-types.ts";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import { resolveResourcePath } from "./resource-loader-paths.ts";
import type { DefaultResourceLoaderInheritanceSnapshot, ResourceLoaderReloadOptions } from "./resource-loader-types.ts";
import { createSourceInfo } from "./source-info.ts";

export function emptyResolvedPaths(): PackageDiscovery {
	return { extensions: [], skills: [], prompts: [], themes: [], legacyWorkflowFiles: [], mcpServers: [] };
}

export async function resolvePackageResourcePaths(
	loader: DefaultResourceLoader,
	options?: {
		useLoadedSettings?: true;
		includeCliProjectLocalResources?: boolean;
		trustedBorrowedProjectLocalSources?: Set<string>;
	},
): Promise<{
	resolvedPaths: PackageDiscovery;
	cliExtensionPaths: PackageDiscovery;
	builtinPackagePaths: PackageDiscovery;
}> {
	const state = resourceInternals(loader);
	if (!options?.useLoadedSettings) await state.settingsManager.reload();
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
	const builtinPackagePaths =
		state.builtinPackagePaths.length > 0
			? markBundledResources(
					await state.packageManager.resolveExtensionSources(state.builtinPackagePaths, { temporary: true }),
				)
			: emptyResolvedPaths();
	return { resolvedPaths, cliExtensionPaths, builtinPackagePaths };
}

function markBundledResources(paths: PackageDiscovery): PackageDiscovery {
	const mark = <T extends ResolvedResource | ResolvedMcpServer>(resources: T[]): T[] =>
		resources.map((resource) => ({
			...resource,
			metadata: { ...resource.metadata, configurationOrigin: "bundled" },
		}));
	return {
		extensions: mark(paths.extensions),
		skills: mark(paths.skills),
		prompts: mark(paths.prompts),
		themes: mark(paths.themes),
		legacyWorkflowFiles: mark(paths.legacyWorkflowFiles),
		mcpServers: mark(paths.mcpServers),
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
	const { extensions, skills, prompts, themes, legacyWorkflowFiles } = cliExtensionPaths;
	for (const resources of [extensions, skills, prompts, themes, legacyWorkflowFiles]) {
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

export function filterBorrowedProjectLocalResources(
	paths: PackageDiscovery,
	trustedSources: Set<string>,
): PackageDiscovery {
	const filterResources = <T extends ResolvedResource | ResolvedMcpServer>(resources: T[]): T[] =>
		resources.filter(
			(resource) => !resource.metadata.borrowedProjectLocal || trustedSources.has(resource.metadata.source),
		);
	return {
		extensions: filterResources(paths.extensions),
		skills: filterResources(paths.skills),
		prompts: filterResources(paths.prompts),
		themes: filterResources(paths.themes),
		legacyWorkflowFiles: filterResources(paths.legacyWorkflowFiles),
		mcpServers: filterResources(paths.mcpServers),
		installFailures: paths.installFailures,
	};
}

/** Enabled manifest MCP servers in discovery order; the first package declaring a name wins. */
export function collectMcpServerContributions(
	resolvedPaths: ResolvedPaths,
	cliExtensionPaths: ResolvedPaths,
	builtinPackagePaths: ResolvedPaths,
): McpServerContribution[] {
	const contributions = new Map<string, McpServerContribution>();
	for (const server of [
		...cliExtensionPaths.mcpServers,
		...resolvedPaths.mcpServers,
		...builtinPackagePaths.mcpServers,
	]) {
		if (!server.enabled || contributions.has(server.name)) continue;
		contributions.set(server.name, {
			name: server.name,
			config: server.config,
			origin: "package",
			sourceInfo: createSourceInfo(server.path, server.metadata),
		});
	}
	return [...contributions.values()];
}

export function createPackageMcpServerSource(loader: DefaultResourceLoader): PackageMcpServerSource {
	const state = resourceInternals(loader);
	return {
		getMcpServers: () => state.mcpServerContributions,
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
