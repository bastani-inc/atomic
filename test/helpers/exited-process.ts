import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROCESS_START_TOKEN_MODULE = fileURLToPath(
	new URL("../../packages/coding-agent/src/core/process-start-token.ts", import.meta.url),
);
const PAST_ITS_START_TICK_MS = 50;

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

export interface KeptExitedPid {
	readonly pid: number;
	release(): Promise<void>;
}

export async function keptExitedPid(): Promise<KeptExitedPid> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
	await once(child, "spawn");
	const pid = child.pid!;
	const exited = once(child, "exit");
	try {
		const release = await keepProcessPid(child);
		return { pid, release };
	} finally {
		child.kill("SIGKILL");
		await exited;
	}
}

export async function keepProcessPid(child: ChildProcess): Promise<() => Promise<void>> {
	const pid = childPidWhileNodeOwnsHandle(child);
	if (process.platform !== "win32") return async () => {};
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
	holder.stdin.on("error", () => {});
	let stderr = "";
	holder.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const ended = new Promise<void>((resolve) => holder.once("close", () => resolve()));
	const release = async () => {
		holder.stdin.end();
		await ended;
	};
	try {
		await new Promise<void>((resolve, reject) => {
			holder.stdout.once("data", () => {
				try {
					childPidWhileNodeOwnsHandle(child);
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			holder.once("error", reject);
			holder.once("exit", (code) =>
				reject(new Error(`no handle to process ${pid} could be held (exit ${code}): ${stderr}`)),
			);
		});
		return release;
	} catch (error) {
		await release();
		throw error;
	}
}

function childPidWhileNodeOwnsHandle(child: ChildProcess): number {
	if (child.pid === undefined) throw new Error("Cannot keep a process PID before the child has spawned");
	if (child.exitCode !== null || child.signalCode !== null) {
		throw new Error(`Process ${child.pid} exited before its PID could be kept`);
	}
	return child.pid;
}
