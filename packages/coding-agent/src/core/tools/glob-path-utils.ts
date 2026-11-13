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

/** A base path that names only a filesystem root once its trailing separator is removed: POSIX `/`, `C:` or `//server/share`. */
const ROOT_ONLY_BASE = /^(?:|[A-Za-z]:|\/\/[^/]+\/[^/]+)$/;

export function splitPathLikeGlob(input: string): PathLikeGlobParts {
	const value = normalizePathLikeInput(input);
	const normalized = value.replace(/\\/g, "/");
	const segments = normalized.split("/");
	const firstGlobSegment = segments.findIndex((segment) => pathLikeContainsGlob(segment));
	if (firstGlobSegment === -1) return { basePath: value };

	const joinedBase = segments.slice(0, firstGlobSegment).join("/");
	// A glob directly after a root keeps that root, with its separator as written, as the search base.
	const basePath =
		firstGlobSegment > 0 && ROOT_ONLY_BASE.test(joinedBase)
			? value.slice(0, joinedBase.length + 1)
			: joinedBase || ".";
	let glob = segments.slice(firstGlobSegment).join("/");
	if (firstGlobSegment === 0 && glob !== "**" && !glob.startsWith("**/")) {
		glob = `**/${glob}`;
	}
	return { basePath, glob };
}
