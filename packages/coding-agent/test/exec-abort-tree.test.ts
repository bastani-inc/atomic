import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";
import { execCommand } from "../src/core/exec.ts";
import { containmentFunction } from "../src/core/process-tree-containment.ts";

/** Longer than a killed process takes to be gone, however loaded the machine. */
const GONE_MS = 5_000;
const POLL_MS = 20;
/** Longer than a SIGKILLed process takes to be gone; a process still there after it was not signalled. */
const KILL_SEEN_MS = 1_000;
/** The command's timeout: longer than starting it and the process it starts takes, however loaded the machine. */
const COMMAND_TIMEOUT_MS = 8_000;
/** How long a process that ignores SIGTERM has before SIGKILL, as `pi.exec` documents. */
const FORCE_KILL_DELAY_MS = 5_000;
/** Longer than a process takes to end on SIGTERM, however loaded the machine, and well before that SIGKILL. */
const TERM_SEEN_MS = 3_000;

const directories: string[] = [];
const processes: RecordedProcess[] = [];

afterEach(async () => {
	for (const recorded of processes.splice(0)) await signalRecordedProcess(recorded);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function pidFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-exec-abort-"));
	directories.push(directory);
	return join(directory, "child.pid");
}

async function recordedFrom(file: string): Promise<RecordedProcess> {
	const deadline = Date.now() + GONE_MS * 4;
	while (!(existsSync(file) && readFileSync(file, "utf8") !== "") && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	const recorded = await recordProcess(Number(readFileSync(file, "utf8")));
	processes.push(recorded);
	return recorded;
}

/**
 * A command that starts a process of its own in the background, as `sleep 1000 &` does, which records its pid in
 * `file`; both run until they are ended. `detached` starts it in a session of its own, `deaf` has it ignore SIGTERM.
 */
function commandStartingAProcess(file: string, options: { detached?: boolean; deaf?: boolean } = {}): string[] {
	const child = `${options.deaf ? 'process.on("SIGTERM", () => {});' : ""}require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const root = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore", detached: ${options.detached === true} }).unref(); setInterval(() => {}, 1000);`;
	return ["-e", root];
}

describe("a pi.exec command ended by Atomic ends with the processes it started", () => {
	for (const how of ["abort", "timeout"] as const) {
		test(`on ${how === "abort" ? "an abort" : "its timeout"}`, async () => {
			const file = pidFile();
			const controller = new AbortController();
			const running = execCommand(
				process.execPath,
				commandStartingAProcess(file),
				process.cwd(),
				how === "abort" ? { signal: controller.signal } : { timeout: COMMAND_TIMEOUT_MS },
			);
			const started = await recordedFrom(file);

			if (how === "abort") controller.abort();
			const result = await running;

			assert.equal(result.killed, true);
			assert.equal(result.code, 143, "the command itself reports SIGTERM");
			assert.equal(
				await waitUntilGone(started, TERM_SEEN_MS),
				true,
				"the process the command started did not end on SIGTERM",
			);
		});
	}

	test("also when the output limit ends it", async () => {
		const file = pidFile();
		const [flag, root] = commandStartingAProcess(file);
		const running = execCommand(
			process.execPath,
			[flag!, `${root} setTimeout(() => process.stdout.write("x".repeat(4096)), 300);`],
			process.cwd(),
			{ maxBuffer: 1024 },
		);
		const started = await recordedFrom(file);

		const result = await running;

		assert.equal(result.truncated, true);
		assert.equal(
			await waitUntilGone(started, TERM_SEEN_MS),
			true,
			"the process the command started did not end on SIGTERM",
		);
	});

	test("a command started with its abort already signalled ends at once with SIGTERM, as before", async () => {
		const [command, args] =
			process.platform === "win32"
				? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "ping -n 2 127.0.0.1 > nul"]]
				: ["sleep", ["1"]];
		const result = await execCommand(command, args, process.cwd(), { signal: AbortSignal.abort() });

		// A command that ran to its end reports 0.
		assert.deepEqual({ killed: result.killed, code: result.code }, { killed: true, code: 143 });
	});

	// On Windows the command's process tree ends at once.
	test.skipIf(process.platform === "win32")(
		"a process that ignores SIGTERM gets SIGKILL after five seconds, also once the command itself exited",
		async () => {
			const file = pidFile();
			const controller = new AbortController();
			const running = execCommand(process.execPath, commandStartingAProcess(file, { deaf: true }), process.cwd(), {
				signal: controller.signal,
			});
			const started = await recordedFrom(file);

			controller.abort();
			await running;

			assert.equal(await waitUntilGone(started, FORCE_KILL_DELAY_MS + GONE_MS), true);
		},
	);

	// A tree kill on Windows follows parent links, which a detached process keeps.
	test.skipIf(process.platform === "win32")(
		"leaves a program the command started in a session of its own running",
		async () => {
			const file = pidFile();
			const controller = new AbortController();
			const running = execCommand(
				process.execPath,
				commandStartingAProcess(file, { detached: true }),
				process.cwd(),
				{ signal: controller.signal },
			);
			const detached = await recordedFrom(file);

			controller.abort();
			await running;

			assert.equal(await waitUntilGone(detached, KILL_SEEN_MS), false, "a program that detached itself was ended");
		},
	);
});

