import { lstatSync, realpathSync, statSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";

/** Safe Win32 path length threshold for `CreateProcessW` `lpCurrentDirectory` without long-path opt-in. */
const SAFE_WINDOWS_CWD_LENGTH = 248;

interface ResolvedProtectedDir {
	readonly lexical: string;
	readonly real: string | undefined;
}

interface ResolvedCandidateDir {
	readonly lexical: string;
	readonly real: string | undefined;
	readonly unverifiedLink: boolean;
}

export interface SafeWindowsWorkingDirectoryOptions {
	/** Optional explicit/resolved command path whose directory and drive root may be used as fallbacks. */
	readonly commandPath?: string;
	/** Additional folders (besides `process.cwd()`) that the child process must not run inside. */
	readonly protectedDirs?: readonly (string | undefined)[];
}

function isAsciiLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDriveRootPrefix(slashed: string): boolean {
	return slashed.length >= 3 && isAsciiLetter(slashed.charCodeAt(0)) && slashed[1] === ":" && slashed[2] === "\\";
}

function normalizeUncPath(slashed: string): string | undefined {
	const rest = slashed.slice(2);
	const firstSep = rest.indexOf("\\");
	if (firstSep <= 0) return undefined;
	const server = rest.slice(0, firstSep);
	if (server === "." || server === "..") return undefined;
	const afterServer = rest.slice(firstSep + 1);
	const secondSep = afterServer.indexOf("\\");
	const share = secondSep === -1 ? afterServer : afterServer.slice(0, secondSep);
	if (share === "" || share === "." || share === "..") return undefined;
	return win32.resolve(slashed);
}

/**
 * Normalizes a fully-qualified Windows directory path for comparison and safe `cwd` use.
 *
 * Strips extended-length and Win32 device prefixes (`\\?\`, `\\.\`, `\\?\UNC\`) so aliased paths compare
 * equal to their standard counterparts, preserves trailing separators on drive and share roots, and
 * rejects relative paths, bare drives (`C:`), drive-relative paths (`C:foo`), rooted-without-drive paths
 * (`\Windows`), raw volume devices (`\\?\C:`, `\\?\Volume{...}` without `\`), incomplete UNC roots, and
 * NUL bytes.
 */
export function normalizeWindowsPathForCompare(value: string): string | undefined {
	if (value === "" || value.includes("\0")) return undefined;
	const slashed = value.replaceAll("/", "\\");
	if (slashed.startsWith("\\\\?\\") || slashed.startsWith("\\\\.\\")) {
		const rest = slashed.slice(4);
		if (rest.length >= 4 && rest.slice(0, 4).toLowerCase() === "unc\\") {
			return normalizeUncPath(`\\\\${rest.slice(4)}`);
		}
		if (isDriveRootPrefix(rest)) {
			return win32.resolve(rest);
		}
		if (rest.length > 9 && rest.slice(0, 7).toLowerCase() === "volume{") {
			const sepIndex = rest.indexOf("\\");
			if (sepIndex <= 8 || rest[sepIndex - 1] !== "}") return undefined;
			const root = `\\\\?\\${rest.slice(0, sepIndex + 1)}`;
			const tail = rest.slice(sepIndex + 1);
			const normalizedTail = tail === "" ? "" : win32.resolve("C:\\", tail).slice(3);
			return `${root}${normalizedTail}`;
		}
		return undefined;
	}
	if (slashed.startsWith("\\\\")) {
		return normalizeUncPath(slashed);
	}
	if (isDriveRootPrefix(slashed)) {
		return win32.resolve(slashed);
	}
	return undefined;
}

export function isAbsoluteWindowsPath(value: string): boolean {
	return normalizeWindowsPathForCompare(value) !== undefined;
}

/** Returns the normalized drive, UNC share, or volume root (always ending with `\`) for an absolute Windows path. */
export function windowsDriveRoot(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeWindowsPathForCompare(value);
	if (normalized === undefined) return undefined;
	if (normalized.startsWith("\\\\?\\")) {
		const sepIndex = normalized.indexOf("\\", 4);
		return sepIndex === -1 ? undefined : normalized.slice(0, sepIndex + 1);
	}
	const root = win32.parse(normalized).root;
	if (root.length <= 1) return undefined;
	return root.endsWith("\\") ? root : `${root}\\`;
}

export function isDriveRootWindowsPath(normalized: string): boolean {
	const root = windowsDriveRoot(normalized);
	return root !== undefined && normalized.toLowerCase() === root.toLowerCase();
}

function isSubpathOrSame(folderNormalized: string, candidateNormalized: string): boolean {
	const rel = win32.relative(folderNormalized.toLowerCase(), candidateNormalized.toLowerCase());
	return rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel);
}

