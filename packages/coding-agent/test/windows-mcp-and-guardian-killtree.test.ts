import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
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

const fakes = vi.hoisted(() => ({
	taskkillRuns: [] as { command: string; args: string[]; cwd: string | undefined }[],
	taskkillFirstEnoent: false,
	interceptContainment: false,
	containAvailable: true,
	containBreakawayCalls: [] as number[],
	containedTrees: [] as { pid: number; active: number; terminated: number; released: number; closed: number }[],
	interceptHold: false,
	holdMode: "held" as "held" | "held-root-exited" | "absent" | "unavailable",
	holdCalls: [] as number[],
	holdEnded: 0,
	interceptStartToken: false,
	nativeCreationReturn: undefined as string | null | undefined,
	crossSpawnOverride: undefined as
		| ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess)
		| undefined,
	interceptCwdResolver: false,
	cwdResolverGate: undefined as (() => Promise<string | undefined>) | undefined,
	fsProbes: [] as string[],
	interceptFsPromises: false,
}));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	const spawn = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
		const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
		const spawnOptions = (Array.isArray(argsOrOptions) ? options : argsOrOptions) ?? {};
		if (!String(command).toLowerCase().endsWith("taskkill.exe")) {
			return actual.spawn(command, args, spawnOptions);
		}
		const callIndex = fakes.taskkillRuns.length;
		fakes.taskkillRuns.push({
			command: String(command),
			args: [...args],
			cwd: spawnOptions.cwd === undefined ? undefined : String(spawnOptions.cwd),
		});
		const run = new EventEmitter();
		queueMicrotask(() => {
			if (fakes.taskkillFirstEnoent && callIndex === 0) {
				run.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
			} else {
				run.emit("exit", 0, null);
				run.emit("close", 0, null);
			}
		});
		return run as unknown as ChildProcess;
	}) as typeof actual.spawn;
	return { ...actual, spawn, default: { ...actual, spawn } };
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
		const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
		const spawnOptions = (Array.isArray(argsOrOptions) ? options : argsOrOptions) ?? {};
		if (!String(command).toLowerCase().endsWith("taskkill.exe")) {
			return actual.spawn(command, args, spawnOptions);
		}
		const callIndex = fakes.taskkillRuns.length;
		fakes.taskkillRuns.push({
			command: String(command),
			args: [...args],
			cwd: spawnOptions.cwd === undefined ? undefined : String(spawnOptions.cwd),
		});
		const run = new EventEmitter();
		queueMicrotask(() => {
			if (fakes.taskkillFirstEnoent && callIndex === 0) {
				run.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
			} else {
				run.emit("exit", 0, null);
				run.emit("close", 0, null);
			}
		});
		return run as unknown as ChildProcess;
	}) as typeof actual.spawn;
	return { ...actual, spawn, default: { ...actual, spawn } };
});

vi.mock("cross-spawn", async (importOriginal) => {
	const actual = await importOriginal<typeof import("cross-spawn")>();
	const crossSpawn = ((command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
		if (fakes.crossSpawnOverride) return fakes.crossSpawnOverride(command, args, options);
		return actual.default(command, args, options);
	}) as typeof actual.default;
	return { ...actual, default: crossSpawn };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const stat = (async (path: Parameters<typeof actual.stat>[0]) => {
		if (fakes.interceptFsPromises) {
			fakes.fsProbes.push(`stat:${String(path)}`);
			return { isDirectory: () => true } as Stats;
		}
		return actual.stat(path);
	}) as typeof actual.stat;
	const realpath = (async (path: Parameters<typeof actual.realpath>[0], opts?: BufferEncoding) => {
		if (fakes.interceptFsPromises) {
			fakes.fsProbes.push(`realpath:${String(path)}`);
			return String(path);
		}
		return actual.realpath(path, opts);
	}) as typeof actual.realpath;
	return { ...actual, stat, realpath, default: { ...actual, stat, realpath } };
});

