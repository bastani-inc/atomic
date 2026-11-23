import assert from "node:assert/strict";
import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	isGone,
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";
import { bunExecutable, spawnProcess } from "../../../test/helpers/runtime.js";
import { GitSandbox, gitConfigPath } from "../../../test/helpers/worktree-snapshot.js";

/** Controls fake native containment / descendant holding / creation-time termination for cross-platform unit tests. */
const fakes = vi.hoisted(() => ({
	taskkillRuns: [] as string[][],
	taskkillError: false,
	interceptContainment: false,
	containAvailable: true,
	containedTrees: [] as {
		pid: number;
		active: number;
		terminated: number;
		released: number;
		closed: number;
	}[],
	interceptHold: false,
	holdMode: "held" as "held" | "held-root-exited" | "absent" | "unavailable",
	holdCalls: [] as number[],
	holdEnded: 0,
	interceptStartToken: false,
	creationTimes: new Map<number, string | null>(),
	nativeCreationAvailable: true,
	nativeTerminateMode: "terminated" as "terminated" | "null" | "unavailable",
	nativeTerminateCalls: [] as { pid: number; started: string; descendants: boolean }[],
}));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	const spawn = ((command: string, args: readonly string[], options: object) => {
		if (!String(command).toLowerCase().endsWith("taskkill.exe")) return actual.spawn(command, [...args], options);
		fakes.taskkillRuns.push([...args]);
		const run = new EventEmitter();
		queueMicrotask(() => {
			if (fakes.taskkillError) {
				run.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
			} else {
				run.emit("exit", 0, null);
				run.emit("close", 0, null);
			}
		});
		return run;
	}) as typeof actual.spawn;
	return { ...actual, spawn };
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	const spawn = ((command: string, args: readonly string[], options: object) => {
		if (!String(command).toLowerCase().endsWith("taskkill.exe")) return actual.spawn(command, [...args], options);
		fakes.taskkillRuns.push([...args]);
		const run = new EventEmitter();
		queueMicrotask(() => {
			if (fakes.taskkillError) {
				run.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
			} else {
				run.emit("exit", 0, null);
				run.emit("close", 0, null);
			}
		});
		return run;
	}) as typeof actual.spawn;
	return { ...actual, spawn };
});

vi.mock("../src/core/process-tree-containment.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/process-tree-containment.ts")>();
	const makeHeld = (rootEnded: boolean) => ({
		count: 1,
		endAll: () => {
			if (rootEnded) fakes.holdEnded++;
			return rootEnded;
		},
		release: () => {},
	});
	return {
		...actual,
		containProcessTree: (pid: number) => {
			if (!fakes.interceptContainment) return actual.containProcessTree(pid);
			if (!fakes.containAvailable) return undefined;
			const tree = { pid, active: 0, terminated: 0, released: 0, closed: 0 };
			fakes.containedTrees.push(tree);
			return {
				terminate: () => {
					tree.terminated++;
					tree.active = 0;
					return true;
				},
				activeProcesses: () => tree.active,
				release: () => {
					tree.released++;
					return true;
				},
				close: () => {
					tree.closed++;
				},
			};
		},
		containProcessTreeAllowingBreakaway: (pid: number) => {
			if (!fakes.interceptContainment) return actual.containProcessTreeAllowingBreakaway(pid);
			if (!fakes.containAvailable) return undefined;
			const tree = { pid, active: 0, terminated: 0, released: 0, closed: 0 };
			fakes.containedTrees.push(tree);
			return {
				terminate: () => {
					tree.terminated++;
					tree.active = 0;
					return true;
				},
				activeProcesses: () => tree.active,
				release: () => {
					tree.released++;
					return true;
				},
				close: () => {
					tree.closed++;
				},
			};
		},
		holdProcessDescendants: (pid: number) => {
			if (!fakes.interceptHold) return actual.holdProcessDescendants(pid);
			fakes.holdCalls.push(pid);
			if (fakes.holdMode === "held") return makeHeld(true);
			if (fakes.holdMode === "held-root-exited") return makeHeld(false);
			return undefined;
		},
		holdProcessDescendantsResult: (pid: number) => {
			if (!fakes.interceptHold) return actual.holdProcessDescendantsResult(pid);
			fakes.holdCalls.push(pid);
			if (fakes.holdMode === "held") return { kind: "held" as const, held: makeHeld(true) };
			if (fakes.holdMode === "held-root-exited") return { kind: "held" as const, held: makeHeld(false) };
			if (fakes.holdMode === "absent") return { kind: "absent" as const };
			return { kind: "unavailable" as const };
		},
	};
});