function conflictsWithNormalizedFolder(folderNormalized: string, candidateNormalized: string): boolean {
	if (isDriveRootWindowsPath(folderNormalized)) {
		return folderNormalized.toLowerCase() === candidateNormalized.toLowerCase();
	}
	return isSubpathOrSame(folderNormalized, candidateNormalized);
}

function isInsideProtectedFolder(folder: ResolvedProtectedDir, candidate: ResolvedCandidateDir): boolean {
	if (candidate.unverifiedLink) return true;
	if (folder.real !== undefined && candidate.real !== undefined) {
		if (isDriveRootWindowsPath(folder.real)) {
			return folder.real.toLowerCase() === candidate.real.toLowerCase();
		}
		if (isSubpathOrSame(folder.real, candidate.real)) return true;
		if (!isDriveRootWindowsPath(folder.lexical) && isSubpathOrSame(folder.lexical, candidate.lexical)) return true;
		return false;
	}
	if (conflictsWithNormalizedFolder(folder.lexical, candidate.lexical)) return true;
	if (folder.real !== undefined && conflictsWithNormalizedFolder(folder.real, candidate.lexical)) return true;
	if (candidate.real !== undefined && conflictsWithNormalizedFolder(folder.lexical, candidate.real)) return true;
	return false;
}

function preferredCandidatePath(candidate: ResolvedCandidateDir): string {
	const { lexical, real } = candidate;
	if (real !== undefined && (real.length <= SAFE_WINDOWS_CWD_LENGTH || real.length <= lexical.length)) {
		return real;
	}
	return lexical;
}

function readProcessCwd(): string | undefined {
	try {
		return process.cwd();
	} catch {
		return undefined;
	}
}

function collectRawProtectedDirs(extra?: readonly (string | undefined)[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	const add = (dir: string | undefined) => {
		if (dir === undefined) return;
		const normalized = normalizeWindowsPathForCompare(dir);
		if (normalized === undefined) return;
		const key = normalized.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		result.push(dir);
	};
	add(readProcessCwd());
	for (const dir of extra ?? []) add(dir);
	return result;
}

function buildCandidates(
	protectedDirs: readonly ResolvedProtectedDir[],
	commandPath: string | undefined,
): readonly string[] {
	const tempDir = tmpdir();
	const normalizedCommand = commandPath === undefined ? undefined : normalizeWindowsPathForCompare(commandPath);
	const commandDir = normalizedCommand === undefined ? undefined : win32.dirname(normalizedCommand);
	const commandRoot = windowsDriveRoot(normalizedCommand);
	const tempRoot = windowsDriveRoot(tempDir);
	const protectedRoots: (string | undefined)[] = [];
	for (const folder of protectedDirs) {
		protectedRoots.push(windowsDriveRoot(folder.real));
		protectedRoots.push(windowsDriveRoot(folder.lexical));
	}
	const rawList: readonly (string | undefined)[] = [
		process.env.SystemRoot,
		process.env.windir,
		"C:\\Windows",
		tempDir,
		commandDir,
		commandRoot,
		tempRoot,
		...protectedRoots,
		windowsDriveRoot(process.env.SystemRoot),
		windowsDriveRoot(process.env.windir),
		"C:\\",
	];
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const item of rawList) {
		if (item === undefined || item === "") continue;
		const key = item.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}
	return deduped;
}

function tryRealPathSync(dir: string): string | undefined {
	try {
		const native = realpathSync.native;
		return normalizeWindowsPathForCompare(typeof native === "function" ? native(dir) : realpathSync(dir));
	} catch {
		try {
			return normalizeWindowsPathForCompare(realpathSync(dir));
		} catch {
			return undefined;
		}
	}
}

