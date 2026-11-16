import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROCESS_START_TOKEN_MODULE = fileURLToPath(
	new URL("../../packages/coding-agent/src/core/process-start-token.ts", import.meta.url),
);
/**
 * How long a process this module starts runs after it read its start. A start is read to the tick of a clock, 10 ms on
 * Linux and up to 15.6 ms on Windows, so a process given its pid once it exited, which starts after that, starts on a
 * later tick and has another start.
 */
const PAST_ITS_START_TICK_MS = 50;

/**
 * A process that exited, named as the processes this host's locks, claims and holds name: by its pid and, where that
 * can be read, when it started (`started`), which it reads itself while it runs. Windows soon gives an exited process's
 * pid to another process, and only the start tells that process from the one that exited; one named by its pid alone
 * would be that process.
 */
export function exitedProcess(): { readonly pid: number; readonly started?: string } {
	const exited = spawnSync(
		"bun",
		[
			"--eval",
			`const { processStartToken } = await import(${JSON.stringify(PROCESS_START_TOKEN_MODULE)});
			process.stdout.write(JSON.stringify({ pid: process.pid, started: processStartToken(process.pid) }));
			await new Promise((resolve) => setTimeout(resolve, ${PAST_ITS_START_TICK_MS}));`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(exited.status, 0, exited.stderr);
	return JSON.parse(exited.stdout) as { pid: number; started?: string };
}

/** The pid of a process that ran and exited, which no later process is given until it is released. */
export interface KeptExitedPid {
	readonly pid: number;
	/** Lets a later process be given the pid. */
	release(): Promise<void>;
}

/**
 * A process that ran and exited, named by its pid alone, as a holder is named where its start cannot be read. Such a
 * holder is judged by whether a process has its pid. Windows soon gives an exited process's pid to another process,
 * which would then be taken for the holder, but only once no handle to the process that had it is open, and Node closes
 * its own as the process exits. So on Windows a PowerShell process holds a handle to it, opened while it ran, until
 * `release` (#5286). Elsewhere a pid is given again only once the system's pids wrap around, and nothing is held.
 */
export async function keptExitedPid(): Promise<KeptExitedPid> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
	await once(child, "spawn");
	const pid = child.pid!;
	const exited = once(child, "exit");
	try {
		const release = process.platform === "win32" ? await holdHandle(pid) : async () => {};
		return { pid, release };
	} finally {
		child.kill("SIGKILL");
		await exited;
	}
}

/** Holds a handle to running process `pid` until the returned function is called. Windows only. */
async function holdHandle(pid: number): Promise<() => Promise<void>> {
	const holder = spawn(
		join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$ErrorActionPreference = 'Stop'; $p = [System.Diagnostics.Process]::GetProcessById(${pid}); $null = $p.Handle; [Console]::Out.WriteLine('held'); $null = [Console]::In.ReadLine()`,
		],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	// Ending the input of a holder that already exited must not fail the test that releases it.
	holder.stdin.on("error", () => {});
	let stderr = "";
	holder.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const ended = new Promise<void>((resolve) => holder.once("close", () => resolve()));
	await new Promise<void>((resolve, reject) => {
		holder.stdout.once("data", () => resolve());
		holder.once("error", reject);
		holder.once("exit", (code) =>
			reject(new Error(`no handle to process ${pid} could be held (exit ${code}): ${stderr}`)),
		);
	});
	return async () => {
		holder.stdin.end();
		await ended;
	};
}