vi.mock("../src/core/process-tree-containment.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/process-tree-containment.ts")>();
	const makeTree = (pid: number) => {
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
	};
	const makeHeld = (rootEnded: boolean) => ({
		count: 1,
		endAll: () => {
			if (rootEnded) fakes.holdEnded++;
			return rootEnded;
		},
		endDescendants: () => 1,
		release: () => {},
	});
	return {
		...actual,
		containProcessTree: (pid: number) => {
			if (!fakes.interceptContainment) return actual.containProcessTree(pid);
			return fakes.containAvailable ? makeTree(pid) : undefined;
		},
		containProcessTreeAllowingBreakaway: (pid: number) => {
			if (!fakes.interceptContainment) return actual.containProcessTreeAllowingBreakaway(pid);
			fakes.containBreakawayCalls.push(pid);
			return fakes.containAvailable ? makeTree(pid) : undefined;
		},
		holdProcessDescendantsResult: (pid: number) => {
			if (!fakes.interceptHold) return actual.holdProcessDescendantsResult(pid);
			fakes.holdCalls.push(pid);
			if (fakes.holdMode === "held") return { kind: "held" as const, held: makeHeld(true) };
			if (fakes.holdMode === "held-root-exited") return { kind: "held" as const, held: makeHeld(false) };
			if (fakes.holdMode === "absent") return { kind: "absent" as const };
			return { kind: "unavailable" as const };
		},
		hasNativeProcessHold: () => {
			if (!fakes.interceptHold) return actual.hasNativeProcessHold?.() ?? false;
			return fakes.holdMode !== "unavailable";
		},
	};
});

vi.mock("../src/core/process-start-token.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/process-start-token.js")>();
	return {
		...actual,
		nativeProcessCreationTime: (pid: number) => {
			if (!fakes.interceptStartToken) return actual.nativeProcessCreationTime(pid);
			return fakes.nativeCreationReturn;
		},
	};
});

vi.mock("../src/utils/windows-cwd.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/windows-cwd.js")>();
	return {
		...actual,
		resolveSafeWindowsWorkingDirectoryAsync: async (
			opts?: Parameters<typeof actual.resolveSafeWindowsWorkingDirectoryAsync>[0],
		) => {
			if (fakes.interceptCwdResolver && fakes.cwdResolverGate) return fakes.cwdResolverGate();
			return actual.resolveSafeWindowsWorkingDirectoryAsync(opts);
		},
	};
});

const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.js");
const {
	getPowerShellConfig,
	killChildProcessTree,
	killTrackedDetachedChildren,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} = await import("../src/utils/shell.js");
const { renameWithRetry } = await import("../src/core/rename-retry.ts");
const { runGit, setWorktreeSnapshotGit } = await import("../src/core/worktree-snapshot/git.ts");

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
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

function createFakeChild(pid: number) {
	const child = Object.assign(new EventEmitter(), {
		pid,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		killed: false,
		kill: vi.fn(() => true),
		ref() {},
		unref() {},
	});
	return child;
}

beforeEach(() => {
	fakes.taskkillRuns.length = 0;
	fakes.taskkillFirstEnoent = false;
	fakes.interceptContainment = false;
	fakes.containAvailable = true;
	fakes.containBreakawayCalls.length = 0;
	fakes.containedTrees.length = 0;
	fakes.interceptHold = false;
	fakes.holdMode = "held";
	fakes.holdCalls.length = 0;
	fakes.holdEnded = 0;
	fakes.interceptStartToken = false;
	fakes.nativeCreationReturn = undefined;
	fakes.crossSpawnOverride = undefined;
	fakes.interceptCwdResolver = false;
	fakes.cwdResolverGate = undefined;
	fakes.fsProbes.length = 0;
	fakes.interceptFsPromises = false;
});

