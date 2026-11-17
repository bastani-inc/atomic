/**
 * Which process resumed a session (#5135): `atomic --session`, `--resume` and `--continue` claim the session they open
 * before they write to it or restore its checkouts, so that two processes never resume one session at once. A claim is
 * a file `session-claims/<session id>.json` under the agent directory, created atomically: it is written in full under
 * a name of its own, flushed, and then linked into place, which fails when a claim is already there. It names the
 * holder's host, pid and, where that can be read, when the holder started, so a later process given the same pid is
 * never taken for the holder. A claim whose holder on this host is gone, as after SIGKILL, or whose heartbeat stopped,
 * for a holder on another host sharing the agent directory, is taken over. A claim is released when the session it
 * was taken for closes in this process, and at exit.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { prepareTakeoverMutex, putBack, removeAside, takeTakeoverMutex } from "./lock-takeover.js";
import { processStartToken } from "./process-start-token.js";
import { SessionAlreadyOpenError } from "./session-manager-errors.js";

/** How often a held claim's heartbeat is refreshed. */
const HEARTBEAT_MS = 15_000;
/** How old the heartbeat of a claim of another host may be before the claim no longer counts. */
const STALE_MS = 4 * HEARTBEAT_MS;
/** Attempts to claim a session whose claims keep changing hands under this process. */
const MAX_ATTEMPTS = 100;
/** How long a claim waits before it looks again while another process takes a dead claim over. */
const TAKEOVER_WAIT_MS = 20;
/** Tells this process's claims from an earlier process given the same pid. */
const PROCESS_TOKEN = `${process.pid}-${randomBytes(8).toString("hex")}`;

interface ClaimRecord {
	readonly token: string;
	readonly pid: number;
	readonly host: string;
	readonly started?: string;
}

interface HeldClaim {
	readonly path: string;
	/** Whether the session's open marker took this claim over: closing the session releases the claim. */
	attached: boolean;
}

/** The claims this process holds, by session id. */
const held = new Map<string, HeldClaim>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

function claimPath(agentDir: string, sessionId: string): string {
	return join(agentDir, "session-claims", `${sessionId}.json`);
}

function readClaim(path: string): { readonly record: ClaimRecord | undefined; readonly ageMs: number } | undefined {
	let text: string;
	let ageMs: number;
	try {
		ageMs = Date.now() - statSync(path).mtimeMs;
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let parsed: Partial<ClaimRecord> | undefined;
	try {
		parsed = JSON.parse(text) as Partial<ClaimRecord>;
	} catch {
		// Never written by a claim, which is linked into place only once complete.
	}
	const valid = typeof parsed?.token === "string" && typeof parsed.pid === "number" && typeof parsed.host === "string";
	return { record: valid ? (parsed as ClaimRecord) : undefined, ageMs };
}

/** Whether `pid` is a live process on this host; one this process may not signal (EPERM) still exists. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether the process that wrote `record` still runs, by its pid and when it started, as worktree leases are judged. */
function holderRuns(record: ClaimRecord, ageMs: number): boolean {
	if (record.host !== hostname()) return ageMs <= STALE_MS;
	// This process's pid: an earlier process given it, or a claim of this process it no longer holds.
	if (record.pid === process.pid) return false;
	const started = record.started === undefined ? undefined : processStartToken(record.pid);
	if (started !== undefined) return started === record.started;
	return processAlive(record.pid);
}

/** Writes `record` in full under a name of its own, flushed, and links it to `path`; false when a claim is there. */
function linkClaim(path: string, record: ClaimRecord): boolean {
	const staging = `${path}.${record.token}.tmp`;
	const fd = openSync(staging, "w");
	try {
		writeSync(fd, JSON.stringify(record));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(staging, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		rmSync(staging);
	}
}

/** Whether the claim read from `path` is still the dead one with `token` that was judged. */
function stillDead(claim: ReturnType<typeof readClaim>, token: string | undefined): boolean {
	if (claim === undefined || claim.record?.token !== token) return false;
	return claim.record === undefined || !holderRuns(claim.record, claim.ageMs);
}

/**
 * Removes the claim at `path` when it is still the one with `token` that was found dead (#5179). Takeovers take turns
 * under the takeover mutex, an advisory lock the kernel releases when its holder dies (#5193), and the whole removal
 * runs while it is held: the claim is judged again inside it and moved aside, and removed only when the moved record is
 * the dead one. A claim moved that is not is linked back only while no claim is in its place, never replacing one. A
 * mutex held elsewhere is contention: the caller looks again.
 */
function removeDeadClaim(path: string, token: string | undefined): void {
	const mutex = takeTakeoverMutex(path, TAKEOVER_WAIT_MS);
	if (mutex === undefined) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TAKEOVER_WAIT_MS);
		return;
	}
	try {
		if (!stillDead(readClaim(path), token) || !mutex.owned()) return;
		const aside = `${path}.${randomUUID()}.dead`;
		try {
			renameSync(path, aside);
		} catch {
			// Gone meanwhile: the next attempt links a claim in its place.
			return;
		}
		if (readClaim(aside)?.record?.token === token) removeAside(aside);
		else putBack(aside, path);
	} finally {
		mutex.release();
	}
}

