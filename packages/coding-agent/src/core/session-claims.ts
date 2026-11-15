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

import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { processStartToken } from "./process-start-token.ts";
import { SessionAlreadyOpenError } from "./session-manager-errors.js";

/** How often a held claim's heartbeat is refreshed. */
const HEARTBEAT_MS = 15_000;
/** How old the heartbeat of a claim of another host may be before the claim no longer counts. */
const STALE_MS = 4 * HEARTBEAT_MS;
/** How long a takeover may hold the takeover lock before another process breaks it as left by a dead one. */
const TAKEOVER_LOCK_STALE_MS = 10_000;
/** Attempts to claim a session whose claims keep changing hands under this process. */
const MAX_ATTEMPTS = 100;
/** How long a claim waits before it looks again while another process takes a dead claim over. */
const TAKEOVER_WAIT_MS = 20;
/** Tells this process's claims from an earlier process given the same pid. */
const PROCESS_TOKEN = `${process.pid}-${randomBytes(8).toString("hex")}`;
const PROCESS_START = processStartToken(process.pid);

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
	try {
		const parsed = JSON.parse(text) as Partial<ClaimRecord>;
		if (typeof parsed.token !== "string" || typeof parsed.pid !== "number" || typeof parsed.host !== "string") {
			return { record: undefined, ageMs };
		}
		return {
			record: {
				token: parsed.token,
				pid: parsed.pid,
				host: parsed.host,
				started: typeof parsed.started === "string" ? parsed.started : undefined,
			},
			ageMs,
		};
	} catch {
		// Never written by a claim, which is linked into place only once complete.
		return { record: undefined, ageMs };
	}
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
	if (record.pid === process.pid) return record.token === PROCESS_TOKEN;
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
		rmSync(staging, { force: true });
	}
}

/**
 * Removes the claim at `path` when it is still the one with `token` that was found dead. Takeovers take turns under a
 * lock directory, so one never removes a claim another takeover just linked.
 */
function removeDeadClaim(path: string, token: string | undefined): void {
	const lock = `${path}.takeover`;
	try {
		mkdirSync(lock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		try {
			// A process that died while taking a claim over leaves the lock behind.
			if (Date.now() - statSync(lock).mtimeMs > TAKEOVER_LOCK_STALE_MS) rmdirSync(lock);
			else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TAKEOVER_WAIT_MS);
		} catch {
			// Released or broken by another process meanwhile.
		}
		return;
	}
	try {
		const current = readClaim(path);
		if (current !== undefined && current.record?.token === token) rmSync(path, { force: true });
	} finally {
		rmdirSync(lock);
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
		if (ownClaim(claim.path)) rmSync(claim.path, { force: true });
	} catch {
		// Gone already; a claim left behind is taken over once this process is gone.
	}
}

// A process that exits with claims removes them; one killed leaves them for the next resume to take over.
process.on("exit", () => {
	for (const [sessionId, claim] of held) dropClaim(sessionId, claim);
});

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
	const record: ClaimRecord = {
		token: PROCESS_TOKEN,
		pid: process.pid,
		host: hostname(),
		...(PROCESS_START === undefined ? {} : { started: PROCESS_START }),
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
