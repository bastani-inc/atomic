import { existsSync, statSync } from "node:fs";
import { globSync } from "glob";
import { resolve } from "node:path";
import { addResource, getTargetMap } from "./package-manager-resource-accumulator.ts";
import { collectResourceFiles } from "./package-manager-resource-files.ts";
import { conventionDirsForResource, manifestEntriesForResource, readPiManifest } from "./package-manager-manifest.ts";
import {
	applyPatterns,
	hasGlobPattern,
	isOverridePattern,
	splitPatterns,
} from "./package-manager-resource-patterns.ts";
import { resolvePathFromBase } from "./package-manager-paths.ts";
import type {
	PackageFilter,
	PathMetadata,
	ResourceAccumulator,
	ResourceMap,
	ResourceType,
} from "./package-manager-types.ts";

export function collectPackageResources(
	packageRoot: string,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
): boolean {
	if (filter) {
		for (const resourceType of ["extensions", "skills", "prompts", "themes", "workflows"] as const) {
			const patterns = filter[resourceType as keyof PackageFilter];
			const target = getTargetMap(accumulator, resourceType);
			if (patterns !== undefined) {
				applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
			} else {
				collectDefaultResources(packageRoot, resourceType, target, metadata);
			}
		}
		return true;
	}

	const manifest = readPiManifest(packageRoot);
	if (manifest) {
		for (const resourceType of ["extensions", "skills", "prompts", "themes", "workflows"] as const) {
			const entries = manifestEntriesForResource(manifest, resourceType);
			if (entries !== undefined) {
				addManifestEntries(entries, packageRoot, resourceType, getTargetMap(accumulator, resourceType), metadata);
				continue;
			}
			if (resourceType === "workflows") {
				collectDefaultResources(packageRoot, resourceType, getTargetMap(accumulator, resourceType), metadata);
			}
		}
		return true;
	}

	let hasAnyDir = false;
	for (const resourceType of ["extensions", "skills", "prompts", "themes", "workflows"] as const) {
		for (const dir of conventionDirsForResource(packageRoot, resourceType)) {
			if (existsSync(dir)) {
				const files = collectResourceFiles(dir, resourceType);
				for (const f of files) {
					addResource(getTargetMap(accumulator, resourceType), f, metadata, true);
				}
				hasAnyDir = true;
			}
		}
	}
	return hasAnyDir;
}

function collectDefaultResources(
	packageRoot: string,
	resourceType: ResourceType,
	target: ResourceMap,
	metadata: PathMetadata,
): void {
	const manifest = readPiManifest(packageRoot);
	const entries = manifestEntriesForResource(manifest, resourceType);
	if (entries !== undefined) {
		addManifestEntries(entries, packageRoot, resourceType, target, metadata);
		return;
	}
	for (const dir of conventionDirsForResource(packageRoot, resourceType)) {
		if (existsSync(dir)) {
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				addResource(target, f, metadata, true);
			}
		}
	}
}

function applyPackageFilter(
	packageRoot: string,
	userPatterns: string[],
	resourceType: ResourceType,
	target: ResourceMap,
	metadata: PathMetadata,
): void {
	const { allFiles } = collectManifestFiles(packageRoot, resourceType);
	if (userPatterns.length === 0) {
		for (const f of allFiles) {
			addResource(target, f, metadata, false);
		}
		return;
	}

	const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);
	for (const f of allFiles) {
		addResource(target, f, metadata, enabledByUser.has(f));
	}
}

function collectManifestFiles(
	packageRoot: string,
	resourceType: ResourceType,
): { allFiles: string[]; enabledByManifest: Set<string> } {
	const manifest = readPiManifest(packageRoot);
	const entries = manifestEntriesForResource(manifest, resourceType);
	if (entries && entries.length > 0) {
		const allFiles = collectFilesFromManifestEntries(entries, packageRoot, resourceType);
		const manifestPatterns = entries.filter(isOverridePattern);
		const enabledByManifest =
			manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
		return { allFiles: Array.from(enabledByManifest), enabledByManifest };
	}

	const allFiles = conventionDirsForResource(packageRoot, resourceType).flatMap((dir) =>
		existsSync(dir) ? collectResourceFiles(dir, resourceType) : [],
	);
	return { allFiles, enabledByManifest: new Set(allFiles) };
}

function addManifestEntries(
	entries: string[] | undefined,
	root: string,
	resourceType: ResourceType,
	target: ResourceMap,
	metadata: PathMetadata,
): void {
	if (!entries) return;

	const allFiles = collectFilesFromManifestEntries(entries, root, resourceType);
	const patterns = entries.filter(isOverridePattern);
	const enabledPaths = applyPatterns(allFiles, patterns, root);

	for (const f of allFiles) {
		if (enabledPaths.has(f)) {
			addResource(target, f, metadata, true);
		}
	}
}

function collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): string[] {
	const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
	const resolved = sourceEntries.flatMap((entry) => {
		if (!hasGlobPattern(entry)) {
			return [resolve(root, entry)];
		}
		return globSync(entry, {
			cwd: root,
			absolute: true,
			dot: false,
			nodir: false,
		}).map((match) => resolve(match));
	});
	return collectFilesFromPaths(resolved, resourceType);
}

export function resolveLocalEntries(
	entries: string[],
	resourceType: ResourceType,
	target: ResourceMap,
	metadata: PathMetadata,
	baseDir: string,
): void {
	if (entries.length === 0) return;

	const { plain, patterns } = splitPatterns(entries);
	const resolvedPlain = plain.map((p) => resolvePathFromBase(p, baseDir));
	const allFiles = collectFilesFromPaths(resolvedPlain, resourceType);
	const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

	for (const f of allFiles) {
		addResource(target, f, metadata, enabledPaths.has(f));
	}
}

export function collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
	const files: string[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const stats = statSync(p);
			if (stats.isFile()) {
				files.push(p);
			} else if (stats.isDirectory()) {
				files.push(...collectResourceFiles(p, resourceType));
			}
		} catch {}
	}
	return files;
}
