/**
 * Age-based sweeper for tool-output storage.
 *
 * Three targets are reaped, all strictly scoped to tool output:
 *
 * - `<tmpdir>/<APP_NAME>-<owner>/` — the per-session temp trees created by
 *   `session-temp-dir.ts`.
 * - `<sessionsRoot>/<project>/tool-results/` — persisted tool results under the
 *   default, project-nested session roots.
 * - `<sessionDir>/tool-results/` — the same, for a custom session directory
 *   chosen with `--session-dir`, `ATOMIC_CODING_AGENT_SESSION_DIR`, or the
 *   `sessionDir` setting, where there is no project nesting to walk.
 *
 * Transcripts, `.jsonl` session files, and every other file under session
 * storage are out of scope: the walk only ever descends into a `tool-results`
 * directory, and only ever deletes inside it.
 *
 * The throttle/lock shape mirrors `packages/subagents/src/shared/artifacts.ts`:
 * a `.last-cleanup` marker skips the scan for a day, a `.cleanup.lock` exclusive
 * lock keeps concurrent sessions from racing, a stale lock left by a crashed
 * process is broken, and lock ownership is rechecked before every destructive
 * step. Those two names are required, but the subagents sweep already owns them
 * inside the default sessions roots, so session-storage scans keep their
 * marker/lock pair in a coding-agent control root keyed by target instead of
 * writing into the scanned directory. The temp root, which nothing else owns,
 * carries its pair directly.
 *
 * Symlinks are never followed. A scan root or a `tool-results` entry that is a
 * symlink is skipped rather than read or deleted, because `readdirSync` and
 * `rmSync` resolve links and would otherwise reach outside the target.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentConfigPaths } from "../../config.ts";
import {
	ensureTempDir,
	getProtectedSessionTempDirs,
	getTempRootDir,
	SESSION_TEMP_FILE_MODE,
} from "./session-temp-dir.ts";
import { TOOL_RESULTS_SUBDIR } from "./tool-limits.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How long a tool-output tree survives without being touched. */
export const SESSION_TEMP_RETENTION_DAYS = 30;
export const SESSION_TEMP_RETENTION_MS = SESSION_TEMP_RETENTION_DAYS * MS_PER_DAY;

/** Minimum interval between two sweeps of the same root. */
export const SESSION_TEMP_CLEANUP_INTERVAL_MS = MS_PER_DAY;

/** A lock older than this belonged to a process that died holding it. */
export const SESSION_TEMP_CLEANUP_LOCK_STALE_MS = 60 * 60 * 1000;

/** How long after startup the sweep runs, so it never sits on the startup path. */
export const SESSION_TEMP_CLEANUP_DELAY_MS = 10_000;

/** Deepest directory nesting the mtime walk will descend. */
const MAX_SCAN_DEPTH = 32;

export const CLEANUP_MARKER_FILE = ".last-cleanup";
export const CLEANUP_LOCK_FILE = ".cleanup.lock";

/**
 * Control root for session-storage scans, inside the owner-scoped temp root.
 * A session id can never sanitize to this name (leading dots are stripped), so
 * it cannot collide with a session temp tree.
 */
export const CLEANUP_CONTROL_SUBDIR = ".cleanup";

export type SweepOutcome = "swept" | "throttled" | "locked" | "missing";

export interface SweepOptions {
	/** Clock override for tests. */
	now?: number;
	/** Age past which an untouched entry is reaped. */
	retentionMs?: number;
	/** Minimum interval between sweeps of this root. */
	throttleMs?: number;
	/** Directories that must survive regardless of age. */
	protectedPaths?: Iterable<string>;
	/** Parent of the per-target control directories. Defaults to `<tempRoot>/.cleanup`. */
	controlRoot?: string;
}

/** Default parent for the marker/lock pair of a session-storage scan. */
export function getCleanupControlRoot(): string {
	return join(getTempRootDir(), CLEANUP_CONTROL_SUBDIR);
}

/**
 * Control directory for one scan target: `<controlRoot>/<digest-of-target>`.
 * Keyed by the target path so two roots never share throttle state.
 */
export function getCleanupControlDir(target: string, controlRoot?: string): string {
	const key = createHash("sha256").update(target).digest("hex").slice(0, 16);
	return join(controlRoot ?? getCleanupControlRoot(), key);
}

function getErrnoCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

/** An existing real directory — not a symlink, not a file, not missing. */
function isRealDirectory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function markerIsFresh(markerPath: string, now: number, throttleMs: number): boolean {
	try {
		return now - statSync(markerPath).mtimeMs < throttleMs;
	} catch {
		return false;
	}
}

