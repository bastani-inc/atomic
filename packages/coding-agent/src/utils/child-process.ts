import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

const EXIT_STDIO_IDLE_GRACE_MS = 100;
const EXIT_STDIO_ACTIVE_DRAIN_HARD_CAP_MS = 5_000;
const WINDOWS_SHELL_COMMANDS = new Set(["bun", "npm", "npx", "pnpm", "yarn", "yarnpkg", "corepack"]);

export function shouldUseWindowsShell(command: string): boolean {
	if (process.platform !== "win32") return false;
	const commandName = basename(command).toLowerCase();
	return commandName.endsWith(".cmd") || commandName.endsWith(".bat") || WINDOWS_SHELL_COMMANDS.has(commandName);
}

export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

function isWindowsProcessAlive(pid: number): boolean {
	const result = nodeSpawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf-8", windowsHide: true });
	if (result.status !== 0) return true;
	return new RegExp(`\\b${pid}\\b`).test(result.stdout);
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. We must not resolve and destroy the streams on a short fixed deadline
 * measured from `exit`, or finite post-exit output still being written past that
 * deadline is silently lost (earendil-works/pi#5303). Instead, after `exit` we wait
 * for the pipes to fall idle: the grace timer is re-armed on every chunk, so finite
 * post-exit writers drain while active, while a quiet inherited handle (e.g. a
 * Windows daemonized descendant that never lets `close` fire) releases promptly
 * after the grace elapses. A longer active-drain hard cap is armed once on `exit`
 * so an endlessly noisy descendant cannot keep the wait pending forever.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitIdleTimer: NodeJS.Timeout | undefined;
		let postExitActiveDrainHardCapTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
		let windowsExitPoll: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (windowsExitPoll) {
				clearInterval(windowsExitPoll);
				windowsExitPoll = undefined;
			}
			if (postExitIdleTimer) {
				clearTimeout(postExitIdleTimer);
				postExitIdleTimer = undefined;
			}
			if (postExitActiveDrainHardCapTimer) {
				clearTimeout(postExitActiveDrainHardCapTimer);
				postExitActiveDrainHardCapTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const armIdleTimer = () => {
			if (postExitIdleTimer) clearTimeout(postExitIdleTimer);
			postExitIdleTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_IDLE_GRACE_MS);
		};

		const armActiveDrainHardCapTimer = () => {
			if (postExitActiveDrainHardCapTimer) return;
			postExitActiveDrainHardCapTimer = setTimeout(
				() => finalize(exitCode),
				EXIT_STDIO_ACTIVE_DRAIN_HARD_CAP_MS,
			);
		};

		const onData = () => {
			// Output is still arriving after exit; keep extending the idle grace
			// so active finite writers can drain without truncating the tail.
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) {
				armActiveDrainHardCapTimer();
				armIdleTimer();
			}
		};

		const pollWindowsExit = () => {
			if (process.platform !== "win32" || !child.pid || exited || settled) return;
			if (!isWindowsProcessAlive(child.pid)) {
				onExit(child.exitCode ?? 0);
			}
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		if (process.platform === "win32" && child.pid) windowsExitPoll = setInterval(pollWindowsExit, 50);
		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