vi.mock("../src/core/process-start-token.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/process-start-token.js")>();
	const tokenFor = (created: string) => createHash("sha256").update(`windows\n${created}`).digest("hex").slice(0, 12);
	return {
		...actual,
		nativeProcessCreationTime: (pid: number) => {
			if (!fakes.interceptStartToken) return actual.nativeProcessCreationTime(pid);
			if (!fakes.nativeCreationAvailable) return undefined;
			return fakes.creationTimes.has(pid) ? fakes.creationTimes.get(pid)! : null;
		},
		readProcessCreationTime: async (pid: number) => {
			if (!fakes.interceptStartToken) return actual.readProcessCreationTime(pid);
			const value = fakes.creationTimes.get(pid);
			return value === undefined || value === null ? undefined : value;
		},
		processStartTokenAsync: async (pid: number) => {
			if (!fakes.interceptStartToken) return actual.processStartTokenAsync(pid);
			const value = fakes.creationTimes.get(pid);
			return value === undefined || value === null ? undefined : tokenFor(value);
		},
		nativeTerminateProcess: (pid: number, started: string, descendants: boolean) => {
			if (!fakes.interceptStartToken) return actual.nativeTerminateProcess(pid, started, descendants);
			fakes.nativeTerminateCalls.push({ pid, started, descendants });
			if (fakes.nativeTerminateMode === "unavailable") return undefined;
			if (fakes.nativeTerminateMode === "null") {
				// Simulate PID reuse by a different process with a newer creation time.
				fakes.creationTimes.set(pid, "133500000000000999");
				return null;
			}
			fakes.creationTimes.set(pid, null);
			return 2;
		},
	};
});

const { spawn } = await import("node:child_process");
const {
	killChildProcessTree,
	killProcessTree,
	killTrackedDetachedChildren,
	spawnShellProcess,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} = await import("../src/utils/shell.js");
const { terminateRpcClientProcess } = await import("../src/modes/rpc/rpc-client-process.js");
const { buildLockPath, settleOtherBuilds } = await import("../src/core/resume/blueprint/build-lock.ts");
const { nativeProcessCreationTime, processStartToken } = await import("../src/core/process-start-token.js");
const { getPowerShellConfig } = await import("../src/utils/shell.js");
const { resolveGit } = await import("../src/utils/tools-manager.ts");
const { runWorkspaceProcess } = await import("../src/core/workspace/process.ts");
const { runGit, setWorktreeSnapshotGit } = await import("../src/core/worktree-snapshot/git.ts");
const { renameWithRetry } = await import("../src/core/rename-retry.ts");

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const THIS_HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
const tempDirs: string[] = [];
const recordedProcs: RecordedProcess[] = [];

function fakePlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { configurable: true, value });
}

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function fakeChild(pid: number, exitCode: number | null = null) {
	return Object.assign(new EventEmitter(), {
		pid,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode,
		signalCode: null as NodeJS.Signals | null,
		killed: false,
		kill: vi.fn(() => true),
		ref() {},
		unref() {},
	});
}

function exited(child: ChildProcess): Promise<void> {
	return child.exitCode !== null || child.signalCode !== null
		? Promise.resolve()
		: new Promise((resolve) => child.once("exit", () => resolve()));
}

/**
 * Routes `process.kill(pid, 0)` through `fakes.creationTimes` while `fakes.interceptStartToken` is active so mocked
 * `build-lock` tests never probe real host OS processes when a fake PID is absent or terminated.
 */
function isolateFakeProcessLiveness(): () => void {
	const realKill = process.kill.bind(process);
	const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
		if (signal === 0 && fakes.interceptStartToken) {
			const created = fakes.creationTimes.get(pid);
			if (created !== undefined && created !== null) return true;
			throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
		}
		return realKill(pid, signal as NodeJS.Signals);
	}) as typeof process.kill);
	return () => spy.mockRestore();
}

const PID_FILE_POLL_MS = 20;

async function waitForPidNumber(file: string, timeoutMs = 20_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (existsSync(file)) {
				const raw = readFileSync(file, "utf8").trim();
				const pid = Number(raw);
				if (raw !== "" && Number.isInteger(pid) && pid > 0) return pid;
			}
		} catch {}
		assert.ok(Date.now() < deadline, `timed out waiting for PID file ${file}`);
		await new Promise((resolve) => setTimeout(resolve, PID_FILE_POLL_MS));
	}
}

beforeEach(() => {
	fakes.taskkillRuns.length = 0;
	fakes.taskkillError = false;
	fakes.interceptContainment = false;
	fakes.containAvailable = true;
	fakes.containedTrees.length = 0;
	fakes.interceptHold = false;
	fakes.holdMode = "held";
	fakes.holdCalls.length = 0;
	fakes.holdEnded = 0;
	fakes.interceptStartToken = false;
	fakes.creationTimes.clear();
	fakes.nativeCreationAvailable = true;
	fakes.nativeTerminateMode = "terminated";
	fakes.nativeTerminateCalls.length = 0;
});

