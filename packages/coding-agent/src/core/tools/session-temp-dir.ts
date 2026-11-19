/**
 * Owner- and session-scoped temp storage for tool output files.
 *
 * Bash overflow logs, output accumulator spills and in-memory tool-result files
 * live under the process's private run directory, in a directory per session.
 * SDK hosts that explicitly set TMPDIR keep the historical owner/session layout
 * and retention policy. Never adopt another account's tree in either layout.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	type BigIntStats,
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpath as realpathCallback,
	realpathSync,
	rmSync,
	type Stats,
} from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	APP_NAME,
	getAgentDir,
	getRuntimeScratchCache,
	getRuntimeScratchDir,
	useManagedSessionScratch,
} from "../../config.js";
import {
	getRuntimeScratchDirSync,
	plannedRuntimeScratchDir,
	preferredRuntimeScratchDir,
	removeRunSession,
} from "../../config-runtime-scratch.ts";
import { createModuleRequire } from "../../utils/module-require.js";
import { getErrnoCode } from "./errno.ts";
import {
	evaluateWindowsDirectorySecurity,
	resetWindowsDirectorySecurityStateForTesting,
	trackWindowsDirectorySecurityWork,
	VERIFICATION_PENDING_REASON,
	verifyWindowsDirectorySecurity,
	verifyWindowsDirectorySecurityAsync,
	type WindowsDirectorySecurity,
} from "./windows-directory-security.ts";

/** Directory mode for every directory this module creates (owner-only). */
export const SESSION_TEMP_DIR_MODE = 0o700;

/** File mode for persisted tool-output files (owner-only). */
export const SESSION_TEMP_FILE_MODE = 0o600;

/** Longest path component this module will emit for a sanitized value. */
const MAX_PATH_COMPONENT_LENGTH = 64;

const FALLBACK_SESSION_COMPONENT = "session";
const FALLBACK_OWNER_COMPONENT = "user";

/**
 * Reduce a value to a single safe path component.
 *
 * Disallowed characters collapse to `_`; leading `.`/`_` and trailing `.`/`_`
 * are stripped so the result can never be `.`, `..`, a hidden sweeper marker
 * file name, or anything that escapes the parent directory. Trimming uses a
 * linear scan rather than a `/^[._]+|[._]+$/` regex to avoid polynomial-time
 * backtracking on adversarial ids (CodeQL js/polynomial-redos).
 */
export function sanitizeTempPathComponent(value: string, fallback: string): string {
	const collapsed = value.replace(/[^a-zA-Z0-9._-]+/g, "_");
	let start = 0;
	let end = collapsed.length;
	while (start < end && (collapsed[start] === "_" || collapsed[start] === ".")) {
		start++;
	}
	while (end > start && (collapsed[end - 1] === "_" || collapsed[end - 1] === ".")) {
		end--;
	}
	const sanitized = collapsed.slice(start, end).slice(0, MAX_PATH_COMPONENT_LENGTH);
	return sanitized.length > 0 ? sanitized : fallback;
}

let cachedOwnerComponent: string | undefined;

/**
 * Derive the owner component for a named (non-uid) account.
 *
 * Sanitizing a name to a safe path component is lossy, and two distinct
 * accounts can reduce to the same component (`aliceé` and `aliceø` both yield
 * `alice_`). Where the system temp directory is machine-wide and
 * shared-accessible, that would put two accounts in one tree. Appending a short
 * digest of the raw identity keeps distinct accounts on distinct roots, with
 * the readable component in front so the directory stays recognizable.
 *
 * This prevents collision; it is not owner verification. Ownership is proven
 * separately by `verifyOwnedDirectory` — a uid check on POSIX, an owner-SID
 * and DACL check on Windows.
 *
 * Exported as a pure function so the collision property can be tested directly:
 * its only caller reaches this branch on Windows, which a POSIX test host
 * cannot enter.
 */
export function deriveOwnerComponent(rawIdentity: string): string {
	// Windows account names are case-insensitive, so `Alice` and `alice` are one
	// account and must resolve to one root. Normalize before both the readable
	// component and the digest: normalizing only the digest would still emit two
	// spellings of one directory, which NTFS then treats as the same path while
	// the sweeper's bookkeeping sees two.
	const normalized = rawIdentity.toLowerCase();
	const readable = sanitizeTempPathComponent(normalized, FALLBACK_OWNER_COMPONENT);
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
	return `${readable}-${digest}`;
}

/**
 * Assemble the account identity used where there is no uid.
 *
 * `userInfo().username` returns the bare account name, so `CONTOSO\Alice` and
 * `FABRIKAM\Alice` would otherwise be one identity and share a tree. Exported
 * for tests: its caller only reaches this branch on Windows.
 */
export function windowsPrincipal(name: string | undefined): string {
	const account = name || process.env.USERNAME || process.env.USER || "";
	// USERDOMAIN is the NetBIOS domain and is set for both domain and local
	// accounts; USERDNSDOMAIN appears only on domain-joined hosts and
	// distinguishes two forests that share a NetBIOS name. Neither is
	// authoritative on its own, so both take part in the identity.
	const domain = process.env.USERDNSDOMAIN || process.env.USERDOMAIN || "";
	return domain ? `${domain}\\${account}` : account;
}

/**
 * Identify the account that owns the temp tree.
 *
 * POSIX uses the numeric uid, which is already collision-free. Windows has no
 * `process.getuid`, so the domain-qualified principal stands in.
 */
