import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";
import { bunExecutable, spawnProcess } from "../../../test/helpers/runtime.js";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { createLocalPowerShellOperations } from "../src/core/tools/powershell.ts";
import { ShellTimeoutError } from "../src/core/tools/shell-errors.ts";
import { killTrackedDetachedChildren } from "../src/utils/shell.ts";

/** Longer than an ended process takes to be gone, however loaded the machine. */
const GONE_MS = 5_000;
const POLL_MS = 20;
/** Longer than an ended process takes to be gone; a process still there after it was not ended. */
const NOT_ENDED_MS = 1_000;
/** How long a test's program runs when nothing ends it: bounded, well past any test. */
const FIXTURE_MS = 120_000;
/** The tool's timeout: longer than starting the program takes, however loaded the machine. */
const TIMEOUT_SECONDS = 3;
/** Starting Bun, loading the tool from source and running one PowerShell command, however loaded the machine. */
const TOOL_PROCESS_MS = 60_000;
/** The test that runs the tool in a Bun process of its own: that process, then a check that the program still runs. */
const TOOL_PROCESS_TEST_TIMEOUT_MS = TOOL_PROCESS_MS + GONE_MS * 4 + NOT_ENDED_MS;

const directories: string[] = [];
const processes: RecordedProcess[] = [];

afterEach(async () => {
	for (const recorded of processes.splice(0)) await signalRecordedProcess(recorded);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
	const created = mkdtempSync(join(tmpdir(), "atomic-shell-fallback-tree-"));
	directories.push(created);
	return created;
}

async function recordedFrom(file: string): Promise<RecordedProcess> {
	const deadline = Date.now() + GONE_MS * 4;
	while (!(existsSync(file) && readFileSync(file, "utf8") !== "") && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	const recorded = await recordProcess(Number(readFileSync(file, "utf8")));
	processes.push(recorded);
	return recorded;
}

/** A path as Git Bash takes it in a single-quoted word. */
function bashWord(path: string): string {
	return `'${path.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

/** A path in a PowerShell single-quoted string. */
function powerShellWord(path: string): string {
	return `'${path.replace(/'/g, "''")}'`;
}

/** A Node.js program that records its own process ID in `pidFile` and ends by itself after {@link FIXTURE_MS}. */
function program(): { path: string; pidFile: string } {
	const dir = directory();
	const path = join(dir, "program.js");
	writeFileSync(
		path,
		`require("node:fs").writeFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => process.exit(0), ${FIXTURE_MS});\n`,
	);
	return { path, pidFile: join(dir, "program.pid") };
}

/**
 * A PowerShell command that starts the program through a Node.js process that exits at once, so the program's parent
 * is gone (`taskkill /T` follows parents), and then waits.
 */
function orphanThenWait(): { command: string; pidFile: string } {
	const { path, pidFile } = program();
	const starter = `require('node:child_process').spawn(process.execPath,process.argv.slice(1),{stdio:'ignore',detached:true,windowsHide:true}).unref()`;
	return {
		command: `& ${powerShellWord(process.execPath)} -e "${starter}" ${powerShellWord(path)} ${powerShellWord(pidFile)}; Start-Sleep ${FIXTURE_MS / 1000}`,
		pidFile,
	};
}