afterEach(async () => {
	vi.useRealTimers();
	Object.defineProperty(process, "platform", realPlatform);
	vi.restoreAllMocks();
	for (const recorded of recordedProcs.splice(0)) await signalRecordedProcess(recorded);
	for (const dir of tempDirs.splice(0))
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe("O9b Windows MCP stdio close, guardian, and remaining bare-PID kill safety", () => {
	test("StdioTransport on Windows uses breakaway Job object + holdProcessDescendantsResult and never spawns taskkill or probes kill-cwd when native is available", async () => {
		fakePlatform("win32");
		fakes.interceptContainment = true;
		fakes.containAvailable = true;
		fakes.interceptHold = true;
		fakes.holdMode = "held";
		fakes.interceptFsPromises = true;

		const fakeChild = createFakeChild(51004);
		fakes.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};

		const transport = new StdioTransport({ command: "C:\\Tools\\node.exe", closeTimeoutMs: 50 });
		await transport.start();
		assert.deepEqual(fakes.containBreakawayCalls, [51004], "attaches breakaway-allowing Job object on start()");

		vi.useFakeTimers();
		const closing = transport.close();
		await vi.advanceTimersByTimeAsync(50);
		fakeChild.exitCode = 1;
		fakeChild.emit("close", 1, null);
		await vi.advanceTimersByTimeAsync(0);
		await closing;

		assert.deepEqual(fakes.holdCalls, [51004]);
		assert.equal(fakes.holdEnded, 1);
		assert.equal(fakes.containedTrees.length, 1);
		assert.equal(fakes.containedTrees[0]!.terminated, 1, "Job object terminated once");
		assert.equal(fakes.containedTrees[0]!.closed, 1, "Job object handle closed");
		assert.deepEqual(fakes.taskkillRuns, [], "never spawns taskkill when native is available");
		assert.deepEqual(fakes.fsProbes, [], "performs zero kill-cwd filesystem probes when native is available");
	});

	test("StdioTransport on Windows never falls back to taskkill when Job is unavailable and native hold reports absent", async () => {
		fakePlatform("win32");
		fakes.interceptContainment = true;
		fakes.containAvailable = false;
		fakes.interceptHold = true;
		fakes.holdMode = "absent";

		const fakeChild = createFakeChild(51008);
		fakeChild.kill.mockImplementation(() => {
			fakeChild.exitCode = 1;
			fakeChild.emit("close", 1, null);
			return true;
		});
		fakes.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};

		const transport = new StdioTransport({ command: "C:\\Tools\\node.exe", closeTimeoutMs: 50 });
		await transport.start();

		vi.useFakeTimers();
		const closing = transport.close();
		await vi.advanceTimersByTimeAsync(50);
		await closing;

		assert.deepEqual(fakes.holdCalls, [51008]);
		assert.deepEqual(fakes.taskkillRuns, [], "must not fall back to taskkill on native absent");
		assert.equal(fakeChild.kill.mock.calls.length, 1, "falls back to live handle kill only");
	});

	test("StdioTransport on Windows releases the Job object without terminating members on cooperative close and already-exited close", async () => {
		fakePlatform("win32");
		fakes.interceptContainment = true;
		fakes.containAvailable = true;
		fakes.interceptHold = true;
		fakes.holdMode = "held";

		// 1) Cooperative close: server exits on stdin EOF before grace fires.
		const coopChild = createFakeChild(51010);
		coopChild.stdin.on("finish", () => {
			coopChild.exitCode = 0;
			coopChild.emit("close", 0, null);
		});
		fakes.crossSpawnOverride = () => {
			process.nextTick(() => coopChild.emit("spawn"));
			return coopChild as unknown as ChildProcess;
		};

		const transport1 = new StdioTransport({ command: "C:\\Tools\\node.exe", closeTimeoutMs: 500 });
		await transport1.start();
		await transport1.close();

		assert.equal(fakes.containedTrees.length, 1);
		assert.equal(fakes.containedTrees[0]!.terminated, 0, "cooperative close must not terminate Job members");
		assert.equal(fakes.containedTrees[0]!.released, 1, "cooperative close releases Job before closing");
		assert.equal(fakes.containedTrees[0]!.closed, 1, "cooperative close closes Job handle");
		assert.deepEqual(fakes.holdCalls, [], "cooperative close does not force-kill descendants");

		// 2) Already exited before close().
		const exitedChild = createFakeChild(51011);
		fakes.crossSpawnOverride = () => {
			process.nextTick(() => exitedChild.emit("spawn"));
			return exitedChild as unknown as ChildProcess;
		};
		const transport2 = new StdioTransport({ command: "C:\\Tools\\node.exe", closeTimeoutMs: 500 });
		await transport2.start();
		exitedChild.exitCode = 0;
		await transport2.close();

		assert.equal(fakes.containedTrees.length, 2);
		assert.equal(fakes.containedTrees[1]!.terminated, 0, "already-exited close must not terminate Job members");
		assert.equal(fakes.containedTrees[1]!.released, 1, "already-exited close releases Job before closing");
		assert.equal(fakes.containedTrees[1]!.closed, 1, "already-exited close closes Job handle");
	});

	test("killTrackedDetachedChildren on Windows never kills an unverified bare PID when natives are unavailable", () => {
		fakePlatform("win32");
		fakes.interceptStartToken = true;
		fakes.nativeCreationReturn = undefined; // native addon unavailable -> no verified creation time
		fakes.interceptHold = true;
		fakes.holdMode = "unavailable";

		trackDetachedChildPid(51012);
		try {
			killTrackedDetachedChildren();
		} finally {
			untrackDetachedChildPid(51012);
		}

		assert.deepEqual(fakes.taskkillRuns, [], "must never kill an unverified bare PID without natives");
	});

	test("killChildProcessTree async taskkill ENOENT cwd-retry does not spawn a second taskkill if the child exited while resolving cwd", async () => {
		fakePlatform("win32");
		fakes.interceptHold = true;
		fakes.holdMode = "unavailable";
		fakes.taskkillFirstEnoent = true;
		fakes.interceptCwdResolver = true;

		const fakeChild = createFakeChild(51016);
		let releaseCwd!: (cwd: string) => void;
		fakes.cwdResolverGate = () =>
			new Promise<string | undefined>((resolve) => {
				releaseCwd = resolve;
			});

		killChildProcessTree(fakeChild as unknown as ChildProcess, false);
		await vi.waitFor(() => assert.equal(fakes.taskkillRuns.length, 1, "first taskkill attempted while live"));

		// Child exits while resolveSafeWindowsWorkingDirectoryAsync is still pending (its PID may now be reused).
		fakeChild.exitCode = 0;
		releaseCwd("D:\\OtherSafeDir");
		await new Promise((resolve) => setTimeout(resolve, 20));

		assert.equal(fakes.taskkillRuns.length, 1, "must not spawn retry taskkill after child exited");
	});

	test.skipIf(process.platform === "win32")(
		"worktree-snapshot runGit taskkill fallback does not spawn taskkill if the child exits while resolving safe cwd",
		async () => {
			fakePlatform("win32");
			fakes.interceptContainment = true;
			fakes.containAvailable = false;
			fakes.interceptHold = true;
			fakes.holdMode = "unavailable";
			fakes.interceptCwdResolver = true;

			let releaseCwd!: (cwd: string | undefined) => void;
			let cwdCalled!: () => void;
			const cwdStarted = new Promise<void>((resolve) => {
				cwdCalled = resolve;
			});
			fakes.cwdResolverGate = () => {
				cwdCalled();
				return new Promise<string | undefined>((resolve) => {
					releaseCwd = resolve;
				});
			};

			const dir = makeTempDir("atomic-killtree-git-cwd-race-");
			const pidFile = join(dir, "git.pid");
			const fakeGit = join(dir, "fake-git.sh");
			writeFileSync(fakeGit, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
			chmodSync(fakeGit, 0o755);
			const prevGit = setWorktreeSnapshotGit(async () => ({ path: fakeGit, env: {} }));
			try {
				const controller = new AbortController();
				const running = runGit(["status"], { cwd: dir, signal: controller.signal });
				running.catch(() => {});
				await vi.waitFor(() => assert.equal(existsSync(pidFile), true));
				const gitPid = Number(readFileSync(pidFile, "utf8").trim());

				controller.abort(new Error("aborted"));
				await cwdStarted;
				// Child exits while resolveSafeWindowsWorkingDirectoryAsync is still pending.
				try {
					process.kill(gitPid, "SIGKILL");
				} catch {}
				await new Promise((resolve) => setTimeout(resolve, 40));
				releaseCwd("C:\\Windows");

				await assert.rejects(running, /aborted/);
				assert.deepEqual(fakes.taskkillRuns, [], "must not spawn taskkill after child exited during cwd lookup");
			} finally {
				setWorktreeSnapshotGit(prevGit);
			}
		},
	);
});

// Real Windows kernel verification: MCP orphan grandchild + breakaway + guardian reused-PID decoy survival!
describe.runIf(process.platform === "win32")(
	"on Windows, real kernel MCP stdio and parent guardian tree-kill safety",
	() => {
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

		test("StdioTransport.close() ends a stubborn MCP server and its orphan grandchild, unlocks the folder, and spawns zero taskkill commands", async () => {
			const dir = makeTempDir("atomic-win-mcp-orphan-");
			const workDir = join(dir, "work");
			mkdirSync(workDir);
			const pidFile = join(dir, "orphan.pid");
			const script = join(dir, "mcp-orphan.cjs");
			writeFileSync(
				script,
				`
const { spawn } = require("node:child_process");
const { openSync, renameSync, writeFileSync } = require("node:fs");
const [self, pidFile, role] = process.argv.slice(1);
if (role === "orphan") {
	openSync("held.txt", "w");
	writeFileSync(pidFile + ".tmp", String(process.pid));
	renameSync(pidFile + ".tmp", pidFile);
	setTimeout(() => process.exit(0), 120_000);
} else if (role === "starter") {
	spawn(process.execPath, [self, pidFile, "orphan"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
} else {
	spawn(process.execPath, [self, pidFile, "starter"], { stdio: "ignore", windowsHide: true });
	process.stdin.resume();
	setTimeout(() => process.exit(0), 120_000);
}
`,
			);

			const transport = new StdioTransport({
				command: process.execPath,
				args: [script, pidFile, "root"],
				cwd: workDir,
				projectCwd: workDir,
				closeTimeoutMs: 2_000,
			});
			await transport.start();
			assert.ok(transport.pid !== undefined);
			const rootRec = await recordProcess(transport.pid);
			recordedProcs.push(rootRec);

			const orphan = await waitForPidFile(pidFile);
			assert.equal(await stillRuns(orphan), true, "orphan grandchild is running");

			await transport.close();

			assert.equal(await isGone(rootRec), true, "MCP server ended");
			assert.equal(await isGone(orphan), true, "orphan grandchild ended before StdioTransport.close() resolved");
			assert.deepEqual(fakes.taskkillRuns, [], "StdioTransport.close() never spawned taskkill under native Windows");
			await renameWithRetry(workDir, join(dir, "work-moved"), { budgetMs: 10_000 });
		});

		const BREAKAWAY_HELPER_CS = `using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AtomicMcpBreakaway {
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

		test("StdioTransport allows an explicit CREATE_BREAKAWAY_FROM_JOB helper to start without error 5 and survive cooperative close", async () => {
			const dir = makeTempDir("atomic-win-mcp-breakaway-");
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
			// Starts breakaway helper, then exits cleanly when stdin closes.
			const psCommand = `Add-Type -Path ${psWord(csFile)}; $id = [AtomicMcpBreakaway]::Start(${psWord(cmdLine)}); if ($id -le 0) { Set-Content -NoNewline -Path ${psWord(errFile)} -Value (-$id); exit 1 }; $null = [Console]::In.ReadToEnd(); exit 0`;

			const transport = new StdioTransport({
				command: ps.shell,
				args: [...ps.args, psCommand],
				cwd: tmpdir(),
				closeTimeoutMs: 5_000,
			});
			await transport.start();
			const survivor = await waitForPidFile(pidFile);
			await transport.close();

			assert.equal(
				existsSync(errFile),
				false,
				existsSync(errFile)
					? `CREATE_BREAKAWAY_FROM_JOB failed with Win32 error ${readFileSync(errFile, "utf8")}`
					: "",
			);
			assert.equal(
				await waitUntilGone(survivor, NOT_ENDED_MS),
				false,
				"breakaway helper survived cooperative close",
			);
		});

		test("StdioTransport preserves a detached non-breakaway helper across a cooperative close", async () => {
			const dir = makeTempDir("atomic-win-mcp-coop-detached-");
			const pidFile = join(dir, "detached.pid");
			const helperScript = join(dir, "helper.cjs");
			writeFileSync(
				helperScript,
				`const fs = require("node:fs"); fs.writeFileSync(process.argv[2] + ".tmp", String(process.pid)); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); setTimeout(() => process.exit(0), 120_000);`,
			);
			const serverScript = join(dir, "server.cjs");
			writeFileSync(
				serverScript,
				`const cp = require("node:child_process");
cp.spawn(process.execPath, [process.argv[2], process.argv[3]], { cwd: require("node:os").tmpdir(), detached: true, stdio: "ignore", windowsHide: true }).unref();
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
setTimeout(() => process.exit(0), 120_000);
`,
			);

			const transport = new StdioTransport({
				command: process.execPath,
				args: [serverScript, helperScript, pidFile],
				cwd: tmpdir(),
				closeTimeoutMs: 5_000,
			});
			await transport.start();
			const detachedHelper = await waitForPidFile(pidFile);
			assert.equal(await stillRuns(detachedHelper), true);

			await transport.close();

			assert.equal(
				await waitUntilGone(detachedHelper, NOT_ENDED_MS),
				false,
				"detached helper must survive cooperative MCP close",
			);
		});

		test("PARENT_GUARDIAN_SOURCE terminates self, its live child, and a live verified tracked tree natively while sparing a live reused-PID decoy", async () => {
			const dir = makeTempDir("atomic-win-guardian-decoy-");
			const stopFile = join(dir, "stop");
			const childPidFile = join(dir, "child.pid");
			const trackedPidFile = join(dir, "tracked.pid");
			const trackedGrandPidFile = join(dir, "tracked-grand.pid");
			const childScript = join(dir, "child.cjs");
			writeFileSync(
				childScript,
				`const fs = require("node:fs"); fs.writeFileSync(process.argv[2] + ".tmp", String(process.pid)); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); setTimeout(() => process.exit(0), 120_000);`,
			);
			const trackedParentScript = join(dir, "tracked-parent.cjs");
			writeFileSync(
				trackedParentScript,
				`const fs = require("node:fs"); const cp = require("node:child_process"); fs.writeFileSync(process.argv[2] + ".tmp", String(process.pid)); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); cp.spawn(process.execPath, [process.argv[3], process.argv[4]], { cwd: require("node:os").tmpdir(), stdio: "ignore", windowsHide: true }); setTimeout(() => process.exit(0), 120_000);`,
			);

			// Spawn an unrelated live decoy process (representing a process that reused a tracked child's PID).
			const decoyProc = spawnProcess([process.execPath, "-e", "setTimeout(() => process.exit(0), 120_000)"], {
				stdout: "ignore",
				stderr: "ignore",
			});
			const decoy = await recordProcess(decoyProc.pid!);
			recordedProcs.push(decoy);

			// Spawn a live tracked process + its own child OUTSIDE the guardian host's direct PPID tree
			// so only the guardian's native terminateProcessCreatedAt(trackedPid, created, true) path can end them.
			const trackedProc = spawnProcess(
				[process.execPath, trackedParentScript, trackedPidFile, childScript, trackedGrandPidFile],
				{ cwd: tmpdir(), stdout: "ignore", stderr: "ignore" },
			);
			const trackedRec = await waitForPidFile(trackedPidFile);
			const trackedGrandRec = await waitForPidFile(trackedGrandPidFile);

			// Launch a host running startParentProcessGuardian that:
			// 1) Spawns a real child C of itself (must be ended by guardian's holdProcessDescendants + endDescendants!).
			// 2) Tracks trackedRec.pid with its REAL creation time (must be ended with trackedGrandRec!).
			// 3) Tracks decoy.pid with an EARLIER process's creation time (simulating PID reuse -> decoy MUST survive!).
			// 4) Writes stopFile so guardian triggers immediately.
			const shellUrl = pathToFileURL(join(process.cwd(), "src/utils/shell.ts")).href;
			const tokenUrl = pathToFileURL(join(process.cwd(), "src/core/process-start-token.ts")).href;
			const hostScript = `
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setNativeProcessCreationTimeForTesting } from ${JSON.stringify(tokenUrl)};
import { startParentProcessGuardian, trackDetachedChildPid } from ${JSON.stringify(shellUrl)};