function refreshClaims(): void {
	const now = new Date();
	for (const claim of held.values()) {
		try {
			utimesSync(claim.path, now, now);
		} catch {
			// Best effort: only a holder on another host is judged by its heartbeat.
		}
	}
}

function ownClaim(path: string): boolean {
	return readClaim(path)?.record?.token === PROCESS_TOKEN;
}

function dropClaim(sessionId: string, claim: HeldClaim): void {
	if (held.get(sessionId) !== claim) return;
	held.delete(sessionId);
	if (held.size === 0 && heartbeat !== undefined) {
		clearInterval(heartbeat);
		heartbeat = undefined;
	}
	try {
		if (ownClaim(claim.path)) rmSync(claim.path);
	} catch {
		// Gone already; a claim left behind is taken over once this process is gone.
	}
}

// A process that exits with claims removes them; one killed leaves them for the next resume to take over.
process.on("exit", () => {
	for (const [sessionId, claim] of held) dropClaim(sessionId, claim);
});

export async function prepareSessionClaim(sessionId: string, options: { readonly agentDir: string }): Promise<void> {
	const path = claimPath(options.agentDir, sessionId);
	const holder = claimHolder(path);
	await prepareTakeoverMutex(path, holder);
}

function claimHolder(path: string): ClaimRecord | undefined {
	try {
		return readClaim(path)?.record;
	} catch {
		return undefined;
	}
}

/**
 * Claims `sessionId` for this process before a resume writes to it or restores its checkouts (#5135). Rejects with a
 * {@link SessionAlreadyOpenError} naming the holder, having changed nothing, when another live process holds it. A
 * claim this process holds already is kept as it is. Returns a release for a resume that stops before its session
 * opens; once the session's open marker took the claim over (see {@link attachSessionClaim}) the release does
 * nothing, and the claim lasts until the session closes or this process exits.
 */
export function claimSession(sessionId: string, options: { readonly agentDir: string }): () => void {
	// Held by this process already: its holder keeps it.
	if (held.has(sessionId)) return () => {};
	const path = claimPath(options.agentDir, sessionId);
	mkdirSync(join(options.agentDir, "session-claims"), { recursive: true });
	const started = processStartToken(process.pid);
	const record: ClaimRecord = {
		token: PROCESS_TOKEN,
		pid: process.pid,
		host: hostname(),
		...(started === undefined ? {} : { started }),
	};
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (linkClaim(path, record)) {
			const claim: HeldClaim = { path, attached: false };
			held.set(sessionId, claim);
			if (heartbeat === undefined) {
				heartbeat = setInterval(refreshClaims, HEARTBEAT_MS);
				heartbeat.unref();
			}
			return () => {
				if (!claim.attached) dropClaim(sessionId, claim);
			};
		}
		const current = readClaim(path);
		if (current === undefined) continue;
		if (current.record !== undefined && holderRuns(current.record, current.ageMs)) {
			throw new SessionAlreadyOpenError(sessionId, current.record);
		}
		removeDeadClaim(path, current.record?.token);
	}
	const current = readClaim(path)?.record;
	throw new SessionAlreadyOpenError(sessionId, current ?? { pid: 0, host: "unknown" });
}

/**
 * Hands the claim this process holds for `sessionId`, if any, to the session's open marker (#5135): the claim then
 * lasts until the returned function is called, when the session closes.
 */
export function attachSessionClaim(sessionId: string): (() => void) | undefined {
	const claim = held.get(sessionId);
	if (claim === undefined || claim.attached) return undefined;
	claim.attached = true;
	return () => dropClaim(sessionId, claim);
}
