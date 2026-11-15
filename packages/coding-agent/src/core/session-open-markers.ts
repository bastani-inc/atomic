/**
 * Which sessions are running (#4971): a process that runs a session keeps a marker for it, refreshed on a heartbeat and
 * removed when the session closes or the process exits. A store that keeps markers (`SessionStore.openMarkers`, a table
 * in a SQL store) holds them, so every host and agent directory sharing the store sees them; for any other store they
 * are files under the agent directory, `open-sessions/<session id>/<token>.json`. Deleting a session that has a fresh
 * marker, from another process or from another session of the same process, is refused. A marker is stale, and
 * ignored, when its process on this host is gone or its heartbeat stopped, as for a process killed with SIGKILL or one
 * on another host.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.js";
import { attachSessionClaim } from "./session-claims.ts";
import { SessionOpenElsewhereError } from "./session-manager-errors.js";
import type {
	SessionOpenMarker,
	SessionOpenMarkerAge,
	SessionOpenMarkerStore,
	SessionStore,
} from "./storage/session/types.js";

/** How often a held marker's heartbeat is refreshed. */
const HEARTBEAT_MS = 15_000;
/** How old a marker's heartbeat may be before the marker no longer counts. */
const STALE_MS = 4 * HEARTBEAT_MS;
/** This process's markers: its pid, and a nonce that tells it from an earlier process given the same pid. */
const PROCESS_TOKEN = `${process.pid}-${randomBytes(8).toString("hex")}`;
/** The session ids a marker directory can be named after, as `assertValidSessionId` accepts them. */
const VALID_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** A process that holds a marker for a session. */
export interface SessionOpenHolder {
	readonly pid: number;
	readonly host: string;
}

/** Marker files under an agent directory, for stores that keep no markers. */
class FileOpenMarkers implements SessionOpenMarkerStore {
	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	private directory(sessionId: string): string {
		return join(this.agentDir, "open-sessions", sessionId);
	}

	async put(sessionId: string, marker: SessionOpenMarker): Promise<void> {
		this.putSync(sessionId, marker);
	}

	putSync(sessionId: string, marker: SessionOpenMarker): void {
		const path = join(this.directory(sessionId), `${marker.token}.json`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ pid: marker.pid, host: marker.host }));
	}

	async remove(sessionId: string, token: string): Promise<void> {
		this.removeSync(sessionId, token);
	}

	removeSync(sessionId: string, token: string): void {
		const directory = this.directory(sessionId);
		try {
			rmSync(join(directory, `${token}.json`));
			rmdirSync(directory);
		} catch {
			// Another process's marker may remain in the directory, or it is gone already.
		}
	}

	async list(sessionId: string): Promise<readonly SessionOpenMarkerAge[]> {
		const directory = this.directory(sessionId);
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch {
			return [];
		}
		return names.flatMap((name) => {
			const path = join(directory, name);
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; host?: unknown };
				if (typeof parsed.pid !== "number" || typeof parsed.host !== "string") return [];
				const token = name.replace(/\.json$/, "");
				// The file system's clock stamps the file; files are shared only by hosts that share the agent directory.
				const ageMs = Date.now() - statSync(path).mtimeMs;
				return [{ token, pid: parsed.pid, host: parsed.host, ageMs }];
			} catch {
				// Being written or removed right now, or not a marker.
				return [];
			}
		});
	}
}

const fileMarkers = new Map<string, FileOpenMarkers>();

function fileMarkersIn(agentDir: string): FileOpenMarkers {
	let markers = fileMarkers.get(agentDir);
	if (markers === undefined) {
		markers = new FileOpenMarkers(agentDir);
		fileMarkers.set(agentDir, markers);
	}
	return markers;
}

/** Where `store`'s sessions are marked open: in the store when it keeps markers, else under `agentDir`. */
function markersFor(store: SessionStore | undefined, agentDir: string): SessionOpenMarkerStore {
	return store?.openMarkers ?? fileMarkersIn(agentDir);
}

interface HeldMarker {
	readonly markers: SessionOpenMarkerStore;
	readonly sessionId: string;
	holds: number;
	/** Releases the resume claim this marker took over (#5135), if any. */
	readonly releaseClaim: (() => void) | undefined;
}