const child = spawn(process.execPath, [${JSON.stringify(childScript)}, ${JSON.stringify(childPidFile)}], {
	cwd: tmpdir(),
	stdio: "ignore",
	windowsHide: true,
});
while (!(existsSync(${JSON.stringify(childPidFile)}) && readFileSync(${JSON.stringify(childPidFile)}, "utf8").trim() !== "")) {
	await new Promise((r) => setTimeout(r, 20));
}

// Track the real live tracked process with its real kernel creation time.
trackDetachedChildPid(${trackedRec.pid});

// Simulate that decoy.pid was previously owned by an older process created at 133500000000000001
// before exiting and having Windows reassign decoy.pid to the live unrelated decoy!
setNativeProcessCreationTimeForTesting(() => "133500000000000001");
trackDetachedChildPid(${decoy.pid});
setNativeProcessCreationTimeForTesting(undefined);

startParentProcessGuardian(process.pid, ${JSON.stringify(stopFile)});
await new Promise((r) => setTimeout(r, 150));
writeFileSync(${JSON.stringify(stopFile)}, "stop");
setTimeout(() => { process.stdout.write("SURVIVED"); process.exit(0); }, 20_000);
`;
			const host = spawnProcess([bunExecutable(), "--eval", hostScript], { stdout: "pipe", stderr: "pipe" });
			const hostRec = await recordProcess(host.pid!);
			recordedProcs.push(hostRec);

			const childRec = await waitForPidFile(childPidFile);
			const exitCode = await Promise.race([
				host.exited,
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20_000)),
			]);
			if (exitCode === "timeout") host.kill();

			assert.notEqual(exitCode, "timeout", "guardian terminated its own process");
			assert.equal(
				await waitUntilGone(childRec, GONE_MS),
				true,
				"guardian terminated its own live descendant child",
			);
			assert.equal(await waitUntilGone(trackedRec, GONE_MS), true, "guardian terminated verified tracked process");
			assert.equal(
				await waitUntilGone(trackedGrandRec, GONE_MS),
				true,
				"guardian terminated tracked process's child",
			);
			assert.equal(
				await waitUntilGone(decoy, NOT_ENDED_MS),
				false,
				"reused-PID decoy process MUST survive guardian cleanup",
			);
			await trackedProc.exited;
		});

		test("PARENT_GUARDIAN_SOURCE falls back to taskkill for self when older natives lack endDescendants, ending detached descendants", async () => {
			const dir = makeTempDir("atomic-win-guardian-old-natives-");
			const stopFile = join(dir, "stop");
			const childPidFile = join(dir, "child.pid");
			const childScript = join(dir, "child.cjs");
			writeFileSync(
				childScript,
				`const fs = require("node:fs"); fs.writeFileSync(process.argv[2] + ".tmp", String(process.pid)); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); setTimeout(() => process.exit(0), 120_000);`,
			);
			// Preload that intercepts @bastani/atomic-natives inside the Node guardian worker to strip endDescendants,
			// matching a 0.10.4 native binary where endAll() alone would kill self before ending descendants.
			const preload = join(dir, "old-natives-preload.cjs");
			writeFileSync(
				preload,
				`const Module = require("node:module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	const mod = origLoad.apply(this, arguments);
	if (request === "@bastani/atomic-natives" && mod && typeof mod.holdProcessDescendants === "function") {
		return {
			...mod,
			holdProcessDescendants(pid) {
				const held = mod.holdProcessDescendants(pid);
				if (!held) return held;
				return {
					get count() { return held.count; },
					endAll: () => held.endAll(),
					release: () => held.release(),
				};
			},
		};
	}
	return mod;
};
`,
			);
			const resolveTsHook = `data:text/javascript,${encodeURIComponent(`import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`)}`;
			const shellUrl = pathToFileURL(join(process.cwd(), "src/utils/shell.ts")).href;
			const hostScript = `
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { startParentProcessGuardian } from ${JSON.stringify(shellUrl)};

