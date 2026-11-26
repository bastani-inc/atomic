/**
 * Which sessions are running (#4971): a process that runs a session keeps a marker for it, refreshed on a heartbeat and
 * removed when the session closes or the process exits. A store that keeps markers (`SessionStore.openMarkers`, a table
 * in a SQL store) holds them, so every host and agent directory sharing the store sees them; for any other store they
 * are files under the agent directory, `open-sessions/<session id>/<token>.json`. Deleting a session that has a fresh
 * marker, from another process or from another session of the same process, is refused. A marker of a process on
 * this host counts while that process runs, however long it was suspended; one of another host counts while its
 * heartbeat is fresh, judged on the clock that stamps the marker (#5058): the store's, or the shared file system's.
 */

import { randomBytes } from "node:crypto";
import { rmdirSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, VERSION } from "../config.js";
import { reportDebugAsync } from "./debug.ts";
import { ownProcessStartToken, readProcessStartToken } from "./process-start-token.js";
import { attachSessionClaim } from "./session-claims.js";
import { SessionOpenElsewhereError } from "./session-manager-errors.js";
import { setSharedHistorySwitchHost } from "./storage/session/shared-history-switch.js";
import type {
	SessionOpenMarker,
	SessionOpenMarkerAge,
	SessionOpenMarkerStore,
	SessionStore,
} from "./storage/session/types.js";
import { sharedClockNow } from "./worktree-snapshot/shared-clock.ts";

/** How often a held marker's heartbeat is refreshed. */
const HEARTBEAT_MS = 15_000;
/** How old the heartbeat of another host's marker may be before the marker no longer counts. */
const STALE_MS = 4 * HEARTBEAT_MS;
/**
 * How long a marker of this host that does not say when its holder started counts while a process with its pid runs: a
 * later process may have been given the pid (#5058).
 */
const UNSTARTED_MARKER_LIMIT_MS = 24 * 60 * 60_000;
const PROCESS_NONCE = randomBytes(8).toString("hex");
let processToken: string | undefined;

/**
 * This process's markers: its pid, a nonce that tells it from an earlier process given the same pid, and when it
 * started, where that can be read, which tells it from a later one (#5058). Fixed once first used.
 */
function ownToken(): string {
	if (processToken === undefined) {
		const started = ownProcessStartToken();
		processToken = `${process.pid}-${PROCESS_NONCE}${started === undefined ? "" : `-${started}`}`;
	}
	return processToken;
}

export async function prepareSessionOpenMarkers(): Promise<void> {
	await readProcessStartToken(process.pid);
}

/** A marker token that names when its holder started. */
const STARTED_TOKEN = /^\d+-[0-9a-f]{16}-([0-9a-f]{12})$/;
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
	private readonly pending = new Map<string, Promise<void>>();

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	private directory(sessionId: string): string {
		return join(this.agentDir, "open-sessions", sessionId);
	}

	private inOrder(path: string, operation: () => Promise<void>): Promise<void> {
		const result = (this.pending.get(path) ?? Promise.resolve()).then(operation);
		const settled = result.catch(() => {});
		this.pending.set(path, settled);
		void settled.then(() => {
			if (this.pending.get(path) === settled) this.pending.delete(path);
		});
		return result;
	}

	put(sessionId: string, marker: SessionOpenMarker): Promise<void> {
		const path = join(this.directory(sessionId), `${marker.token}.json`);
		return this.inOrder(path, async () => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify({ pid: marker.pid, host: marker.host }));
		});
	}

	remove(sessionId: string, token: string): Promise<void> {
		const directory = this.directory(sessionId);
		const path = join(directory, `${token}.json`);
		return this.inOrder(path, async () => {
			try {
				await rm(path);
				await rmdir(directory);
			} catch {}
		});
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
		await Promise.all([...this.pending].flatMap(([path, settled]) => (dirname(path) === directory ? [settled] : [])));
		let names: string[];
		try {
			names = await readdir(directory);
		} catch {
			return [];
		}
		if (names.length === 0) return [];
		// Ages on the clock that stamps the files, which hosts sharing the agent directory share (#5058).
		const now = await sharedClockNow(dirname(directory));
		const markers: SessionOpenMarkerAge[] = [];
		for (const name of names) {
			const path = join(directory, name);
			try {
				const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; host?: unknown };
				if (typeof parsed.pid !== "number" || typeof parsed.host !== "string") continue;
				const token = name.replace(/\.json$/, "");
				const ageMs = Math.max(0, now - (await stat(path)).mtimeMs);
				markers.push({ token, pid: parsed.pid, host: parsed.host, ageMs });
			} catch {
				// Being written or removed right now, or not a marker.
			}
		}
		return markers;
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
	readonly releaseClaim: (() => Promise<void>) | undefined;
}

/** Markers this process holds, by store and then session id. */
const held = new Map<SessionOpenMarkerStore, Map<string, HeldMarker>>();
let heldCount = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function ownMarker(): SessionOpenMarker {
	return { token: ownToken(), pid: process.pid, host: hostname(), build: VERSION };
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
			if (marker.markers instanceof FileOpenMarkers) marker.markers.removeSync(marker.sessionId, ownToken());
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
		markers.put(sessionId, ownMarker()).catch(() => {});
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
		const releasingClaim = holding.releaseClaim?.();
		if (--heldCount === 0 && heartbeat !== undefined) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		await releasingClaim;
		if (held.get(markers)?.has(sessionId)) return;
		await markers.remove(sessionId, ownToken()).catch(() => {});
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
 * Whether the holder of `marker`, a marker of this host, still runs (#5058): a process with its pid that started when
 * the marker says, or, for a marker that does not say, any process with its pid for a day after its last heartbeat. A
 * marker whose start cannot be read right now is its holder's while a process with its pid runs (#5141).
 */
async function holderRuns(marker: SessionOpenMarkerAge): Promise<boolean> {
	if (marker.pid === process.pid) {
		await prepareSessionOpenMarkers();
		return marker.token === ownToken();
	}
	const started = STARTED_TOKEN.exec(marker.token)?.[1];
	const current = started === undefined ? undefined : await readProcessStartToken(marker.pid);
	if (current !== undefined) return current === started;
	// A start recorded yet unreadable right now, as when a read timed out, never makes a running process another one
	// (#5141); only a marker naming no start is judged by its age.
	return (started !== undefined || marker.ageMs <= UNSTARTED_MARKER_LIMIT_MS) && processAlive(marker.pid);
}

/**
 * Whether the process that keeps `marker` still runs, as {@link findSessionOpenHolder} judges it: one of this host while
 * it runs, however long it was suspended; one of another host while its heartbeat is fresh.
 */
export async function sessionOpenMarkerRuns(marker: SessionOpenMarkerAge): Promise<boolean> {
	return marker.host === hostname() ? await holderRuns(marker) : marker.ageMs <= STALE_MS;
}

// A session store's open switches it to shared-history forks only once no older Atomic runs a session there (#6560): it
// judges their markers as this module does, and notes a switch it leaves for later in the debug log.
setSharedHistorySwitchHost({
	live: sessionOpenMarkerRuns,
	skipped: (fields) => {
		reportDebugAsync("storage", "shared-history-forks-deferred", fields).catch(() => {});
	},
});

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
		// A process of this host is judged by whether it runs, never by its heartbeat, which a suspended one misses.
		if (marker.host === host ? !(await holderRuns(marker)) : marker.ageMs > STALE_MS) {
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
