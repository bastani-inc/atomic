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
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentConfigPaths } from "../../config.ts";
import { getErrnoCode } from "./errno.ts";
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

interface FileIdentity {
	dev: bigint;
	ino: bigint;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function realDirectoryIdentity(path: string): FileIdentity | undefined {
	try {
		const stat = lstatSync(path, { bigint: true });
		if (stat.isDirectory() && !stat.isSymbolicLink()) {
			return { dev: stat.dev, ino: stat.ino };
		}
	} catch {
		// Missing, unreadable, and changing paths are not cleanup candidates.
	}
	return undefined;
}

/** An existing real directory — not a symlink, not a file, not missing. */
function isRealDirectory(path: string): boolean {
	return realDirectoryIdentity(path) !== undefined;
}

function markerIsFresh(markerPath: string, now: number, throttleMs: number): boolean {
	try {
		const stat = lstatSync(markerPath);
		return stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs < throttleMs;
	} catch {
		return false;
	}
}

interface CleanupLock extends FileIdentity {
	token: string;
}

function pathIdentifiesFile(path: string, identity: FileIdentity): boolean {
	try {
		const stat = lstatSync(path, { bigint: true });
		return stat.isFile() && !stat.isSymbolicLink() && sameFileIdentity(stat, identity);
	} catch {
		return false;
	}
}

function removeCreatedFile(path: string, identity: FileIdentity): void {
	try {
		if (pathIdentifiesFile(path, identity)) {
			unlinkSync(path);
		}
	} catch {
		// Best effort. An uncertain path is left untouched.
	}
}
/**
 * Take an exclusive lock so two sessions never scan the same target at once.
 *
 * `wx` creation is the exclusivity primitive. Returns an ownership token; a lock
 * left behind by a crashed process is broken once stale, and release only
 * removes a lock that still carries the caller's token.
 */
function acquireCleanupLock(lockPath: string, now: number, staleMs: number): CleanupLock | null {
	const token = `${process.pid}.${now}.${Math.random().toString(36).slice(2)}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		let fd: number;
		try {
			fd = openSync(lockPath, "wx+", SESSION_TEMP_FILE_MODE);
		} catch (error) {
			if (getErrnoCode(error) !== "EEXIST") {
				return null;
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
			continue;
		}

		let lock: CleanupLock | undefined;
		let failed = false;
		try {
			const createdStat = fstatSync(fd, { bigint: true });
			lock = { token, dev: createdStat.dev, ino: createdStat.ino };
			if (!createdStat.isFile()) {
				failed = true;
			} else {
				if (process.platform !== "win32") {
					fchmodSync(fd, SESSION_TEMP_FILE_MODE);
					const modeStat = fstatSync(fd, { bigint: true });
					if (!modeStat.isFile() || Number(modeStat.mode & 0o777n) !== SESSION_TEMP_FILE_MODE) {
						failed = true;
					}
				}
				if (!failed && writeSync(fd, token) !== token.length) {
					failed = true;
				}
			}
		} catch {
			failed = true;
		}
		try {
			closeSync(fd);
		} catch {
			failed = true;
		}
		if (failed || lock === undefined || !pathIdentifiesFile(lockPath, lock) || !ownsCleanupLock(lockPath, lock)) {
			if (lock !== undefined) {
				removeCreatedFile(lockPath, lock);
			}
			return null;
		}
		return lock;
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

function ownsCleanupLock(lockPath: string, lock: CleanupLock): boolean {
	try {
		return (
			pathIdentifiesFile(lockPath, lock) &&
			readFileSync(lockPath, "utf-8") === lock.token &&
			pathIdentifiesFile(lockPath, lock)
		);
	} catch {
		return false;
	}
}

function releaseCleanupLock(lockPath: string, lock: CleanupLock): void {
	try {
		if (ownsCleanupLock(lockPath, lock) && pathIdentifiesFile(lockPath, lock)) {
			unlinkSync(lockPath);
		}
	} catch {
		// Release is best-effort: an unreleased lock only goes stale and is
		// broken by a later sweep.
	}
}

/** Publish the throttle marker without ever opening or unlinking its destination. */
function publishCleanupMarker(markerPath: string, now: number): boolean {
	const tempPath = `${markerPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
	const timestamp = String(now);
	let fd: number;
	try {
		fd = openSync(tempPath, "wx+", SESSION_TEMP_FILE_MODE);
	} catch {
		return false;
	}

	let identity: FileIdentity | undefined;
	let failed = false;
	try {
		const createdStat = fstatSync(fd, { bigint: true });
		identity = { dev: createdStat.dev, ino: createdStat.ino };
		if (!createdStat.isFile()) {
			failed = true;
		} else {
			if (process.platform !== "win32") {
				fchmodSync(fd, SESSION_TEMP_FILE_MODE);
				const modeStat = fstatSync(fd, { bigint: true });
				if (!modeStat.isFile() || Number(modeStat.mode & 0o777n) !== SESSION_TEMP_FILE_MODE) {
					failed = true;
				}
			}
			if (!failed && writeSync(fd, timestamp) !== timestamp.length) {
				failed = true;
			}
		}
	} catch {
		failed = true;
	}
	try {
		closeSync(fd);
	} catch {
		failed = true;
	}
	if (failed || identity === undefined || !pathIdentifiesFile(tempPath, identity)) {
		if (identity !== undefined) {
			removeCreatedFile(tempPath, identity);
		}
		return false;
	}

	try {
		renameSync(tempPath, markerPath);
	} catch {
		removeCreatedFile(tempPath, identity);
		return false;
	}
	return pathIdentifiesFile(markerPath, identity);
}

type ScanFreshness = "fresh" | "stale" | "unknown";

/**
 * Classify whether `entryPath` has a fresh descendant, is fully stale, or could
 * not be scanned completely.
 *
 * Only `stale` authorizes deletion. Symlinks, unreadable entries, and the depth
 * bound fail closed as `unknown`; `ENOENT` is stale because the entry vanished.
 * The walk still exits on its first fresh descendant.
 */
function scanFreshness(entryPath: string, cutoff: number, depth = 0): ScanFreshness {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(entryPath);
	} catch (error) {
		return getErrnoCode(error) === "ENOENT" ? "stale" : "unknown";
	}
	if (stat.isSymbolicLink()) {
		return "unknown";
	}
	if (stat.mtimeMs >= cutoff) {
		return "fresh";
	}
	if (!stat.isDirectory()) {
		return "stale";
	}
	if (depth >= MAX_SCAN_DEPTH) {
		return "unknown";
	}
	let children: string[];
	try {
		children = readdirSync(entryPath);
	} catch (error) {
		return getErrnoCode(error) === "ENOENT" ? "stale" : "unknown";
	}
	let foundUnknown = false;
	for (const child of children) {
		const freshness = scanFreshness(join(entryPath, child), cutoff, depth + 1);
		if (freshness === "fresh") {
			return "fresh";
		}
		if (freshness === "unknown") {
			foundUnknown = true;
		}
	}
	return foundUnknown ? "unknown" : "stale";
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
		if (!aborted && ownsCleanupLock(lockPath, token)) {
			// Failing to publish the marker only means the sweep repeats sooner.
			publishCleanupMarker(markerPath, now);
		}
	} finally {
		releaseCleanupLock(lockPath, token);
	}
	return aborted ? "locked" : "swept";
}