afterEach(async () => {
	Object.defineProperty(process, "platform", realPlatform);
	fakes.interceptContainment = false;
	fakes.interceptHold = false;
	fakes.interceptStartToken = false;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const recorded of recordedProcs.splice(0)) {
		if (await signalRecordedProcess(recorded)) await waitUntilGone(recorded, 5_000);
	}
	for (const dir of tempDirs.splice(0))
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe("Windows tree-kill safety without bare-PID taskkill", () => {
	test("killChildProcessTree uses holdProcessDescendants on Windows and never spawns taskkill when native is available", () => {
		fakePlatform("win32");
		fakes.interceptHold = true;
		fakes.holdMode = "held";
		const running = fakeChild(41004, null);

		killChildProcessTree(running as unknown as ChildProcess, false);

		assert.deepEqual(fakes.holdCalls, [41004]);
		assert.equal(fakes.holdEnded, 1);
		assert.deepEqual(fakes.taskkillRuns, [], "never spawns taskkill when native hold is available");
		assert.equal(running.kill.mock.calls.length, 0);
	});

	test("killChildProcessTree never spawns taskkill when native hold reports the process already exited (absent)", () => {
		fakePlatform("win32");
		fakes.interceptHold = true;
		fakes.holdMode = "absent";
		const running = fakeChild(41008, null);

		killChildProcessTree(running as unknown as ChildProcess, false);

		assert.deepEqual(fakes.holdCalls, [41008]);
		assert.deepEqual(fakes.taskkillRuns, [], "must not fall back to taskkill when native saw the process absent");
		assert.equal(running.kill.mock.calls.length, 1, "falls back to the live handle only");
	});

	test("killChildProcessTree ignores an already-exited ChildProcess even if exited=false was passed", () => {
		fakePlatform("win32");
		fakes.interceptHold = true;
		fakes.holdMode = "unavailable";
		const alreadyExited = fakeChild(41012, 0);

		killChildProcessTree(alreadyExited as unknown as ChildProcess, false);

		assert.deepEqual(fakes.holdCalls, []);
		assert.deepEqual(fakes.taskkillRuns, [], "must never kill a closed handle's PID");
		assert.equal(alreadyExited.kill.mock.calls.length, 0);
	});

	test("killProcessTree uses holdProcessDescendants on Windows and never spawns taskkill when native is available", () => {
		fakePlatform("win32");
		fakes.interceptHold = true;
		fakes.holdMode = "held";

		killProcessTree(41016);

		assert.deepEqual(fakes.holdCalls, [41016]);
		assert.equal(fakes.holdEnded, 1);
		assert.deepEqual(fakes.taskkillRuns, []);

		fakes.holdMode = "absent";
		killProcessTree(41020);
		assert.deepEqual(fakes.taskkillRuns, [], "absent under native must not fall back to taskkill");
	});

	test("killTrackedDetachedChildren verifies Windows creation time via nativeTerminateProcess and never kills a reused PID", () => {
		fakePlatform("win32");
		fakes.interceptStartToken = true;
		fakes.creationTimes.set(41024, "133500000000000001");
		fakes.nativeTerminateMode = "null";

		trackDetachedChildPid(41024);
		try {
			killTrackedDetachedChildren();
		} finally {
			untrackDetachedChildPid(41024);
		}

		assert.deepEqual(fakes.nativeTerminateCalls, [{ pid: 41024, started: "133500000000000001", descendants: true }]);
		assert.deepEqual(fakes.taskkillRuns, [], "must not fall back to taskkill when native proved PID was reused");
	});

	test("build-lock settleOtherBuilds terminates Windows steps via nativeTerminateProcess without taskkill and skips reused PIDs", async () => {
		// Spawn real host processes whose PIDs collide with the mocked dead holder and terminated step
		// so the test proves fake-table isolation even when those PIDs are live on the host OS.
		const holderBystander = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60_000)"], {
			cwd: tmpdir(),
			stdio: "ignore",
			windowsHide: true,
		});
		const stepBystander = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60_000)"], {
			cwd: tmpdir(),
			stdio: "ignore",
			windowsHide: true,
		});
		const holderRec = await recordProcess(holderBystander.pid!);
		const stepRec = await recordProcess(stepBystander.pid!);
		recordedProcs.push(holderRec, stepRec);

		fakePlatform("win32");
		fakes.interceptStartToken = true;
		const restoreKill = isolateFakeProcessLiveness();
		try {
			const storeDir = makeTempDir("atomic-killtree-lock-");
			const root = join(storeDir, "worktree");
			mkdirSync(join(storeDir, "blueprint-builds", "locks"), { recursive: true });

			const created = "133500000000000099";
			const start = createHash("sha256").update(`windows\n${created}`).digest("hex").slice(0, 12);
			const reusedPid = 41029;
			fakes.creationTimes.set(stepBystander.pid!, created);
			fakes.creationTimes.set(reusedPid, "133500000000000888");
			fakes.nativeTerminateMode = "terminated";

			writeFileSync(
				buildLockPath(storeDir, root),
				JSON.stringify({
					host: THIS_HOST,
					pid: holderBystander.pid!,
					start: "aaaaaaaaaaaa",
					steps: [
						{ pid: stepBystander.pid!, start },
						{ pid: reusedPid, start: "bbbbbbbbbbbb" },
					],
				}),
			);

			const settled = await settleOtherBuilds(storeDir, [root], { waitMs: 300 });
			await settled.release();

			assert.deepEqual(settled.warnings, []);
			assert.deepEqual(fakes.nativeTerminateCalls, [
				{ pid: stepBystander.pid!, started: created, descendants: true },
			]);
			assert.deepEqual(fakes.taskkillRuns, [], "build-lock must use nativeTerminateProcess, never taskkill");
		} finally {
			restoreKill();
			fakes.interceptStartToken = false;
			Object.defineProperty(process, "platform", realPlatform);
		}
		assert.equal(await stillRuns(holderRec), true, "host process colliding with dead holder PID was never signalled");
		assert.equal(await stillRuns(stepRec), true, "host process colliding with mocked step PID was never signalled");
	});

	test("build-lock settleOtherBuilds never falls back to taskkill when nativeTerminateProcess returns null for a reused PID", async () => {
		const holderBystander = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60_000)"], {
			cwd: tmpdir(),
			stdio: "ignore",
			windowsHide: true,
		});
		const holderRec = await recordProcess(holderBystander.pid!);
		recordedProcs.push(holderRec);

		fakePlatform("win32");
		fakes.interceptStartToken = true;
		const restoreKill = isolateFakeProcessLiveness();
		try {
			const storeDir = makeTempDir("atomic-killtree-lock-reused-");
			const root = join(storeDir, "worktree");
			mkdirSync(join(storeDir, "blueprint-builds", "locks"), { recursive: true });

			const created = "133500000000000111";
			const start = createHash("sha256").update(`windows\n${created}`).digest("hex").slice(0, 12);
			fakes.creationTimes.set(41030, created);
			// Simulate the process exiting and being replaced right as nativeTerminateProcess runs.
			fakes.nativeTerminateMode = "null";

			writeFileSync(
				buildLockPath(storeDir, root),
				JSON.stringify({
					host: THIS_HOST,
					pid: holderBystander.pid!,
					start: "aaaaaaaaaaaa",
					steps: [{ pid: 41030, start }],
				}),
			);

			const settled = await settleOtherBuilds(storeDir, [root], { waitMs: 50 });
			await settled.release();

			assert.deepEqual(settled.warnings, []);
			assert.deepEqual(fakes.nativeTerminateCalls, [{ pid: 41030, started: created, descendants: true }]);
			assert.deepEqual(fakes.taskkillRuns, [], "must not fall back to taskkill on native null");
		} finally {
			restoreKill();
			fakes.interceptStartToken = false;
			Object.defineProperty(process, "platform", realPlatform);
		}
		assert.equal(await stillRuns(holderRec), true, "host process colliding with dead holder PID was never signalled");
	});

	test("terminateRpcClientProcess uses holdProcessDescendants on Windows escalation and never spawns taskkill", async () => {
		fakePlatform("win32");
		fakes.interceptHold = true;
		fakes.holdMode = "held";
		vi.useFakeTimers();
		try {
			const child = fakeChild(41032, null);
			const stopping = terminateRpcClientProcess(child as unknown as ChildProcess, true, true);
			await vi.advanceTimersByTimeAsync(5_000);
			assert.deepEqual(fakes.holdCalls, [41032]);
			assert.equal(fakes.holdEnded, 1);
			assert.deepEqual(fakes.taskkillRuns, [], "rpc-client-process must use holdProcessDescendants, never taskkill");
			child.exitCode = 1;
			child.emit("exit", 1, null);
			await stopping;
		} finally {
			vi.useRealTimers();
		}
	});

	test.skipIf(process.platform === "win32")(
		"nativeProcessCreationTime reports unavailable (undefined) on non-Windows hosts even when process.platform is spoofed",
		() => {
			fakePlatform("win32");
			fakes.interceptStartToken = false;
			assert.equal(nativeProcessCreationTime(process.pid), undefined);
		},
	);

	test.skipIf(process.platform === "win32")(
		"worktree-snapshot runGit stopCommand uses holdProcessDescendants when containProcessTree is unavailable and never spawns taskkill",
		async () => {
			fakePlatform("win32");
			fakes.interceptContainment = true;
			fakes.containAvailable = false;
			fakes.interceptHold = true;
			fakes.holdMode = "held";
			const dir = makeTempDir("atomic-killtree-git-");
			const readyFile = join(dir, "fake-git.pid");
			const fakeGit = join(dir, "fake-git.sh");
			writeFileSync(
				fakeGit,
				`#!/bin/sh\nprintf '%s\\n' "$$" > "$ATOMIC_FAKE_GIT_READY.tmp" && mv "$ATOMIC_FAKE_GIT_READY.tmp" "$ATOMIC_FAKE_GIT_READY"\nexec sleep 30\n`,
			);
			chmodSync(fakeGit, 0o755);
			const prevGit = setWorktreeSnapshotGit(async () => ({ path: fakeGit, env: {} }));
			let childPid: number | undefined;
			let childKilled = false;
			try {
				const controller = new AbortController();
				const running = runGit(["status"], {
					cwd: dir,
					env: { ATOMIC_FAKE_GIT_READY: readyFile },
					signal: controller.signal,
				});
				running.catch(() => {});
				childPid = await waitForPidNumber(readyFile);
				controller.abort(new Error("aborted"));
				await vi.waitFor(() => assert.equal(fakes.holdCalls.length, 1));
				assert.equal(fakes.holdCalls[0], childPid);
				assert.deepEqual(
					fakes.taskkillRuns,
					[],
					"git fallback must use holdProcessDescendants when native is available",
				);
				childKilled = true;
				try {
					process.kill(childPid, "SIGKILL");
				} catch {}
				await assert.rejects(running, /aborted/);
			} finally {
				if (childPid !== undefined && !childKilled) {
					try {
						process.kill(childPid, "SIGKILL");
					} catch {}
				}
				setWorktreeSnapshotGit(prevGit);
			}
		},
	);
});

