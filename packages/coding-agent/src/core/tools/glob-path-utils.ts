const GLOB_CHARS = /[*?[{]/;

export interface PathLikeGlobParts {
	basePath: string;
	glob?: string;
}

export function normalizePathLikeInput(value: string): string {
	let trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		trimmed = trimmed.slice(1, -1);
	}
	return trimmed;
}

export function pathLikeContainsGlob(value: string): boolean {
	return GLOB_CHARS.test(value);
}

export function splitPathLikeGlob(input: string): PathLikeGlobParts {
	const value = normalizePathLikeInput(input);
	const normalized = value.replace(/\\/g, "/");
	const segments = normalized.split("/");
	const firstGlobSegment = segments.findIndex((segment) => pathLikeContainsGlob(segment));
	if (firstGlobSegment === -1) return { basePath: value };

	const basePath = segments.slice(0, firstGlobSegment).join("/") || ".";
	let glob = segments.slice(firstGlobSegment).join("/");
	if (firstGlobSegment === 0 && glob !== "**" && !glob.startsWith("**/")) {
		glob = `**/${glob}`;
	}
	return { basePath, glob };
}
