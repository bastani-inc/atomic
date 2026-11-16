import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
		const release = process.platform === "win32" ? await holdHandle(pid) : async () => {};
		return { pid, release };
	} finally {
		child.kill("SIGKILL");
		await exited;
	}
}

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