function isCleanupArtifact(name: string): boolean {
	return (
		name === CLEANUP_MARKER_FILE ||
		name.startsWith(`${CLEANUP_MARKER_FILE}.tmp.`) ||
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
				const initialIdentity = realDirectoryIdentity(entryPath);
				if (initialIdentity === undefined || scanFreshness(entryPath, gate.cutoff) !== "stale") {
					continue;
				}
				if (!gate.ownsLock()) {
					return;
				}
				const finalIdentity = realDirectoryIdentity(entryPath);
				if (finalIdentity === undefined || !sameFileIdentity(initialIdentity, finalIdentity)) {
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
 * A directory a live session registered is skipped whatever its age. Age alone
 * is not enough here: replaying a persisted result reuses the existing file
 * without touching its mtime, so a month-old file can be advertised to the model
 * this very turn.
 *
 * Otherwise the directory's newest entry decides its fate, exactly as it does for
 * a session temp tree: one fresh descendant keeps the entire tree, stale siblings
 * included.
 */
function reapToolResultsDir(parent: string, cutoff: number, protectedPaths: ReadonlySet<string>): void {
	const toolResultsDir = join(parent, TOOL_RESULTS_SUBDIR);
	if (protectedPaths.has(toolResultsDir) || !isRealDirectory(toolResultsDir)) {
		return;
	}
	if (scanFreshness(toolResultsDir, cutoff) !== "stale") {
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
	const gateOptions: SweepOptions = {
		...options,
		protectedPaths: options.protectedPaths ?? getProtectedSessionTempDirs(),
	};
	return withCleanupGate(getCleanupControlDir(sessionsRoot, options.controlRoot), gateOptions, (gate) => {
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
				reapToolResultsDir(projectDir, gate.cutoff, gate.protectedPaths);
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
	const gateOptions: SweepOptions = {
		...options,
		protectedPaths: options.protectedPaths ?? getProtectedSessionTempDirs(),
	};
	return withCleanupGate(getCleanupControlDir(sessionDir, options.controlRoot), gateOptions, (gate) => {
		if (!gate.ownsLock()) {
			return;
		}
		try {
			reapToolResultsDir(sessionDir, gate.cutoff, gate.protectedPaths);
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
	// Session storage carries the same protection as the temp trees: a live
	// session registers its own `tool-results` directory, and a replayed result
	// reuses an old file without refreshing its mtime, so age alone cannot keep
	// an advertised path alive.
	for (const root of sessionsRoots ?? safeSessionsRoots()) {
		try {
			sweepToolResultsRoot(root, sweepOptions);
		} catch {
			// Best effort.
		}
	}
	for (const dir of sessionDirs ?? []) {
		try {
			sweepSessionDirToolResults(dir, sweepOptions);
		} catch {
			// Best effort.
		}
	}
}

let cleanupScheduled = false;
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
const scheduledSessionsRoots = new Set<string>();
const scheduledSessionDirs = new Set<string>();

/** Arm one deferred sweep for the roots currently pending. */
function armSessionTempCleanup(options: SessionTempCleanupOptions): void {
	cleanupScheduled = true;
	cleanupTimer = setTimeout(() => {
		// Drain before the sweep. A session discovered while cleanup is running adds
		// to the now-empty sets and is rearmed in `finally`, rather than being lost
		// or starting a second callback alongside this one.
		const sessionsRoots = [...scheduledSessionsRoots];
		const sessionDirs = [...scheduledSessionDirs];
		scheduledSessionsRoots.clear();
		scheduledSessionDirs.clear();
		try {
			runSessionTempCleanup({
				...options,
				sessionsRoots: sessionsRoots.length > 0 ? sessionsRoots : options.sessionsRoots,
				sessionDirs,
			});
		} finally {
			cleanupTimer = undefined;
			cleanupScheduled = false;
			if (scheduledSessionsRoots.size > 0 || scheduledSessionDirs.size > 0) {
				armSessionTempCleanup(options);
			}
		}
	}, SESSION_TEMP_CLEANUP_DELAY_MS);
	cleanupTimer.unref?.();
}

/**
 * Schedule one deferred sweep for the current pending batch.
 *
 * Calls made before or during a sweep merge their targets into sets. The active
 * callback drains one snapshot, remains marked active while it runs, then rearms
 * one new unref'd timer only when later roots arrived.
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
	armSessionTempCleanup(options);
}

/** Test seam: cancel pending work and forget scheduler state. */
export function resetSessionTempCleanupScheduleForTesting(): void {
	if (cleanupTimer !== undefined) {
		clearTimeout(cleanupTimer);
	}
	cleanupTimer = undefined;
	cleanupScheduled = false;
	scheduledSessionsRoots.clear();
	scheduledSessionDirs.clear();
}

/** Narrow lock seam for descriptor-mode and release tests. */
export const sessionTempCleanupTestHooks = {
	acquireCleanupLock,
	releaseCleanupLock,
};