test("a native module from before the breakaway job gives a pi.exec command no job, rather than a stricter one", () => {
	const strict = () => null;
	const allowingBreakaway = () => null;
	assert.equal(containmentFunction({ containProcessTree: strict }, { allowBreakaway: true }), undefined);
	assert.equal(
		containmentFunction(
			{ containProcessTree: strict, containProcessTreeAllowingBreakaway: allowingBreakaway },
			{
				allowBreakaway: true,
			},
		),
		allowingBreakaway,
	);
	assert.equal(containmentFunction({ containProcessTree: strict }), strict, "other callers keep their job");
	assert.equal(containmentFunction(null, { allowBreakaway: true }), undefined);
});

/** A number no other process's command line is likely to hold, which a test's command passes to what it starts. */
function uniqueMarker(): string {
	return String(1_000_000 + Math.floor(Math.random() * 8_999_999));
}

/** The Windows processes whose command line holds `marker`, other than this test's own queries. */
function windowsProcessesWith(marker: string): number[] {
	const output = execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '\\b${marker}\\b' -and $_.Name -ne 'powershell.exe' }).ProcessId`,
		],
		{ encoding: "utf8", timeout: GONE_MS * 4 },
	);
	return output.split(/\s+/).filter(Boolean).map(Number);
}

/**
 * The processes a test's command started with `marker`, once they run, recorded with when they started so that a test
 * and its cleanup only ever signal those processes.
 */
async function windowsProcessesStarted(marker: string): Promise<RecordedProcess[]> {
	const deadline = Date.now() + GONE_MS * 4;
	let found: number[] = [];
	while (found.length === 0 && Date.now() <= deadline) {
		found = windowsProcessesWith(marker);
		if (found.length === 0) await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
	}
	const recorded = await Promise.all(found.map((pid) => recordProcess(pid)));
	processes.push(...recorded);
	return recorded;
}

async function allGone(recorded: readonly RecordedProcess[], withinMs: number): Promise<boolean> {
	const gone = await Promise.all(recorded.map((process) => waitUntilGone(process, withinMs)));
	return gone.every(Boolean);
}

async function noneGone(recorded: readonly RecordedProcess[]): Promise<boolean> {
	const gone = await Promise.all(recorded.map((process) => waitUntilGone(process, KILL_SEEN_MS)));
	return !gone.some(Boolean);
}

/** A quit stop as a session gives a command an extension runs outside its `session_shutdown` handlers. */
const quitStop = () => () => {};

// What a Windows command starts leaves Node's own job, which ended only the command itself; a job of the command's own
// holds its tree.
describe.runIf(process.platform === "win32")(
	"on Windows, a pi.exec command an abort ends takes its tree with it",
	() => {
		const cases: readonly {
			readonly name: string;
			readonly command: string;
			readonly args: (marker: string) => string[];
		}[] = [
			{
				name: "a ping cmd.exe started",
				command: process.env.ComSpec ?? "cmd.exe",
				args: (marker) => ["/d", "/s", "/c", `ping -n ${marker} 127.0.0.1 > nul`],
			},
			{
				name: "a program PowerShell's Start-Process started",
				command: "powershell.exe",
				args: (marker) => [
					"-NoProfile",
					"-Command",
					`Start-Process -WindowStyle Hidden ping -ArgumentList '-n','${marker}','127.0.0.1'; Start-Sleep 600`,
				],
			},
		];
		for (const { name, command, args } of cases) {
			test(name, async () => {
				const marker = uniqueMarker();
				const controller = new AbortController();
				const running = execCommand(command, args(marker), process.cwd(), { signal: controller.signal }, quitStop);
				const started = await windowsProcessesStarted(marker);
				assert.ok(started.length > 0, "the command started nothing");

				controller.abort();
				const result = await running;

				assert.equal(result.code, 143);
				assert.equal(await allGone(started, GONE_MS), true, "what the command started outlived it");
			});
		}

		test("a child that asked to leave the job still starts, and keeps running", async () => {
			const marker = uniqueMarker();
			const breakaway = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class Breakaway {
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string r; public string d; public string t; public int x, y, w, h, cx, cy, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
	[StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr p, t; public int pid, tid; }
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
	public static int Start(string cmd) { var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); PROCESS_INFORMATION pi; if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, null, ref si, out pi)) return -Marshal.GetLastWin32Error(); return pi.pid; }
}
'@; Write-Output ([Breakaway]::Start('ping -n ${marker} 127.0.0.1')); Start-Sleep 600`;
			const controller = new AbortController();
			const running = execCommand(
				"powershell.exe",
				["-NoProfile", "-Command", breakaway],
				process.cwd(),
				{ signal: controller.signal },
				quitStop,
			);
			const started = await windowsProcessesStarted(marker);
			assert.ok(started.length > 0, "the child that asked to leave the job did not start");

			controller.abort();
			const result = await running;

			assert.ok(!result.stdout.trim().startsWith("-"), `the start failed: ${result.stdout}`);
			assert.equal(await noneGone(started), true, "a child outside the job was ended");
		});

		// Git Bash, as Cygwin does, starts its processes outside a job that lets them leave, as the job of a pi.exec command
		// does so that such a start still works.
		test("a background job of Git Bash leaves the command's job and keeps running, as before", async () => {
			const marker = uniqueMarker();
			const controller = new AbortController();
			const running = execCommand(
				"bash",
				["-c", `sleep ${marker} & wait`],
				process.cwd(),
				{ signal: controller.signal },
				quitStop,
			);
			const started = await windowsProcessesStarted(marker);
			assert.ok(started.length > 0, "the command started nothing");

			controller.abort();
			assert.equal((await running).code, 143);

			assert.equal(await noneGone(started), true);
		});

		test("an abort after the command ended signals nothing, so a process given its number is left alone", async () => {
			const marker = uniqueMarker();
			const unrelatedPid = Number(
				execFileSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-Command",
						`(Start-Process -WindowStyle Hidden ping -ArgumentList '-n','${marker}','127.0.0.1' -PassThru).Id`,
					],
					{ encoding: "utf8", timeout: GONE_MS * 4 },
				).trim(),
			);
			const unrelated = await recordProcess(unrelatedPid);
			processes.push(unrelated);
			const controller = new AbortController();
			const result = await execCommand(
				process.env.ComSpec ?? "cmd.exe",
				["/d", "/s", "/c", "exit 0"],
				process.cwd(),
				{ signal: controller.signal },
				quitStop,
			);
			controller.abort();

			assert.equal(result.code, 0);
			assert.equal(await noneGone([unrelated]), true, "an unrelated process was ended");
		});
	},
);