spawn(process.execPath, [${JSON.stringify(childScript)}, ${JSON.stringify(childPidFile)}], {
	cwd: tmpdir(),
	detached: true,
	stdio: "ignore",
	windowsHide: true,
}).unref();
while (!(existsSync(${JSON.stringify(childPidFile)}) && readFileSync(${JSON.stringify(childPidFile)}, "utf8").trim() !== "")) {
	await new Promise((r) => setTimeout(r, 20));
}

startParentProcessGuardian(process.pid, ${JSON.stringify(stopFile)});
await new Promise((r) => setTimeout(r, 150));
writeFileSync(${JSON.stringify(stopFile)}, "stop");
setTimeout(() => { process.stdout.write("SURVIVED"); process.exit(0); }, 20_000);
`;
			const host = spawnProcess(
				[process.execPath, "--import", resolveTsHook, "--input-type=module", "--eval", hostScript],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
				},
			);
			const hostRec = await recordProcess(host.pid!);
			recordedProcs.push(hostRec);

			const childRec = await waitForPidFile(childPidFile);
			const exitCode = await Promise.race([
				host.exited,
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
			]);
			if (exitCode === "timeout") host.kill();

			assert.notEqual(exitCode, "timeout", "guardian terminated host under older natives");
			assert.equal(
				await waitUntilGone(childRec, GONE_MS),
				true,
				"guardian fell back to taskkill and ended detached child when older natives lacked endDescendants",
			);
		});

		test("PARENT_GUARDIAN_SOURCE exits its host via process.exit(1) when natives are unavailable and fallback taskkill cannot spawn", async () => {
			const dir = makeTempDir("atomic-win-guardian-tk-enoent-");
			const stopFile = join(dir, "stop");
			const emptySystemRoot = join(dir, "empty-win");
			mkdirSync(emptySystemRoot);
			const preload = join(dir, "no-natives-preload.cjs");
			writeFileSync(
				preload,
				`const Module = require("node:module");