/**
 * Take an exclusive lock so two sessions never scan the same target at once.
 *
 * `wx` creation is the exclusivity primitive. Returns an ownership token; a lock
 * left behind by a crashed process is broken once stale, and release only
 * removes a lock that still carries the caller's token.
 */
function acquireCleanupLock(lockPath: string, now: number, staleMs: number): string | null {
	const token = `${process.pid}.${now}.${Math.random().toString(36).slice(2)}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockPath, "wx", SESSION_TEMP_FILE_MODE);
			try {
				writeSync(fd, token);
			} finally {
				closeSync(fd);
			}
			return token;
		} catch (error) {
			if (getErrnoCode(error) !== "EEXIST") {
				return null;
			}
		}
		let lockMtimeMs: number;
		try {
			lockMtimeMs = statSync(lockPath).mtimeMs;
		} catch {
			// The holder released between the failed create and the stat; retry.
			continue;
		}
		if (now - lockMtimeMs < staleMs) {
			return null;
		}
		if (!breakStaleLock(lockPath, lockMtimeMs)) {
			return null;
		}
	}
	return null;
}

/**
 * Claim a stale lock via rename, then verify it is still the lock observed
 * during stale detection. A lock that changed identity in between belongs to a
 * new holder: hand it back and treat the takeover as contention.
 */
function breakStaleLock(lockPath: string, observedMtimeMs: number): boolean {
	const breakPath = `${lockPath}.break.${process.pid}.${Math.random().toString(36).slice(2)}`;
	try {
		renameSync(lockPath, breakPath);
	} catch {
		// Another sweep released or broke it first; contend again on create.
		return false;
	}
	let displacedFreshLock = false;
	try {
		displacedFreshLock = statSync(breakPath).mtimeMs !== observedMtimeMs;
	} catch {
		displacedFreshLock = false;
	}
	if (displacedFreshLock) {
		try {
			renameSync(breakPath, lockPath);
		} catch {
			// Best-effort hand-back; the displaced holder aborts at its next
			// ownership recheck.
		}
		return false;
	}
	try {
		unlinkSync(breakPath);
	} catch {
		// A leftover break file is harmless.
	}
	return true;
}

function ownsCleanupLock(lockPath: string, token: string): boolean {
	try {
		return readFileSync(lockPath, "utf-8") === token;
	} catch {
		return false;
	}
}

function releaseCleanupLock(lockPath: string, token: string): void {
	try {
		if (readFileSync(lockPath, "utf-8") === token) {
			unlinkSync(lockPath);
		}
	} catch {
		// Release is best-effort: an unreleased lock only goes stale and is
		// broken by a later sweep.
	}
}

/**
 * Whether any entry at or under `entryPath` was modified at/after `cutoff`.
 *
 * Short-circuits on the first fresh descendant, so a live tree costs one stat.
 * Symlinks are never followed: `lstat` reports them as non-directories, so the
 * walk cannot be steered outside the root.
 */
function hasEntryNewerThan(entryPath: string, cutoff: number, depth = 0): boolean {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(entryPath);
	} catch {
		// Vanished mid-scan: nothing to protect and nothing to delete.
		return false;
	}
	if (stat.mtimeMs >= cutoff) {
		return true;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink() || depth >= MAX_SCAN_DEPTH) {
		return false;
	}
	let children: string[];
	try {
		children = readdirSync(entryPath);
	} catch {
		// An unreadable directory is kept rather than deleted.
		return true;
	}
	for (const child of children) {
		if (hasEntryNewerThan(join(entryPath, child), cutoff, depth + 1)) {
			return true;
		}
	}
	return false;
}

interface CleanupGate {
	/** Whether this sweep still owns the lock; false means another holder took over. */
	ownsLock(): boolean;
	cutoff: number;
	protectedPaths: ReadonlySet<string>;
}

/**
 * Run `scan` under the marker/lock protocol for one target.
 *
 * `controlDir` holds the `.last-cleanup`/`.cleanup.lock` pair; it may be the
 * scanned directory itself (temp root) or a coding-agent-owned directory outside
 * it (session storage).
 */
function withCleanupGate(controlDir: string, options: SweepOptions, scan: (gate: CleanupGate) => void): SweepOutcome {
	const now = options.now ?? Date.now();
	const throttleMs = options.throttleMs ?? SESSION_TEMP_CLEANUP_INTERVAL_MS;
	try {
		// The control root lives under the owner temp root, so create it through the
		// same validated, non-recursive path the spill directories use.
		ensureTempDir(controlDir);
	} catch {
		// Without a control directory there is nowhere to record the throttle;
		// skip rather than sweep unthrottled and unlocked.
		return "locked";
	}
	const markerPath = join(controlDir, CLEANUP_MARKER_FILE);
	if (markerIsFresh(markerPath, now, throttleMs)) {
		return "throttled";
	}
	const lockPath = join(controlDir, CLEANUP_LOCK_FILE);
	const token = acquireCleanupLock(lockPath, now, SESSION_TEMP_CLEANUP_LOCK_STALE_MS);
	if (token === null) {
		return "locked";
	}
	let aborted = false;
	try {
		scan({
			ownsLock: () => {
				if (aborted) {
					return false;
				}
				if (ownsCleanupLock(lockPath, token)) {
					return true;
				}
				aborted = true;
				return false;
			},
			cutoff: now - (options.retentionMs ?? SESSION_TEMP_RETENTION_MS),
			protectedPaths: new Set(options.protectedPaths ?? []),
		});
		try {
			if (!aborted && ownsCleanupLock(lockPath, token)) {
				writeFileSync(markerPath, String(now));
			}
		} catch {
			// Failing to record the marker only means the sweep repeats sooner.
		}
	} finally {
		releaseCleanupLock(lockPath, token);
	}
	return aborted ? "locked" : "swept";
}

function isCleanupArtifact(name: string): boolean {
	return (
		name === CLEANUP_MARKER_FILE ||
		name === CLEANUP_LOCK_FILE ||
		name.startsWith(`${CLEANUP_LOCK_FILE}.`) ||
		name === CLEANUP_CONTROL_SUBDIR
	);
}

/**
 * Reap per-session temp trees under `<tmpdir>/<APP_NAME>-<owner>/`.
 *
 * A tree is removed only when nothing at any depth inside it is newer than the
 * retention cutoff, and never when it belongs to a session this process
 * registered as live. A symlinked root is refused outright.
 */
export function sweepSessionTempRoot(root: string = getTempRootDir(), options: SweepOptions = {}): SweepOutcome {
	if (!isRealDirectory(root)) {
		return "missing";
	}
	const gateOptions: SweepOptions = {
		...options,
		protectedPaths: options.protectedPaths ?? getProtectedSessionTempDirs(),
	};
	return withCleanupGate(root, gateOptions, (gate) => {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			// Cleanup is best-effort housekeeping; an unreadable root is skipped.
			return;
		}
		for (const entry of entries) {
			if (isCleanupArtifact(entry)) {
				continue;
			}
			const entryPath = join(root, entry);
			if (gate.protectedPaths.has(entryPath)) {
				continue;
			}
			// A holder displaced by a stale-lock takeover must stop deleting
			// alongside the new owner.
			if (!gate.ownsLock()) {
				return;
			}
			try {
				if (hasEntryNewerThan(entryPath, gate.cutoff)) {
					continue;
				}
				rmSync(entryPath, { recursive: true, force: true });
			} catch {
				// One bad entry must not block the rest of the sweep.
			}
		}
	});
}

/**
 * Reap one `<parent>/tool-results` directory.
 *
 * A symlinked (or otherwise non-directory) `tool-results` is skipped entirely —
 * neither descended into nor deleted — because `readdirSync`/`rmSync` resolve
 * links and would reach the outside directory the link points at.
 *
 * The directory's newest entry decides its fate, exactly as it does for a session
 * temp tree: one fresh descendant keeps the entire tree, stale siblings included.
 * That is what makes every path inside a live tree stay valid, including one a
 * tool result recorded weeks ago and the model may still read back.
 */
function reapToolResultsDir(parent: string, cutoff: number): void {
	const toolResultsDir = join(parent, TOOL_RESULTS_SUBDIR);
	if (!isRealDirectory(toolResultsDir)) {
		return;
	}
	if (hasEntryNewerThan(toolResultsDir, cutoff)) {
		return;
	}
	rmSync(toolResultsDir, { recursive: true, force: true });
}

/**
 * Reap stale `tool-results` directories under one project-nested sessions root.
 * Only `<sessionsRoot>/<project>/tool-results` is touched — never the sibling
 * `.jsonl` transcripts.
 */
export function sweepToolResultsRoot(sessionsRoot: string, options: SweepOptions = {}): SweepOutcome {
	if (!isRealDirectory(sessionsRoot)) {
		return "missing";
	}
	return withCleanupGate(getCleanupControlDir(sessionsRoot, options.controlRoot), options, (gate) => {
		let entries: string[];
		try {
			entries = readdirSync(sessionsRoot);
		} catch {
			return;
		}
		for (const entry of entries) {
			const projectDir = join(sessionsRoot, entry);
			if (!isRealDirectory(projectDir) || gate.protectedPaths.has(projectDir)) {
				continue;
			}
			if (!gate.ownsLock()) {
				return;
			}
			try {
				reapToolResultsDir(projectDir, gate.cutoff);
			} catch {
				// Keep going so one unreadable project directory does not block the rest.
			}
		}
	});
}

/**
 * Reap `<sessionDir>/tool-results` for a directly chosen session directory.
 *
 * A custom `--session-dir` has no project nesting: session files live in the
 * directory itself, so only its own `tool-results` child is in scope and its
 * siblings — including transcripts — are never touched.
 */
export function sweepSessionDirToolResults(sessionDir: string, options: SweepOptions = {}): SweepOutcome {
	if (!isRealDirectory(sessionDir)) {
		return "missing";
	}
	return withCleanupGate(getCleanupControlDir(sessionDir, options.controlRoot), options, (gate) => {
		if (!gate.ownsLock()) {
			return;
		}
		try {
			reapToolResultsDir(sessionDir, gate.cutoff);
		} catch {
			// Best effort.
		}
	});
}

export interface SessionTempCleanupOptions extends SweepOptions {
	/** Temp root override; defaults to the owner-scoped root. */
	tempRoot?: string;
	/** Project-nested sessions roots; defaults to the configured agent session roots. */
	sessionsRoots?: readonly string[];
	/** Directly chosen session directories (custom `--session-dir` and friends). */
	sessionDirs?: readonly string[];
}

function safeSessionsRoots(): readonly string[] {
	try {
		return getAgentConfigPaths("sessions");
	} catch {
		return [];
	}
}

/** Run every sweep once. Each failure is swallowed: cleanup is housekeeping. */
export function runSessionTempCleanup(options: SessionTempCleanupOptions = {}): void {
	const { tempRoot, sessionsRoots, sessionDirs, ...sweepOptions } = options;
	try {
		sweepSessionTempRoot(tempRoot ?? getTempRootDir(), sweepOptions);
	} catch {
		// Best effort.
	}
	// Session-storage sweeps protect nothing by path: a live session's results are
	// fresh, and the retention cutoff is what keeps them.
	const storageOptions: SweepOptions = { ...sweepOptions, protectedPaths: [] };
	for (const root of sessionsRoots ?? safeSessionsRoots()) {
		try {
			sweepToolResultsRoot(root, storageOptions);
		} catch {
			// Best effort.
		}
	}
	for (const dir of sessionDirs ?? []) {
		try {
			sweepSessionDirToolResults(dir, storageOptions);
		} catch {
			// Best effort.
		}
	}
}

let cleanupScheduled = false;
const scheduledSessionsRoots = new Set<string>();
const scheduledSessionDirs = new Set<string>();

/**
 * Schedule the sweep once per process, deferred off startup on an unref'd timer
 * so a short-lived run exits without waiting for it.
 *
 * Later calls cannot re-arm the timer, so their targets are merged into the
 * pending run instead of being dropped: in-process child sessions may use
 * different session directories than the session that scheduled first.
 */
export function scheduleSessionTempCleanup(options: SessionTempCleanupOptions = {}): void {
	for (const root of options.sessionsRoots ?? []) {
		scheduledSessionsRoots.add(root);
	}
	for (const dir of options.sessionDirs ?? []) {
		scheduledSessionDirs.add(dir);
	}
	if (cleanupScheduled) {
		return;
	}
	cleanupScheduled = true;
	const handle = setTimeout(() => {
		runSessionTempCleanup({
			...options,
			sessionsRoots: scheduledSessionsRoots.size > 0 ? [...scheduledSessionsRoots] : options.sessionsRoots,
			sessionDirs: [...scheduledSessionDirs],
		});
	}, SESSION_TEMP_CLEANUP_DELAY_MS);
	handle.unref?.();
}

/** Test seam: allow a second schedule in the same process. */
export function resetSessionTempCleanupScheduleForTesting(): void {
	cleanupScheduled = false;
	scheduledSessionsRoots.clear();
	scheduledSessionDirs.clear();
}
