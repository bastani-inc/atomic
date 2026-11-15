/**
 * A resume's claim of its session (#5135): taken atomically before anything is written, refused while a live process
 * holds it, and taken over from a holder that is gone or, on another host, whose heartbeat stopped.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { attachSessionClaim, claimSession } from "../src/core/session-claims.ts";
import { SESSION_ALREADY_OPEN_EXIT_CODE, SessionAlreadyOpenError } from "../src/core/session-manager-errors.ts";
import { holdSessionOpenMarker } from "../src/core/session-open-markers.ts";

let agentDir: string;
let sessionCount = 0;
const releases: (() => void)[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "atomic-session-claims-"));
});

afterEach(() => {
	while (releases.length > 0) releases.pop()?.();
	for (const child of children.splice(0)) child.kill("SIGKILL");
	rmSync(agentDir, { recursive: true, force: true });
});

function newSessionId(): string {
	return `claim-${process.pid}-${++sessionCount}`;
}

function claimFile(sessionId: string): string {
	return join(agentDir, "session-claims", `${sessionId}.json`);
}

function claim(sessionId: string): () => void {
	const release = claimSession(sessionId, { agentDir });
	releases.push(release);
	return release;
}

/** Leaves a claim for `sessionId` as another process wrote it. */
function writeClaim(sessionId: string, record: object, ageMs = 0): void {
	mkdirSync(join(agentDir, "session-claims"), { recursive: true });
	writeFileSync(claimFile(sessionId), JSON.stringify(record));
	if (ageMs > 0) {
		const at = new Date(Date.now() - ageMs);
		utimesSync(claimFile(sessionId), at, at);
	}
}

/** A live process other than this one. */
async function liveProcess(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
	return child.pid!;
}

/** The pid of a process that ran and is gone. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return child.pid!;
}

function claimedByThisProcess(sessionId: string): boolean {
	const record = JSON.parse(readFileSync(claimFile(sessionId), "utf8")) as { pid: number; host: string };
	return record.pid === process.pid && record.host === hostname();
}

describe("session claims (#5135)", () => {
	test("a claim names this process and is removed again by its release (#5135)", () => {
		const sessionId = newSessionId();
		const release = claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
		release();
		assert.equal(existsSync(claimFile(sessionId)), false);
		assert.deepEqual(readdirSync(join(agentDir, "session-claims")), [], "no staging file is left behind");
	});

	test("a second claim by the holding process keeps the claim (#5135)", () => {
		const sessionId = newSessionId();
		claim(sessionId);
		claim(sessionId)();
		assert.ok(claimedByThisProcess(sessionId));
	});

	test("a claim of a live process is refused with its pid and host, and left as it is (#5135)", async () => {
		const sessionId = newSessionId();
		const pid = await liveProcess();
		writeClaim(sessionId, { token: "other", pid, host: hostname() });
		const before = readFileSync(claimFile(sessionId), "utf8");
		assert.throws(
			() => claim(sessionId),
			(error: unknown) => {
				assert.ok(error instanceof SessionAlreadyOpenError);
				assert.equal(error.sessionId, sessionId);
				assert.equal(error.pid, pid);
				assert.equal(error.host, hostname());
				assert.equal(error.exitCode, SESSION_ALREADY_OPEN_EXIT_CODE);
				assert.equal(error.exitCode, 75);
				assert.match(error.message, new RegExp(`^Session ${sessionId} is already open in process ${pid} on `));
				return true;
			},
		);
		assert.equal(readFileSync(claimFile(sessionId), "utf8"), before);
	});

	test("a claim whose holder is gone is taken over (#5135)", async () => {
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "dead", pid: await deadPid(), host: hostname() });
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
	});

	test("a claim naming a start of its pid other than the live process's is taken over (#5135)", async () => {
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "reused", pid: await liveProcess(), host: hostname(), started: "000000000000" });
		if (process.platform === "linux") {
			claim(sessionId);
			assert.ok(claimedByThisProcess(sessionId));
		} else {
			// Without a start to compare, a live process of that pid is the holder.
			assert.throws(() => claim(sessionId), SessionAlreadyOpenError);
		}
	});

	test("an earlier process given this process's pid does not hold the claim (#5135)", () => {
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "earlier", pid: process.pid, host: hostname() });
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
	});

	test("a claim that is not a claim record is taken over (#5135)", () => {
		const sessionId = newSessionId();
		mkdirSync(join(agentDir, "session-claims"), { recursive: true });
		writeFileSync(claimFile(sessionId), "{not json");
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
		const otherId = newSessionId();
		writeClaim(otherId, { token: 1, pid: "x", host: null });
		claim(otherId);
		assert.ok(claimedByThisProcess(otherId));
	});

	test("a claim of another host counts while its heartbeat runs and is taken over once it stopped (#5135)", () => {
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "remote", pid: 1, host: "another-host" }, 30_000);
		assert.throws(() => claim(sessionId), SessionAlreadyOpenError);
		writeClaim(sessionId, { token: "remote", pid: 1, host: "another-host" }, 61_000);
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
	});

	test("a takeover lock left by a dead process is broken (#5135)", async () => {
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "dead", pid: await deadPid(), host: hostname() });
		const lock = `${claimFile(sessionId)}.takeover`;
		mkdirSync(lock);
		const at = new Date(Date.now() - 11_000);
		utimesSync(lock, at, at);
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
		assert.equal(existsSync(lock), false);
	});

	test("a takeover lock held by a live takeover is waited out, then the claim is reported held (#5135)", async () => {
		const sessionId = newSessionId();
		const dead = await deadPid();
		writeClaim(sessionId, { token: "dead", pid: dead, host: hostname() });
		mkdirSync(`${claimFile(sessionId)}.takeover`);
		assert.throws(
			() => claim(sessionId),
			(error: unknown) => error instanceof SessionAlreadyOpenError && error.pid === dead,
		);
	});

	test("a claim the session's open marker took over lasts until the session closes (#5135)", async () => {
		const sessionId = newSessionId();
		const release = claim(sessionId);
		const closeSession = holdSessionOpenMarker(sessionId, { agentDir });
		release();
		assert.ok(claimedByThisProcess(sessionId), "the open session keeps the claim");
		await closeSession();
		assert.equal(existsSync(claimFile(sessionId)), false, "closing the session releases the claim");
	});

	test("only a held claim is handed to an open marker, and only once (#5135)", () => {
		const sessionId = newSessionId();
		assert.equal(attachSessionClaim(sessionId), undefined);
		claim(sessionId);
		const detach = attachSessionClaim(sessionId);
		assert.ok(detach);
		assert.equal(attachSessionClaim(sessionId), undefined);
		detach();
		assert.equal(existsSync(claimFile(sessionId)), false);
	});

	test("a release leaves a claim another process took over meanwhile (#5135)", async () => {
		const sessionId = newSessionId();
		const release = claim(sessionId);
		const pid = await liveProcess();
		writeClaim(sessionId, { token: "other", pid, host: hostname() });
		release();
		assert.equal(JSON.parse(readFileSync(claimFile(sessionId), "utf8")).pid, pid);
	});
});
