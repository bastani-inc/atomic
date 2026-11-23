import { lstatSync, realpathSync, statSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";

/** Safe Win32 path length threshold for `CreateProcessW` `lpCurrentDirectory` without an extended `\\?\` prefix. */
const SAFE_WINDOWS_CWD_LENGTH = 248;
/** Default upper bound on async filesystem probes so slow or offline UNC/OneDrive paths never stall callers. */
export const DEFAULT_WINDOWS_CWD_TIMEOUT_MS = 100;
/** Maximum share of the timeout budget spent resolving protected directories' realpaths before probing local candidates. */
const MAX_PROTECTED_REALPATH_BUDGET_MS = 50;

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
	/**
	 * Installation directories (e.g. extension dir, `dist/utils`, standalone executable dir) whose enclosing
	 * install roots—both lexical and canonical realpath (catching `subst` drives and junctions)—must be protected.
	 */
	readonly installDirs?: readonly (string | undefined)[];
	/** When true (kill/stop commands), try `commandPath`'s directory ahead of `os.tmpdir()`. */
	readonly preferCommandDir?: boolean;
	/** Maximum time in milliseconds spent on async `stat`/`realpath`/`lstat` probes. Default: 100 ms. */
	readonly timeoutMs?: number;
	/** Optional abort signal to cancel pending timeout timers immediately when the caller no longer needs the result. */
	readonly signal?: AbortSignal;
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
 * Normalizes a fully-qualified Windows directory path for containment comparison.
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

/**
 * Formats a normalized comparison path for Win32 filesystem / `CreateProcessW` APIs:
 * keeps short paths (< 248 chars) plain and ensures paths >= 248 chars carry the proper
 * extended-length prefix (`\\?\` for drive paths, `\\?\UNC\server\share\...` for UNC paths).
 */
export function toSpawnWindowsPath(comparePath: string): string {
	if (comparePath.startsWith("\\\\?\\") || comparePath.length < SAFE_WINDOWS_CWD_LENGTH) {
		return comparePath;
	}
	if (comparePath.startsWith("\\\\")) {
		return `\\\\?\\UNC\\${comparePath.slice(2)}`;
	}
	return `\\\\?\\${comparePath}`;
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

function addNonRootWindowsDir(target: string[], seen: Set<string>, candidate: string): void {
	const normalized = normalizeWindowsPathForCompare(candidate);
	if (normalized === undefined || isDriveRootWindowsPath(normalized)) return;
	const key = normalized.toLowerCase();
	if (seen.has(key)) return;
	seen.add(key);
	target.push(normalized);
}

/**
 * Returns the install-root directories enclosing `entryDir` that background helpers must not keep as their working
 * directory on Windows (npm/pnpm/bun package root + `@scope`/`node_modules`, standalone binary `versions/<ver>` +
 * install root, or `dist/utils` package root). Never promotes a drive or share root to an inferred protected ancestor.
 */
export function collectInstallProtectedDirs(entryDir: string | undefined): string[] {
	if (entryDir === undefined || entryDir === "") return [];
	const normalized = normalizeWindowsPathForCompare(entryDir);
	if (normalized === undefined) return [];
	const result: string[] = [normalized];
	const seen = new Set<string>([normalized.toLowerCase()]);

	const add = (dir: string) => addNonRootWindowsDir(result, seen, dir);
	const parent = win32.dirname(normalized);
	const parentName = win32.basename(parent).toLowerCase();
	const ownName = win32.basename(normalized).toLowerCase();
	const grandParent = win32.dirname(parent);
	const grandParentName = win32.basename(grandParent).toLowerCase();

	let packageDir = normalized;
	if (parentName === "builtin" && grandParentName === "dist") {
		packageDir = win32.dirname(grandParent);
		add(grandParent);
		add(packageDir);
	} else if (parentName === "builtin") {
		const versionDir = grandParent;
		packageDir = versionDir;
		add(versionDir);
		const versionDirName = win32.basename(versionDir).toLowerCase();
		const versionsParent = win32.dirname(versionDir);
		if (win32.basename(versionsParent).toLowerCase() === "versions") {
			add(versionsParent);
			add(win32.dirname(versionsParent));
		} else if (versionDirName === "current" || versionDirName === "atomic-current") {
			add(versionsParent);
		}
	} else if (ownName === "utils" && parentName === "dist") {
		packageDir = grandParent;
		add(parent);
		add(packageDir);
	} else if (parentName === "versions") {
		add(parent);
		add(grandParent);
	} else if (ownName === "current" || ownName === "atomic-current") {
		add(parent);
	}

	const pkgParent = win32.dirname(packageDir);
	const pkgParentName = win32.basename(pkgParent).toLowerCase();
	const pkgGrandParent = win32.dirname(pkgParent);
	const pkgGrandParentName = win32.basename(pkgGrandParent).toLowerCase();
	if (pkgParentName.startsWith("@") && pkgGrandParentName === "node_modules") {
		add(pkgParent);
		add(pkgGrandParent);
	} else if (pkgParentName === "node_modules") {
		add(pkgParent);
	}

	return result;
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
	return toSpawnWindowsPath(candidate.real ?? candidate.lexical);
}

/**
 * Win32 `CreateProcessW` rejects `lpCurrentDirectory` >= `MAX_PATH` (even with `\\?\`) when Windows' default
 * `LongPathsEnabled = 0` is in effect. Prefer a short (< 248-char) verified directory outside the project whenever
 * one is available so kill commands work across both default Windows installs and `LongPathsEnabled = 1` hosts.
 */
function isShortWindowsSpawnPath(spawnPath: string): boolean {
	return !spawnPath.startsWith("\\\\?\\") && spawnPath.length < SAFE_WINDOWS_CWD_LENGTH;
}

function probePathFor(rawDir: string, lexical: string): string {
	if (rawDir.length >= SAFE_WINDOWS_CWD_LENGTH && !rawDir.startsWith("\\\\?\\")) {
		return toSpawnWindowsPath(lexical);
	}
	return rawDir;
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

function dedupeCandidates(rawList: readonly (string | undefined)[]): string[] {
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

function buildCandidates(
	protectedDirs: readonly ResolvedProtectedDir[],
	commandPath: string | undefined,
	preferCommandDir: boolean,
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
	const middle = preferCommandDir ? [commandDir, tempDir] : [tempDir, commandDir];
	return dedupeCandidates([
		process.env.SystemRoot,
		process.env.windir,
		"C:\\Windows",
		...middle,
		commandRoot,
		tempRoot,
		...protectedRoots,
		windowsDriveRoot(process.env.SystemRoot),
		windowsDriveRoot(process.env.windir),
		"C:\\",
	]);
}

function boundedFsCall<T>(work: Promise<T>, budgetMs: number, signal?: AbortSignal): Promise<T | undefined> {
	if (signal?.aborted || budgetMs <= 0) {
		void work.catch(() => {});
		return Promise.resolve(undefined);
	}
	return new Promise<T | undefined>((resolve) => {
		let settled = false;
		const done = (value: T | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => done(undefined);
		const timer = setTimeout(() => done(undefined), budgetMs);
		timer.unref?.();
		signal?.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => done(value),
			() => done(undefined),
		);
	});
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
	return { lexical, real: tryRealPathSync(probePathFor(rawDir, lexical)) };
}

function resolveCandidateDirSync(rawDir: string): ResolvedCandidateDir | undefined {
	const lexical = normalizeWindowsPathForCompare(rawDir);
	if (lexical === undefined) return undefined;
	const probe = probePathFor(rawDir, lexical);
	try {
		if (!statSync(probe).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	const real = tryRealPathSync(probe);
	let unverifiedLink = false;
	if (real === undefined) {
		try {
			unverifiedLink = lstatSync(probe).isSymbolicLink();
		} catch {
			unverifiedLink = false;
		}
	}
	return { lexical, real, unverifiedLink };
}

/** Synchronously resolves a safe Windows working directory using `statSync` and `realpathSync.native`. */
export function resolveSafeWindowsWorkingDirectorySync(
	options: SafeWindowsWorkingDirectoryOptions = {},
): string | undefined {
	const protectedDirs: ResolvedProtectedDir[] = [];
	const seenProtected = new Set<string>();
	const addProtected = (dir: ResolvedProtectedDir | undefined) => {
		if (dir === undefined) return;
		const key = `${dir.lexical.toLowerCase()}\0${dir.real?.toLowerCase() ?? ""}`;
		if (seenProtected.has(key)) return;
		seenProtected.add(key);
		protectedDirs.push(dir);
	};
	for (const raw of collectRawProtectedDirs(options.protectedDirs)) {
		addProtected(resolveProtectedDirSync(raw));
	}
	for (const rawInstall of options.installDirs ?? []) {
		if (rawInstall === undefined) continue;
		const resolvedEntry = resolveProtectedDirSync(rawInstall);
		addProtected(resolvedEntry);
		for (const dir of collectInstallProtectedDirs(rawInstall)) {
			addProtected(resolveProtectedDirSync(dir));
		}
		if (resolvedEntry?.real !== undefined) {
			for (const dir of collectInstallProtectedDirs(resolvedEntry.real)) {
				addProtected({ lexical: dir, real: tryRealPathSync(probePathFor(dir, dir)) ?? dir });
			}
		}
	}
	const candidates = buildCandidates(protectedDirs, options.commandPath, options.preferCommandDir === true);
	let longOutsideFallback: string | undefined;
	let shortFallback: string | undefined;
	let anyFallback: string | undefined;
	for (const rawCandidate of candidates) {
		const candidate = resolveCandidateDirSync(rawCandidate);
		if (candidate === undefined) continue;
		const chosen = preferredCandidatePath(candidate);
		const isShort = isShortWindowsSpawnPath(chosen);
		const insideAny = protectedDirs.some((folder) => isInsideProtectedFolder(folder, candidate));
		if (!insideAny) {
			if (isShort) return chosen;
			longOutsideFallback ??= chosen;
			continue;
		}
		if (isShort) shortFallback ??= chosen;
		anyFallback ??= chosen;
	}
	return longOutsideFallback ?? shortFallback ?? anyFallback;
}

async function tryRealPathAsync(dir: string, deadline: number, signal?: AbortSignal): Promise<string | undefined> {
	const resolved = await boundedFsCall(realpath(dir), deadline - Date.now(), signal);
	return resolved === undefined ? undefined : normalizeWindowsPathForCompare(resolved);
}

async function resolveProtectedDirAsync(
	rawDir: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<ResolvedProtectedDir | undefined> {
	const lexical = normalizeWindowsPathForCompare(rawDir);
	if (lexical === undefined) return undefined;
	const real = await tryRealPathAsync(probePathFor(rawDir, lexical), deadline, signal);
	return { lexical, real };
}

async function resolveCandidateDirAsync(
	rawDir: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<ResolvedCandidateDir | undefined> {
	if (signal?.aborted || deadline - Date.now() <= 0) return undefined;
	const lexical = normalizeWindowsPathForCompare(rawDir);
	if (lexical === undefined) return undefined;
	const probe = probePathFor(rawDir, lexical);
	const stats = await boundedFsCall(stat(probe), deadline - Date.now(), signal);
	if (!stats?.isDirectory()) return undefined;
	const real = await tryRealPathAsync(probe, deadline, signal);
	let unverifiedLink = false;
	if (real === undefined && !signal?.aborted && deadline - Date.now() > 0) {
		const linkStats = await boundedFsCall(lstat(probe), deadline - Date.now(), signal);
		unverifiedLink = linkStats?.isSymbolicLink() === true;
	}
	return { lexical, real, unverifiedLink };
}

/**
 * Asynchronously selects a safe existing Windows working directory outside `process.cwd()` (and any extra
 * protected folders) within a bounded time budget without blocking the event loop.
 */
export async function resolveSafeWindowsWorkingDirectoryAsync(
	options: SafeWindowsWorkingDirectoryOptions = {},
): Promise<string | undefined> {
	const { signal } = options;
	if (signal?.aborted) return undefined;
	const totalMs = Math.max(0, options.timeoutMs ?? DEFAULT_WINDOWS_CWD_TIMEOUT_MS);
	const startedAt = Date.now();
	const overallDeadline = startedAt + totalMs;
	const protectedBudgetMs = Math.min(MAX_PROTECTED_REALPATH_BUDGET_MS, Math.floor(totalMs / 2));
	const protectedDeadline = startedAt + protectedBudgetMs;

	const installEntryKeys = new Set<string>();
	for (const raw of options.installDirs ?? []) {
		if (raw === undefined) continue;
		const normalized = normalizeWindowsPathForCompare(raw);
		if (normalized !== undefined) installEntryKeys.add(normalized.toLowerCase());
	}
	const installLexical = (options.installDirs ?? []).flatMap((raw) => collectInstallProtectedDirs(raw));
	const rawProtected = collectRawProtectedDirs([...(options.protectedDirs ?? []), ...installLexical]);
	const resolvedProtected = await Promise.all(
		rawProtected.map((raw) => resolveProtectedDirAsync(raw, protectedDeadline, signal)),
	);
	if (signal?.aborted) return undefined;
	const protectedDirs: ResolvedProtectedDir[] = [];
	const seenProtected = new Set<string>();
	const addProtected = (dir: ResolvedProtectedDir | undefined) => {
		if (dir === undefined) return;
		const key = `${dir.lexical.toLowerCase()}\0${dir.real?.toLowerCase() ?? ""}`;
		if (seenProtected.has(key)) return;
		seenProtected.add(key);
		protectedDirs.push(dir);
	};
	for (const dir of resolvedProtected) {
		addProtected(dir);
		if (dir !== undefined && dir.real !== undefined && installEntryKeys.has(dir.lexical.toLowerCase())) {
			for (const canonicalAncestor of collectInstallProtectedDirs(dir.real)) {
				addProtected({ lexical: canonicalAncestor, real: canonicalAncestor });
			}
		}
	}
	const candidates = buildCandidates(protectedDirs, options.commandPath, options.preferCommandDir === true);
	let longOutsideFallback: string | undefined;
	let shortFallback: string | undefined;
	let anyFallback: string | undefined;
	for (const rawCandidate of candidates) {
		if (signal?.aborted || overallDeadline - Date.now() <= 0) break;
		const candidate = await resolveCandidateDirAsync(rawCandidate, overallDeadline, signal);
		if (candidate === undefined) continue;
		const chosen = preferredCandidatePath(candidate);
		const isShort = isShortWindowsSpawnPath(chosen);
		const insideAny = protectedDirs.some((folder) => isInsideProtectedFolder(folder, candidate));
		if (!insideAny) {
			if (isShort) return chosen;
			longOutsideFallback ??= chosen;
			continue;
		}
		if (isShort) shortFallback ??= chosen;
		anyFallback ??= chosen;
	}
	return longOutsideFallback ?? shortFallback ?? anyFallback;
}

/**
 * Pure synchronous lexical working-directory selector for kill commands (zero filesystem syscalls).
 *
 * Avoids unverified `TMP`/`TEMP` paths (which may not exist) and prefers reliable OS directories
 * (`C:\Windows` when `SystemRoot` is on `C:` or unset, or `process.cwd()`'s own drive root when Windows is
 * installed on another drive or `process.cwd()` is inside `C:\Windows`), rejecting relative paths, bare drives,
 * raw devices, incomplete UNC roots, and paths lexically inside any protected folder (including `\\?\`, `\\.\`,
 * and `\\?\UNC\` aliases). Always preserves `\\?\` / `\\?\UNC\` on paths >= 248 chars.
 */
export function resolveSafeWindowsKillCwdLexical(options: SafeWindowsWorkingDirectoryOptions = {}): string | undefined {
	const protectedDirs: ResolvedProtectedDir[] = [];
	const installLexical = (options.installDirs ?? []).flatMap((raw) => collectInstallProtectedDirs(raw));
	for (const raw of collectRawProtectedDirs([...(options.protectedDirs ?? []), ...installLexical])) {
		const lexical = normalizeWindowsPathForCompare(raw);
		if (lexical !== undefined) protectedDirs.push({ lexical, real: undefined });
	}
	const normalizedCommand =
		options.commandPath === undefined ? undefined : normalizeWindowsPathForCompare(options.commandPath);
	const commandDir = normalizedCommand === undefined ? undefined : win32.dirname(normalizedCommand);
	const commandRoot = windowsDriveRoot(normalizedCommand);
	const protectedRoots = protectedDirs.map((folder) => windowsDriveRoot(folder.lexical));
	const systemRootDrive = windowsDriveRoot(process.env.SystemRoot)?.toLowerCase();
	const nonCSystemDrive = systemRootDrive !== undefined && systemRootDrive !== "c:\\";
	// On non-C: Windows installs, prefer the existing drive root of process.cwd() / SystemRoot before hardcoded
	// C:\Windows (which may not exist). On standard C: installs (or unset SystemRoot), prefer C:\Windows ahead of an
	// unverified SystemRoot that could be a junction pointing into the project folder.
	const candidates = dedupeCandidates(
		nonCSystemDrive
			? [
					...protectedRoots,
					windowsDriveRoot(process.env.SystemRoot),
					commandRoot,
					"C:\\Windows",
					process.env.SystemRoot,
					process.env.windir,
					commandDir,
					"C:\\",
				]
			: [
					"C:\\Windows",
					...protectedRoots,
					commandDir,
					commandRoot,
					process.env.SystemRoot,
					process.env.windir,
					"C:\\",
				],
	);
	let longOutsideFallback: string | undefined;
	let shortFallback: string | undefined;
	let anyFallback: string | undefined;
	for (const rawCandidate of candidates) {
		const lexical = normalizeWindowsPathForCompare(rawCandidate);
		if (lexical === undefined) continue;
		const candidate: ResolvedCandidateDir = { lexical, real: undefined, unverifiedLink: false };
		const chosen = toSpawnWindowsPath(lexical);
		const isShort = isShortWindowsSpawnPath(chosen);
		const insideAny = protectedDirs.some((folder) => isInsideProtectedFolder(folder, candidate));
		if (!insideAny) {
			if (isShort) return chosen;
			longOutsideFallback ??= chosen;
			continue;
		}
		if (isShort) shortFallback ??= chosen;
		anyFallback ??= chosen;
	}
	return longOutsideFallback ?? shortFallback ?? anyFallback;
}
