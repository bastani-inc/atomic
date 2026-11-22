import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, test } from "vitest";
import { terminateRpcClientProcess } from "../../packages/coding-agent/src/modes/rpc/rpc-client-process.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "../../packages/intercom/broker/control-request.js";
import { getBrokerLogPath, getBrokerPidPath, getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { bunExecutable, makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";

const REPO = join(moduleDir(import.meta.url), "../..");
const INTERCOM_DIR = join(REPO, "packages/intercom");
const SPAWN_ENTRY = join(INTERCOM_DIR, "broker/spawn.ts");
const JITI_CLI = join(REPO, "node_modules/jiti/lib/jiti-cli.mjs");
const WINDOWS_DETACH_TEST_TIMEOUT_MS = 60_000;

/**
 * PowerShell Win32 harness that runs a parent command in one of three real Windows containment/console environments:
 * - `breakaway-job`: Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK; closes job
 *   once parent exits, proving the spawned broker broke away and survived job closure.
 * - `strict-job`: Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE only (no breakaway); proves the retry without
 *   CREATE_BREAKAWAY_FROM_JOB still starts the broker and lets it answer before the job closes.
 * - `conpty-close`: fresh pseudoconsole (ConPTY); closes the pseudoconsole once the broker is listening, proving the
 *   broker is detached from the parent console and survives console closure.
 */
const WIN32_HARNESS = String.raw`
param([string]$Mode, [string]$CommandLine, [string]$Cwd, [string]$BrokerPidFile, [string]$ReadyMarker)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AtomicBrokerDetachHarness {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY;
    public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput;
    public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong R; public ulong W; public ulong O; public ulong RT; public ulong WT; public ulong OT; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, int size);
  [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
  [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  public static string RunJob(string cmdLine, string cwd, string pidFile, bool allowBreakaway) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = allowBreakaway ? (0x2000u | 0x0800u) : 0x2000u;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
      throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error());
    var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, false, 0x4 | 0x08000000, IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("CreateProcessW " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, pi.hProcess))
      throw new Exception("AssignProcessToJobObject " + Marshal.GetLastWin32Error());
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    bool parentExited = WaitForSingleObject(pi.hProcess, 30000) == 0;
    uint parentCode = 999;
    if (parentExited) GetExitCodeProcess(pi.hProcess, out parentCode);
    else TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hProcess);
    int brokerPid = 0;
    bool inJobBeforeClose = false;
    IntPtr brokerHandle = IntPtr.Zero;
    if (File.Exists(pidFile)) {
      int.TryParse(File.ReadAllText(pidFile).Trim(), out brokerPid);
      if (brokerPid > 0) {
        brokerHandle = OpenProcess(0x00100000 | 0x1000, false, brokerPid);
        if (brokerHandle != IntPtr.Zero) IsProcessInJob(brokerHandle, job, out inJobBeforeClose);
      }
    }
    CloseHandle(job);
    Thread.Sleep(400);
    bool survivedJobClose = brokerHandle != IntPtr.Zero && WaitForSingleObject(brokerHandle, 0) != 0;
    if (brokerHandle != IntPtr.Zero) CloseHandle(brokerHandle);
    return "{\"parentExited\":" + parentExited.ToString().ToLowerInvariant()
      + ",\"parentCode\":" + parentCode
      + ",\"brokerPid\":" + brokerPid
      + ",\"inJobBeforeClose\":" + inJobBeforeClose.ToString().ToLowerInvariant()
      + ",\"survivedJobClose\":" + survivedJobClose.ToString().ToLowerInvariant() + "}";
  }

  public static string RunConPtyClose(string cmdLine, string cwd, string pidFile, string readyMarker) {
    SafeFileHandle ir, iw, or_, ow;
    CreatePipe(out ir, out iw, IntPtr.Zero, 0); CreatePipe(out or_, out ow, IntPtr.Zero, 0);
    COORD sz; sz.X = 100; sz.Y = 30; IntPtr con;
    int hr = CreatePseudoConsole(sz, ir, ow, 0, out con);
    if (hr != 0) throw new Exception("CreatePseudoConsole " + hr);
    ir.Dispose(); ow.Dispose();
    var reader = new FileStream(or_, FileAccess.Read);
    var th = new Thread(() => { var b = new byte[8192]; try { while (reader.Read(b, 0, b.Length) > 0) {} } catch {} });
    th.IsBackground = true; th.Start();
    IntPtr ls = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref ls);
    var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.StartupInfo.dwFlags = 0x100; si.StartupInfo.hStdInput = (IntPtr)(-1); si.StartupInfo.hStdOutput = (IntPtr)(-1); si.StartupInfo.hStdError = (IntPtr)(-1);
    si.lpAttributeList = Marshal.AllocHGlobal(ls);
    InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, ref ls);
    UpdateProcThreadAttribute(si.lpAttributeList, 0, (IntPtr)0x20016, con, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x00000400, IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("CreateProcessW " + Marshal.GetLastWin32Error());
    for (int i = 0; i < 600 && !File.Exists(readyMarker); i++) Thread.Sleep(50);
    int brokerPid = 0; IntPtr brokerHandle = IntPtr.Zero;
    if (File.Exists(pidFile)) {
      int.TryParse(File.ReadAllText(pidFile).Trim(), out brokerPid);
      if (brokerPid > 0) brokerHandle = OpenProcess(0x00100000 | 0x1000, false, brokerPid);
    }
    var closer = new Thread(() => ClosePseudoConsole(con));
    closer.IsBackground = true; closer.Start();
    bool parentExited = WaitForSingleObject(pi.hProcess, 10000) == 0;
    Thread.Sleep(500);
    bool survivedConsoleClose = brokerHandle != IntPtr.Zero && WaitForSingleObject(brokerHandle, 0) != 0;
    if (!parentExited) TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    if (brokerHandle != IntPtr.Zero) CloseHandle(brokerHandle);
    iw.Dispose();
    return "{\"parentExited\":" + parentExited.ToString().ToLowerInvariant()
      + ",\"brokerPid\":" + brokerPid
      + ",\"survivedConsoleClose\":" + survivedConsoleClose.ToString().ToLowerInvariant() + "}";
  }
}
'@
if ($Mode -eq 'breakaway-job') {
  Write-Output ([AtomicBrokerDetachHarness]::RunJob($CommandLine, $Cwd, $BrokerPidFile, $true))
} elseif ($Mode -eq 'strict-job') {
  Write-Output ([AtomicBrokerDetachHarness]::RunJob($CommandLine, $Cwd, $BrokerPidFile, $false))
} else {
  Write-Output ([AtomicBrokerDetachHarness]::RunConPtyClose($CommandLine, $Cwd, $BrokerPidFile, $ReadyMarker))
}
`;

async function queryBrokerPid(agentDir: string): Promise<number | undefined> {
	const answer = await controlRequest(
		getBrokerSocketPath("win32", agentDir),
		"broker_status",
		"broker_status",
		BROKER_CONTROL_TIMEOUT_MS,
	);
	if (!answer.connected || answer.reply === undefined) return undefined;
	const reply = answer.reply;
	const report = typeof reply === "object" && reply !== null && !Array.isArray(reply) ? reply.report : undefined;
	const pid = typeof report === "object" && report !== null && !Array.isArray(report) ? report.pid : undefined;
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

describe.skipIf(process.platform !== "win32")("Windows direct broker detachment and survival", () => {
	function writeParentRunner(
		dir: string,
		agentDir: string,
		options: { readonly holdForConsoleClose?: boolean; readonly readyMarker?: string } = {},
	): string {
		const runner = join(dir, "spawn-parent.ts");
		writeFileSync(
			runner,
			[
				`process.env.ATOMIC_CODING_AGENT_DIR = ${JSON.stringify(agentDir)};`,
				"delete process.env.PI_CODING_AGENT_DIR;",
				`import { writeFileSync } from "node:fs";`,
				`import { spawnBrokerIfNeeded } from ${JSON.stringify(SPAWN_ENTRY)};`,
				`await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], 30_000, ${JSON.stringify(INTERCOM_DIR)});`,
				options.readyMarker ? `writeFileSync(${JSON.stringify(options.readyMarker)}, "ready");` : "",
				options.holdForConsoleClose ? "setInterval(() => {}, 1000);" : "process.exit(0);",
			].join("\n"),
			"utf8",
		);
		return runner;
	}

	function runHarness(
		root: string,
		mode: "breakaway-job" | "strict-job" | "conpty-close",
		commandLine: string,
		agentDir: string,
		readyMarker: string,
	): Record<string, unknown> {
		const script = join(root, `harness-${mode}.ps1`);
		writeFileSync(script, WIN32_HARNESS, "utf8");
		const result = spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				script,
				mode,
				commandLine,
				root,
				getBrokerPidPath(agentDir),
				readyMarker,
			],
			{ encoding: "utf8", timeout: WINDOWS_DETACH_TEST_TIMEOUT_MS, windowsHide: true },
		);
		assert.equal(result.status, 0, `harness ${mode} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
		return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
	}

	for (const runtime of [
		{ name: "node", commandLine: (runner: string) => `"${process.execPath}" "${JITI_CLI}" "${runner}"` },
		{ name: "bun", commandLine: (runner: string) => `"${bunExecutable()}" "${runner}"` },
	]) {
		test(
			`${runtime.name}: direct broker breaks away from a breakaway-allowing parent job object, captures stderr with % in paths, and writes no VBS`,
			async () => {
				const root = makeTempDirectory(`ic-job-${runtime.name}-100%TEMP%-`);
				const agentDir = join(root, "agent-100%");
				mkdirSync(agentDir, { recursive: true });
				try {
					const runner = writeParentRunner(root, agentDir);
					const report = runHarness(
						root,
						"breakaway-job",
						runtime.commandLine(runner),
						agentDir,
						join(root, "unused"),
					);
					assert.equal(report.parentExited, true, JSON.stringify(report));
					assert.equal(report.parentCode, 0, JSON.stringify(report));
					assert.equal(
						report.inJobBeforeClose,
						false,
						`broker stayed inside parent job: ${JSON.stringify(report)}`,
					);
					assert.equal(
						report.survivedJobClose,
						true,
						`broker died when parent job closed: ${JSON.stringify(report)}`,
					);
					assert.equal(existsSync(join(agentDir, "intercom", "broker-launch.vbs")), false);
					assert.equal(await queryBrokerPid(agentDir), report.brokerPid, "broker did not answer after job close");
					const log = readFileSync(getBrokerLogPath(agentDir), "utf8");
					assert.ok(log.includes("Intercom multi-node routing"), `expected broker stderr in log, got:\n${log}`);
				} finally {
					await removeTempRootReleasingBroker(root, agentDir);
				}
			},
			WINDOWS_DETACH_TEST_TIMEOUT_MS,
		);

		test(
			`${runtime.name}: direct broker survives the parent's ConPTY console closing`,
			async () => {
				const root = makeTempDirectory(`ic-con-${runtime.name}-`);
				const agentDir = join(root, "agent");
				mkdirSync(agentDir, { recursive: true });
				const readyMarker = join(root, "ready");
				try {
					const runner = writeParentRunner(root, agentDir, { holdForConsoleClose: true, readyMarker });
					const report = runHarness(root, "conpty-close", runtime.commandLine(runner), agentDir, readyMarker);
					assert.equal(report.parentExited, true, JSON.stringify(report));
					assert.equal(
						report.survivedConsoleClose,
						true,
						`broker died when parent console closed: ${JSON.stringify(report)}`,
					);
					assert.equal(
						await queryBrokerPid(agentDir),
						report.brokerPid,
						"broker did not answer after console close",
					);
				} finally {
					await removeTempRootReleasingBroker(root, agentDir);
				}
			},
			WINDOWS_DETACH_TEST_TIMEOUT_MS,
		);
	}

	test(
		"still starts inside a strict parent job object that forbids breakaway",
		async () => {
			const root = makeTempDirectory("ic-strict-job-");
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			try {
				const runner = writeParentRunner(root, agentDir);
				const report = runHarness(
					root,
					"strict-job",
					`"${process.execPath}" "${JITI_CLI}" "${runner}"`,
					agentDir,
					join(root, "unused"),
				);
				assert.equal(report.parentExited, true, JSON.stringify(report));
				assert.equal(report.parentCode, 0, JSON.stringify(report));
				assert.ok(typeof report.brokerPid === "number" && report.brokerPid > 0, JSON.stringify(report));
			} finally {
				await removeTempRootReleasingBroker(root, agentDir);
			}
		},
		WINDOWS_DETACH_TEST_TIMEOUT_MS,
	);

	test(
		"custom .cmd brokerCommand starts without wscript and captures stderr via inherited append handle",
		async () => {
			const root = makeTempDirectory("ic-batch-100%-");
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			const previous = process.env.ATOMIC_CODING_AGENT_DIR;
			const previousPi = process.env.PI_CODING_AGENT_DIR;
			process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
			delete process.env.PI_CODING_AGENT_DIR;
			const batchPath = join(root, "custom broker.cmd");
			const marker = `BATCH-STDERR-${Date.now()}`;
			writeFileSync(batchPath, `@echo off\r\necho ${marker} 1>&2\r\nexit /b 9\r\n`, "utf8");
			try {
				await assert.rejects(
					() => spawnBrokerIfNeeded(batchPath, [], 15_000, INTERCOM_DIR),
					(error: unknown) => {
						assert.ok(error instanceof Error);
						assert.match(error.message, /Intercom broker exited before startup with code 9/u, error.message);
						assert.ok(error.message.includes(marker), error.message);
						return true;
					},
				);
				assert.equal(existsSync(join(agentDir, "intercom", "broker-launch.vbs")), false);
				assert.ok(readFileSync(getBrokerLogPath(agentDir), "utf8").includes(marker));
			} finally {
				if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
				else process.env.ATOMIC_CODING_AGENT_DIR = previous;
				if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousPi;
				await removeTempRootReleasingBroker(root, agentDir);
			}
		},
		WINDOWS_DETACH_TEST_TIMEOUT_MS,
	);

	test(
		"direct broker starts with no console window and no conhost child",
		async () => {
			const root = makeTempDirectory("ic-noconsole-");
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			try {
				const runner = writeParentRunner(root, agentDir);
				const result = spawnSync(process.execPath, [JITI_CLI, runner], {
					cwd: root,
					encoding: "utf8",
					timeout: WINDOWS_DETACH_TEST_TIMEOUT_MS,
					windowsHide: true,
				});
				assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
				const brokerPid = Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10);
				assert.ok(Number.isInteger(brokerPid) && brokerPid > 0);
				// Verify no conhost.exe child exists under the broker process and no broker-launch.vbs was written.
				const ps = spawnSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${brokerPid} AND Name = 'conhost.exe'").Count`,
					],
					{ encoding: "utf8", timeout: 15_000, windowsHide: true },
				);
				assert.equal(ps.status, 0, ps.stderr);
				assert.equal(ps.stdout.trim(), "0", `broker spawned conhost.exe: ${ps.stdout}`);
				assert.equal(existsSync(join(agentDir, "intercom", "broker-launch.vbs")), false);
				assert.equal(await queryBrokerPid(agentDir), brokerPid);
			} finally {
				await removeTempRootReleasingBroker(root, agentDir);
			}
		},
		WINDOWS_DETACH_TEST_TIMEOUT_MS,
	);

	interface HungEngineFixture {
		readonly root: string;
		readonly agentDir: string;
		readonly engine: ReturnType<typeof spawn>;
		readonly enginePid: number;
		readonly brokerPid: number;
		readonly otherPid: number;
		readonly brokerCreated: string;
		readonly otherCreated: string;
		readonly peer: IntercomClient;
		readonly peerDisconnected: () => boolean;
		readonly natives: {
			holdProcessDescendants(pid: number): { readonly count: number; endAll(): boolean; release(): void } | null;
			processCreationTime(pid: number): string | null;
			terminateProcessCreatedAt(pid: number, created: string, descendants: boolean): number | null;
		};
	}

	/**
	 * Starts a child that mimics an isolated engine: it starts the shared Intercom broker via `spawnBrokerIfNeeded`
	 * plus one ordinary child process, records both PIDs, and then hangs (ignoring stdin EOF). Connects a separate
	 * peer session to the shared broker so we verify both that the broker does not idle-retire during the 5 s grace and
	 * that another session connected to the shared broker stays connected without disconnecting.
	 */
	async function startHungEngineWithBroker(prefix: string): Promise<HungEngineFixture> {
		const root = makeTempDirectory(prefix);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const readyFile = join(root, "ready.json");
		const engineScript = join(root, "hung-engine.ts");
		writeFileSync(
			engineScript,
			[
				`process.env.ATOMIC_CODING_AGENT_DIR = ${JSON.stringify(agentDir)};`,
				"delete process.env.PI_CODING_AGENT_DIR;",
				'import { spawn } from "node:child_process";',
				'import { readFileSync, writeFileSync } from "node:fs";',
				`import { spawnBrokerIfNeeded } from ${JSON.stringify(SPAWN_ENTRY)};`,
				`import { getBrokerPidPath } from ${JSON.stringify(join(INTERCOM_DIR, "broker/paths.ts"))};`,
				`await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], 30_000, ${JSON.stringify(INTERCOM_DIR)});`,
				'const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
				`const brokerPid = Number(readFileSync(getBrokerPidPath(${JSON.stringify(agentDir)}), "utf8").trim());`,
				`writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ enginePid: process.pid, brokerPid, otherPid: other.pid }));`,
				// Hang deliberately: ignore stdin end so graceful shutdown hits the grace escalation path.
				"process.stdin.resume();",
				"setInterval(() => {}, 1000);",
			].join("\n"),
			"utf8",
		);
		const natives = createRequire(import.meta.url)("@bastani/atomic-natives") as HungEngineFixture["natives"];
		const engine = spawn(process.execPath, [JITI_CLI, engineScript], {
			cwd: root,
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
		});
		const deadline = Date.now() + 30_000;
		while (!existsSync(readyFile) && Date.now() < deadline) {
			if (engine.exitCode !== null) throw new Error(`hung-engine fixture exited early with ${engine.exitCode}`);
			await sleep(50);
		}
		assert.equal(existsSync(readyFile), true, "hung-engine fixture never became ready");
		const info = JSON.parse(readFileSync(readyFile, "utf8")) as {
			enginePid: number;
			brokerPid: number;
			otherPid: number;
		};
		const brokerCreated = natives.processCreationTime(info.brokerPid);
		const otherCreated = natives.processCreationTime(info.otherPid);
		assert.ok(brokerCreated !== null, "broker was not running before hung-engine escalation");
		assert.ok(otherCreated !== null, "ordinary engine child was not running before hung-engine escalation");
		const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		const previousPiDir = process.env.PI_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_CODING_AGENT_DIR;
		let disconnected = false;
		const peer = new IntercomClient("other-live-session");
		peer.on("disconnected", () => {
			disconnected = true;
		});
		try {
			await peer.connect({
				name: "other-live-session",
				cwd: root,
				model: "test-model",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
			});
		} finally {
			if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
			if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousPiDir;
		}
		return {
			root,
			agentDir,
			engine,
			enginePid: info.enginePid,
			brokerPid: info.brokerPid,
			otherPid: info.otherPid,
			brokerCreated,
			otherCreated,
			peer,
			peerDisconnected: () => disconnected,
			natives,
		};
	}

	for (const escalation of ["holdProcessDescendants", "taskkill", "terminateRpcClientProcess"] as const) {
		test(
			`hung-engine ${escalation} escalation ends the engine and its ordinary child while sparing the shared broker`,
			async () => {
				const fixture = await startHungEngineWithBroker(`ic-hung-${escalation}-`);
				try {
					if (escalation === "holdProcessDescendants") {
						const held = fixture.natives.holdProcessDescendants(fixture.enginePid);
						assert.ok(held !== null, "holdProcessDescendants returned null for running engine");
						assert.equal(held.endAll(), true, "holdProcessDescendants.endAll did not end the engine");
					} else if (escalation === "taskkill") {
						const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
						spawnSync(
							join(systemRoot, "System32", "taskkill.exe"),
							["/F", "/T", "/PID", String(fixture.enginePid)],
							{
								stdio: "ignore",
								windowsHide: true,
							},
						);
					} else {
						// Real RPC host escalation: closes stdin, waits out ENGINE_SHUTDOWN_GRACE_MS (5 s), then tree-kills.
						await terminateRpcClientProcess(fixture.engine, true, true);
					}

					const goneBy = Date.now() + 5_000;
					while (
						Date.now() < goneBy &&
						(fixture.natives.processCreationTime(fixture.enginePid) !== null ||
							fixture.natives.processCreationTime(fixture.otherPid) === fixture.otherCreated)
					) {
						await sleep(50);
					}
					assert.equal(
						fixture.natives.processCreationTime(fixture.enginePid),
						null,
						"hung engine still ran after tree kill",
					);
					assert.notEqual(
						fixture.natives.processCreationTime(fixture.otherPid),
						fixture.otherCreated,
						"ordinary engine descendant survived tree kill",
					);
					assert.equal(
						fixture.natives.processCreationTime(fixture.brokerPid),
						fixture.brokerCreated,
						`shared Intercom broker was killed by hung-engine ${escalation} escalation`,
					);
					assert.equal(
						fixture.peerDisconnected(),
						false,
						`other session was disconnected from the shared broker by hung-engine ${escalation} escalation`,
					);
					const listed = await fixture.peer.listSessions();
					assert.ok(
						listed.some((session) => session.name === "other-live-session"),
						"other session could no longer query the shared broker after hung-engine escalation",
					);
					assert.equal(
						await queryBrokerPid(fixture.agentDir),
						fixture.brokerPid,
						`shared Intercom broker stopped answering after hung-engine ${escalation} escalation`,
					);
				} finally {
					fixture.peer.disconnect();
					try {
						fixture.engine.kill("SIGKILL");
					} catch {}
					fixture.natives.terminateProcessCreatedAt(fixture.otherPid, fixture.otherCreated, true);
					await removeTempRootReleasingBroker(fixture.root, fixture.agentDir);
				}
			},
			WINDOWS_DETACH_TEST_TIMEOUT_MS,
		);
	}
});