// Real Windows kernel verification: orphan grandchildren, PID reuse, and zero bare-PID taskkill calls.
describe.runIf(process.platform === "win32")("on Windows, real kernel tree-kill safety", () => {
	const GONE_MS = 10_000;
	const NOT_ENDED_MS = 800;

	async function waitForPidFile(file: string): Promise<RecordedProcess> {
		const recorded = await recordProcess(await waitForPidNumber(file));
		recordedProcs.push(recorded);
		return recorded;
	}

	function writeOrphanTreeScript(dir: string, holdFile: boolean): string {
		const script = join(dir, "holder.cjs");
		writeFileSync(
			script,
			`
const { spawn } = require("node:child_process");
const { ${holdFile ? "openSync, " : ""}renameSync, writeFileSync } = require("node:fs");
const [self, pidFile, role] = process.argv.slice(1);
if (role === "orphan") {
	${holdFile ? 'openSync("held.txt", "w");' : ""}
	writeFileSync(pidFile + ".tmp", String(process.pid));
	renameSync(pidFile + ".tmp", pidFile);
	setTimeout(() => process.exit(0), 120_000);
} else if (role === "starter") {
	spawn(process.execPath, [self, pidFile, "orphan"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
} else {
	spawn(process.execPath, [self, pidFile, "starter"], { stdio: "ignore", windowsHide: true });
	setTimeout(() => process.exit(0), 120_000);
}
`,
		);
		return script;
	}

	test("runWorkspaceProcess abort ends an orphan grandchild whose intermediate starter already exited and unlocks its directory", async () => {
		const dir = makeTempDir("atomic-win-workspace-orphan-");
		const workDir = join(dir, "work");
		mkdirSync(workDir);
		const pidFile = join(dir, "orphan.pid");
		const script = writeOrphanTreeScript(dir, true);

		const controller = new AbortController();
		const running = runWorkspaceProcess({
			path: process.execPath,
			args: [script, pidFile, "root"],
			cwd: workDir,
			env: process.env,
			signal: controller.signal,
		});
		running.catch(() => {});

		const orphan = await waitForPidFile(pidFile);
		assert.equal(await stillRuns(orphan), true, "orphan grandchild is running");

		controller.abort(new Error("workspace aborted"));
		await assert.rejects(running, /workspace aborted/);
		assert.equal(await isGone(orphan), true, "orphan grandchild ended before runWorkspaceProcess rejected");
		assert.deepEqual(fakes.taskkillRuns, [], "never spawned taskkill on native Windows");
		await renameWithRetry(workDir, join(dir, "work-moved"), { budgetMs: 10_000 });
	});

	test("runWorkspaceProcess timeout ends an orphan grandchild whose intermediate starter already exited", async () => {
		const dir = makeTempDir("atomic-win-workspace-timeout-");
		const pidFile = join(dir, "orphan.pid");
		const script = writeOrphanTreeScript(dir, false);

		const running = runWorkspaceProcess({
			path: process.execPath,
			args: [script, pidFile, "root"],
			cwd: tmpdir(),
			env: process.env,
			timeoutMs: 5_000,
			timeoutError: (ms) => new Error(`timed out after ${ms}ms`),
		});
		running.catch(() => {});

		const orphan = await waitForPidFile(pidFile);
		assert.equal(await stillRuns(orphan), true);
		await assert.rejects(running, /timed out after/);
		assert.equal(await waitUntilGone(orphan, GONE_MS), true, "orphan grandchild ended on timeout");
		assert.deepEqual(fakes.taskkillRuns, []);
	});

	test("spawnShellProcess fallback (child-process) ends live descendants via holdProcessDescendants without taskkill, and never kills by bare PID after exit", async () => {
		vi.stubEnv("ATOMIC_HOST_SPAWN", "child-process");
		const dir = makeTempDir("atomic-win-shell-fallback-");
		const pidFile = join(dir, "child.pid");
		const childScript = join(dir, "sleeper.cjs");
		writeFileSync(
			childScript,
			`const fs = require("node:fs"); fs.writeFileSync(process.argv[2] + ".tmp", String(process.pid)); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); setTimeout(() => process.exit(0), 120_000);`,
		);
		const parentScript = join(dir, "parent.cjs");
		writeFileSync(
			parentScript,
			`require("node:child_process").spawn(process.execPath, [process.argv[2], process.argv[3]], { cwd: require("node:os").tmpdir(), stdio: "ignore", windowsHide: true }); setTimeout(() => process.exit(0), 120_000);`,
		);

		const shellProc = await spawnShellProcess(process.execPath, [parentScript, childScript, pidFile], {
			cwd: tmpdir(),
			env: process.env,
			stdin: "ignore",
		});
		if (shellProc.child.pid !== undefined) recordedProcs.push(await recordProcess(shellProc.child.pid));
		try {
			const descendant = await waitForPidFile(pidFile);
			assert.equal(await stillRuns(descendant), true);

			shellProc.stop();

			assert.equal(await waitUntilGone(descendant, GONE_MS), true, "fallback stop ended live descendant");
			await exited(shellProc.child as ChildProcess);
			assert.deepEqual(fakes.taskkillRuns, [], "fallback stop used native holdProcessDescendants, never taskkill");
		} finally {
			shellProc.finish();
		}

		// Exited shell: stop() and killTrackedDetachedChildren() must never invoke taskkill on its bare PID.
		const quickProc = await spawnShellProcess(process.execPath, ["-e", "process.exit(0)"], {
			cwd: tmpdir(),
			env: process.env,
			stdin: "ignore",
		});
		try {
			await exited(quickProc.child as ChildProcess);
			quickProc.stop();
			killTrackedDetachedChildren();
			assert.deepEqual(fakes.taskkillRuns, [], "exited shell never triggers bare-PID taskkill");
		} finally {
			quickProc.finish();
		}
	});

	test("terminateRpcClientProcess ends a real child and its descendant via holdProcessDescendants without taskkill", async () => {
		const dir = makeTempDir("atomic-win-rpc-killtree-");
		const pidFile = join(dir, "desc.pid");
		const childScript = join(dir, "desc.cjs");
		writeFileSync(
			childScript,
			`const fs = require("node:fs"); fs.writeFileSync(process.argv[2] + ".tmp", String(process.pid)); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); setTimeout(() => process.exit(0), 120_000);`,
		);
		const engineScript = join(dir, "engine.cjs");
		writeFileSync(
			engineScript,
			`require("node:child_process").spawn(process.execPath, [process.argv[2], process.argv[3]], { cwd: require("node:os").tmpdir(), stdio: "ignore", windowsHide: true }); process.stdin.resume(); setTimeout(() => process.exit(0), 120_000);`,
		);

		const child = spawn(process.execPath, [engineScript, childScript, pidFile], {
			cwd: tmpdir(),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		recordedProcs.push(await recordProcess(child.pid!));
		const desc = await waitForPidFile(pidFile);
		assert.equal(await stillRuns(desc), true);

		// Graceful=true closes stdin, engine ignores EOF for 5s then escalates to killChildProcessTree(child, false).
		await terminateRpcClientProcess(child, true, true);

		assert.equal(await waitUntilGone(desc, GONE_MS), true, "descendant ended when hung engine was terminated");
		assert.deepEqual(fakes.taskkillRuns, [], "rpc-client-process never spawned taskkill on native Windows");
	});

	test("build-lock settleOtherBuilds ends a dead build's live step and its child via nativeTerminateProcess without taskkill, and spares a process with a mismatched start", async () => {
		const dir = makeTempDir("atomic-win-buildlock-killtree-");
		const root = join(dir, "worktree");
		mkdirSync(join(dir, "blueprint-builds", "locks"), { recursive: true });
		const pidFile = join(dir, "step-child.pid");
		const childScript = join(dir, "step-child.cjs");
		writeFileSync(
			childScript,
			`const fs = require("node:fs"); fs.writeFileSync(process.argv[2] + ".tmp", String(process.pid)); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); setTimeout(() => process.exit(0), 120_000);`,
		);
		const stepScript = join(dir, "step.cjs");
		writeFileSync(
			stepScript,
			`require("node:child_process").spawn(process.execPath, [process.argv[2], process.argv[3]], { cwd: require("node:os").tmpdir(), stdio: "ignore", windowsHide: true }); setTimeout(() => process.exit(0), 120_000);`,
		);

		// Dead holder process: hold stdin open until its start token is captured so a fast exit never leaves
		// `deadStart` undefined and vulnerable to PID reuse under load.
		const dead = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
			cwd: tmpdir(),
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
		});
		const deadStart = processStartToken(dead.pid!);
		assert.ok(deadStart !== undefined, "captured dead holder start token while process was live");
		dead.stdin!.end();
		await exited(dead);

		// Live step + child + unrelated bystander (simulating reused PID with different start token).
		const step = spawn(process.execPath, [stepScript, childScript, pidFile], {
			cwd: tmpdir(),
			stdio: "ignore",
			windowsHide: true,
		});
		const stepRec = await recordProcess(step.pid!);
		recordedProcs.push(stepRec);
		const stepChild = await waitForPidFile(pidFile);
		const bystander = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 120_000)"], {
			cwd: tmpdir(),
			stdio: "ignore",
			windowsHide: true,
		});
		const bystanderRec = await recordProcess(bystander.pid!);
		recordedProcs.push(bystanderRec);

		writeFileSync(
			buildLockPath(dir, root),
			JSON.stringify({
				host: THIS_HOST,
				pid: dead.pid,
				start: deadStart,
				steps: [
					{ pid: step.pid, start: processStartToken(step.pid!) },
					// Bystander's PID recorded with another process's start token (reused PID).
					{ pid: bystander.pid, start: "000000000000" },
				],
			}),
		);

		const settled = await settleOtherBuilds(dir, [root], { waitMs: 300 });
		await settled.release();

		assert.deepEqual(settled.warnings, []);
		assert.equal(await waitUntilGone(stepRec, GONE_MS), true, "proven step ended");
		assert.equal(await waitUntilGone(stepChild, GONE_MS), true, "proven step's child ended");
		await exited(step);
		assert.equal(await waitUntilGone(bystanderRec, NOT_ENDED_MS), false, "process with mismatched start survived");
		assert.deepEqual(fakes.taskkillRuns, [], "build-lock never spawned taskkill on native Windows");
	});

	test("worktree-snapshot runGit ends a live command and its child via holdProcessDescendants without taskkill when containProcessTree is unavailable", async () => {
		fakes.interceptContainment = true;
		fakes.containAvailable = false;
		const sandbox = new GitSandbox();
		try {
			const checkout = sandbox.path("checkout");
			mkdirSync(checkout);
			await sandbox.git(checkout, "init", "-q");
			const pidFile = sandbox.path("child.pid");
			const script = sandbox.path("child.cjs");
			writeFileSync(
				script,
				`const { spawn } = require("node:child_process");
const { renameSync, writeFileSync } = require("node:fs");
const [self, pidFile, role] = process.argv.slice(1);
if (role === "leaf") {
	writeFileSync(pidFile + ".tmp", String(process.pid));
	renameSync(pidFile + ".tmp", pidFile);
	setTimeout(() => process.exit(0), 120_000);
} else {
	spawn(process.execPath, [self, pidFile, "leaf"], { stdio: "ignore", windowsHide: true });
	setTimeout(() => process.exit(0), 120_000);
}
`,
			);
			const alias = `alias.hold=!"${gitConfigPath(process.execPath)}" "${gitConfigPath(script)}" "${gitConfigPath(pidFile)}"`;
			const controller = new AbortController();
			const running = runGit(["-c", alias, "hold"], { cwd: checkout, signal: controller.signal });
			running.catch(() => {});

			const leaf = await waitForPidFile(pidFile);
			assert.equal(await stillRuns(leaf), true);

			controller.abort(new Error("git fallback aborted"));
			await assert.rejects(running, /git fallback aborted/);
			assert.equal(await waitUntilGone(leaf, GONE_MS), true, "descendant ended via holdProcessDescendants fallback");
			assert.deepEqual(fakes.taskkillRuns, [], "git fallback never spawned taskkill on native Windows");
		} finally {
			sandbox.dispose();
		}
	});

	test("killTrackedDetachedChildren terminates a live tracked PID and its child via nativeTerminateProcess without taskkill, and leaves an exited tracked PID without running taskkill", async () => {
		const dir = makeTempDir("atomic-win-tracked-killtree-");
		const pidFile = join(dir, "tracked-child.pid");
		const childScript = join(dir, "tracked-child.cjs");
		writeFileSync(
			childScript,
			`const fs = require("node:fs"); fs.writeFileSync(process.argv[2] + ".tmp", String(process.pid)); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); setTimeout(() => process.exit(0), 120_000);`,
		);
		const parentScript = join(dir, "tracked-parent.cjs");
		writeFileSync(
			parentScript,
			`require("node:child_process").spawn(process.execPath, [process.argv[2], process.argv[3]], { cwd: require("node:os").tmpdir(), stdio: "ignore", windowsHide: true }); setTimeout(() => process.exit(0), 120_000);`,
		);

		// Live tracked parent + child -> ended synchronously via nativeTerminateProcess without taskkill.
		const parent = spawn(process.execPath, [parentScript, childScript, pidFile], {
			cwd: tmpdir(),
			stdio: "ignore",
			windowsHide: true,
		});
		const parentRec = await recordProcess(parent.pid!);
		recordedProcs.push(parentRec);
		const childRec = await waitForPidFile(pidFile);

		// Short-lived tracked process: hold stdin open until tracked so its live creation time is captured,
		// then let it exit before killTrackedDetachedChildren -> native sees gone, no taskkill.
		const shortLived = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
			cwd: tmpdir(),
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
		});
		trackDetachedChildPid(shortLived.pid!);
		shortLived.stdin!.end();
		await exited(shortLived);

		trackDetachedChildPid(parent.pid!);
		try {
			killTrackedDetachedChildren();
		} finally {
			untrackDetachedChildPid(parent.pid!);
			untrackDetachedChildPid(shortLived.pid!);
		}

		assert.equal(await waitUntilGone(parentRec, GONE_MS), true, "tracked parent ended");
		assert.equal(await waitUntilGone(childRec, GONE_MS), true, "tracked parent's child ended");
		await exited(parent);
		assert.deepEqual(fakes.taskkillRuns, [], "killTrackedDetachedChildren never spawned taskkill on native Windows");
	});

	/** C# helper that starts a process with CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW. */
	const BREAKAWAY_HELPER_CS = `using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AtomicWorkspaceBreakaway {
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	struct StartupInfo {
		public int cb; public string reserved; public string desktop; public string title;
		public int x; public int y; public int width; public int height; public int columns; public int rows;
		public int fillAttribute; public int flags; public short showWindow; public short reserved2Size;
		public IntPtr reserved2; public IntPtr input; public IntPtr output; public IntPtr error;
	}
	[StructLayout(LayoutKind.Sequential)]
	struct ProcessInformation { public IntPtr process; public IntPtr thread; public int processId; public int threadId; }
	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
		IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
		ref StartupInfo startup, out ProcessInformation information);
	[DllImport("kernel32.dll")]
	static extern bool CloseHandle(IntPtr handle);
	public static int Start(string commandLine) {
		StartupInfo startup = new StartupInfo();
		startup.cb = Marshal.SizeOf(typeof(StartupInfo));
		ProcessInformation information;
		const uint CreateBreakawayFromJob = 0x01000000, CreateNoWindow = 0x08000000;
		if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false,
				CreateBreakawayFromJob | CreateNoWindow, IntPtr.Zero, null, ref startup, out information))
			return -Marshal.GetLastWin32Error();
		CloseHandle(information.thread);
		CloseHandle(information.process);
		return information.processId;
	}
}
`;

	test("runWorkspaceProcess allows a descendant that explicitly breaks away (CREATE_BREAKAWAY_FROM_JOB) to start and survive after completion and host exit", async () => {
		const dir = makeTempDir("atomic-win-workspace-breakaway-");
		const csFile = join(dir, "breakaway.cs");
		const pidFile = join(dir, "breakaway.pid");
		const errFile = join(dir, "breakaway.err");
		const targetScript = join(dir, "target.cjs");
		writeFileSync(csFile, BREAKAWAY_HELPER_CS);
		writeFileSync(
			targetScript,
			`const fs = require("node:fs"); fs.writeFileSync(process.argv[2] + ".tmp", String(process.pid)); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); setTimeout(() => process.exit(0), 120_000);`,
		);
		const ps = getPowerShellConfig();
		const psWord = (value: string) => `'${value.replace(/'/g, "''")}'`;
		const cmdLine = `"${process.execPath}" "${targetScript}" "${pidFile}"`;
		const psCommand = `Add-Type -Path ${psWord(csFile)}; $id = [AtomicWorkspaceBreakaway]::Start(${psWord(cmdLine)}); if ($id -le 0) { Set-Content -NoNewline -Path ${psWord(errFile)} -Value (-$id); exit 1 }`;

		// Run runWorkspaceProcess inside a child Bun process that exits once the command finishes,
		// verifying the breakaway descendant starts without error 5 and outlives both the command and host exit.
		const processModule = new URL("../src/core/workspace/process.ts", import.meta.url).href;
		const runner = `const { runWorkspaceProcess } = await import(${JSON.stringify(processModule)});
const outcome = await runWorkspaceProcess({
	path: ${JSON.stringify(ps.shell)},
	args: ${JSON.stringify([...ps.args, psCommand])},
	cwd: ${JSON.stringify(tmpdir())},
	env: process.env,
});
process.exit(outcome.kind === "exited" ? (outcome.status ?? 1) : 2);`;
		const host = spawnProcess([bunExecutable(), "--eval", runner], { stdout: "ignore", stderr: "inherit" });
		const exitCode = await Promise.race([
			host.exited,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25_000)),
		]);
		if (exitCode === "pending") host.kill();

		assert.equal(
			existsSync(errFile),
			false,
			existsSync(errFile)
				? `CREATE_BREAKAWAY_FROM_JOB failed with Win32 error ${readFileSync(errFile, "utf8")}`
				: "",
		);
		assert.equal(exitCode, 0, "workspace command succeeded when spawning a breakaway descendant");
		const survivor = await waitForPidFile(pidFile);
		assert.equal(await waitUntilGone(survivor, NOT_ENDED_MS), false, "breakaway descendant survived host exit");
	});

	test("runWorkspaceProcess lets Git's builtin fsmonitor daemon (core.fsmonitor=true) start and stay running after git completes", async () => {
		const git = await resolveGit();
		const dir = makeTempDir("atomic-win-workspace-fsmonitor-");
		const repo = join(dir, "repo");
		mkdirSync(repo);
		const gitEnv = { ...process.env, ...git.env };
		const runGitCmd = (args: readonly string[]) =>
			runWorkspaceProcess({ path: git.path, args, cwd: repo, env: gitEnv });

		const init = await runGitCmd(["init", "-q"]);
		assert.equal(init.kind, "exited");
		assert.equal(init.status, 0);
		writeFileSync(join(repo, "file.txt"), "hello\n");

		try {
			const status = await runGitCmd(["-c", "core.fsmonitor=true", "status", "--porcelain"]);
			assert.equal(status.kind, "exited");
			assert.equal(status.status, 0, `git status failed: ${status.stderr}`);

			// Check that fsmonitor--daemon is still running after the workspace command completed.
			const daemonStatus = await runGitCmd(["fsmonitor--daemon", "status"]);
			assert.equal(daemonStatus.kind, "exited");
			assert.equal(
				daemonStatus.status,
				0,
				`fsmonitor daemon was killed or failed to start: ${daemonStatus.stdout} ${daemonStatus.stderr}`,
			);
			assert.match(daemonStatus.stdout, /watching/i);
		} finally {
			// Always stop the daemon so it releases the temp repository directory before afterEach removes it.
			await runGitCmd(["fsmonitor--daemon", "stop"]).catch(() => {});
		}
	});
});
