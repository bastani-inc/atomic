import { access, readFile, stat } from "node:fs/promises";
import { glob } from "glob";
import { resolve } from "node:path";
import { addResource, getTargetMap } from "./package-manager-resource-accumulator.ts";
import { collectResourceFiles } from "./package-manager-resource-files.ts";
import { conventionDirsForResource, getManifestFromPackageJson, manifestEntriesForResource } from "./package-manager-manifest.ts";
import { applyAutoloadDisabledPatterns, applyPatterns, hasGlobPattern, isOverridePattern, splitPatterns } from "./package-manager-resource-patterns.ts";
import { resolvePathFromBase } from "./package-manager-paths.ts";
import type { PackageFilter, PathMetadata, ResourceAccumulator, ResourceMap, ResourceType } from "./package-manager-types.ts";

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

async function readPiManifest(packageRoot: string): Promise<ReturnType<typeof getManifestFromPackageJson> | null> {
	try {
		const content = await readFile(resolve(packageRoot, "package.json"), "utf-8");
		return getManifestFromPackageJson(JSON.parse(content) as Record<string, unknown>);
	} catch {
		return null;
	}
}

export async function collectPackageResources(
	packageRoot: string,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
): Promise<boolean> {
	if (filter) {
		for (const resourceType of ["extensions", "skills", "prompts", "themes", "workflows"] as const) {
			const patterns = filter[resourceType];
			const target = getTargetMap(accumulator, resourceType);
			if (filter.autoload === false) {
				const { allFiles } = await collectManifestFiles(packageRoot, resourceType);
				const selected = applyAutoloadDisabledPatterns(allFiles, patterns ?? [], packageRoot);
				for (const [filePath, enabled] of selected) addResource(target, filePath, metadata, enabled);
			} else if (patterns !== undefined) await applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
			else await collectDefaultResources(packageRoot, resourceType, target, metadata);
		}
		return true;
	}
	const manifest = await readPiManifest(packageRoot);
	if (manifest) {
		for (const resourceType of ["extensions", "skills", "prompts", "themes", "workflows"] as const) {
			const entries = manifestEntriesForResource(manifest, resourceType);
			if (entries !== undefined) {
				await addManifestEntries(entries, packageRoot, resourceType, getTargetMap(accumulator, resourceType), metadata);
				continue;
			}
			if (resourceType === "workflows") await collectDefaultResources(packageRoot, resourceType, getTargetMap(accumulator, resourceType), metadata);
		}
		return true;
	}
	let hasAnyDir = false;
	for (const resourceType of ["extensions", "skills", "prompts", "themes", "workflows"] as const) {
		for (const dir of conventionDirsForResource(packageRoot, resourceType)) {
			if (!(await exists(dir))) continue;
			for (const f of await collectResourceFiles(dir, resourceType)) addResource(getTargetMap(accumulator, resourceType), f, metadata, true);
			hasAnyDir = true;
		}
	}
	return hasAnyDir;
}

async function collectDefaultResources(packageRoot: string, resourceType: ResourceType, target: ResourceMap, metadata: PathMetadata): Promise<void> {
	const manifest = await readPiManifest(packageRoot);
	const entries = manifestEntriesForResource(manifest, resourceType);
	if (entries !== undefined) {
		await addManifestEntries(entries, packageRoot, resourceType, target, metadata);
		return;
	}
	for (const dir of conventionDirsForResource(packageRoot, resourceType)) {
		if (!(await exists(dir))) continue;
		for (const f of await collectResourceFiles(dir, resourceType)) addResource(target, f, metadata, true);
	}
}

async function applyPackageFilter(packageRoot: string, userPatterns: string[], resourceType: ResourceType, target: ResourceMap, metadata: PathMetadata): Promise<void> {
	const { allFiles } = await collectManifestFiles(packageRoot, resourceType);
	if (userPatterns.length === 0) {
		for (const f of allFiles) addResource(target, f, metadata, false);
		return;
	}
	const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);
	for (const f of allFiles) addResource(target, f, metadata, enabledByUser.has(f));
}

async function collectManifestFiles(packageRoot: string, resourceType: ResourceType): Promise<{ allFiles: string[]; enabledByManifest: Set<string> }> {
	const manifest = await readPiManifest(packageRoot);
	const entries = manifestEntriesForResource(manifest, resourceType);
	if (entries && entries.length > 0) {
		const allFiles = await collectFilesFromManifestEntries(entries, packageRoot, resourceType);
		const manifestPatterns = entries.filter(isOverridePattern);
		const enabledByManifest = manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
		return { allFiles: Array.from(enabledByManifest), enabledByManifest };
	}
	const allFiles: string[] = [];
	for (const dir of conventionDirsForResource(packageRoot, resourceType)) {
		if (await exists(dir)) allFiles.push(...await collectResourceFiles(dir, resourceType));
	}
	return { allFiles, enabledByManifest: new Set(allFiles) };
}

async function addManifestEntries(entries: string[] | undefined, root: string, resourceType: ResourceType, target: ResourceMap, metadata: PathMetadata): Promise<void> {
	if (!entries) return;
	const allFiles = await collectFilesFromManifestEntries(entries, root, resourceType);
	const patterns = entries.filter(isOverridePattern);
	const enabledPaths = applyPatterns(allFiles, patterns, root);
	for (const f of allFiles) if (enabledPaths.has(f)) addResource(target, f, metadata, true);
}

async function collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): Promise<string[]> {
	const resolved: string[] = [];
	for (const entry of entries.filter((entry) => !isOverridePattern(entry))) {
		if (!hasGlobPattern(entry)) resolved.push(resolve(root, entry));
		else resolved.push(...(await glob(entry, { cwd: root, absolute: true, dot: false, nodir: false })).map((match) => resolve(match)));
	}
	return collectFilesFromPaths(resolved, resourceType);
}

export async function resolveLocalEntries(entries: string[], resourceType: ResourceType, target: ResourceMap, metadata: PathMetadata, baseDir: string): Promise<void> {
	if (entries.length === 0) return;
	const { plain, patterns } = splitPatterns(entries);
	const resolvedPlain = plain.map((p) => resolvePathFromBase(p, baseDir));
	const allFiles = await collectFilesFromPaths(resolvedPlain, resourceType);
	const enabledPaths = applyPatterns(allFiles, patterns, baseDir);
	for (const f of allFiles) addResource(target, f, metadata, enabledPaths.has(f));
}

export async function collectFilesFromPaths(paths: string[], resourceType: ResourceType): Promise<string[]> {
	const files: string[] = [];
	for (const p of paths) {
		if (!(await exists(p))) continue;
		try {
			const stats = await stat(p);
			if (stats.isFile()) files.push(p);
			else if (stats.isDirectory()) files.push(...await collectResourceFiles(p, resourceType));
		} catch {}
	}
	return files;
}
