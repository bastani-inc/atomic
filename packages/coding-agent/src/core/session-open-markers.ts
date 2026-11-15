/**
 * Which sessions are running (#4971): a process that runs a session keeps a small marker file for it under the agent
 * directory, `open-sessions/<session id>/<pid>-<nonce>.json`, refreshed on a heartbeat and removed when the session
 * closes or the process exits. Deleting a session that has a fresh marker, from another process or from another
 * session of the same process, is refused. A marker is stale, and ignored, when its process on this host is gone or its heartbeat stopped, as for a
 * process killed with SIGKILL or one on another host that shares the agent directory.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.js";
import { SessionOpenElsewhereError } from "./session-manager-errors.js";

/** How often a held marker's heartbeat is refreshed. */
const HEARTBEAT_MS = 15_000;
/** How old a marker's heartbeat may be before the marker no longer counts. */
const STALE_MS = 4 * HEARTBEAT_MS;
/** Tells this process's markers apart from those of an earlier process given the same pid. */
const PROCESS_NONCE = randomBytes(8).toString("hex");
/** The session ids a marker directory can be named after, as `assertValidSessionId` accepts them. */
const VALID_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

interface HeldMarker {
	readonly path: string;
	holds: number;
}

/** A process that holds a marker for a session. */
export interface SessionOpenHolder {
	readonly pid: number;
	readonly host: string;
}

const held = new Map<string, HeldMarker>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

/** The directory of `sessionId`'s markers; undefined for an id that cannot name one (no marker is kept for it). */
function markerDirectory(agentDir: string, sessionId: string): string | undefined {
	return VALID_SESSION_ID.test(sessionId) ? join(agentDir, "open-sessions", sessionId) : undefined;
}

function writeMarker(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), openedAt: new Date().toISOString() }));
}

function refreshMarkers(): void {
	const now = new Date();
	for (const marker of held.values()) {
		try {
			utimesSync(marker.path, now, now);
		} catch {
			try {
				writeMarker(marker.path);
			} catch {
				// Best effort: a marker that cannot be kept only lets another process delete the session.
			}
		}
	}
}

function removeMarker(path: string): void {
	try {
		rmSync(path);
		rmdirSync(join(path, ".."));
	} catch {
		// Another process's marker may remain in the directory, or it is gone already.
	}
}

// A process that exits with sessions still open removes their markers; one killed leaves them stale.
process.on("exit", () => {
	for (const marker of held.values()) removeMarker(marker.path);
});

/**
 * Records that this process has `sessionId` open, until the returned function is called, once; holds by one process
 * for one session share a marker. Never throws: a marker that cannot be written leaves the session unprotected.
 */
export function holdSessionOpenMarker(agentDir: string, sessionId: string): () => void {
	const directory = markerDirectory(agentDir, sessionId);
	if (directory === undefined) return () => {};
	const key = directory;
	let marker = held.get(key);
	if (marker === undefined) {
		const path = join(directory, `${process.pid}-${PROCESS_NONCE}.json`);
		try {
			writeMarker(path);
		} catch {
			return () => {};
		}
		marker = { path, holds: 0 };
		held.set(key, marker);
		if (heartbeat === undefined) {
			heartbeat = setInterval(refreshMarkers, HEARTBEAT_MS);
			heartbeat.unref();
		}
	}
	const holding = marker;
	holding.holds++;
	return () => {
		if (--holding.holds > 0) return;
		held.delete(key);
		removeMarker(holding.path);
		if (held.size === 0 && heartbeat !== undefined) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
	};
}

/** Whether `pid` is a live process on this host; one this process may not signal (EPERM) still exists. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { readonly code?: unknown }).code === "EPERM";
	}
}

/**
 * A running session, in another process or in this one, that has `sessionId` open, or undefined when none does.
 * Stale markers are removed.
 */
export function findSessionOpenHolder(agentDir: string, sessionId: string): SessionOpenHolder | undefined {
	const directory = markerDirectory(agentDir, sessionId);
	if (directory === undefined) return undefined;
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return undefined;
	}
	const host = hostname();
	const ownName = `${process.pid}-${PROCESS_NONCE}.json`;
	for (const name of names) {
		const path = join(directory, name);
		let holder: SessionOpenHolder;
		let heartbeatAt: number;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; host?: unknown };
			if (typeof parsed.pid !== "number" || typeof parsed.host !== "string") continue;
			holder = { pid: parsed.pid, host: parsed.host };
			heartbeatAt = statSync(path).mtimeMs;
		} catch {
			// Being written or removed right now, or not a marker.
			continue;
		}
		// With this process's pid but not its marker: an earlier process given the same pid.
		const gone = holder.host === host && (holder.pid === process.pid ? name !== ownName : !processAlive(holder.pid));
		if (gone || Date.now() - heartbeatAt > STALE_MS) {
			removeMarker(path);
			continue;
		}
		return holder;
	}
	return undefined;
}

/** Throws a {@link SessionOpenElsewhereError} when a running session has `sessionId` open (#4971). */
export function assertSessionNotOpenElsewhere(sessionId: string, agentDir = getAgentDir()): void {
	const holder = findSessionOpenHolder(agentDir, sessionId);
	if (holder !== undefined) throw new SessionOpenElsewhereError(sessionId, holder);
}
