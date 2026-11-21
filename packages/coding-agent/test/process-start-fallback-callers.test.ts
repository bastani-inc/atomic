import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage-backends.js";
import { lockHolderPath } from "../src/core/lock-holder.js";
import {
	lockHolder,
	setNativeLocksForTesting,
	takeoverMutexPath,
	takeTakeoverMutex,
} from "../src/core/lock-takeover.js";
import {
	processStartToken,
	readProcessStartToken,
	setNativeProcessCreationTimeForTesting,
	setProcessCreationTimeQueryForTesting,
} from "../src/core/process-start-token.js";
import { claimSession, prepareSessionClaim } from "../src/core/session-claims.js";
import {
	findSessionOpenHolder,
	holdSessionOpenMarker,
	prepareSessionOpenMarkers,
} from "../src/core/session-open-markers.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { FileSettingsStorage } from "../src/core/settings-storage.js";
import type { SettingsScope } from "../src/core/settings-types.js";
import { ProjectTrustStore } from "../src/core/trust-manager.js";
import { HOST, holderRuns, thisProcess } from "../src/core/worktree-snapshot/process-holder.js";

const windows = process.platform === "win32";
const GONE_START = "abcdefabcdef";
const MISSING_PID = 2 ** 22 + 7;
const UNSTARTED_LIMIT_MS = 60_000;
const POWERSHELL_READS_TIMEOUT_MS = 60_000;
/** How long a test waits for a marker published off the event loop: a file write, which a loaded machine delays. */
const MARKER_PUBLISHED_TIMEOUT_MS = 15_000;
const NATIVE_MODULE_PATH = createRequire(import.meta.url).resolve("@bastani/atomic-natives");

/**
 * Has the fallback's bounded query answered by a Node child that reads the start with the native module, instead of by
 * PowerShell. On a loaded machine PowerShell alone can take longer to start than the query's bound, which leaves that
 * read without a start; the tests that use this check what callers do with a start the fallback reads, and
 * process-start-token.test.ts checks PowerShell's reads.
 */
function answerStartQueriesQuickly(): void {
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: (pid) => [
			"-e",
			`const created = require(${JSON.stringify(NATIVE_MODULE_PATH)}).processCreationTime(${pid}); if (created) process.stdout.write(created);`,
		],
	});
}

let agentDir: string;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "atomic-process-start-callers-"));
});

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	setProcessCreationTimeQueryForTesting(undefined);
	setNativeLocksForTesting(undefined);
	setNativeProcessCreationTimeForTesting(undefined);
	rmSync(agentDir, { recursive: true, force: true });
});

