import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { processStartToken, setNativeProcessCreationTimeForTesting } from "../src/core/process-start-token.ts";
import { claimSession, prepareSessionClaim } from "../src/core/session-claims.ts";
import {
	findSessionOpenHolder,
	holdSessionOpenMarker,
	prepareSessionOpenMarkers,
} from "../src/core/session-open-markers.ts";
import { HOST, holderRuns, thisProcess } from "../src/core/worktree-snapshot/process-holder.ts";

const windows = process.platform === "win32";
const GONE_START = "abcdefabcdef";
const UNSTARTED_LIMIT_MS = 60_000;
const POWERSHELL_READS_TIMEOUT_MS = 60_000;

let agentDir: string;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "atomic-process-start-callers-"));
});

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	setNativeProcessCreationTimeForTesting(undefined);
	rmSync(agentDir, { recursive: true, force: true });
});

async function runningProcess(): Promise<{ readonly pid: number; readonly start: string | undefined }> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const exited = new Promise((resolve) => child.once("exit", resolve));
	await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
	cleanups.push(async () => {
		child.kill("SIGKILL");
		await exited;
	});
	return { pid: child.pid!, start: processStartToken(child.pid!) };
}

describe("callers reading starts without the native module (#5315)", () => {
	test.skipIf(!windows)(
		"a resume takes over a claim whose holder is gone though another process has its pid, and names this process's start (#5315)",
		async () => {
			const own = processStartToken(process.pid);
			const later = await runningProcess();
			setNativeProcessCreationTimeForTesting(null);
			const sessionId = "11111111-1111-4111-8111-111111111111";
			const path = join(agentDir, "session-claims", `${sessionId}.json`);
			mkdirSync(join(agentDir, "session-claims"), { recursive: true });
			writeFileSync(path, JSON.stringify({ token: "gone", pid: later.pid, host: hostname(), started: GONE_START }));

			await prepareSessionClaim(sessionId, { agentDir });
			cleanups.push(claimSession(sessionId, { agentDir }));

			const claim = JSON.parse(readFileSync(path, "utf8")) as { pid: number; started?: string };
			assert.equal(claim.pid, process.pid);
			assert.equal(claim.started, own);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"a session's open marker counts while its holder runs, not once another process has its pid, and names this process's start (#5315)",
		async () => {
			const own = processStartToken(process.pid);
			const holder = await runningProcess();
			setNativeProcessCreationTimeForTesting(null);
			const sessionId = "22222222-2222-4222-8222-222222222222";
			const markers = join(agentDir, "open-sessions", sessionId);
			const marker = (nonce: string, start: string | undefined) => {
				mkdirSync(markers, { recursive: true });
				writeFileSync(
					join(markers, `${holder.pid}-${nonce.repeat(16)}-${start}.json`),
					JSON.stringify({ pid: holder.pid, host: hostname() }),
				);
			};

			marker("0", GONE_START);
			assert.equal(await findSessionOpenHolder(sessionId, { agentDir }), undefined);
			marker("1", holder.start);
			assert.deepEqual(await findSessionOpenHolder(sessionId, { agentDir }), { pid: holder.pid, host: hostname() });

			const ownSession = "33333333-3333-4333-8333-333333333333";
			await prepareSessionOpenMarkers();
			cleanups.push(holdSessionOpenMarker(ownSession, { agentDir }));
			const [name] = readdirSync(join(agentDir, "open-sessions", ownSession));
			assert.match(name ?? "", new RegExp(`^${process.pid}-[0-9a-f]{16}-${own}\\.json$`));
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"a pooled worktree's or download's holder runs only while its start matches, and this process names its own (#5315)",
		async () => {
			const own = processStartToken(process.pid);
			const holder = await runningProcess();
			setNativeProcessCreationTimeForTesting(null);
			assert.equal(
				await holderRuns({ host: HOST, pid: holder.pid, start: GONE_START }, 0, UNSTARTED_LIMIT_MS),
				false,
			);
			assert.equal(
				await holderRuns({ host: HOST, pid: holder.pid, start: holder.start }, 0, UNSTARTED_LIMIT_MS),
				true,
			);
			assert.equal((await thisProcess()).start, own);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);
});
