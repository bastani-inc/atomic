/** Minimal subprocess and TCP helpers for local DBOS database provisioning. */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createChildProcessEnvironment } from "@bastani/atomic";

export interface LocalCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	/** True when bounded capture discarded the beginning of stdout. */
	readonly stdoutTruncated?: true;
	/** True when bounded capture discarded the beginning of stderr. */
	readonly stderrTruncated?: true;
}

const OUTPUT_LIMIT_BYTES = 16_384;

export interface LocalCommandOptions {
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * For daemon launchers whose successful descendants inherit stdio, settle
	 * from a successful direct-child exit. Nonzero exits still drain through
	 * `close`, preserving bounded failure diagnostics.
	 */
	readonly completion?: "successful-exit";
	/** POSIX drop-privilege identity for the spawned process (root only). */
	readonly uid?: number;
	readonly gid?: number;
}

export function runLocalCommand(
	command: string,
	args: readonly string[],
	options?: LocalCommandOptions,
): Promise<LocalCommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: createChildProcessEnvironment(options?.env ? { ...options.env } : undefined),
			...(options?.uid !== undefined ? { uid: options.uid } : {}),
			...(options?.gid !== undefined ? { gid: options.gid } : {}),
		});
		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let settled = false;
		let exitFallback: NodeJS.Immediate | undefined;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		const onStdout = (chunk: string): void => {
			const appended = boundedAppend(stdout, chunk);
			stdout = appended.value;
			stdoutTruncated ||= appended.truncated;
		};
		const onStderr = (chunk: string): void => {
			const appended = boundedAppend(stderr, chunk);
			stderr = appended.value;
			stderrTruncated ||= appended.truncated;
		};
		const cleanup = (): void => {
			if (exitFallback !== undefined) clearImmediate(exitFallback);
			child.off("error", onError);
			child.off("exit", onExit);
			child.off("close", onClose);
			child.stdout.off("data", onStdout);
			child.stderr.off("data", onStderr);
			child.stdout.destroy();
			child.stderr.destroy();
		};
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
				...(stdoutTruncated ? { stdoutTruncated: true as const } : {}),
				...(stderrTruncated ? { stderrTruncated: true as const } : {}),
			});
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null): void => {
			if (code !== 0) return;
			// pg_ctl redirects server output with `-l`; only its successful child
			// exit needs early settlement because Postgres can retain inherited EOF.
			exitFallback = setImmediate(() => finish(code));
		};
		const onClose = (code: number | null): void => finish(code);
		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.once("error", onError);
		if (options?.completion === "successful-exit") child.once("exit", onExit);
		child.once("close", onClose);
	});
}

export function commandFailureDetail(result: LocalCommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when a TCP listener accepts a connection on host:port within the timeout. */
export function tcpReachable(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const finish = (reachable: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(reachable);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
	});
}

function boundedAppend(current: string, chunk: string): { readonly value: string; readonly truncated: boolean } {
	const next = current + chunk;
	return next.length <= OUTPUT_LIMIT_BYTES
		? { value: next, truncated: false }
		: { value: next.slice(-OUTPUT_LIMIT_BYTES), truncated: true };
}
