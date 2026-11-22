import assert from "node:assert/strict";
import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			if (fakes.nativeTerminateMode === "null") return null;
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
const { processStartToken } = await import("../src/core/process-start-token.js");
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
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const recorded of recordedProcs.splice(0)) await signalRecordedProcess(recorded);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
		fakePlatform("win32");
		fakes.interceptStartToken = true;
		const storeDir = makeTempDir("atomic-killtree-lock-");
		const root = join(storeDir, "worktree");
		mkdirSync(join(storeDir, "blueprint-builds", "locks"), { recursive: true });

		const created = "133500000000000099";
		const start = createHash("sha256").update(`windows\n${created}`).digest("hex").slice(0, 12);
		fakes.creationTimes.set(41028, created);
		fakes.nativeTerminateMode = "terminated";

		writeFileSync(
			buildLockPath(storeDir, root),
			JSON.stringify({ host: THIS_HOST, pid: 41000, start: "aaaaaaaaaaaa", steps: [{ pid: 41028, start }] }),
		);

		const settled = await settleOtherBuilds(storeDir, [root], { waitMs: 300 });
		await settled.release();

		assert.deepEqual(settled.warnings, []);
		assert.deepEqual(fakes.nativeTerminateCalls, [{ pid: 41028, started: created, descendants: true }]);
		assert.deepEqual(fakes.taskkillRuns, [], "build-lock must use nativeTerminateProcess, never taskkill");
	});

	test("build-lock settleOtherBuilds never falls back to taskkill when nativeTerminateProcess returns null for a reused PID", async () => {
		fakePlatform("win32");
		fakes.interceptStartToken = true;
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
			JSON.stringify({ host: THIS_HOST, pid: 41000, start: "aaaaaaaaaaaa", steps: [{ pid: 41030, start }] }),
		);

		const settled = await settleOtherBuilds(storeDir, [root], { waitMs: 50 });
		await settled.release();

		assert.deepEqual(fakes.nativeTerminateCalls, [{ pid: 41030, started: created, descendants: true }]);
		assert.deepEqual(fakes.taskkillRuns, [], "must not fall back to taskkill on native null");
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
		"worktree-snapshot runGit stopCommand uses holdProcessDescendants when containProcessTree is unavailable and never spawns taskkill",
		async () => {
			fakePlatform("win32");
			fakes.interceptContainment = true;
			fakes.containAvailable = false;
			fakes.interceptHold = true;
			fakes.holdMode = "held";
			const dir = makeTempDir("atomic-killtree-git-");
			const fakeGit = join(dir, "fake-git.sh");
			writeFileSync(fakeGit, "#!/bin/sh\nsleep 30\n");
			chmodSync(fakeGit, 0o755);
			const prevGit = setWorktreeSnapshotGit(async () => ({ path: fakeGit, env: {} }));
			try {
				const controller = new AbortController();
				const running = runGit(["status"], { cwd: dir, signal: controller.signal });
				running.catch(() => {});
				await new Promise((resolve) => setTimeout(resolve, 100));
				controller.abort(new Error("aborted"));
				await vi.waitFor(() => assert.equal(fakes.holdCalls.length, 1));
				assert.deepEqual(
					fakes.taskkillRuns,
					[],
					"git fallback must use holdProcessDescendants when native is available",
				);
				const pid = fakes.holdCalls[0]!;
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
				await assert.rejects(running, /aborted/);
			} finally {
				setWorktreeSnapshotGit(prevGit);
			}
		},
	);
});

// Real Windows kernel verification: orphan grandchildren, PID reuse, and zero bare-PID taskkill calls.
describe.runIf(process.platform === "win32")("on Windows, real kernel tree-kill safety", () => {
	const GONE_MS = 10_000;
	const NOT_ENDED_MS = 800;
	const POLL_MS = 20;

	async function waitForPidFile(file: string): Promise<RecordedProcess> {
		const deadline = Date.now() + 20_000;
		while (!(existsSync(file) && readFileSync(file, "utf8").trim() !== "") && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
		const recorded = await recordProcess(Number(readFileSync(file, "utf8").trim()));
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
			cwd: dir,
			env: process.env,
			timeoutMs: 3_000,
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
			`require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => process.exit(0), 120_000);`,
		);
		const parentScript = join(dir, "parent.cjs");
		writeFileSync(
			parentScript,
			`require("node:child_process").spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore", windowsHide: true }); setTimeout(() => process.exit(0), 120_000);`,
		);

		const shellProc = await spawnShellProcess(process.execPath, [parentScript, childScript, pidFile], {
			cwd: dir,
			env: process.env,
			stdin: "ignore",
		});
		try {
			const descendant = await waitForPidFile(pidFile);
			assert.equal(await stillRuns(descendant), true);

			shellProc.stop();

			assert.equal(await waitUntilGone(descendant, GONE_MS), true, "fallback stop ended live descendant");
			assert.deepEqual(fakes.taskkillRuns, [], "fallback stop used native holdProcessDescendants, never taskkill");
		} finally {
			shellProc.finish();
		}

		// Exited shell: stop() and killTrackedDetachedChildren() must never invoke taskkill on its bare PID.
		const quickProc = await spawnShellProcess(process.execPath, ["-e", "process.exit(0)"], {
			cwd: dir,
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
			`require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => process.exit(0), 120_000);`,
		);
		const engineScript = join(dir, "engine.cjs");
		writeFileSync(
			engineScript,
			`require("node:child_process").spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore", windowsHide: true }); process.stdin.resume(); setTimeout(() => process.exit(0), 120_000);`,
		);

		const child = spawn(process.execPath, [engineScript, childScript, pidFile], {
			cwd: dir,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
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
			`require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => process.exit(0), 120_000);`,
		);
		const stepScript = join(dir, "step.cjs");
		writeFileSync(
			stepScript,
			`require("node:child_process").spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore", windowsHide: true }); setTimeout(() => process.exit(0), 120_000);`,
		);

		// Dead holder process.
		const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
		const deadStart = processStartToken(dead.pid!);
		await exited(dead);

		// Live step + child + unrelated bystander (simulating reused PID with different start token).
		const step = spawn(process.execPath, [stepScript, childScript, pidFile], {
			cwd: dir,
			stdio: "ignore",
			windowsHide: true,
		});
		const stepRec = await recordProcess(step.pid!);
		recordedProcs.push(stepRec);
		const stepChild = await waitForPidFile(pidFile);
		const bystander = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 120_000)"], {
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
const { writeFileSync } = require("node:fs");
const [self, pidFile, role] = process.argv.slice(1);
if (role === "leaf") {
	writeFileSync(pidFile, String(process.pid));
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
			`require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => process.exit(0), 120_000);`,
		);
		const parentScript = join(dir, "tracked-parent.cjs");
		writeFileSync(
			parentScript,
			`require("node:child_process").spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore", windowsHide: true }); setTimeout(() => process.exit(0), 120_000);`,
		);

		// Live tracked parent + child -> ended synchronously via nativeTerminateProcess without taskkill.
		const parent = spawn(process.execPath, [parentScript, childScript, pidFile], {
			cwd: dir,
			stdio: "ignore",
			windowsHide: true,
		});
		const parentRec = await recordProcess(parent.pid!);
		recordedProcs.push(parentRec);
		const childRec = await waitForPidFile(pidFile);

		// Short-lived tracked process that exits before killTrackedDetachedChildren -> native sees gone, no taskkill.
		const shortLived = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
		trackDetachedChildPid(shortLived.pid!);
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
		assert.deepEqual(fakes.taskkillRuns, [], "killTrackedDetachedChildren never spawned taskkill on native Windows");
	});
});
