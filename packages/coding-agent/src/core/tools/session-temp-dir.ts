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

import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
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

/** `<tmpdir>/<APP_NAME>-<owner>` — the root every session temp tree lives under. */
export function getTempRootDir(): string {
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

/**
 * Create `dir` (and its parents) with owner-only permissions.
 *
 * The memo only skips work once the cached path is confirmed to still be a real
 * directory: a system temp reaper (or the sweeper in another process) can delete
 * a session tree underneath a live session, and a blind cache hit would then hand
 * back a path whose writes fail with `ENOENT` — an uncaught stream error that
 * takes the interactive process down. A non-directory squatting on the path is
 * removed rather than trusted; for a symlink that unlinks the link alone and
 * never touches its target. The explicit `chmod` covers a directory that already
 * existed with looser permissions, which `mkdir`'s mode argument would leave alone.
 */
export function ensureTempDir(dir: string): string {
	if (ensuredDirs.has(dir) && isRealDirectory(dir)) {
		return dir;
	}
	ensuredDirs.delete(dir);
	try {
		if (!lstatSync(dir).isDirectory()) {
			rmSync(dir, { force: true });
		}
	} catch {
		// Nothing at the path yet, or it cannot be inspected; mkdir decides.
	}
	mkdirSync(dir, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
	if (process.platform !== "win32") {
		try {
			chmodSync(dir, SESSION_TEMP_DIR_MODE);
		} catch {
			// Best effort: a directory we cannot chmod (foreign owner, read-only
			// mount) still works for writes we are about to attempt.
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
}
