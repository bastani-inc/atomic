import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
	processLaunch,
	processLaunchAsync,
	spawnLaunchedProcess,
	spawnLaunchedProcessSync,
} from "../utils/child-process.ts";
import type { HelperLaunch } from "../utils/helper-command.ts";
import { isStdoutTakenOver } from "./output-guard.ts";
import { getCommandEnv } from "./package-manager-env.ts";

function spawnCommand(
	launch: HelperLaunch,
	command: string,
	args: string[],
	options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcess {
	return spawnLaunchedProcess(launch, args, {
		cwd: options?.cwd,
		stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
		env: getCommandEnv(command, options?.env),
	});
}

function spawnCaptureCommand(
	launch: HelperLaunch,
	command: string,
	args: string[],
	options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcessByStdio<null, Readable, Readable> {
	return spawnLaunchedProcess(launch, args, {
		cwd: options?.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: getCommandEnv(command, options?.env),
	});
}

export async function runCommandCapture(
	command: string,
	args: string[],
	options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
	const launch = await processLaunchAsync(command, { cwd: options?.cwd, env: getCommandEnv(command, options?.env) });
	return new Promise((resolvePromise, reject) => {
		const child = spawnCaptureCommand(launch, command, args, options);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout =
			typeof options?.timeoutMs === "number"
				? setTimeout(() => {
						timedOut = true;
						child.kill();
					}, options.timeoutMs)
				: undefined;

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		child.once("error", (error) => {
			if (timeout) clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			if (timedOut) {
				reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
				return;
			}
			if (code === 0) {
				resolvePromise(stdout.trim());
				return;
			}
			const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
		});
	});
}

export async function runCommand(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
	const launch = await processLaunchAsync(command, { cwd: options?.cwd, env: getCommandEnv(command, options?.env) });
	return new Promise((resolvePromise, reject) => {
		const child = spawnCommand(launch, command, args, options);
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolvePromise();
			} else {
				reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
			}
		});
	});
}

export function runCommandSync(command: string, args: string[]): string {
	const result = spawnLaunchedProcessSync(processLaunch(command, { env: getCommandEnv(command) }), args, {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf-8",
		env: getCommandEnv(command),
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
		);
	}
	return (result.stdout || result.stderr || "").trim();
}

export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	if (tasks.length === 0) {
		return [];
	}

	const results: T[] = new Array(tasks.length);
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(limit, tasks.length));

	const worker = async () => {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= tasks.length) {
				return;
			}
			results[index] = await tasks[index]();
		}
	};

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
