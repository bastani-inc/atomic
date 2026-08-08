/**
 * Owner- and session-scoped temp storage for tool output files.
 *
 * Every file a tool spills to the system temp directory (bash overflow logs,
 * async bash logs, `OutputAccumulator` spill files, and the in-memory-session
 * tool-result fallback) lands under:
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
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import { APP_NAME } from "../../config.ts";
import { getErrnoCode } from "./errno.ts";

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
 * This prevents collision; it is not owner verification. POSIX separately
 * proves ownership through `verifyOwnedDirectory`, which has no portable
 * Windows equivalent here.
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
 * Windows has no uid or POSIX mode to check, so only the symlink and directory
 * checks apply there. That is a real gap, not an oversight: an existing root is
 * adopted without proving its owner SID or that its DACL is restrictive, so on a
 * host where the system temp directory has been redirected to a shared location,
 * a local attacker who can pre-create the (predictable) root can have this
 * account's persisted tool output written into a tree they control. Closing it
 * needs a real principal identity and an ACL read, neither of which Node exposes
 * — `lstatSync` reports uid/gid 0 on Windows — so it means a native binding or a
 * PowerShell `Get-Acl` per directory creation. Tracked in bastani-inc/atomic#2245
 * rather than bolted on here; the default Windows temp directory is per-user,
 * which is what keeps this narrow. Domain-qualifying the principal (see
 * `windowsPrincipal`) stops two accounts *colliding* by accident, which is a
 * different problem and is not a substitute for verification.
 */
function verifyOwnedDirectory(path: string, known?: Stats): void {
	let stat = known ?? lstatSync(path);
	if (stat.isSymbolicLink()) {
		throw new TempDirRefusedError(path, "it is a symbolic link");
	}
	if (!stat.isDirectory()) {
		throw new TempDirRefusedError(path, "it is not a directory");
	}
	if (process.platform === "win32") {
		return;
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (typeof uid === "number" && stat.uid !== uid) {
		throw new TempDirRefusedError(path, "it is owned by another account");
	}
	if ((stat.mode & 0o777) === SESSION_TEMP_DIR_MODE) {
		return;
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
function ensureOwnedDirectory(path: string): void {
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
		verifyOwnedDirectory(path);
		return;
	}
	verifyOwnedDirectory(path, stat);
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
 * more than one lifetime: a session protects its own tree, an async spill writer
 * outlives the session object it started under, and one session can be replaced
 * by another wrapping the same paths. Releasing one holder must not unprotect a
 * directory another is still writing to, and a session that is gone must stop
 * protecting a tree the startup sweep exists to collect.
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
}
