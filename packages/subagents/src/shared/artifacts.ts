import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentConfigPaths } from "@bastani/atomic";
import { appendToActiveEventWriter } from "./event-jsonl-writer.ts";
import { publishFileExclusive, unlinkIfPresent } from "./exclusive-file-publication.js";
import { type ArtifactPaths, TEMP_ARTIFACTS_DIR } from "./types.ts";

const CLEANUP_MARKER_FILE = ".last-cleanup";
const CLEANUP_LOCK_FILE = ".cleanup.lock";
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_LOCK_STALE_MS = 60 * 60 * 1000;

export function getArtifactsDir(sessionFile: string | null): string {
	if (sessionFile) {
		const sessionDir = path.dirname(sessionFile);
		return path.join(sessionDir, "subagent-artifacts");
	}
	return TEMP_ARTIFACTS_DIR;
}

export function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths {
	const suffix = index !== undefined ? `_${index}` : "";
	const safeAgent = agent.replace(/[^\w.-]/g, "_");
	const base = `${runId}_${safeAgent}${suffix}`;
	return {
		inputPath: path.join(artifactsDir, `${base}_input.md`),
		outputPath: path.join(artifactsDir, `${base}_output.md`),
		jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
		metadataPath: path.join(artifactsDir, `${base}_meta.json`),
	};
}

export function ensureArtifactsDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, "utf-8");
}

