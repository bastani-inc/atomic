import type { PathMetadata, ResourceConfigurationOrigin } from "./package-manager.ts";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
	configurationOrigin?: ResourceConfigurationOrigin;
}

export const BUILTIN_PATH_PREFIX = "builtin:";

export function getSyntheticPathSource(path: string): string | undefined {
	if (path.startsWith(BUILTIN_PATH_PREFIX)) return "builtin";
	if (path.startsWith("<") && path.endsWith(">")) return path.slice(1, -1).split(":")[0] || "temporary";
	return undefined;
}

export function isSyntheticPath(path: string): boolean {
	return path.startsWith(BUILTIN_PATH_PREFIX) || path.startsWith("<");
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
		configurationOrigin: metadata.configurationOrigin,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
		configurationOrigin?: ResourceConfigurationOrigin;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
		configurationOrigin: options.configurationOrigin,
	};
}
