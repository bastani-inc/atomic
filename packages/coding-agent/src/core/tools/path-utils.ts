import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { pathExists } from "../../utils/path-exists.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import { currentWorktreeRootMappings, mapPathForCwd, mapPathForCwdAsync } from "../resume/path-mapping.ts";

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

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export { pathExists };

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

function resolveLiteralAndNormalized(filePath: string, cwd: string): { literal: string; normalized: string } {
	return {
		literal: mapPathForCwd(resolvePath(filePath, cwd), cwd),
		normalized: mapPathForCwd(resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true }), cwd),
	};
}

async function resolveLiteralAndNormalizedAsync(
	filePath: string,
	cwd: string,
): Promise<{ literal: string; normalized: string }> {
	const [literal, normalized] = await Promise.all([
		mapPathForCwdAsync(resolvePath(filePath, cwd), cwd),
		mapPathForCwdAsync(resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true }), cwd),
	]);
	return { literal, normalized };
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths. A path under a checkout root that was restored on this host into the
 * worktree `cwd` is in resolves to the same place in that worktree.
 *
 * The literal path wins when it exists. Models sometimes write `@path` mentions or paste Unicode spaces, so the
 * `@`-stripped, space-normalised spelling is used only when the literal path does not exist. A new file keeps its
 * literal name when the literal directory exists.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const { literal, normalized } = resolveLiteralAndNormalized(filePath, cwd);
	if (fileExists(literal)) return literal;
	if (fileExists(normalized)) return normalized;
	if (fileExists(dirname(literal))) return literal;
	return normalized;
}

export function resolveToCwdIfUnambiguous(filePath: string, cwd: string): string | undefined {
	if (currentWorktreeRootMappings().length > 0) return undefined;
	const literal = resolvePath(filePath, cwd);
	const normalized = resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
	return literal === normalized ? literal : undefined;
}

export async function resolveToCwdAsync(filePath: string, cwd: string): Promise<string> {
	const { literal, normalized } = await resolveLiteralAndNormalizedAsync(filePath, cwd);
	if (await pathExists(literal)) return literal;
	if (await pathExists(normalized)) return normalized;
	if (await pathExists(dirname(literal))) return literal;
	return normalized;
}

/** macOS filename variants of the literal and normalised spellings, in the order they are tried. */
function readPathVariants({ literal, normalized }: { literal: string; normalized: string }): string[] {
	const variants: string[] = [];
	for (const base of new Set([literal, normalized])) {
		// macOS AM/PM variant (narrow no-break space before AM/PM)
		variants.push(tryMacOSScreenshotPath(base));
		// NFD variant (macOS stores filenames in NFD form)
		const nfdVariant = tryNFDVariant(base);
		variants.push(nfdVariant);
		// Curly quote variant (macOS uses U+2019 in screenshot names)
		variants.push(tryCurlyQuoteVariant(base));
		// Combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
		variants.push(tryCurlyQuoteVariant(nfdVariant));
	}
	return variants;
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	if (fileExists(resolved)) return resolved;
	for (const variant of readPathVariants(resolveLiteralAndNormalized(filePath, cwd))) {
		if (fileExists(variant)) return variant;
	}
	return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = await resolveToCwdAsync(filePath, cwd);
	if (await pathExists(resolved)) return resolved;
	for (const variant of readPathVariants(await resolveLiteralAndNormalizedAsync(filePath, cwd))) {
		if (await pathExists(variant)) return variant;
	}
	return resolved;
}
