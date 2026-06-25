import { relative } from "node:path";
import { valid, validRange } from "semver";
import { isLocalPath } from "../utils/paths.ts";
import { parseGitUrl } from "../utils/git.ts";
import { getBaseDirForScope, resolveManagerPath, resolvePathFromBase } from "./package-manager-paths.ts";
import type { PackageManagerContext, ParsedSource, SourceScope } from "./package-manager-types.ts";
import type { PackageSource } from "./settings-manager.ts";

function isExactNpmVersion(version: string | undefined): boolean {
	return valid(version ?? "") !== null;
}

function getNpmVersionRange(version: string | undefined): string | undefined {
	return version ? (validRange(version) ?? undefined) : undefined;
}

export function parseNpmSpec(spec: string): { name: string; version?: string } {
	const versionSeparator = spec.startsWith("@") ? spec.indexOf("@", spec.indexOf("/") + 1) : spec.indexOf("@");
	if (versionSeparator <= 0) {
		return { name: spec };
	}
	return {
		name: spec.slice(0, versionSeparator),
		version: spec.slice(versionSeparator + 1),
	};
}

export function parseSource(source: string): ParsedSource {
	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length).trim();
		const { name, version } = parseNpmSpec(spec);
		return {
			type: "npm",
			spec,
			name,
			version,
			range: getNpmVersionRange(version),
			pinned: isExactNpmVersion(version),
		};
	}

	if (isLocalPath(source)) {
		return { type: "local", path: source };
	}

	const gitParsed = parseGitUrl(source);
	if (gitParsed) {
		return gitParsed;
	}

	return { type: "local", path: source };
}

export function getPackageSourceString(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

function getSourceMatchKeyForInput(context: PackageManagerContext, source: string): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		return `git:${parsed.host}/${parsed.path}`;
	}
	return `local:${resolveManagerPath(context, parsed.path)}`;
}

function getSourceMatchKeyForSettings(
	context: PackageManagerContext,
	source: string,
	scope: SourceScope,
): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		return `git:${parsed.host}/${parsed.path}`;
	}
	const baseDir = getBaseDirForScope(context, scope);
	return `local:${resolvePathFromBase(parsed.path, baseDir)}`;
}

export function packageSourcesMatch(
	context: PackageManagerContext,
	existing: PackageSource,
	inputSource: string,
	scope: SourceScope,
): boolean {
	const left = getSourceMatchKeyForSettings(context, getPackageSourceString(existing), scope);
	const right = getSourceMatchKeyForInput(context, inputSource);
	return left === right;
}

export function normalizePackageSourceForSettings(
	context: PackageManagerContext,
	source: string,
	scope: SourceScope,
): string {
	const parsed = parseSource(source);
	if (parsed.type !== "local") {
		return source;
	}
	const baseDir = getBaseDirForScope(context, scope);
	const resolved = resolveManagerPath(context, parsed.path);
	const rel = relative(baseDir, resolved);
	return rel || ".";
}

export function getPackageIdentity(context: PackageManagerContext, source: string, scope?: SourceScope): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		return `git:${parsed.host}/${parsed.path}`;
	}
	if (scope) {
		const baseDir = getBaseDirForScope(context, scope);
		return `local:${resolvePathFromBase(parsed.path, baseDir)}`;
	}
	return `local:${resolveManagerPath(context, parsed.path)}`;
}

export function dedupePackages(
	context: PackageManagerContext,
	packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
): Array<{ pkg: PackageSource; scope: SourceScope }> {
	const seen = new Map<string, { pkg: PackageSource; scope: SourceScope }>();

	for (const entry of packages) {
		const sourceStr = getPackageSourceString(entry.pkg);
		const identity = getPackageIdentity(context, sourceStr, entry.scope);
		const existing = seen.get(identity);
		if (!existing) {
			seen.set(identity, entry);
		} else if (entry.scope === "project" && existing.scope === "user") {
			seen.set(identity, entry);
		}
	}

	return Array.from(seen.values());
}

export function buildNoMatchingPackageMessage(
	context: PackageManagerContext,
	source: string,
	configuredPackages: PackageSource[],
): string {
	const suggestion = findSuggestedConfiguredSource(context, source, configuredPackages);
	if (!suggestion) {
		return `No matching package found for ${source}`;
	}
	return `No matching package found for ${source}. Did you mean ${suggestion}?`;
}

function findSuggestedConfiguredSource(
	_context: PackageManagerContext,
	source: string,
	configuredPackages: PackageSource[],
): string | undefined {
	const trimmedSource = source.trim();
	const suggestions = new Set<string>();

	for (const pkg of configuredPackages) {
		const sourceStr = getPackageSourceString(pkg);
		const parsed = parseSource(sourceStr);
		if (parsed.type === "npm") {
			if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
				suggestions.add(sourceStr);
			}
			continue;
		}
		if (parsed.type === "git") {
			const shorthand = `${parsed.host}/${parsed.path}`;
			const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
			if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
				suggestions.add(sourceStr);
			}
		}
	}

	return suggestions.values().next().value;
}

export function assertProjectTrustedForScope(context: PackageManagerContext, scope: SourceScope): void {
	if (scope === "project" && !context.settingsManager.isProjectTrusted()) {
		throw new Error("Project is not trusted; refusing to access project package storage");
	}
}