/** Markers this process holds, by store and then session id. */
const held = new Map<SessionOpenMarkerStore, Map<string, HeldMarker>>();
let heldCount = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function ownMarker(): SessionOpenMarker {
	return { token: PROCESS_TOKEN, pid: process.pid, host: hostname() };
}

function refreshMarkers(): void {
	for (const sessions of held.values()) {
		for (const marker of sessions.values()) {
			// Best effort: a marker that cannot be kept only lets another process delete the session.
			marker.markers.put(marker.sessionId, ownMarker()).catch(() => {});
		}
	}
}

// A process that exits with sessions still open removes their marker files; one killed leaves them stale. Markers in a
// store cannot be removed at exit; they go stale the same way.
process.on("exit", () => {
	for (const sessions of held.values()) {
		for (const marker of sessions.values()) {
			if (marker.markers instanceof FileOpenMarkers) marker.markers.removeSync(marker.sessionId, PROCESS_TOKEN);
		}
	}
});

/**
 * Records that this process has `sessionId` of `store` open, until the returned function is called, once; holds by
 * one process for one session share a marker. Never throws, and neither does the release: a marker that cannot be
 * written leaves the session unprotected.
 */
export function holdSessionOpenMarker(
	sessionId: string,
	options: { readonly store?: SessionStore; readonly agentDir?: string } = {},
): () => Promise<void> {
	if (!VALID_SESSION_ID.test(sessionId)) return async () => {};
	const markers = markersFor(options.store, options.agentDir ?? getAgentDir());
	let sessions = held.get(markers);
	if (sessions === undefined) {
		sessions = new Map();
		held.set(markers, sessions);
	}
	let marker = sessions.get(sessionId);
	if (marker === undefined) {
		marker = { markers, sessionId, holds: 0, releaseClaim: attachSessionClaim(sessionId) };
		sessions.set(sessionId, marker);
		heldCount++;
		if (markers instanceof FileOpenMarkers) {
			try {
				markers.putSync(sessionId, ownMarker());
			} catch {
				// Best effort, as above.
			}
		} else markers.put(sessionId, ownMarker()).catch(() => {});
		if (heartbeat === undefined) {
			heartbeat = setInterval(refreshMarkers, HEARTBEAT_MS);
			heartbeat.unref();
		}
	}
	const holding = marker;
	const owner = sessions;
	holding.holds++;
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		if (--holding.holds > 0) return;
		owner.delete(sessionId);
		if (owner.size === 0) held.delete(markers);
		holding.releaseClaim?.();
		if (--heldCount === 0 && heartbeat !== undefined) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		await markers.remove(sessionId, PROCESS_TOKEN).catch(() => {});
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
 * A running session, in another process or in this one, that has `sessionId` of `store` open, or undefined when none
 * does. Stale markers are removed.
 */
export async function findSessionOpenHolder(
	sessionId: string,
	options: { readonly store?: SessionStore; readonly agentDir?: string } = {},
): Promise<SessionOpenHolder | undefined> {
	if (!VALID_SESSION_ID.test(sessionId)) return undefined;
	const markers = markersFor(options.store, options.agentDir ?? getAgentDir());
	const host = hostname();
	for (const marker of await markers.list(sessionId)) {
		// With this process's pid but not its token: an earlier process given the same pid.
		const gone =
			marker.host === host &&
			(marker.pid === process.pid ? marker.token !== PROCESS_TOKEN : !processAlive(marker.pid));
		if (gone || marker.ageMs > STALE_MS) {
			await markers.remove(sessionId, marker.token).catch(() => {});
			continue;
		}
		return { pid: marker.pid, host: marker.host };
	}
	return undefined;
}

/** Rejects with a {@link SessionOpenElsewhereError} when a running session has `sessionId` of `store` open (#4971). */
export async function assertSessionNotOpenElsewhere(
	sessionId: string,
	options: { readonly store?: SessionStore; readonly agentDir?: string } = {},
): Promise<void> {
	const holder = await findSessionOpenHolder(sessionId, options);
	if (holder !== undefined) throw new SessionOpenElsewhereError(sessionId, holder);
}
