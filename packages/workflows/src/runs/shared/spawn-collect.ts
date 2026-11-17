import { type ChildProcess, spawn } from "node:child_process";
import { killProcessTree } from "@bastani/atomic";

const SIGKILL_ESCALATION_MS = 100;

export interface SpawnCollectOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	/** Milliseconds before the process is sent SIGTERM and the result carries an `ETIMEDOUT` error. */
	readonly timeout: number;
	/** Bytes each of stdout and stderr may carry before the process is sent SIGTERM and the result carries `ENOBUFS`. */
	readonly maxBuffer: number;
	/** Written to the process's stdin, which is then closed; without it stdin is ignored. */
	readonly input?: string;
}

/** What a process left once it closed, in the shape `spawnSync` reports it. */
export interface SpawnCollectResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly error?: Error;
}

function codedError(command: string, code: string): Error {
	return Object.assign(new Error(`spawn ${command} ${code}`), { code });
}

/**
 * Runs `command` without a shell and collects its output, as `spawnSync` does, without blocking: a timeout or an
 * output over `maxBuffer` ends the process with SIGTERM and is reported as `ETIMEDOUT` or `ENOBUFS`, a process that
 * cannot start is reported by its spawn error, and a failed write of `input` (a process that exits without reading
 * it) is reported alongside the status the process exited with.
 */
export function spawnCollect(
	command: string,
	args: readonly string[],
	options: SpawnCollectOptions,
): Promise<SpawnCollectResult> {
	return new Promise((resolve) => {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let error: Error | undefined;
		let inputError: Error | undefined;
		let settled = false;
		let exited = false;
		let stopped = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let child: ChildProcess;
		const startedAt = Date.now();
		const killTree = () => {
			if (child.pid !== undefined && child.pid !== process.pid) {
				killProcessTree(child.pid);
			}
		};
		const finish = (status: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			// The runtime's own `timeout` may end the process before the timer below reports it.
			if (error === undefined && signal !== null && Date.now() - startedAt >= options.timeout)
				error = codedError(command, "ETIMEDOUT");
			const reported = error ?? inputError;
			resolve({
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				status,
				signal,
				...(reported === undefined ? {} : { error: reported }),
			});
		};
		const stop = (reason: Error) => {
			stopped = true;
			error ??= reason;
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (process.platform !== "win32" && child.pid !== undefined && child.pid !== process.pid) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {}
			} else {
				killTree();
			}
			child.kill("SIGTERM");
			if (exited || child.pid === undefined) {
				killTree();
				finish(null, "SIGTERM");
				return;
			}
			killTimer ??= setTimeout(() => {
				killTree();
				child.kill("SIGKILL");
			}, SIGKILL_ESCALATION_MS);
		};
		try {
			child = spawn(command, [...args], {
				cwd: options.cwd,
				env: options.env,
				shell: false,
				timeout: options.timeout,
				detached: process.platform !== "win32",
				windowsHide: true,
				stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			});
		} catch (spawnError) {
			resolve({
				stdout: "",
				stderr: "",
				status: null,
				signal: null,
				error: spawnError instanceof Error ? spawnError : new Error(String(spawnError)),
			});
			return;
		}
		const timer = setTimeout(() => stop(codedError(command, "ETIMEDOUT")), options.timeout);
		const collect = (chunks: Buffer[]) => {
			let bytes = 0;
			return (chunk: Buffer) => {
				if (error !== undefined) return;
				bytes += chunk.length;
				if (bytes > options.maxBuffer) {
					chunks.push(chunk.subarray(0, chunk.length - (bytes - options.maxBuffer)));
					stop(codedError(command, "ENOBUFS"));
					return;
				}
				chunks.push(chunk);
			};
		};
		child.stdout?.on("data", collect(stdout));
		child.stderr?.on("data", collect(stderr));
		child.on("error", (spawnError) => {
			error ??= spawnError;
			if (child.pid === undefined) finish(null, null);
		});
		child.on("exit", (status, signal) => {
			exited = true;
			if (error === undefined && signal !== null && Date.now() - startedAt >= options.timeout) {
				stop(codedError(command, "ETIMEDOUT"));
			}
			if (stopped) {
				killTree();
				finish(status, signal);
			}
		});
		child.on("close", (status, signal) => finish(status, signal));
		if (options.input !== undefined && child.stdin !== null) {
			child.stdin.on("error", (writeError) => {
				inputError ??= writeError;
			});
			child.stdin.end(options.input);
		}
	});
}
