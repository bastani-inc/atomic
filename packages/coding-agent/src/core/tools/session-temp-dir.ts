/**
 * Owner- and session-scoped temp storage for tool output files.
 *
 * Every file a tool spills to the system temp directory (bash overflow logs,
 * `OutputAccumulator` spill files, and the in-memory-session tool-result fallback)
 * lands under:
 *
 * ```text
 * <tmpdir>/<APP_NAME>-<owner>/<sanitized-session-id>/
 * ```
 *
 * The owner segment mirrors the upstream Claude Code `claude-{uid}` convention
 * (mehmoodosman/claude-code): a shared multi-user temp directory must never let
 * one account write into (or read) another account's tree. The session segment
 * makes the tree reapable as a unit by the age-based sweeper in
 * `session-temp-cleanup.ts` once the session is long gone.
 */

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, type Stats } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { APP_NAME, getAgentDir } from "../../config.js";
import { getErrnoCode } from "./errno.ts";
import {
	resetWindowsDirectorySecurityStateForTesting,
	verifyWindowsDirectorySecurity,
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

/** `<tmpdir>/<APP_NAME>-<owner>` — the root every session temp tree lives under. */
export function getTempRootDir(): string {
	const app = sanitizeTempPathComponent(APP_NAME, "atomic");
	return join(baseTempDirs().raw, `${app}-${ownerComponent()}`);
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
	return join(getTempRootDir(), sanitizeTempPathComponent(id, FALLBACK_SESSION_COMPONENT));
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
	constructor(path: string, reason: string) {
		super(`Refusing to use temp directory ${path}: ${reason}`);
		this.name = "TempDirRefusedError";
	}
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
 * reports uid/gid 0 on Windows — so the read goes through a PowerShell
 * `Get-Acl` subprocess. Successful verifications are cached per path per
 * process, keyed to the directory's metadata identity so a swapped directory
 * or an in-place DACL edit forces a fresh read. Domain-qualifying the
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
	const key = JSON.stringify([process.env.XDG_RUNTIME_DIR ?? "", getAgentDir(), tmpdir(), parts]);
	const known = privateTempDirs.get(key);
	if (known !== undefined && stillPrivate(known)) {
		return known.path;
	}
	privateTempDirs.delete(key);
	const path = choosePrivateTempDir(segments, parts);
	try {
		privateTempDirs.set(key, { path, birthtimeMs: lstatSync(path).birthtimeMs });
	} catch {
		// Not remembered; the next call checks it from scratch.
	}
	return path;
}

interface KnownPrivateTempDir {
	path: string;
	/** Creation time when it was verified: a directory recreated at the path carries a fresh one. */
	birthtimeMs: number;
}

/** Directories {@link ensurePrivateTempDir} already created or verified in this process. */
const privateTempDirs = new Map<string, KnownPrivateTempDir>();

/**
 * Re-check a directory verified earlier in this process without re-reading
 * its whole chain. It must still be the same real directory (not a symlink, not
 * recreated); on POSIX it must still be owned by this account with no group or
 * other access. On Windows the owner and DACL were verified when it was chosen,
 * and a directory this account owns cannot have its DACL changed by another
 * (non-administrator) account, so the costly PowerShell read is not repeated
 * every time a file is written below it.
 */
function stillPrivate(known: KnownPrivateTempDir): boolean {
	try {
		const stat = lstatSync(known.path);
		if (stat.isSymbolicLink() || !stat.isDirectory() || stat.birthtimeMs !== known.birthtimeMs) return false;
		if (process.platform === "win32") return true;
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		return (uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

function choosePrivateTempDir(segments: readonly string[], parts: readonly string[]): string {
	const attempts: Array<() => string> = [];
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (process.platform !== "win32" && runtimeDir && isAbsolute(runtimeDir)) {
		attempts.push(() => {
			if (!isUntouchablePrivateRoot(runtimeDir)) {
				throw new TempDirRefusedError(runtimeDir, "it is not private to this account");
			}
			const app = sanitizeTempPathComponent(APP_NAME, "atomic");
			return ensurePrivateChain(runtimeDir, runtimeDir, [app, ...parts]);
		});
	}
	attempts.push(() => {
		const cacheDir = join(getAgentDir(), "cache");
		mkdirSync(cacheDir, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
		return ensurePrivateChain(cacheDir, cacheDir, ["tmp", ...parts]);
	});
	attempts.push(() => {
		const base = baseTempDirs();
		const rootName = getTempRootDir().slice(base.raw.length + sep.length);
		return ensurePrivateChain(base.canonical, base.raw, [rootName, ...parts]);
	});
	for (const attempt of attempts) {
		try {
			return attempt();
		} catch {
			// Not trustworthy (or not creatable) for this account; try the next root.
		}
	}
	try {
		privateTempFallbackDir ??= mkdtempSync(join(tmpdir(), `${sanitizeTempPathComponent(APP_NAME, "atomic")}-`));
		// mkdtemp created it 0700 under an unpredictable name, so nobody else can
		// have placed anything inside it.
		const dir = join(privateTempFallbackDir, ...parts);
		mkdirSync(dir, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
		return dir;
	} catch {
		throw new TempDirRefusedError(
			join(tmpdir(), ...segments),
			"no directory private to this account could be created",
		);
	}
}

/**
 * Throw {@link TempDirRefusedError} unless `path` is a real directory owned by
 * this account with no group or other access. Nothing is created or changed.
 */
export function assertPrivateDirectory(path: string): void {
	verifyOwnedDirectory(path, undefined, true);
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
export function ensureTempDir(dir: string): string {
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
		ensureLeafDirectory(checkedDir);
	} else {
		// A caller-supplied directory outside the system temp base (a session
		// directory, for instance) is the caller's to own; only the leaf is ours.
		if (!(ensuredDirs.has(dir) && isRealDirectory(dir))) {
			mkdirSync(dirname(dir), { recursive: true, mode: SESSION_TEMP_DIR_MODE });
			ensureLeafDirectory(dir);
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
	release(): void;
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
	return resolveSessionTempDirPath(sessionId);
}

/** Directories this process must not reap: session temp trees and live tool-results. */
export function getProtectedSessionTempDirs(): ReadonlySet<string> {
	return new Set(protectedPathCounts.keys());
}

/** Test seam: forget the process-level active/protected session state. */
export function resetSessionTempDirStateForTesting(): void {
	activeSessionId = undefined;
	protectedPathCounts.clear();
	ensuredDirs.clear();
	cachedOwnerComponent = undefined;
	cachedBaseTempDirs = undefined;
	privateTempFallbackDir = undefined;
	privateTempDirs.clear();
	resetWindowsDirectorySecurityStateForTesting();
}
