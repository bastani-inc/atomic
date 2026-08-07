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

import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import { APP_NAME } from "../../config.ts";

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
 * Identify the account that owns the temp tree.
 *
 * POSIX uses the numeric uid. Windows has no `process.getuid`, so fall back to
 * the account name — the value only has to separate accounts that share one
 * machine-wide temp directory, not to be numeric.
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
		// fallback below still separates the common Windows case.
		name = undefined;
	}
	cachedOwnerComponent = sanitizeTempPathComponent(
		name || process.env.USERNAME || process.env.USER || "",
		FALLBACK_OWNER_COMPONENT,
	);
	return cachedOwnerComponent;
}

let cachedBaseTempDir: { raw: string; resolved: string } | undefined;

/**
 * The system temp directory, canonicalized.
 *
 * Only the OS-provided base is resolved through symlinks (macOS `/var` →
 * `/private/var`, for example). Nothing below it is ever resolved: following a
 * link planted at the owner root is exactly the attack this guards against.
 */
function baseTempDir(): string {
	const raw = tmpdir();
	if (cachedBaseTempDir?.raw === raw) {
		return cachedBaseTempDir.resolved;
	}
	let resolved = raw;
	try {
		resolved = realpathSync(raw);
	} catch {
		// An unresolvable temp directory is used as given; the per-component
		// checks below still apply.
		resolved = raw;
	}
	cachedBaseTempDir = { raw, resolved };
	return resolved;
}

/** `<tmpdir>/<APP_NAME>-<owner>` — the root every session temp tree lives under. */
export function getTempRootDir(): string {
	const app = sanitizeTempPathComponent(APP_NAME, "atomic");
	return join(baseTempDir(), `${app}-${ownerComponent()}`);
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

function getErrnoCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

/**
 * Confirm one existing component is a directory this account owns, at mode 0700.
 *
 * A looser mode is tightened and re-checked; a component owned by another
 * account, or one whose mode cannot be tightened, is refused rather than used.
 * Windows has no uid or POSIX mode to check, so only the symlink and directory
 * checks apply there.
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

/**
 * Create `dir` with owner-only permissions, validating every component below the
 * system temp directory.
 *
 * The memo only skips work once the cached path is confirmed to still be a real
 * directory: a system temp reaper (or the sweeper in another process) can delete
 * a session tree underneath a live session, and a blind cache hit would then hand
 * back a path whose writes fail with `ENOENT` — an uncaught stream error that
 * takes the interactive process down.
 *
 * Throws {@link TempDirRefusedError} when a component cannot be trusted. Every
 * caller treats that as "no spill file", never as a fatal error: failing closed
 * loses a convenience artifact, while failing open writes tool output into a
 * directory someone else controls.
 */
export function ensureTempDir(dir: string): string {
	if (ensuredDirs.has(dir) && isRealDirectory(dir)) {
		return dir;
	}
	ensuredDirs.delete(dir);
	const base = baseTempDir();
	const prefix = `${base}${sep}`;
	if (dir.startsWith(prefix)) {
		const parts = dir
			.slice(prefix.length)
			.split(sep)
			.filter((part) => part.length > 0);
		let current = base;
		for (const part of parts.slice(0, -1)) {
			current = join(current, part);
			ensureOwnedDirectory(current);
		}
	} else {
		// A caller-supplied directory outside the system temp base (a session
		// directory, for instance) is the caller's to own; only the leaf is ours.
		mkdirSync(dirname(dir), { recursive: true, mode: SESSION_TEMP_DIR_MODE });
	}
	ensureLeafDirectory(dir);
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
const protectedTempDirs = new Set<string>();

/**
 * Mark a session as live in this process.
 *
 * Two things follow: writers without a session handle default to this session's
 * directory, and the sweeper never reaps a directory belonging to a session this
 * process is still using — which is what keeps a `Full output saved to:` path
 * valid for the lifetime of the session that produced it.
 */
export function registerActiveSessionTempDir(sessionId: string): string {
	activeSessionId = sessionId;
	const dir = resolveSessionTempDirPath(sessionId);
	protectedTempDirs.add(dir);
	return dir;
}

/** Session temp directories this process must not reap. */
export function getProtectedSessionTempDirs(): ReadonlySet<string> {
	return protectedTempDirs;
}

/** Test seam: forget the process-level active/protected session state. */
export function resetSessionTempDirStateForTesting(): void {
	activeSessionId = undefined;
	protectedTempDirs.clear();
	ensuredDirs.clear();
	cachedOwnerComponent = undefined;
	cachedBaseTempDir = undefined;
}