function watchEventLoop(): { stop(): number } {
	let last = performance.now();
	let longestStallMs = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		longestStallMs = Math.max(longestStallMs, now - last);
		last = now;
	}, 5);
	return {
		stop: () => {
			clearInterval(timer);
			return Math.max(longestStallMs, performance.now() - last);
		},
	};
}

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
	for (const target of ["trust", "auth"] as const) {
		test.skipIf(!windows)(
			`a cold synchronous ${target} save recovers a stale lock and reused mutex pid with PowerShell (#5315)`,
			async () => {
				const later = await runningProcess();
				const path = join(agentDir, `${target}.json`);
				writeFileSync(path, "{}");
				const lockPath = `${path}.lock`;
				mkdirSync(lockPath);
				const stale = new Date(Date.now() - 60_000);
				utimesSync(lockPath, stale, stale);
				const mutexPath = takeoverMutexPath(lockPath);
				mkdirSync(mutexPath);
				writeFileSync(
					join(mutexPath, "owner"),
					JSON.stringify({ host: hostname(), pid: later.pid, started: GONE_START, id: "old-owner" }),
				);
				setNativeLocksForTesting(null);
				setNativeProcessCreationTimeForTesting(null);
				if (target === "trust") {
					const store = new ProjectTrustStore(agentDir);
					store.set(agentDir, true);
					assert.equal(store.get(agentDir), true);
				} else {
					const backend = new FileAuthStorageBackend(path);
					backend.withLock(() => ({ result: undefined, next: JSON.stringify({ saved: true }) }));
					assert.equal((JSON.parse(backend.read() ?? "{}") as { saved?: boolean }).saved, true);
				}
				const mutex = takeTakeoverMutex(lockPath);
				assert.ok(mutex);
				try {
					const owner = JSON.parse(readFileSync(join(mutexPath, "owner"), "utf8")) as { started?: string };
					assert.match(owner.started ?? "", /^[0-9a-f]{12}$/);
					assert.equal(owner.started, await readProcessStartToken(process.pid));
				} finally {
					mutex.release();
				}
			},
			POWERSHELL_READS_TIMEOUT_MS,
		);
	}

	test.skipIf(!windows)(
		"a resume takes over a claim whose holder is gone though another process has its pid, and names this process's start (#5315)",
		async () => {
			const own = processStartToken(process.pid);
			const later = await runningProcess();
			setNativeProcessCreationTimeForTesting(null);
			answerStartQueriesQuickly();
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
			answerStartQueriesQuickly();
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
			// The marker is published off the event loop once the hold is taken.
			const name = await vi.waitFor(
				() => {
					const names = readdirSync(join(agentDir, "open-sessions", ownSession));
					assert.equal(names.length, 1);
					return names[0];
				},
				{ timeout: MARKER_PUBLISHED_TIMEOUT_MS },
			);
			assert.match(name ?? "", new RegExp(`^${process.pid}-[0-9a-f]{16}-${own}\\.json$`));
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"an open marker written before this process's start was read keeps its name until it is released (#5315)",
		async () => {
			vi.resetModules();
			const fresh = await import("../src/core/process-start-token.js");
			const freshMarkers = await import("../src/core/session-open-markers.js");
			fresh.setNativeProcessCreationTimeForTesting(null);
			cleanups.push(() => fresh.setNativeProcessCreationTimeForTesting(undefined));
			const sessionId = "44444444-4444-4444-8444-444444444444";
			const markers = join(agentDir, "open-sessions", sessionId);

			const release = freshMarkers.holdSessionOpenMarker(sessionId, { agentDir });
			// Named when the hold is taken and published off the event loop, still before the start is read.
			await vi.waitFor(
				() => assert.match(readdirSync(markers)[0] ?? "", new RegExp(`^${process.pid}-[0-9a-f]{16}\\.json$`)),
				{ timeout: MARKER_PUBLISHED_TIMEOUT_MS },
			);
			await freshMarkers.prepareSessionOpenMarkers();
			await release();

			assert.equal(existsSync(markers), false, "the marker it wrote is the one it removed");
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"a pooled worktree's or download's holder runs only while its start matches, and this process names its own (#5315)",
		async () => {
			const own = processStartToken(process.pid);
			const holder = await runningProcess();
			setNativeProcessCreationTimeForTesting(null);
			answerStartQueriesQuickly();
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

	test.skipIf(!windows)(
		"a settings save takes over a dead holder whose process id a running process now has, without the native start reader (#5315)",
		async () => {
			const later = await runningProcess();
			const settingsPath = join(agentDir, "settings.json");
			const lockPath = `${settingsPath}.lock`;
			writeFileSync(settingsPath, "{}");
			mkdirSync(lockPath, { recursive: true });
			writeFileSync(
				lockHolderPath(lockPath),
				JSON.stringify({ host: hostname(), pid: later.pid, started: GONE_START, lock: lockHolder(lockPath) }),
			);
			setNativeProcessCreationTimeForTesting(null);
			answerStartQueriesQuickly();

			const manager = SettingsManager.fromStorage(new FileSettingsStorage(agentDir, agentDir));
			manager.setTheme("dark");
			await manager.flush();

			assert.deepEqual(manager.drainErrors(), []);
			assert.equal((JSON.parse(readFileSync(settingsPath, "utf8")) as { theme?: string }).theme, "dark");

			const projectDir = join(agentDir, "project");
			const projectSettingsPath = join(projectDir, ".atomic", "settings.json");
			const projectLockPath = `${projectSettingsPath}.lock`;
			mkdirSync(projectLockPath, { recursive: true });
			writeFileSync(projectSettingsPath, "{}");
			writeFileSync(
				lockHolderPath(projectLockPath),
				JSON.stringify({
					host: hostname(),
					pid: later.pid,
					started: GONE_START,
					lock: lockHolder(projectLockPath),
				}),
			);
			setNativeProcessCreationTimeForTesting(null);
			answerStartQueriesQuickly();

			const projectManager = SettingsManager.fromStorage(new FileSettingsStorage(projectDir, agentDir));
			projectManager.setProjectPackages(["npm:example"]);
			await projectManager.flush();

			assert.deepEqual(projectManager.drainErrors(), []);
			assert.deepEqual((JSON.parse(readFileSync(projectSettingsPath, "utf8")) as { packages?: string[] }).packages, [
				"npm:example",
			]);

			const inMemory = SettingsManager.inMemory();
			inMemory.setTheme("light");
			await inMemory.flush();
			assert.deepEqual(inMemory.drainErrors(), []);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"a settings lock's holder record names this process's start without the native start reader (#5315)",
		async () => {
			const settingsPath = join(agentDir, "settings.json");
			const lockPath = `${settingsPath}.lock`;
			let holder: { pid?: number; started?: string } | undefined;
			class InspectingSettingsStorage extends FileSettingsStorage {
				override withPrimaryWriteLock(
					scope: SettingsScope,
					fn: (currentPrimary: string | undefined) => string | undefined,
				): void {
					super.withPrimaryWriteLock(scope, (current) => {
						holder = JSON.parse(readFileSync(lockHolderPath(lockPath), "utf8")) as {
							pid?: number;
							started?: string;
						};
						return fn(current);
					});
				}
			}
			setNativeProcessCreationTimeForTesting(null);
			answerStartQueriesQuickly();

			const manager = SettingsManager.fromStorage(new InspectingSettingsStorage(agentDir, agentDir));
			manager.setTheme("dark");
			await manager.flush();

			assert.deepEqual(manager.drainErrors(), []);
			assert.equal(holder?.pid, process.pid);
			assert.equal(holder?.started, await readProcessStartToken(process.pid));
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"a lock takeover removes a dead mutex owner whose process id a running process now has, and names this process's start (#5315)",
		async () => {
			const own = processStartToken(process.pid);
			const laterLockMutex = await runningProcess();
			const laterClaimMutex = await runningProcess();
			const settingsPath = join(agentDir, "settings.json");
			const lockPath = `${settingsPath}.lock`;
			writeFileSync(settingsPath, "{}");
			mkdirSync(lockPath, { recursive: true });
			writeFileSync(
				lockHolderPath(lockPath),
				JSON.stringify({ host: hostname(), pid: MISSING_PID, started: GONE_START, lock: lockHolder(lockPath) }),
			);
			const settingsMutexPath = takeoverMutexPath(lockPath);
			mkdirSync(settingsMutexPath, { recursive: true });
			writeFileSync(
				join(settingsMutexPath, "owner"),
				JSON.stringify({
					id: "dead-settings-mutex",
					host: hostname(),
					pid: laterLockMutex.pid,
					started: GONE_START,
				}),
			);
			let mutexOwner: { pid?: number; started?: string } | undefined;
			class InspectingMutexStorage extends FileSettingsStorage {
				override withPrimaryWriteLock(
					scope: SettingsScope,
					fn: (currentPrimary: string | undefined) => string | undefined,
				): void {
					super.withPrimaryWriteLock(scope, (current) => {
						const mutex = takeTakeoverMutex(lockPath);
						assert.ok(mutex, "this process took the directory mutex");
						try {
							mutexOwner = JSON.parse(readFileSync(join(settingsMutexPath, "owner"), "utf8")) as {
								pid?: number;
								started?: string;
							};
						} finally {
							mutex.release();
						}
						return fn(current);
					});
				}
			}
			setNativeLocksForTesting(null);
			setNativeProcessCreationTimeForTesting(null);
			answerStartQueriesQuickly();

			const manager = SettingsManager.fromStorage(new InspectingMutexStorage(agentDir, agentDir));
			manager.setTheme("dark");
			await manager.flush();

			assert.deepEqual(manager.drainErrors(), []);
			assert.equal(mutexOwner?.pid, process.pid);
			assert.equal(mutexOwner?.started, own);

			const sessionId = "55555555-5555-4555-8555-555555555555";
			const claimFilePath = join(agentDir, "session-claims", `${sessionId}.json`);
			mkdirSync(join(agentDir, "session-claims"), { recursive: true });
			writeFileSync(
				claimFilePath,
				JSON.stringify({ token: "gone", pid: MISSING_PID, host: hostname(), started: GONE_START }),
			);
			const claimMutexPath = takeoverMutexPath(claimFilePath);
			mkdirSync(claimMutexPath, { recursive: true });
			writeFileSync(
				join(claimMutexPath, "owner"),
				JSON.stringify({ id: "dead-claim-mutex", host: hostname(), pid: laterClaimMutex.pid, started: GONE_START }),
			);
			setNativeProcessCreationTimeForTesting(null);
			answerStartQueriesQuickly();

			await prepareSessionClaim(sessionId, { agentDir });
			cleanups.push(claimSession(sessionId, { agentDir }));

			const claim = JSON.parse(readFileSync(claimFilePath, "utf8")) as { pid: number; started?: string };
			assert.equal(claim.pid, process.pid);
			assert.equal(claim.started, own);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"preparing a settings save never holds up the event loop, spawns nothing with the native reader, and falls back to pid when a query times out (#5315)",
		async () => {
			const later = await runningProcess();
			const settingsPath = join(agentDir, "settings.json");
			const lockPath = `${settingsPath}.lock`;
			writeFileSync(settingsPath, "{}");
			mkdirSync(lockPath, { recursive: true });
			writeFileSync(
				lockHolderPath(lockPath),
				JSON.stringify({ host: hostname(), pid: later.pid, started: GONE_START, lock: lockHolder(lockPath) }),
			);

			const countFile = join(agentDir, "queries");
			setProcessCreationTimeQueryForTesting({
				file: process.execPath,
				args: () => ["-e", `require("fs").appendFileSync(${JSON.stringify(countFile)}, "x")`],
			});
			const withNative = SettingsManager.fromStorage(new FileSettingsStorage(agentDir, agentDir));
			withNative.setTheme("dark");
			await withNative.flush();
			assert.deepEqual(withNative.drainErrors(), []);
			assert.equal(existsSync(countFile), false);
			setProcessCreationTimeQueryForTesting(undefined);

			mkdirSync(lockPath, { recursive: true });
			writeFileSync(
				lockHolderPath(lockPath),
				JSON.stringify({ host: hostname(), pid: later.pid, started: GONE_START, lock: lockHolder(lockPath) }),
			);
			setNativeProcessCreationTimeForTesting(null);
			const loop = watchEventLoop();
			const startedAt = performance.now();
			const withoutNative = SettingsManager.fromStorage(new FileSettingsStorage(agentDir, agentDir));
			withoutNative.setTheme("light");
			await withoutNative.flush();
			const saveMs = performance.now() - startedAt;
			const longestStallMs = loop.stop();
			assert.deepEqual(withoutNative.drainErrors(), []);
			assert.ok(
				longestStallMs < saveMs / 2,
				`the event loop stalled for ${Math.round(longestStallMs)} ms of the save's ${Math.round(saveMs)} ms`,
			);

			mkdirSync(lockPath, { recursive: true });
			writeFileSync(
				lockHolderPath(lockPath),
				JSON.stringify({ host: hostname(), pid: later.pid, started: GONE_START, lock: lockHolder(lockPath) }),
			);
			setNativeProcessCreationTimeForTesting(null);
			setProcessCreationTimeQueryForTesting({
				file: process.execPath,
				args: () => ["-e", "setInterval(() => {}, 1000)"],
			});
			const timedOut = SettingsManager.fromStorage(new FileSettingsStorage(agentDir, agentDir));
			timedOut.setTheme("dark");
			await timedOut.flush();
			const errors = timedOut.drainErrors();
			assert.equal(errors.length, 1);
			assert.equal((errors[0]?.error as NodeJS.ErrnoException | undefined)?.code, "ELOCKED");
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);
});
