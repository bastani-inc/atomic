import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { normalizePath, resolvePath } from "../../utils/paths.ts";

const NARROW_NO_BREAK_SPACE = "\u202F";

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function tryShellEscapedPath(filePath: string): string {
	// Terminal paste often preserves POSIX shell escaping, e.g. `Screenshot\ 2026.png`.
	// Try the literal path first; only use this as a fallback for paths that did not exist.
	return filePath.includes("\\") ? filePath.replace(/\\(?=.)/g, "") : filePath;
}

function addUniqueCandidate(candidates: string[], filePath: string): void {
	if (!candidates.includes(filePath)) candidates.push(filePath);
}

function addReadPathVariants(candidates: string[], filePath: string): void {
	addUniqueCandidate(candidates, filePath);
	addUniqueCandidate(candidates, tryMacOSScreenshotPath(filePath));
	const nfdVariant = tryNFDVariant(filePath);
	addUniqueCandidate(candidates, nfdVariant);
	addUniqueCandidate(candidates, tryCurlyQuoteVariant(filePath));
	addUniqueCandidate(candidates, tryCurlyQuoteVariant(nfdVariant));
}

function getReadPathCandidates(resolved: string): string[] {
	const candidates: string[] = [];
	addReadPathVariants(candidates, resolved);
	const shellEscapedVariant = tryShellEscapedPath(resolved);
	if (shellEscapedVariant !== resolved) {
		addReadPathVariants(candidates, shellEscapedVariant);
	}
	return candidates;
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	for (const candidate of getReadPathCandidates(resolved)) {
		if (fileExists(candidate)) return candidate;
	}

	return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	for (const candidate of getReadPathCandidates(resolved)) {
		if (await pathExists(candidate)) return candidate;
	}

	return resolved;
}