function resolveProtectedDirSync(rawDir: string): ResolvedProtectedDir | undefined {
	const lexical = normalizeWindowsPathForCompare(rawDir);
	if (lexical === undefined) return undefined;
	return { lexical, real: tryRealPathSync(rawDir) };
}

function resolveCandidateDirSync(rawDir: string): ResolvedCandidateDir | undefined {
	const lexical = normalizeWindowsPathForCompare(rawDir);
	if (lexical === undefined) return undefined;
	try {
		if (!statSync(rawDir).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	const real = tryRealPathSync(rawDir);
	let unverifiedLink = false;
	if (real === undefined) {
		try {
			unverifiedLink = lstatSync(rawDir).isSymbolicLink();
		} catch {
			unverifiedLink = false;
		}
	}
	return { lexical, real, unverifiedLink };
}

/**
 * Synchronously selects a safe existing Windows working directory outside `process.cwd()` (and any extra
 * protected folders), resolving junctions, symlinks, 8.3 short names, `subst` drives, and extended-length
 * aliases via `realpathSync.native` where available, and handling drive roots explicitly.
 */
export function resolveSafeWindowsWorkingDirectorySync(
	options: SafeWindowsWorkingDirectoryOptions = {},
): string | undefined {
	const protectedDirs: ResolvedProtectedDir[] = [];
	for (const raw of collectRawProtectedDirs(options.protectedDirs)) {
		const resolved = resolveProtectedDirSync(raw);
		if (resolved !== undefined) protectedDirs.push(resolved);
	}
	const candidates = buildCandidates(protectedDirs, options.commandPath);
	let fallback: string | undefined;
	for (const rawCandidate of candidates) {
		const candidate = resolveCandidateDirSync(rawCandidate);
		if (candidate === undefined) continue;
		const chosen = preferredCandidatePath(candidate);
		const insideAny = protectedDirs.some((folder) => isInsideProtectedFolder(folder, candidate));
		if (!insideAny) return chosen;
		fallback ??= chosen;
	}
	return fallback;
}

async function tryRealPathAsync(dir: string): Promise<string | undefined> {
	try {
		return normalizeWindowsPathForCompare(await realpath(dir));
	} catch {
		return undefined;
	}
}

async function resolveProtectedDirAsync(rawDir: string): Promise<ResolvedProtectedDir | undefined> {
	const lexical = normalizeWindowsPathForCompare(rawDir);
	if (lexical === undefined) return undefined;
	return { lexical, real: await tryRealPathAsync(rawDir) };
}

async function resolveCandidateDirAsync(rawDir: string): Promise<ResolvedCandidateDir | undefined> {
	const lexical = normalizeWindowsPathForCompare(rawDir);
	if (lexical === undefined) return undefined;
	try {
		if (!(await stat(rawDir)).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	const real = await tryRealPathAsync(rawDir);
	let unverifiedLink = false;
	if (real === undefined) {
		try {
			unverifiedLink = (await lstat(rawDir)).isSymbolicLink();
		} catch {
			unverifiedLink = false;
		}
	}
	return { lexical, real, unverifiedLink };
}

/**
 * Asynchronously selects a safe existing Windows working directory outside `process.cwd()` (and any extra
 * protected folders) without blocking the event loop.
 */
export async function resolveSafeWindowsWorkingDirectoryAsync(
	options: SafeWindowsWorkingDirectoryOptions = {},
): Promise<string | undefined> {
	const rawProtected = collectRawProtectedDirs(options.protectedDirs);
	const resolvedProtected = await Promise.all(rawProtected.map((raw) => resolveProtectedDirAsync(raw)));
	const protectedDirs = resolvedProtected.filter((dir): dir is ResolvedProtectedDir => dir !== undefined);
	const candidates = buildCandidates(protectedDirs, options.commandPath);
	let fallback: string | undefined;
	for (const rawCandidate of candidates) {
		const candidate = await resolveCandidateDirAsync(rawCandidate);
		if (candidate === undefined) continue;
		const chosen = preferredCandidatePath(candidate);
		const insideAny = protectedDirs.some((folder) => isInsideProtectedFolder(folder, candidate));
		if (!insideAny) return chosen;
		fallback ??= chosen;
	}
	return fallback;
}