const origLoad = Module._load;
Module._load = function (request) {
	if (request === "@bastani/atomic-natives") {
		throw Object.assign(new Error("Cannot find module '@bastani/atomic-natives'"), { code: "MODULE_NOT_FOUND" });
	}
	return origLoad.apply(this, arguments);
};
`,
			);
			const resolveTsHook = `data:text/javascript,${encodeURIComponent(`import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`)}`;
			const shellUrl = pathToFileURL(join(process.cwd(), "src/utils/shell.ts")).href;
			const hostScript = `
import { writeFileSync } from "node:fs";
import { startParentProcessGuardian } from ${JSON.stringify(shellUrl)};
startParentProcessGuardian(process.pid, ${JSON.stringify(stopFile)});
await new Promise((r) => setTimeout(r, 150));
writeFileSync(${JSON.stringify(stopFile)}, "stop");
setTimeout(() => { process.stdout.write("SURVIVED"); process.exit(0); }, 20_000);
`;
			const host = spawnProcess(
				[process.execPath, "--import", resolveTsHook, "--input-type=module", "--eval", hostScript],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						SystemRoot: emptySystemRoot,
						windir: emptySystemRoot,
						NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
					},
				},
			);
			const hostRec = await recordProcess(host.pid!);
			recordedProcs.push(hostRec);

			const exitCode = await Promise.race([
				host.exited,
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
			]);
			if (exitCode === "timeout") host.kill();

			assert.equal(exitCode, 1, "guardian still exited host with code 1 when fallback taskkill failed with ENOENT");
		});
	},
);
