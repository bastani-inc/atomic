import { type ChildProcess, spawn } from "node:child_process";
import {
	containProcessTree,
	killChildProcessTree,
	killProcessTree,
	markDetachedChildExited,
	type ProcessTreeContainment,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "@bastani/atomic";

const SIGKILL_ESCALATION_MS = 100;

export interface SpawnCollectOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly timeout: number;
	readonly maxBuffer: number;
	readonly input?: string;
}

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
		let tree: ProcessTreeContainment | undefined;
		let treeTerminated = false;
		let detachedPid: number | undefined;
		const startedAt = Date.now();
		// Terminating the tree ends every process in it, and closing it ends any left: it is terminated at most once.
		const terminateTree = (): boolean => {
			if (!treeTerminated) treeTerminated = tree?.terminate() === true;
			return treeTerminated;
		};
		const killTree = () => {
			if (terminateTree()) return;
			killChildProcessTree(child, exited);
		};
		const finish = (status: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			if (error === undefined && signal !== null && Date.now() - startedAt >= options.timeout)
				error = codedError(command, "ETIMEDOUT");
			if (!stopped && error === undefined) tree?.release();
			tree?.close();
			if (detachedPid !== undefined) untrackDetachedChildPid(detachedPid);
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
			if (terminateTree()) {
				if (exited || child.pid === undefined) finish(null, "SIGTERM");
				return;
			}
			if (process.platform !== "win32" && child.pid !== undefined && child.pid !== process.pid) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {}
				child.kill("SIGTERM");
			} else if (child.pid !== undefined && child.pid !== process.pid && !exited) {
				killProcessTree(child.pid);
			} else if (child.pid === undefined) {
				child.kill("SIGTERM");
			}
			if (exited || child.pid === undefined) {
				killTree();
				finish(null, "SIGTERM");
				return;
			}
			killTimer ??= setTimeout(killTree, SIGKILL_ESCALATION_MS);
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
			tree = child.pid === undefined || child.pid === process.pid ? undefined : containProcessTree(child.pid);
			if (process.platform !== "win32" && child.pid !== undefined && child.pid !== process.pid) {
				detachedPid = child.pid;
				trackDetachedChildPid(detachedPid);
			}
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
			if (detachedPid !== undefined) markDetachedChildExited(detachedPid);
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
