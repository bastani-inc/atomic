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
		// The command passes the output limit only once the process it started has recorded its pid, however long
		// that process takes to start on a loaded machine: ended before then, it would leave no pid to check.
		const overflowOnceStarted = `const overflow = setInterval(() => { let pid = ""; try { pid = require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8"); } catch {} if (pid === "") return; clearInterval(overflow); process.stdout.write("x".repeat(4096)); }, ${POLL_MS});`;
		const running = execCommand(process.execPath, [flag!, `${root} ${overflowOnceStarted}`], process.cwd(), {
			maxBuffer: 1024,
		});
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

	// Windows has no SIGTERM: a command ends at once.
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

/** A number no other process's command line is likely to hold, which a test's command passes to what it starts. */
function uniqueMarker(): string {
	return String(1_000_000 + Math.floor(Math.random() * 8_999_999));
}

/** How long a Windows test's processes run when nothing ends them: bounded, well past any test. */
const WINDOWS_FIXTURE_SECONDS = 120;

interface WindowsProcess {
	readonly pid: number;
	readonly parent: number;
	readonly image: string;
	readonly commandLine: string;
}

function windowsProcesses(): WindowsProcess[] {
	const output = execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
		],
		{ encoding: "utf8", timeout: GONE_MS * 4, maxBuffer: 64 * 1024 * 1024 },
	);
	const rows = JSON.parse(output) as {
		ProcessId: number;
		ParentProcessId: number;
		Name: string | null;
		CommandLine: string | null;
	}[];
	return rows.map((row) => ({
		pid: row.ProcessId,
		parent: row.ParentProcessId,
		image: (row.Name ?? "").toLowerCase(),
		commandLine: row.CommandLine ?? "",
	}));
}

/**
 * The `image` processes below this test process whose command line holds `marker`, once they run, recorded with when
 * they started, so that a test and its cleanup only ever signal those processes.
 */
async function windowsProcessesStarted(image: string, marker: string): Promise<RecordedProcess[]> {
	const deadline = Date.now() + GONE_MS * 4;
	let found: number[] = [];
	while (found.length === 0 && Date.now() <= deadline) {
		const table = windowsProcesses();
		const parents = new Map(table.map((row) => [row.pid, row.parent]));
		const descendsFromTest = (pid: number): boolean => {
			for (let current = parents.get(pid), hops = 0; current !== undefined && hops < 8; hops++) {
				if (current === process.pid) return true;
				current = parents.get(current);
			}
			return false;
		};
		found = table
			.filter(
				(row) =>
					row.image === image && new RegExp(`\\b${marker}\\b`).test(row.commandLine) && descendsFromTest(row.pid),
			)
			.map((row) => row.pid);
		if (found.length === 0) await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
	}
	const recorded = await Promise.all(found.map((pid) => recordProcess(pid)));
	processes.push(...recorded);
	return recorded;
}

// What a Windows command starts leaves the job Node.js starts it in, which ended only the command itself; the processes
// below it now end through handles of their own.
describe.runIf(process.platform === "win32")(
	"on Windows, a pi.exec command an abort ends takes its tree with it",
	() => {
		test("a ping cmd.exe started", async () => {
			const marker = uniqueMarker();
			const controller = new AbortController();
			const running = execCommand(
				process.env.ComSpec ?? "cmd.exe",
				["/d", "/s", "/c", `ping -n ${WINDOWS_FIXTURE_SECONDS} -w ${marker} 127.0.0.1 > nul`],
				process.cwd(),
				{ signal: controller.signal },
			);
			const started = await windowsProcessesStarted("ping.exe", marker);
			assert.ok(started.length > 0, "the command started nothing");

			controller.abort();

			assert.equal((await running).code, 143);
			for (const ping of started)
				assert.equal(await waitUntilGone(ping, GONE_MS), true, "the ping outlived the abort");
		});

		test("a program PowerShell's Start-Process started", async () => {
			const file = pidFile();
			const controller = new AbortController();
			const running = execCommand(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`$p = Start-Process -WindowStyle Hidden ping -ArgumentList '-n','${WINDOWS_FIXTURE_SECONDS}','127.0.0.1' -PassThru; Set-Content -NoNewline -Path '${file.replace(/'/g, "''")}' -Value $p.Id; Start-Sleep ${WINDOWS_FIXTURE_SECONDS}`,
				],
				process.cwd(),
				{ signal: controller.signal },
			);
			const ping = await recordedFrom(file);

			controller.abort();

			assert.equal((await running).code, 143);
			assert.equal(await waitUntilGone(ping, GONE_MS), true, "the program PowerShell started outlived the abort");
		});

		test("a program a Git Bash background job started", async () => {
			const file = pidFile();
			// The program records its own process ID, and ends by itself after the fixture's bound.
			const program = `require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, ${WINDOWS_FIXTURE_SECONDS * 1000});`;
			const controller = new AbortController();
			const running = execCommand(
				"bash",
				["-c", '"$0" -e "$1" "$2" & wait', process.execPath.replace(/\\/g, "/"), program, file],
				process.cwd(),
				{ signal: controller.signal },
			);
			const started = await recordedFrom(file);

			controller.abort();

			assert.equal((await running).code, 143);
			assert.equal(await waitUntilGone(started, GONE_MS), true, "the program Git Bash started outlived the abort");
		});

		test("an abort after the command ended ends nothing, so a process given its number is left alone", async () => {
			const unrelated = await recordProcess(
				Number(
					execFileSync(
						"powershell.exe",
						[
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							`(Start-Process -WindowStyle Hidden ping -ArgumentList '-n','${WINDOWS_FIXTURE_SECONDS}','127.0.0.1' -PassThru).Id`,
						],
						{ encoding: "utf8", timeout: GONE_MS * 4 },
					).trim(),
				),
			);
			processes.push(unrelated);
			const controller = new AbortController();
			const result = await execCommand(
				process.env.ComSpec ?? "cmd.exe",
				["/d", "/s", "/c", "exit 0"],
				process.cwd(),
				{ signal: controller.signal },
			);
			controller.abort();

			assert.equal(result.code, 0);
			assert.equal(await waitUntilGone(unrelated, KILL_SEEN_MS), false, "an unrelated process was ended");
		});
	},
);