function ownerComponent(): string {
	if (cachedOwnerComponent !== undefined) {
		return cachedOwnerComponent;
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (typeof uid === "number" && Number.isFinite(uid)) {
		cachedOwnerComponent = String(uid);
		return cachedOwnerComponent;
	}
	let name: string | undefined;
	try {
		name = userInfo().username;
	} catch {
		// A container without a passwd entry cannot name the account; the env
		// fallback inside windowsPrincipal still separates the common case.
		name = undefined;
	}
	cachedOwnerComponent = deriveOwnerComponent(windowsPrincipal(name));
	return cachedOwnerComponent;
}

interface BaseTempDirs {
	raw: string;
	canonical: string;
}

let cachedBaseTempDirs: BaseTempDirs | undefined;

/**
 * Preserve the OS-provided temp spelling for returned paths while caching a
 * canonical form for internal component checks (macOS `/var` → `/private/var`,
 * for example). Nothing below the base is resolved through `realpath`.
 */
function baseTempDirs(): BaseTempDirs {
	const raw = tmpdir();
	if (cachedBaseTempDirs?.raw === raw) {
		return cachedBaseTempDirs;
	}
	let canonical = raw;
	try {
		canonical = realpathSync(raw);
	} catch {
		// An unresolvable temp directory is checked as given.
	}
	cachedBaseTempDirs = { raw, canonical };
	return cachedBaseTempDirs;
}

/** Ordinary runs isolate session output from other processes; SDKs can select the historical TMPDIR layout. */
export function getTempRootDir(): string {
	return useManagedSessionScratch() ? join(plannedRuntimeScratchDir(), "sessions") : systemTempRootDir();
}

export function systemTempRootDir(): string {
	const app = sanitizeTempPathComponent(APP_NAME, "atomic");
	return join(tmpdir(), `${app}-${ownerComponent()}`);
}

/**
 * The temp directory path for a session, without creating it.
 *
 * Falls back to the process-scoped component when no session id is available,
 * so a tool running outside a transcript session still writes inside the
 * owner-scoped root instead of directly into the system temp directory.
 */
export function resolveSessionTempDirPath(sessionId?: string): string {
	const id = sessionId ?? activeSessionId ?? `pid-${process.pid}`;
	const component = sanitizeTempPathComponent(id, FALLBACK_SESSION_COMPONENT);
	const name = useManagedSessionScratch()
		? managedSessions.get(join(resolve(getAgentDir()), component))?.name
		: undefined;
	return join(getTempRootDir(), name ?? component);
}

const ensuredDirs = new Set<string>();

/** An existing real directory — not a symlink, not a file, not missing. */
function isRealDirectory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/** Raised when a temp directory cannot be created or trusted; callers degrade to no spill file. */
export class TempDirRefusedError extends Error {
	readonly path: string;
	readonly reason: string;

	constructor(path: string, reason: string) {
		super(`Refusing to use temp directory ${path}: ${reason}`);
		this.name = "TempDirRefusedError";
		this.path = path;
		this.reason = reason;
	}
}

function isVerificationPending(error: unknown): error is TempDirRefusedError {
	return error instanceof TempDirRefusedError && error.reason === VERIFICATION_PENDING_REASON;
}

/**
 * Confirm one existing component is a directory this account owns, at mode 0700.
 *
 * A looser mode is tightened and re-checked; a component owned by another
 * account, or one whose mode cannot be tightened, is refused rather than used.
 *
 * Windows has no uid or POSIX mode, so the proof comes from the security
 * descriptor instead: the owner SID must be a trusted principal and the DACL
 * must grant access to trusted principals only
 * (see `windows-directory-security.ts`). Node exposes neither — `lstatSync`
 * reports uid/gid 0 on Windows — so the native module reads the descriptor,
 * with an asynchronous PowerShell `Get-Acl` fallback. It runs once per private
 * root per process: a verified directory stays verified while it is the same
 * directory, and a directory inside a verified one needs no read of its own (see
 * `verifyWindowsDirectorySecurityAsync`). This synchronous check never reads:
 * it refuses a directory not verified yet, and the asynchronous entry points
 * await its verification and try again. Domain-qualifying the
 * principal (see `windowsPrincipal`) stops two accounts *colliding* by
 * accident, which is a different problem and is not a substitute for this
 * verification.
 */
function verifyOwnedDirectory(path: string, known?: Stats, strict = false): void {
	let stat = known ?? lstatSync(path);
	if (stat.isSymbolicLink()) {
		throw new TempDirRefusedError(path, "it is a symbolic link");
	}
	if (!stat.isDirectory()) {
		throw new TempDirRefusedError(path, "it is not a directory");
	}
	if (process.platform === "win32") {
		const refusal = verifyWindowsDirectorySecurity(path);
		if (refusal !== undefined) {
			throw new TempDirRefusedError(path, refusal);
		}
		return;
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (typeof uid === "number" && stat.uid !== uid) {
		throw new TempDirRefusedError(path, "it is owned by another account");
	}
	if ((stat.mode & 0o777) === SESSION_TEMP_DIR_MODE) {
		return;
	}
	if (strict && (stat.mode & 0o077) !== 0) {
		// Someone else could already have written into it; repairing the mode
		// would not undo that, so the directory is refused instead.
		throw new TempDirRefusedError(path, "it is accessible to other accounts");
	}
	try {
		chmodSync(path, SESSION_TEMP_DIR_MODE);
		stat = lstatSync(path);
	} catch {
		throw new TempDirRefusedError(path, "its permissions could not be tightened");
	}
	if ((stat.mode & 0o777) !== SESSION_TEMP_DIR_MODE) {
		throw new TempDirRefusedError(path, "its permissions could not be tightened");
	}
}

/**
 * Create or adopt one path component, never following a link to get there.
 *
 * Creation is non-recursive on purpose: `mkdir -p` resolves an existing symlink
 * on the way down, which is how a link planted at the predictable owner root
 * redirects every later write outside the tree.
 */
function ensureOwnedDirectory(path: string, strict = false): void {
	let stat: Stats | undefined;
	try {
		stat = lstatSync(path);
	} catch {
		stat = undefined;
	}
	if (stat === undefined) {
		try {
			mkdirSync(path, { recursive: false, mode: SESSION_TEMP_DIR_MODE });
		} catch (error) {
			// A concurrent creator winning the race is fine; anything else is not.
			if (getErrnoCode(error) !== "EEXIST") {
				throw new TempDirRefusedError(path, "it could not be created");
			}
		}
		verifyOwnedDirectory(path, undefined, strict);
		return;
	}
	verifyOwnedDirectory(path, stat, strict);
}

/** Split caller segments into plain path components, refusing `.`, `..` and empty ones. */
function privateSegmentParts(segments: readonly string[]): string[] {
	const parts = segments.flatMap((segment) => segment.split(/[\\/]/));
	for (const part of parts) {
		if (part.length === 0 || part === "." || part === "..") {
			throw new TempDirRefusedError(join(...segments), "it is not a plain relative path");
		}
	}
	return parts;
}

/**
 * True when `path` is a real directory this account owns that no other account
 * can enter. Read-only: used for roots this module did not create, such as
 * `$XDG_RUNTIME_DIR`, which must never be changed.
 */
function isUntouchablePrivateRoot(path: string): boolean {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		return (uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

/** Create or adopt each of `parts` below `checkedBase`, strictly; returns the path below `returnedBase`. */
function ensurePrivateChain(checkedBase: string, returnedBase: string, parts: readonly string[]): string {
	let current = checkedBase;
	for (const part of parts) {
		current = join(current, part);
		ensureOwnedDirectory(current, true);
	}
	return join(returnedBase, ...parts);
}

let privateTempFallbackDir: string | undefined;
const fallbackDirectoryIdentities = new Map<string, PrivateDirectoryIdentity>();

/**
 * Create or adopt a directory for state that must stay private to this account
 * (temporary extension installs, the GitHub clone cache, subagent artifacts),
 * and return its path. Use the returned path: which root it is under depends on
 * what this account can trust.
 *
 * Roots are tried in order, preferring ones other accounts cannot create first:
 *
 * 1. `$XDG_RUNTIME_DIR/<APP_NAME>` (POSIX), when the runtime directory is itself
 *    a real directory owned by this account with no group or other access;
 * 2. `<agentDir>/cache/tmp`, inside this account's own Atomic directory;
 * 3. `<tmpdir>/<APP_NAME>-<owner>`, the predictable per-user temp root;
 * 4. a fresh owner-only `mkdtemp` directory, reused for the rest of the process.
 *
 * Below each root every component is created non-recursively with mode 0700,
 * or — when it already exists — must be a real directory (not a symlink) owned
 * by this account with no group or other access. Nothing found is repaired,
 * replaced or followed: a path that fails the check is refused and the next
 * root is tried, so a directory someone else planted is neither used nor able
 * to block the caller. On Windows (no uid or POSIX mode) each component's owner
 * SID and DACL are verified instead, and the runtime-directory root is skipped.
 *
 * Throws {@link TempDirRefusedError} only when the segments are not a plain
 * relative path or not even a fresh temp directory can be created.
 */
export function ensurePrivateTempDir(...segments: string[]): string {
	const parts = privateSegmentParts(segments);
	const key = privateTempDirKey(parts);
	const known = rememberedPrivateTempDir(key);
	if (known !== undefined) {
		return known;
	}
	let pending = false;
	for (const attempt of privateTempDirAttempts(parts)) {
		try {
			return rememberPrivateTempDir(key, attempt(), parts.length);
		} catch (error) {
			// Not trustworthy (or not creatable) for this account; try the next root.
			pending ||= isVerificationPending(error);
		}
	}
	const fallback = privateTempFallback(segments, parts);
	return pending ? fallback : rememberPrivateTempDir(key, fallback, parts.length);
}

export async function ensurePrivateTempDirAsync(...segments: string[]): Promise<string> {
	const parts = privateSegmentParts(segments);
	const key = privateTempDirKey(parts);
	const attempts = privateTempDirAttemptsAsync(parts);
	const known = await rememberedPrivateTempDirAsync(key);
	if (known !== undefined) return known;
	for (const attempt of attempts) {
		try {
			return await rememberPrivateTempDirAsync(key, await attempt(), parts.length);
		} catch {}
	}
	const fallback = privateTempFallbackTail.then(() => privateTempFallbackAsync(segments, parts));
	privateTempFallbackTail = fallback.then(
		() => {},
		() => {},
	);
	return rememberPrivateTempDirAsync(key, await fallback, parts.length);
}

let privateTempFallbackTail: Promise<void> = Promise.resolve();

function privateTempDirKey(parts: readonly string[]): string {
	return JSON.stringify([process.env.XDG_RUNTIME_DIR ?? "", resolve(getAgentDir()), resolve(tmpdir()), parts]);
}

function rememberedPrivateTempDir(key: string): string | undefined {
	const known = privateTempDirs.get(key);
	if (known !== undefined && stillPrivate(known)) {
		return known.path;
	}
	privateTempDirs.delete(key);
	return undefined;
}

function rememberPrivateTempDir(key: string, path: string, depth: number): string {
	try {
		const directories: PrivateDirectoryIdentity[] = [];
		let current = path;
		for (let component = 0; component <= depth; component++) {
			directories.push(privateDirectoryIdentity(current));
			current = dirname(current);
		}
		const runtimeDir = process.env.XDG_RUNTIME_DIR;
		if (process.platform !== "win32" && runtimeDir && current === resolve(runtimeDir)) {
			directories.push(privateDirectoryIdentity(current));
		}
		privateTempDirs.set(key, { path, directories: directories.reverse() });
	} catch {
		// Not remembered; the next call checks it from scratch.
	}
	return path;
}

interface PrivateDirectoryIdentity {
	path: string;
	dev: bigint;
	ino: bigint;
	birthtimeNs: bigint;
}

function privateDirectoryIdentity(path: string): PrivateDirectoryIdentity {
	const stat = lstatSync(path, { bigint: true });
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new TempDirRefusedError(path, "it is not a real directory");
	}
	return { path, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

interface KnownPrivateTempDir {
	path: string;
	directories: readonly PrivateDirectoryIdentity[];
}

/** Directories {@link ensurePrivateTempDir} already created or verified in this process. */
const privateTempDirs = new Map<string, KnownPrivateTempDir>();

/**
 * Re-check the private chain without re-reading its Windows security descriptors.
 * Every component must still be the same real directory (not a symlink, not
 * recreated); on POSIX it must still be owned by this account with no group or
 * other access. On Windows the owner and DACL were verified when it was chosen,
 * and a directory this account owns cannot have its DACL changed by another
 * (non-administrator) account, so the descriptor read is not repeated
 * every time a file is written below it.
 */
function stillPrivate(known: KnownPrivateTempDir): boolean {
	return known.directories.every(stillPrivateDirectory);
}

function stillPrivateDirectory(known: PrivateDirectoryIdentity): boolean {
	try {
		const stat = lstatSync(known.path, { bigint: true });
		if (
			stat.isSymbolicLink() ||
			!stat.isDirectory() ||
			stat.dev !== known.dev ||
			stat.ino !== known.ino ||
			stat.birthtimeNs !== known.birthtimeNs
		) {
			return false;
		}
		if (process.platform === "win32") return true;
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		return (uid === undefined || stat.uid === BigInt(uid)) && (stat.mode & 0o077n) === 0n;
	} catch {
		return false;
	}
}

/** A cache may be readable by others, but no other account may replace the private root below it. */
function checkScratchCache(cache: string, stat: Stats): void {
	if (
		!stat.isDirectory() ||
		(process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))
	) {
		throw new TempDirRefusedError(cache, "it is not a trusted cache directory");
	}
}

/** Only synchronous bootstrap/stream callers use the native synchronous descriptor API. */
export function ensureAgentScratchParent(cache: string): string {
	mkdirSync(cache, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
	checkScratchCache(cache, lstatSync(cache));
	if (process.platform !== "win32") return ensurePrivateChain(cache, cache, ["tmp", "runs"]);
	const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
		windowsDirectorySecurity(path: string): WindowsDirectorySecurity | null;
	};
	let dir = cache;
	for (const part of ["", "tmp", "runs"]) {
		if (part) {
			dir = join(dir, part);
			try {
				mkdirSync(dir);
			} catch (error) {
				if (getErrnoCode(error) !== "EEXIST") throw error;
			}
		}
		if (!lstatSync(dir).isDirectory()) throw new TempDirRefusedError(dir, "it is not a directory");
		const descriptor = binding.windowsDirectorySecurity(dir);
		if (!descriptor || evaluateWindowsDirectorySecurity(descriptor) !== undefined)
			throw new TempDirRefusedError(dir, "its ownership could not be verified");
	}
	return dir;
}

export async function ensureAgentScratchParentAsync(cache: string): Promise<string> {
	await mkdir(cache, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
	checkScratchCache(cache, await lstat(cache));
	if (process.platform === "win32") await verifyWindowsOwnedDirectoryAsync(cache);
	return ensurePrivateChainAsync(cache, cache, ["tmp", "runs"]);
}

function otherWindowsScratchCache(): string | undefined {
	const local = process.env.LOCALAPPDATA;
	if (process.platform !== "win32" || !local || !isAbsolute(local)) return undefined;
	const short = resolve(local, "Atomic", "cache");
	return getRuntimeScratchCache() === short ? resolve(getAgentDir(), "cache") : short;
}

/** Predictable owner roots only; housekeeping never needs to scan a dense shared temporary directory. */
export function fallbackRunParents(): string[] {
	const runtime = process.env.XDG_RUNTIME_DIR;
	const windows = otherWindowsScratchCache();
	return [
		...(windows ? [join(windows, "tmp", "runs")] : []),
		resolve(systemTempRootDir(), "runs"),
		...(process.platform !== "win32" && runtime && isAbsolute(runtime)
			? [join(runtime, sanitizeTempPathComponent(APP_NAME, "atomic"), "runs")]
			: []),
	];
}

/** Try each private fallback through the actual allocation: a pre-existing parent may still be on a full disk. */
export function createFallbackRun(prefix: string): string {
	const windows = otherWindowsScratchCache();
	const attempts = privateTempDirAttempts(["runs"], false);
	if (windows) attempts.unshift(() => ensureAgentScratchParent(windows));
	for (const attempt of attempts) {
		try {
			return mkdtempSync(join(resolve(attempt()), prefix));
		} catch {
			/* Try the next filesystem. */
		}
	}
	return mkdtempSync(join(resolve(tmpdir()), `atomic-${prefix}`));
}

export async function createFallbackRunAsync<T>(prefix: string, use: (dir: string) => Promise<T>): Promise<T> {
	const useNew = async (template: string) => {
		const dir = await mkdtemp(template);
		try {
			return await use(dir);
		} catch (error) {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
	};
	const windows = otherWindowsScratchCache();
	const attempts = privateTempDirAttemptsAsync(["runs"], false);
	if (windows) attempts.unshift(() => ensureAgentScratchParentAsync(windows));
	for (const attempt of attempts) {
		try {
			return await useNew(join(resolve(await attempt()), prefix));
		} catch {
			/* Try the next filesystem. */
		}
	}
	return useNew(join(resolve(tmpdir()), `atomic-${prefix}`));
}

function privateTempDirAttempts(parts: readonly string[], includeCache = true): Array<() => string> {
	const attempts: Array<() => string> = [];
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (process.platform !== "win32" && runtimeDir && isAbsolute(runtimeDir)) {
		const root = resolve(runtimeDir);
		attempts.push(() => {
			if (!isUntouchablePrivateRoot(root)) {
				throw new TempDirRefusedError(root, "it is not private to this account");
			}
			const app = sanitizeTempPathComponent(APP_NAME, "atomic");
			return ensurePrivateChain(root, root, [app, ...parts]);
		});
	}
	const cacheDir = resolve(getAgentDir(), "cache");
	if (includeCache)
		attempts.push(() => {
			mkdirSync(cacheDir, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
			return ensurePrivateChain(cacheDir, cacheDir, ["tmp", ...parts]);
		});
	attempts.push(() => {
		const base = baseTempDirs();
		const rootName = systemTempRootDir().slice(base.raw.length + sep.length);
		return ensurePrivateChain(base.canonical, base.raw, [rootName, ...parts]);
	});
	return attempts;
}

function privateTempFallback(segments: readonly string[], parts: readonly string[]): string {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			if (privateTempFallbackDir === undefined) {
				privateTempFallbackDir = mkdtempSync(join(tmpdir(), `${sanitizeTempPathComponent(APP_NAME, "atomic")}-`));
				fallbackDirectoryIdentities.clear();
				fallbackDirectoryIdentities.set(privateTempFallbackDir, privateDirectoryIdentity(privateTempFallbackDir));
			} else {
				const rootIdentity = fallbackDirectoryIdentities.get(privateTempFallbackDir);
				if (rootIdentity === undefined || !stillPrivateDirectory(rootIdentity)) {
					throw new TempDirRefusedError(privateTempFallbackDir, "it changed after creation");
				}
			}
			let current = privateTempFallbackDir;
			for (const part of parts) {
				current = join(current, part);
				const known = fallbackDirectoryIdentities.get(current);
				if (known !== undefined) {
					if (!stillPrivateDirectory(known)) throw new TempDirRefusedError(current, "it changed after creation");
				} else {
					mkdirSync(current, { mode: SESSION_TEMP_DIR_MODE });
					fallbackDirectoryIdentities.set(current, privateDirectoryIdentity(current));
				}
			}
			return current;
		} catch {
			privateTempFallbackDir = undefined;
			fallbackDirectoryIdentities.clear();
		}
	}
	throw new TempDirRefusedError(join(tmpdir(), ...segments), "no directory private to this account could be created");
}

/**
 * Throw {@link TempDirRefusedError} unless `path` is a real directory owned by
 * this account with no group or other access. Nothing is created or changed.
 */
export function assertPrivateDirectory(path: string): void {
	verifyOwnedDirectory(path, undefined, true);
}

export function assertPrivateDirectoryAsync(path: string): Promise<void> {
	return verifyOwnedDirectoryAsync(resolve(path), undefined, true);
}

/**
 * Adopt the final component, replacing something that is not a directory.
 *
 * Only the leaf gets this treatment: a stale file or link left where a session
 * directory belongs is ours to clear, and removing a symlink removes the link
 * alone. A parent — above all the owner root — is refused instead, because
 * deleting it would be acting on a directory this process does not own.
 */
function ensureLeafDirectory(dir: string): void {
	try {
		if (!lstatSync(dir).isDirectory()) {
			rmSync(dir, { force: true });
		}
	} catch {
		// Nothing at the path yet, or it cannot be inspected; creation decides.
	}
	ensureOwnedDirectory(dir);
}

/** Map a lexical temp child to the same path below the canonical temp base. */
function canonicalTempChild(dir: string, base: BaseTempDirs): string | undefined {
	for (const candidate of [base.raw, base.canonical]) {
		const prefix = `${candidate}${sep}`;
		if (dir.startsWith(prefix)) {
			return join(base.canonical, dir.slice(prefix.length));
		}
	}
	return undefined;
}
/**
 * Create `dir` with owner-only permissions, validating every component below the
 * system temp directory.
 *
 * Temp children always revalidate the canonical owner root and every later
 * component, even after a cache hit. A system temp reaper can delete a session
 * tree, and an attacker must not turn a memoized path into a symlink bypass.
 * Caller-owned paths outside the temp base may use the memo after confirming
 * the leaf is still a real directory.
 *
 * Throws {@link TempDirRefusedError} when a component cannot be trusted. Every
 * caller treats that as "no spill file", never as a fatal error: failing closed
 * loses a convenience artifact, while failing open writes tool output into a
 * directory someone else controls.
 */
export function ensureTempDir(dir: string, options: { preserveExistingLeaf?: boolean } = {}): string {
	const parts = managedSessionParts(resolve(dir));
	if (parts) {
		const run = getRuntimeScratchDirSync();
		return ensurePrivateChain(run, run, parts);
	}
	const base = baseTempDirs();
	const checkedDir = canonicalTempChild(dir, base);
	if (checkedDir !== undefined) {
		const prefix = `${base.canonical}${sep}`;
		const parts = checkedDir
			.slice(prefix.length)
			.split(sep)
			.filter((part) => part.length > 0);
		let current = base.canonical;
		for (const part of parts.slice(0, -1)) {
			current = join(current, part);
			ensureOwnedDirectory(current);
		}
		if (options.preserveExistingLeaf) {
			ensureOwnedDirectory(checkedDir);
		} else {
			ensureLeafDirectory(checkedDir);
		}
	} else {
		// A caller-supplied directory outside the system temp base (a session
		// directory, for instance) is the caller's to own; only the leaf is ours.
		if (!(ensuredDirs.has(dir) && isRealDirectory(dir))) {
			mkdirSync(dirname(dir), { recursive: true, mode: SESSION_TEMP_DIR_MODE });
			if (options.preserveExistingLeaf) {
				ensureOwnedDirectory(dir);
			} else {
				ensureLeafDirectory(dir);
			}
		}
	}
	ensuredDirs.add(dir);
	return dir;
}

/**
 * Resolve and create the temp directory for a session.
 *
 * Pass an already-resolved directory to reuse a caller-provided path (still
 * created lazily with the same mode).
 */
export function getSessionTempDir(sessionId?: string): string {
	return ensureTempDir(resolveSessionTempDirPath(sessionId));
}

/** Create `explicitDir` when supplied, otherwise the active session's temp directory. */
export function ensureSessionTempDir(explicitDir?: string): string {
	return ensureTempDir(explicitDir ?? resolveSessionTempDirPath());
}

async function verifyWindowsOwnedDirectoryAsync(path: string, options: { background?: boolean } = {}): Promise<void> {
	const before = await lstat(path, { bigint: true });
	assertRealDirectory(path, before);
	const refusal = await verifyWindowsDirectorySecurityAsync(path, undefined, options);
	if (refusal !== undefined) throw new TempDirRefusedError(path, refusal);
	const after = await lstat(path, { bigint: true });
	assertRealDirectory(path, after);
	if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs)
		throw new TempDirRefusedError(path, "its ownership could not be verified");
}

function assertRealDirectory(path: string, stat: Stats | BigIntStats): void {
	if (stat.isSymbolicLink()) throw new TempDirRefusedError(path, "it is a symbolic link");
	if (!stat.isDirectory()) throw new TempDirRefusedError(path, "it is not a directory");
}

async function ensureWindowsOwnedDirectoryAsync(path: string, options: { background?: boolean } = {}): Promise<void> {
	try {
		await lstat(path);
	} catch {
		try {
			await mkdir(path, { mode: SESSION_TEMP_DIR_MODE });
		} catch (error) {
			if (getErrnoCode(error) !== "EEXIST") throw new TempDirRefusedError(path, "it could not be created");
		}
	}
	await verifyWindowsOwnedDirectoryAsync(path, options);
}

function managedSessionParts(dir: string): string[] | undefined {
	if (!useManagedSessionScratch()) return undefined;
	// A caller may have obtained the preferred path before another operation selected a fallback.
	for (const root of [getTempRootDir(), join(preferredRuntimeScratchDir(), "sessions")]) {
		if (dir === root) return ["sessions"];
		if (dir.startsWith(`${root}${sep}`)) return ["sessions", ...dir.slice(root.length + 1).split(sep)];
	}
	return undefined;
}

export async function ensureTempDirAsync(
	dir: string,
	options: { preserveExistingLeaf?: boolean } = {},
): Promise<string> {
	const resolvedDir = resolve(dir);
	const parts = managedSessionParts(resolvedDir);
	if (parts) {
		const run = await getRuntimeScratchDir();
		return ensurePrivateChainAsync(run, run, parts);
	}
	const base = await baseTempDirsAsync();
	const checkedDir = canonicalTempChild(resolvedDir, base);
	if (checkedDir !== undefined) {
		const prefix = `${base.canonical}${sep}`;
		const parts = checkedDir
			.slice(prefix.length)
			.split(sep)
			.filter((part) => part.length > 0);
		let current = base.canonical;
		for (const part of parts.slice(0, -1)) {
			current = join(current, part);
			await ensureOwnedDirectoryAsync(current);
		}
		if (options.preserveExistingLeaf) await ensureOwnedDirectoryAsync(checkedDir);
		else await ensureLeafDirectoryAsync(checkedDir);
	} else if (!(ensuredDirs.has(resolvedDir) && (await isRealDirectoryAsync(resolvedDir)))) {
		await mkdir(dirname(resolvedDir), { recursive: true, mode: SESSION_TEMP_DIR_MODE });
		if (options.preserveExistingLeaf) await ensureOwnedDirectoryAsync(resolvedDir);
		else await ensureLeafDirectoryAsync(resolvedDir);
	}
	ensuredDirs.add(resolvedDir);
	return resolvedDir;
}

export function getSessionTempDirAsync(sessionId?: string): Promise<string> {
	return ensureTempDirAsync(resolveSessionTempDirPath(sessionId));
}

export function ensureSessionTempDirAsync(explicitDir?: string): Promise<string> {
	return ensureTempDirAsync(explicitDir ?? resolveSessionTempDirPath());
}

let activeSessionId: string | undefined;

/**
 * Refcounted protection for directories the sweeper must not reap.
 *
 * A count rather than a set, because protection has more than one holder and
 * more than one lifetime: a session protects its own tree, and one session can
 * be replaced by another wrapping the same paths. Releasing one holder must not
 * unprotect a directory another is still using, and a session that is gone must
 * stop protecting a tree the startup sweep exists to collect.
 */
const protectedPathCounts = new Map<string, number>();

/** A protection claim held by one owner; releasing twice is a no-op. */
export interface ProtectedPathLease {
	release(): void | Promise<void>;
}

const managedSessions = new Map<string, { name: string; refs: number }>();

/** Retire the last holder's generation before awaiting I/O: a reopened session cannot reuse the tree being removed. */
export function claimSessionStorage(id: string, persistentPaths: readonly string[]): ProtectedPathLease {
	if (!useManagedSessionScratch()) return acquireProtectedPaths([setActiveSessionTempId(id), ...persistentPaths]);
	const component = sanitizeTempPathComponent(id, FALLBACK_SESSION_COMPONENT);
	const agent = resolve(getAgentDir());
	const key = join(agent, component);
	const current = managedSessions.get(key) ?? { name: `${component}-${randomBytes(4).toString("hex")}`, refs: 0 };
	managedSessions.set(key, current);
	current.refs++;
	const protectedLease = acquireProtectedPaths([setActiveSessionTempId(id), ...persistentPaths]);
	let released = false;
	return {
		async release() {
			if (released) return;
			released = true;
			protectedLease.release();
			if (--current.refs !== 0) return;
			managedSessions.delete(key);
			await removeRunSession(getRuntimeScratchCache(agent), current.name);
		},
	};
}

/** Protect `paths` until the returned lease is released. */
export function acquireProtectedPaths(paths: readonly string[]): ProtectedPathLease {
	const claimed = paths.filter((path) => path.length > 0);
	for (const path of claimed) {
		protectedPathCounts.set(path, (protectedPathCounts.get(path) ?? 0) + 1);
	}
	let released = false;
	return {
		release() {
			if (released) {
				return;
			}
			released = true;
			for (const path of claimed) {
				const remaining = (protectedPathCounts.get(path) ?? 0) - 1;
				if (remaining > 0) {
					protectedPathCounts.set(path, remaining);
				} else {
					protectedPathCounts.delete(path);
				}
			}
		},
	};
}

/**
 * Make `sessionId` the default target for writers without a session handle.
 *
 * Deliberately separate from protection: a disposed session must stop protecting
 * its tree, but whichever session ran last still names where an unattached
 * writer spills.
 */
export function setActiveSessionTempId(sessionId: string): string {
	activeSessionId = sessionId;
	if (process.platform === "win32") {
		void startPrivateRootVerification();
	}
	return resolveSessionTempDirPath(sessionId);
}

function startPrivateRootVerification(): void {
	void trackWindowsDirectorySecurityWork(async () => {
		try {
			if (useManagedSessionScratch()) {
				const run = await getRuntimeScratchDir();
				await ensurePrivateChainAsync(run, run, ["sessions"]);
				return;
			}
			const ownerRoot = canonicalTempChild(systemTempRootDir(), await baseTempDirsAsync());
			if (ownerRoot !== undefined) await ensureWindowsOwnedDirectoryAsync(ownerRoot, { background: true });
		} catch {}
	}).catch(() => undefined);
	void trackWindowsDirectorySecurityWork(async () => {
		try {
			await verifyWindowsOwnedDirectoryAsync(join(getAgentDir(), "cache", "tmp"), { background: true });
		} catch {}
	}).catch(() => undefined);
}

export function isProtectedSessionTempDir(path: string): boolean {
	return protectedPathCounts.has(path);
}

/** Directories this process must not reap: session temp trees and live tool-results. */
export function getProtectedSessionTempDirs(): ReadonlySet<string> {
	return new Set(protectedPathCounts.keys());
}

/** Test seam: forget the process-level active/protected session state. */
export function resetSessionTempDirStateForTesting(): void {
	activeSessionId = undefined;
	protectedPathCounts.clear();
	managedSessions.clear();
	ensuredDirs.clear();
	cachedOwnerComponent = undefined;
	cachedBaseTempDirs = undefined;
	privateTempFallbackDir = undefined;
	fallbackDirectoryIdentities.clear();
	privateTempDirs.clear();
	resetWindowsDirectorySecurityStateForTesting();
}

const realpathAsync = promisify(realpathCallback);

async function baseTempDirsAsync(): Promise<BaseTempDirs> {
	const raw = tmpdir();
	if (cachedBaseTempDirs?.raw === raw) {
		return cachedBaseTempDirs;
	}
	let canonical = raw;
	try {
		canonical = await realpathAsync(raw);
	} catch {}
	cachedBaseTempDirs = { raw, canonical };
	return cachedBaseTempDirs;
}

async function isRealDirectoryAsync(path: string): Promise<boolean> {
	try {
		const stat = await lstat(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

async function verifyOwnedDirectoryAsync(path: string, known?: Stats, strict = false): Promise<void> {
	let stat = known ?? (await lstat(path));
	if (stat.isSymbolicLink()) {
		throw new TempDirRefusedError(path, "it is a symbolic link");
	}
	if (!stat.isDirectory()) {
		throw new TempDirRefusedError(path, "it is not a directory");
	}
	if (process.platform === "win32") {
		await verifyWindowsOwnedDirectoryAsync(path);
		return;
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (typeof uid === "number" && stat.uid !== uid) {
		throw new TempDirRefusedError(path, "it is owned by another account");
	}
	if ((stat.mode & 0o777) === SESSION_TEMP_DIR_MODE) {
		return;
	}
	if (strict && (stat.mode & 0o077) !== 0) {
		throw new TempDirRefusedError(path, "it is accessible to other accounts");
	}
	try {
		await chmod(path, SESSION_TEMP_DIR_MODE);
		stat = await lstat(path);
	} catch {
		throw new TempDirRefusedError(path, "its permissions could not be tightened");
	}
	if ((stat.mode & 0o777) !== SESSION_TEMP_DIR_MODE) {
		throw new TempDirRefusedError(path, "its permissions could not be tightened");
	}
}

async function ensureOwnedDirectoryAsync(path: string, strict = false): Promise<void> {
	let stat: Stats | undefined;
	try {
		stat = await lstat(path);
	} catch {
		stat = undefined;
	}
	if (stat === undefined) {
		try {
			await mkdir(path, { recursive: false, mode: SESSION_TEMP_DIR_MODE });
		} catch (error) {
			if (getErrnoCode(error) !== "EEXIST") {
				throw new TempDirRefusedError(path, "it could not be created");
			}
		}
		await verifyOwnedDirectoryAsync(path, undefined, strict);
		return;
	}
	await verifyOwnedDirectoryAsync(path, stat, strict);
}

async function isUntouchablePrivateRootAsync(path: string): Promise<boolean> {
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		return (uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

async function ensurePrivateChainAsync(
	checkedBase: string,
	returnedBase: string,
	parts: readonly string[],
): Promise<string> {
	let current = checkedBase;
	for (const part of parts) {
		current = join(current, part);
		await ensureOwnedDirectoryAsync(current, true);
	}
	return join(returnedBase, ...parts);
}

async function rememberedPrivateTempDirAsync(key: string): Promise<string | undefined> {
	const known = privateTempDirs.get(key);
	if (known !== undefined && (await stillPrivateAsync(known))) {
		return known.path;
	}
	privateTempDirs.delete(key);
	return undefined;
}

async function rememberPrivateTempDirAsync(key: string, path: string, depth: number): Promise<string> {
	try {
		const directories: PrivateDirectoryIdentity[] = [];
		let current = path;
		for (let component = 0; component <= depth; component++) {
			directories.push(await privateDirectoryIdentityAsync(current));
			current = dirname(current);
		}
		const runtimeDir = process.env.XDG_RUNTIME_DIR;
		if (process.platform !== "win32" && runtimeDir && current === resolve(runtimeDir)) {
			directories.push(await privateDirectoryIdentityAsync(current));
		}
		privateTempDirs.set(key, { path, directories: directories.reverse() });
	} catch {}
	return path;
}

async function privateDirectoryIdentityAsync(path: string): Promise<PrivateDirectoryIdentity> {
	const stat = await lstat(path, { bigint: true });
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new TempDirRefusedError(path, "it is not a real directory");
	}
	return { path, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

async function stillPrivateAsync(known: KnownPrivateTempDir): Promise<boolean> {
	for (const directory of known.directories) {
		if (!(await stillPrivateDirectoryAsync(directory))) return false;
	}
	return true;
}

async function stillPrivateDirectoryAsync(known: PrivateDirectoryIdentity): Promise<boolean> {
	try {
		const stat = await lstat(known.path, { bigint: true });
		if (
			stat.isSymbolicLink() ||
			!stat.isDirectory() ||
			stat.dev !== known.dev ||
			stat.ino !== known.ino ||
			stat.birthtimeNs !== known.birthtimeNs
		) {
			return false;
		}
		if (process.platform === "win32") return true;
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		return (uid === undefined || stat.uid === BigInt(uid)) && (stat.mode & 0o077n) === 0n;
	} catch {
		return false;
	}
}

function privateTempDirAttemptsAsync(parts: readonly string[], includeCache = true): Array<() => Promise<string>> {
	const attempts: Array<() => Promise<string>> = [];
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (process.platform !== "win32" && runtimeDir && isAbsolute(runtimeDir)) {
		const root = resolve(runtimeDir);
		attempts.push(async () => {
			if (!(await isUntouchablePrivateRootAsync(root))) {
				throw new TempDirRefusedError(root, "it is not private to this account");
			}
			const app = sanitizeTempPathComponent(APP_NAME, "atomic");
			return await ensurePrivateChainAsync(root, root, [app, ...parts]);
		});
	}
	const cacheDir = resolve(getAgentDir(), "cache");
	if (includeCache)
		attempts.push(async () => {
			await mkdir(cacheDir, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
			return await ensurePrivateChainAsync(cacheDir, cacheDir, ["tmp", ...parts]);
		});
	attempts.push(async () => {
		const base = await baseTempDirsAsync();
		const rootName = systemTempRootDir().slice(base.raw.length + sep.length);
		return await ensurePrivateChainAsync(base.canonical, base.raw, [rootName, ...parts]);
	});
	return attempts;
}

async function privateTempFallbackAsync(segments: readonly string[], parts: readonly string[]): Promise<string> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			if (privateTempFallbackDir === undefined) {
				privateTempFallbackDir = await mkdtemp(join(tmpdir(), `${sanitizeTempPathComponent(APP_NAME, "atomic")}-`));
				fallbackDirectoryIdentities.clear();
				fallbackDirectoryIdentities.set(
					privateTempFallbackDir,
					await privateDirectoryIdentityAsync(privateTempFallbackDir),
				);
			} else {
				const rootIdentity = fallbackDirectoryIdentities.get(privateTempFallbackDir);
				if (rootIdentity === undefined || !(await stillPrivateDirectoryAsync(rootIdentity))) {
					throw new TempDirRefusedError(privateTempFallbackDir, "it changed after creation");
				}
			}
			let current = privateTempFallbackDir;
			for (const part of parts) {
				current = join(current, part);
				const known = fallbackDirectoryIdentities.get(current);
				if (known !== undefined) {
					if (!(await stillPrivateDirectoryAsync(known)))
						throw new TempDirRefusedError(current, "it changed after creation");
				} else {
					await mkdir(current, { mode: SESSION_TEMP_DIR_MODE });
					fallbackDirectoryIdentities.set(current, await privateDirectoryIdentityAsync(current));
				}
			}
			return current;
		} catch {
			privateTempFallbackDir = undefined;
			fallbackDirectoryIdentities.clear();
		}
	}
	throw new TempDirRefusedError(join(tmpdir(), ...segments), "no directory private to this account could be created");
}

async function ensureLeafDirectoryAsync(dir: string): Promise<void> {
	try {
		if (!(await lstat(dir)).isDirectory()) {
			await rm(dir, { force: true });
		}
	} catch {}
	await ensureOwnedDirectoryAsync(dir);
}
