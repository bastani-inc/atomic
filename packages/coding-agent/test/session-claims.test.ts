/**
 * A resume's claim of its session (#5135): taken atomically before anything is written, refused while a live process
 * holds it, and taken over from a holder that is gone or, on another host, whose heartbeat stopped.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { exitedProcess } from "../../../test/helpers/exited-process.js";
import { setNativeLocksForTesting, TAKEOVER_MUTEX_STALE_MS, takeTakeoverMutex } from "../src/core/lock-takeover.js";
import { processStartToken } from "../src/core/process-start-token.js";
import { attachSessionClaim, claimSession, prepareSessionClaim } from "../src/core/session-claims.js";
import { SESSION_ALREADY_OPEN_EXIT_CODE, SessionAlreadyOpenError } from "../src/core/session-manager-errors.ts";
import { holdSessionOpenMarker } from "../src/core/session-open-markers.js";

let agentDir: string;
const releases: (() => void)[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "atomic-session-claims-"));
});

afterEach(() => {
	vi.useRealTimers();
	setNativeLocksForTesting(undefined);
	while (releases.length > 0) releases.pop()?.();
	for (const child of children.splice(0)) child.kill("SIGKILL");
	rmSync(agentDir, { recursive: true, force: true });
});

function newSessionId(): string {
	return `claim-${randomUUID()}`;
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

function claimedByThisProcess(sessionId: string): boolean {
	const record = JSON.parse(readFileSync(claimFile(sessionId), "utf8")) as { pid: number; host: string };
	return record.pid === process.pid && record.host === hostname();
}

describe("session claims (#5135)", () => {
	test("a claim names this process and is removed again by its release (#5135)", () => {
		const sessionId = newSessionId();
		const release = claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
		// Where it can be read, when this process started, so a later process given its pid is told apart.
		assert.equal(JSON.parse(readFileSync(claimFile(sessionId), "utf8")).started, processStartToken(process.pid));
		release();
		assert.equal(existsSync(claimFile(sessionId)), false);
		assert.deepEqual(readdirSync(join(agentDir, "session-claims")), [], "no staging file is left behind");
	});

	test("preparing the claim of a session nobody claimed, or whose claim cannot be read, never throws (#5315)", async () => {
		const sessionId = newSessionId();
		await prepareSessionClaim(sessionId, { agentDir });
		mkdirSync(claimFile(sessionId), { recursive: true });
		await prepareSessionClaim(sessionId, { agentDir });
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
				assert.equal(error.name, "SessionAlreadyOpenError");
				assert.match(error.message, new RegExp(`^Session ${sessionId} is already open in process ${pid} on `));
				return true;
			},
		);
		assert.equal(readFileSync(claimFile(sessionId), "utf8"), before);
	});

	test("a claim whose holder is gone is taken over (#5135)", async () => {
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "dead", ...exitedProcess(), host: hostname() });
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
	});

	test("a claim naming a start of its pid other than the live process's is taken over (#5135, #5141)", async () => {
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "reused", pid: await liveProcess(), host: hostname(), started: "000000000000" });
		// Linux reads a start from /proc, Windows from the process's creation time (#5141).
		if (process.platform === "linux" || process.platform === "win32") {
			claim(sessionId);
			assert.ok(claimedByThisProcess(sessionId));
		} else {
			// Without a start to compare, a live process of that pid is the holder.
			assert.throws(() => claim(sessionId), SessionAlreadyOpenError);
		}
	});

	test.skipIf(process.platform !== "linux" && process.platform !== "win32")(
		"a claim naming when its live holder started is refused (#5135, #5141)",
		async () => {
			const sessionId = newSessionId();
			const pid = await liveProcess();
			writeClaim(sessionId, { token: "live", pid, host: hostname(), started: processStartToken(pid) });
			assert.throws(() => claim(sessionId), SessionAlreadyOpenError);
		},
	);

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
	});

	test("a claim record missing its token, pid or host is taken over, though a live process has that pid (#5135)", async () => {
		const pid = await liveProcess();
		for (const record of [
			{ pid, host: hostname() },
			{ token: "t", pid: String(pid), host: hostname() },
			{ token: "t", pid },
		]) {
			const sessionId = newSessionId();
			writeClaim(sessionId, record);
			claim(sessionId);
			assert.ok(claimedByThisProcess(sessionId), JSON.stringify(record));
		}
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a holder this process may not signal still runs (#5135)",
		() => {
			const sessionId = newSessionId();
			writeClaim(sessionId, { token: "init", pid: 1, host: hostname() });
			assert.throws(() => claim(sessionId), SessionAlreadyOpenError);
		},
	);

	test("a claim that cannot be read stops the claim with the read error (#5135)", () => {
		const sessionId = newSessionId();
		mkdirSync(claimFile(sessionId), { recursive: true });
		assert.throws(
			() => claim(sessionId),
			(error: unknown) =>
				!(error instanceof SessionAlreadyOpenError) && (error as NodeJS.ErrnoException).code !== undefined,
		);
	});

	test("a held claim's heartbeat keeps it fresh until its last claim is released (#5135)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const sessionId = newSessionId();
		const release = claim(sessionId);
		const releaseOther = claim(newSessionId());
		assert.equal(vi.getTimerCount(), 1, "one heartbeat serves every claim");
		releaseOther();
		assert.equal(vi.getTimerCount(), 1, "the heartbeat runs while a claim is held");
		const old = new Date(Date.now() - 50_000);
		utimesSync(claimFile(sessionId), old, old);
		vi.advanceTimersByTime(15_000);
		for (let attempt = 0; attempt < 200 && Date.now() - statSync(claimFile(sessionId)).mtimeMs >= 10_000; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(Date.now() - statSync(claimFile(sessionId)).mtimeMs < 10_000, "the heartbeat refreshed the claim");
		release();
		assert.equal(vi.getTimerCount(), 0, "no heartbeat runs without claims");
	});

	test("a release run again after the session was claimed anew leaves the new claim (#5135)", () => {
		const sessionId = newSessionId();
		const first = claim(sessionId);
		first();
		claim(sessionId);
		first();
		assert.ok(claimedByThisProcess(sessionId));
	});

	test("a claim of another host counts while its heartbeat runs and is taken over once it stopped (#5135)", () => {
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "remote", pid: 1, host: "another-host" }, 30_000);
		assert.throws(() => claim(sessionId), SessionAlreadyOpenError);
		writeClaim(sessionId, { token: "remote", pid: 1, host: "another-host" }, 61_000);
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
	});

	test("without the native lock, a takeover lock left by a dead process is broken (#5135)", async () => {
		setNativeLocksForTesting(null);
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "dead", ...exitedProcess(), host: hostname() });
		const lock = `${claimFile(sessionId)}.takeover`;
		mkdirSync(lock);
		const at = new Date(Date.now() - 11_000);
		utimesSync(lock, at, at);
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
		assert.equal(existsSync(lock), false);
	});

	test("without the native lock, a takeover lock held by a live takeover is waited out, then the claim is reported held (#5135)", async () => {
		setNativeLocksForTesting(null);
		const sessionId = newSessionId();
		const dead = exitedProcess();
		writeClaim(sessionId, { token: "dead", ...dead, host: hostname() });
		const lock = `${claimFile(sessionId)}.takeover`;
		mkdirSync(lock);
		// The lock names no owner, as a takeover's does between making it and naming itself, and it is held until it is
		// TAKEOVER_MUTEX_STALE_MS old. The claim's attempts can outlast that on a loaded host, so the clock is kept at the
		// last instant before it however long they take.
		vi.useFakeTimers({ toFake: ["Date"], now: Math.floor(statSync(lock).mtimeMs) + TAKEOVER_MUTEX_STALE_MS - 1 });
		assert.throws(
			() => claim(sessionId),
			(error: unknown) => error instanceof SessionAlreadyOpenError && error.pid === dead.pid,
		);
	});

	test("an advisory takeover lock held by a live takeover is waited out, then the claim is reported held (#5193)", async () => {
		const sessionId = newSessionId();
		const dead = exitedProcess();
		writeClaim(sessionId, { token: "dead", ...dead, host: hostname() });
		const mutex = takeTakeoverMutex(claimFile(sessionId));
		assert.ok(mutex);
		try {
			assert.throws(
				() => claim(sessionId),
				(error: unknown) => error instanceof SessionAlreadyOpenError && error.pid === dead.pid,
			);
			assert.equal(JSON.parse(readFileSync(claimFile(sessionId), "utf8")).token, "dead", "the claim is left to it");
		} finally {
			mutex.release();
		}
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId), "once released, the dead claim is taken over");
	});

	test("a takeover directory a killed process left behind does not stop the takeover (#5193)", async () => {
		const sessionId = newSessionId();
		writeClaim(sessionId, { token: "dead", ...exitedProcess(), host: hostname() });
		mkdirSync(`${claimFile(sessionId)}.takeover`);
		writeFileSync(
			join(`${claimFile(sessionId)}.takeover`, "owner"),
			JSON.stringify({ host: hostname(), ...exitedProcess(), id: "killed" }),
		);
		claim(sessionId);
		assert.ok(claimedByThisProcess(sessionId));
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

	test("only a held claim is handed to an open marker, and only once (#5135)", async () => {
		const sessionId = newSessionId();
		assert.equal(attachSessionClaim(sessionId), undefined);
		claim(sessionId);
		const detach = attachSessionClaim(sessionId);
		assert.ok(detach);
		assert.equal(attachSessionClaim(sessionId), undefined);
		await detach();
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
