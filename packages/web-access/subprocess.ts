import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { createChildProcessEnvironment } from "@bastani/atomic";
import { type HelperLaunch, helperLaunchAsync, missingHelperOptions } from "@bastani/atomic-tui";

export interface BunSubprocessOptions {
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes?: number;
	signal?: AbortSignal;
	cwd?: string;
	env?: Record<string, string>;
}

export interface BunSubprocessResult {
	exitCode: number;
	stdout: Buffer;
	stderr: string;
}

export class AsyncSubprocessError extends Error {
	readonly code?: string;
	readonly stderr: string;
	readonly killed: boolean;
	constructor(message: string, options: { code?: string; stderr?: string; killed?: boolean } = {}) {
		super(message);
		this.name = "AsyncSubprocessError";
		this.code = options.code;
		this.stderr = options.stderr ?? "";
		this.killed = options.killed === true;
	}
}

async function readBounded(stream: Readable, maxBytes: number, onOverflow: (error: AsyncSubprocessError) => void): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of stream) {
		const value = chunk as Buffer;
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			const error = new AsyncSubprocessError(`Subprocess output exceeded ${maxBytes} bytes`, { code: "ENOBUFS", killed: true });
			onOverflow(error);
			throw error;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks, bytes);
}

/** Node's child-process adapter also runs in the compiled Bun host. */
export async function runBunSubprocess(
	command: string,
	args: readonly string[],
	options: BunSubprocessOptions,
): Promise<BunSubprocessResult> {
	if (options.signal?.aborted) {
		throw new AsyncSubprocessError(`${command} aborted`, { code: "ABORT_ERR", killed: true });
	}
	const env = createChildProcessEnvironment(options.env);
	// The deadline and cancellation start now: looking the command up counts against them, and a lookup they end
	// starts nothing.
	const deadline = performance.now() + options.timeoutMs;
	const lookupExpired = AbortSignal.timeout(options.timeoutMs);
	let launch: HelperLaunch;
	try {
		// Only PATH's absolute directories, never the working directory.
		launch = await helperLaunchAsync(command, {
			env,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			signal: options.signal ? AbortSignal.any([options.signal, lookupExpired]) : lookupExpired,
		});
	} catch (error) {
		if (options.signal?.aborted) {
			throw new AsyncSubprocessError(`${command} aborted`, { code: "ABORT_ERR", killed: true });
		}
		if (lookupExpired.aborted) {
			throw new AsyncSubprocessError(`${command} timed out`, { code: "ETIMEDOUT", killed: true });
		}
		throw error;
	}
	// A cancellation or the deadline that came as the lookup finished still starts nothing.
	if (options.signal?.aborted) {
		throw new AsyncSubprocessError(`${command} aborted`, { code: "ABORT_ERR", killed: true });
	}
	if (performance.now() >= deadline) {
		throw new AsyncSubprocessError(`${command} timed out`, { code: "ETIMEDOUT", killed: true });
	}
	let primaryError: AsyncSubprocessError | undefined;
	let escalation: ReturnType<typeof setTimeout> | undefined;
	const proc = spawn(
		launch.file,
		args,
		{ cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], ...missingHelperOptions(launch) },
	);
	const exited = new Promise<number>((resolve, reject) => {
		proc.once("error", (error: NodeJS.ErrnoException) => {
			reject(new AsyncSubprocessError(error.message, { code: error.code }));
		});
		proc.once("exit", (code) => resolve(code ?? -1));
	});
	const terminate = (): void => {
		if (escalation) return;
		proc.kill("SIGTERM");
		escalation = setTimeout(() => {
			proc.kill("SIGKILL");
			// Descendants can keep inherited descriptors open after the direct
			// child exits. Bound that drain independently from child reaping.
			proc.stdout.destroy();
			proc.stderr.destroy();
		}, 500);
	};
	const fail = (error: AsyncSubprocessError): void => {
		primaryError ??= error;
		terminate();
	};
	const onAbort = (): void => fail(new AsyncSubprocessError(`${command} aborted`, { code: "ABORT_ERR", killed: true }));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(
		() => fail(new AsyncSubprocessError(`${command} timed out`, { code: "ETIMEDOUT", killed: true })),
		Math.max(0, deadline - performance.now()),
	);
	const output = [
		readBounded(proc.stdout, options.maxStdoutBytes, fail),
		readBounded(proc.stderr, options.maxStderrBytes ?? 256 * 1024, fail),
	] as const;
	try {
		const [exitCode, stdout, stderrBuffer] = await Promise.all([exited, ...output]);
		const stderr = stderrBuffer.toString("utf8");
		if (primaryError) {
			primaryError = new AsyncSubprocessError(primaryError.message, { code: primaryError.code, stderr, killed: true });
			throw primaryError;
		}
		if (exitCode !== 0) throw new AsyncSubprocessError(`${command} exited with code ${exitCode}`, { code: String(exitCode), stderr });
		return { exitCode, stdout, stderr };
	} catch (error) {
		const failure = primaryError ?? (error instanceof AsyncSubprocessError ? error :
			new AsyncSubprocessError(error instanceof Error ? error.message : String(error), { killed: true }));
		clearTimeout(timeout);
		terminate();
		await Promise.allSettled([exited, ...output]);
		throw failure;
	} finally {
		clearTimeout(timeout);
		clearTimeout(escalation);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