export function writeMetadata(filePath: string, metadata: object): void {
	fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

export function appendJsonl(filePath: string, line: string): void {
	if (!appendToActiveEventWriter(filePath, line)) fs.appendFileSync(filePath, `${line}\n`);
}

function cleanupOldArtifactEntry(entryPath: string, cutoff: number): void {
	try {
		const stat = fs.lstatSync(entryPath);
		if (stat.isDirectory()) {
			for (const child of fs.readdirSync(entryPath)) {
				cleanupOldArtifactEntry(path.join(entryPath, child), cutoff);
			}
			if (fs.readdirSync(entryPath).length === 0 && stat.mtimeMs < cutoff) {
				fs.rmSync(entryPath, { recursive: true, force: true });
			}
			return;
		}
		if (stat.mtimeMs < cutoff) fs.unlinkSync(entryPath);
	} catch {
		// Artifact cleanup is best-effort housekeeping. Skip entries that disappear
		// or become unreadable while scanning so one bad entry does not block the rest.
	}
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
	if (!fs.existsSync(dir)) return;

	const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
	const now = Date.now();

	if (fs.existsSync(markerPath)) {
		const stat = fs.statSync(markerPath);
		if (now - stat.mtimeMs < CLEANUP_INTERVAL_MS) return;
	}

	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = now - maxAgeMs;

	for (const file of fs.readdirSync(dir)) {
		if (file === CLEANUP_MARKER_FILE) continue;
		cleanupOldArtifactEntry(path.join(dir, file), cutoff);
	}

	fs.writeFileSync(markerPath, String(now));
}

function markerIsFresh(markerPath: string, now: number): boolean {
	try {
		return now - fs.statSync(markerPath).mtimeMs < CLEANUP_INTERVAL_MS;
	} catch {
		return false;
	}
}

/**
 * Take an exclusive lock at lockPath so concurrent activations never race the same
 * sessions-root scan. A lock left behind by a crashed process is broken once stale.
 * Returns an ownership token on success; release only removes a lock that still
 * carries the caller's token, so a holder whose stale lock was taken over cannot
 * erase the new holder's lock.
 */
function acquireCleanupLock(lockPath: string, now: number): string | null {
	const token = `${process.pid}.${now}.${Math.random().toString(36).slice(2)}`;
	const source = `${lockPath}.${token}.tmp`;
	try {
		fs.writeFileSync(source, token);
		for (let attempt = 0; attempt < 2; attempt++) {
			if (publishFileExclusive(source, lockPath) === "published") return token;
			let lockMtimeMs: number;
			try {
				lockMtimeMs = fs.statSync(lockPath).mtimeMs;
			} catch {
				// The holder released between publish and stat; retry once.
				continue;
			}
			if (now - lockMtimeMs < CLEANUP_LOCK_STALE_MS) return null;
			if (!breakStaleLock(lockPath, lockMtimeMs)) return null;
		}
		return null;
	} catch {
		return null;
	} finally {
		try {
			unlinkIfPresent(source);
		} catch {
			// Lock acquisition is best-effort; a leftover temp source is harmless.
		}
	}
}

/**
 * Atomically claim a stale lock via rename, then verify it is still the lock
 * observed during stale detection. A lock that changed identity in between
 * belongs to a new holder: it is handed back and the takeover is treated as
 * contention instead of deleting the fresh lock.
 */
function breakStaleLock(lockPath: string, observedMtimeMs: number): boolean {
	const breakPath = `${lockPath}.break.${process.pid}.${Math.random().toString(36).slice(2)}`;
	try {
		fs.renameSync(lockPath, breakPath);
	} catch {
		// Another activation released or broke the lock first; contend for publish.
		return false;
	}
	let displacedFreshLock = false;
	try {
		displacedFreshLock = fs.statSync(breakPath).mtimeMs !== observedMtimeMs;
	} catch {
		displacedFreshLock = false;
	}
	try {
		if (displacedFreshLock) publishFileExclusive(breakPath, lockPath);
	} catch {
		// Best-effort hand-back. A holder whose lock could not be restored notices the
		// loss at its next ownership recheck and aborts its scan.
	}
	try {
		unlinkIfPresent(breakPath);
	} catch {
		// A leftover break file is harmless.
	}
	return !displacedFreshLock;
}

function ownsCleanupLock(lockPath: string, token: string): boolean {
	try {
		return fs.readFileSync(lockPath, "utf-8") === token;
	} catch {
		return false;
	}
}

function releaseCleanupLock(lockPath: string, token: string): void {
	try {
		if (fs.readFileSync(lockPath, "utf-8") === token) fs.unlinkSync(lockPath);
	} catch {
		// Lock release is best-effort; a failure only means the lock goes stale and is
		// broken by a later scan, and must never abort cleanup of the remaining roots.
	}
}

function cleanupSessionsRoot(sessionsBase: string, maxAgeDays: number): void {
	if (!fs.existsSync(sessionsBase)) return;

	const now = Date.now();
	const markerPath = path.join(sessionsBase, CLEANUP_MARKER_FILE);
	if (markerIsFresh(markerPath, now)) return;

	const lockPath = path.join(sessionsBase, CLEANUP_LOCK_FILE);
	const lockToken = acquireCleanupLock(lockPath, now);
	if (lockToken === null) return;
	try {
		let dirs: string[];
		try {
			dirs = fs.readdirSync(sessionsBase);
		} catch {
			// Session artifact cleanup is best-effort. If the sessions root cannot be read,
			// skip cleanup instead of failing extension startup.
			return;
		}

		for (const dir of dirs) {
			if (dir === CLEANUP_MARKER_FILE || dir === CLEANUP_LOCK_FILE) continue;
			// A holder displaced by a stale-lock takeover that could not be handed its
			// lock back must not keep deleting alongside the new lock owner; recheck
			// ownership before every destructive per-session cleanup and abort the
			// scan as soon as the lock is lost.
			if (!ownsCleanupLock(lockPath, lockToken)) return;
			const artifactsDir = path.join(sessionsBase, dir, "subagent-artifacts");
			try {
				cleanupOldArtifacts(artifactsDir, maxAgeDays);
			} catch {
				// Session cleanup is best-effort. Keep going so one unreadable session dir
				// does not block cleanup for the rest.
			}
		}

		try {
			if (ownsCleanupLock(lockPath, lockToken)) fs.writeFileSync(markerPath, String(now));
		} catch {
			// Failing to record the marker only means the scan may repeat sooner.
		}
	} finally {
		releaseCleanupLock(lockPath, lockToken);
	}
}

export function cleanupAllArtifactDirs(maxAgeDays: number, sessionsRoots?: readonly string[]): void {
	cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

	// Host-provided sessions roots keep isolated/programmatic agent directories from
	// leaking into the real global (and legacy) session roots; only the env/global
	// derivation scans those.
	for (const sessionsBase of sessionsRoots ?? getAgentConfigPaths("sessions")) {
		cleanupSessionsRoot(sessionsBase, maxAgeDays);
	}
}
