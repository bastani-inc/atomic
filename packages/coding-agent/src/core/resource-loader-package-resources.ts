import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripBom } from "../utils/text.ts";
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
import type {
	DefaultResourceLoaderInheritanceSnapshot,
	PackageAgentFile,
	ResourceLoaderReloadOptions,
} from "./resource-loader-types.ts";
import { createSourceInfo } from "./source-info.ts";

export function emptyResolvedPaths(): PackageDiscovery {
	return {
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
		legacyWorkflowFiles: [],
		agents: [],
		mcpServers: [],
	};
}

export async function resolvePackageResourcePaths(
	loader: DefaultResourceLoader,
	options?: {
		useLoadedSettings?: true;
		includeCliProjectLocalResources?: boolean;
		trustedBorrowedProjectLocalSources?: Set<string>;
		/** Leave out what the settings and the extensions folders configure, which also installs nothing. */
		withoutConfigured?: true;
	},
): Promise<{
	resolvedPaths: PackageDiscovery;
	cliExtensionPaths: PackageDiscovery;
	builtinPackagePaths: PackageDiscovery;
}> {
	const state = resourceInternals(loader);
	if (!options?.useLoadedSettings) await state.settingsManager.reload();
	const includeCliProjectLocalResources = options?.includeCliProjectLocalResources ?? true;
	const [resolvedPaths, rawCliExtensionPaths, builtinPackagePaths] = await Promise.all([
		options?.withoutConfigured ? Promise.resolve(emptyResolvedPaths()) : state.packageManager.resolve(),
		state.additionalExtensionPaths.length > 0
			? state.packageManager.resolveExtensionSources(state.additionalExtensionPaths, {
					temporary: true,
					includeProjectLocalResources: includeCliProjectLocalResources,
				})
			: Promise.resolve(emptyResolvedPaths()),
		state.builtinPackagePaths.length > 0
			? state.packageManager
					.resolveExtensionSources(state.builtinPackagePaths, { temporary: true })
					.then(markBundledResources)
			: Promise.resolve(emptyResolvedPaths()),
	]);
	const cliExtensionPaths =
		includeCliProjectLocalResources && options?.trustedBorrowedProjectLocalSources
			? filterBorrowedProjectLocalResources(rawCliExtensionPaths, options.trustedBorrowedProjectLocalSources)
			: rawCliExtensionPaths;
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
		agents: mark(paths.agents),
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
	const { extensions, skills, prompts, themes, legacyWorkflowFiles, agents } = cliExtensionPaths;
	for (const resources of [extensions, skills, prompts, themes, legacyWorkflowFiles, agents]) {
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
		agents: filterResources(paths.agents),
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

async function readPackageJsonName(packageRoot: string): Promise<string | undefined> {
	try {
		const pkg: unknown = JSON.parse(stripBom(await readFile(join(packageRoot, "package.json"), "utf-8")));
		const name = typeof pkg === "object" && pkg !== null ? (pkg as { name?: unknown }).name : undefined;
		return typeof name === "string" && name.trim() ? name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Enabled package agent files in discovery order (`-e` packages first, then project-installed, then global), each
 * once, with the package it came from. Only package resources count: a manifest `agents` entry is the only way a
 * definition gets here.
 */
export async function collectPackageAgentFiles(
	...resourceLists: ReadonlyArray<readonly ResolvedResource[]>
): Promise<PackageAgentFile[]> {
	const files: PackageAgentFile[] = [];
	const seen = new Set<string>();
	const packageNames = new Map<string, Promise<string | undefined>>();
	for (const resources of resourceLists) {
		for (const { path, enabled, metadata } of resources) {
			const packageRoot = metadata.packageRoot;
			if (!enabled || metadata.origin !== "package" || !packageRoot || seen.has(path)) continue;
			seen.add(path);
			let packageName = packageNames.get(packageRoot);
			if (!packageName) {
				packageName = readPackageJsonName(packageRoot);
				packageNames.set(packageRoot, packageName);
			}
			const name = await packageName;
			files.push({
				path,
				source: metadata.source,
				scope: metadata.scope,
				packageRoot,
				...(name === undefined ? {} : { packageName: name }),
			});
		}
	}
	return files;
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