/** C# that starts a program asking to leave its job (`CREATE_BREAKAWAY_FROM_JOB`), as some installers and updaters do. */
const BREAKAWAY_START = `using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AtomicBreakawayStart {
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
	/** The process ID, or minus the error CreateProcess failed with. */
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

/** A PowerShell command that starts ping with Start-Process, records its process ID, and then runs `then`. */
function startProcessThen(then: string): { command: string; pidFile: string } {
	const pidFile = join(directory(), "ping.pid");
	return {
		command: `$p = Start-Process -WindowStyle Hidden ping -ArgumentList '-n','${FIXTURE_MS / 1000}','127.0.0.1' -PassThru; Set-Content -NoNewline -Path ${powerShellWord(pidFile)} -Value $p.Id; ${then}`,
		pidFile,
	};
}

// The bash and PowerShell tools run without a task owner (every `!` command on Windows, and an SDK's own
// createBashTool() or createPowerShellTool() given none) start the shell in a job of their own on Windows.
describe.runIf(process.platform === "win32")("on Windows, the bash and PowerShell tools without a task owner", () => {
	test("an abort ends a program whose starter already exited", async () => {
		const { command, pidFile } = orphanThenWait();
		const controller = new AbortController();
		const running = createLocalPowerShellOperations().exec(command, process.cwd(), {
			onData: () => {},
			signal: controller.signal,
		});
		const orphan = await recordedFrom(pidFile);

		controller.abort();

		await assert.rejects(running, /aborted/);
		assert.equal(await waitUntilGone(orphan, GONE_MS), true, "the program outlived the abort");
	});

	test("a timeout ends a program whose starter already exited", async () => {
		const { command, pidFile } = orphanThenWait();
		const running = createLocalPowerShellOperations().exec(command, process.cwd(), {
			onData: () => {},
			timeout: TIMEOUT_SECONDS,
		});
		const orphan = await recordedFrom(pidFile);

		await assert.rejects(running, new RegExp(`timeout:${TIMEOUT_SECONDS}`));
		assert.equal(await waitUntilGone(orphan, GONE_MS), true, "the program outlived the timeout");
	});

	test("an abort ends a program PowerShell's Start-Process started", async () => {
		const { command, pidFile } = startProcessThen(`Start-Sleep ${FIXTURE_MS / 1000}`);
		const controller = new AbortController();
		const running = createLocalPowerShellOperations().exec(command, process.cwd(), {
			onData: () => {},
			signal: controller.signal,
		});
		const ping = await recordedFrom(pidFile);

		controller.abort();

		await assert.rejects(running, /aborted/);
		assert.equal(await waitUntilGone(ping, GONE_MS), true, "the program PowerShell started outlived the abort");
	});

	test("an abort ends a program Git Bash started in the background", async () => {
		const { path, pidFile } = program();
		const controller = new AbortController();
		const running = createLocalBashOperations().exec(
			`${bashWord(process.execPath)} ${bashWord(path)} ${bashWord(pidFile)} & wait`,
			process.cwd(),
			{ onData: () => {}, signal: controller.signal },
		);
		const background = await recordedFrom(pidFile);

		controller.abort();

		await assert.rejects(running, /aborted/);
		assert.equal(await waitUntilGone(background, GONE_MS), true, "the background program outlived the abort");
	});

	test("a timeout ends a program Git Bash started in the background", async () => {
		const { path, pidFile } = program();
		const running = createLocalBashOperations().exec(
			`${bashWord(process.execPath)} ${bashWord(path)} ${bashWord(pidFile)} & wait`,
			process.cwd(),
			{ onData: () => {}, timeout: TIMEOUT_SECONDS },
		);
		const background = await recordedFrom(pidFile);

		await assert.rejects(running, (error: Error) => error instanceof ShellTimeoutError);
		assert.equal(await waitUntilGone(background, GONE_MS), true, "the background program outlived the timeout");
	});

	test("a program that asks to leave the command's job starts", async () => {
		const dir = directory();
		const source = join(dir, "breakaway.cs");
		const pidFile = join(dir, "breakaway.pid");
		writeFileSync(source, BREAKAWAY_START);
		const result = await createLocalPowerShellOperations().exec(
			`Add-Type -Path ${powerShellWord(source)}; $id = [AtomicBreakawayStart]::Start('ping -n ${FIXTURE_MS / 1000} 127.0.0.1'); Set-Content -NoNewline -Path ${powerShellWord(pidFile)} -Value $id`,
			process.cwd(),
			{ onData: () => {} },
		);

		const started = Number(readFileSync(pidFile, "utf8"));
		assert.ok(started > 0, `the program could not start: CreateProcess failed with error ${-started}`);
		const program = await recordProcess(started);
		processes.push(program);
		assert.equal(result.exitCode, 0);
		assert.equal(await stillRuns(program), true, "the program is not running");
	});

	test("quitting ends the programs of a command still running", async () => {
		const { command, pidFile } = startProcessThen(`Start-Sleep ${FIXTURE_MS / 1000}`);
		const running = createLocalPowerShellOperations().exec(command, process.cwd(), { onData: () => {} });
		const settled = running.then(
			(result) => result.exitCode,
			(error: Error) => error,
		);
		const ping = await recordedFrom(pidFile);

		killTrackedDetachedChildren();

		assert.equal(await waitUntilGone(ping, GONE_MS), true, "the program outlived the quit");
		assert.notEqual(await settled, 0, "the command ran to its end");
	});

	test(
		"what a finished command left running keeps running after the process that ran it exits",
		async () => {
			const { command, pidFile } = startProcessThen("exit 0");
			const tool = new URL("../src/core/tools/powershell.ts", import.meta.url).href;
			const script = `const { createLocalPowerShellOperations } = await import(${JSON.stringify(tool)});
const result = await createLocalPowerShellOperations().exec(${JSON.stringify(command)}, process.cwd(), { onData: () => {} });
process.exit(result.exitCode ?? 1);`;
			const child = spawnProcess([bunExecutable(), "--eval", script], { stdout: "ignore", stderr: "inherit" });
			const exitCode = await Promise.race([
				child.exited,
				new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), TOOL_PROCESS_MS)),
			]);
			if (exitCode === "pending") child.kill();

			const ping = await recordedFrom(pidFile);

			assert.equal(exitCode, 0, "the process running the command did not finish it");
			assert.equal(await waitUntilGone(ping, NOT_ENDED_MS), false, "the program the command left running was ended");
		},
		TOOL_PROCESS_TEST_TIMEOUT_MS,
	);
});
