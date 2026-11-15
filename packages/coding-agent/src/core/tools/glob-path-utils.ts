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

/** Characters a backslash makes literal: `\[`, `\]`, `\*`, `\?`, `\{` and `\}`. */
const ESCAPABLE = "[]*?{}";
const ESCAPE_SEQUENCE = /\\([[\]*?{}])/g;
const HAS_ESCAPE = /\\[[\]*?{}]/;
/** Private-use stand-ins that hold an escaped character while the path is split. */
const PLACEHOLDER = /[\uE000-\uE005]/g;

/**
 * A backslash escapes a glob character except on Windows and in drive (`C:\`) or UNC (`\\server\share`) paths, where
 * every backslash is a separator. There, an existing literal path is matched by checking it first, not by escaping.
 */
function backslashEscapes(value: string): boolean {
	return process.platform !== "win32" && !/^(?:[A-Za-z]:|\\\\)/.test(value);
}

function restoreEscapes(value: string, keepBackslash: boolean): string {
	return value.replace(PLACEHOLDER, (placeholder) => {
		const char = ESCAPABLE[placeholder.charCodeAt(0) - 0xe000] ?? "";
		return keepBackslash ? `\\${char}` : char;
	});
}

/** A path, without quotes, that names an existing file or directory exactly, glob characters and all. */
export function literalPathLike(input: string): PathLikeGlobParts {
	return { basePath: normalizePathLikeInput(input) };
}

/**
 * Split a path into its literal base and the glob after it. Callers check first whether the whole path exists, and use
 * {@link literalPathLike} when it does, so `app/[id]/page.tsx` names that file rather than the pattern `app/[id]`.
 */
export function splitPathLikeGlob(input: string): PathLikeGlobParts {
	const unquoted = normalizePathLikeInput(input);
	if (!backslashEscapes(unquoted) || !HAS_ESCAPE.test(unquoted)) return splitUnescaped(unquoted);
	const protectedValue = unquoted.replace(ESCAPE_SEQUENCE, (_sequence, char: string) =>
		String.fromCharCode(0xe000 + ESCAPABLE.indexOf(char)),
	);
	const parts = splitUnescaped(protectedValue);
	const basePath = restoreEscapes(parts.basePath, false);
	return parts.glob === undefined ? { basePath } : { basePath, glob: restoreEscapes(parts.glob, true) };
}

function splitUnescaped(value: string): PathLikeGlobParts {
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
