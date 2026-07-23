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

async function readBounded(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	onOverflow: () => void,
): Promise<Buffer> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				onOverflow();
				throw new AsyncSubprocessError(`Subprocess output exceeded ${maxBytes} bytes`, { code: "ENOBUFS", killed: true });
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
}

export async function runBunSubprocess(
	command: string,
	args: readonly string[],
	options: BunSubprocessOptions,
): Promise<BunSubprocessResult> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn([command, ...args], {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		throw new AsyncSubprocessError(failure.message, { code: (failure as Error & { code?: string }).code });
	}
	let timedOut = false;
	let aborted = false;
	const terminate = (): void => {
		try { proc.kill("SIGTERM"); } catch {}
		void Promise.race([proc.exited, Bun.sleep(500)]).then(() => {
			if (proc.exitCode === null) try { proc.kill("SIGKILL"); } catch {}
		});
	};
	const onAbort = (): void => { aborted = true; terminate(); };
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
	try {
		const stdoutPromise = readBounded(proc.stdout as ReadableStream<Uint8Array>, options.maxStdoutBytes, terminate);
		const stderrPromise = readBounded(proc.stderr as ReadableStream<Uint8Array>, options.maxStderrBytes ?? 256 * 1024, terminate);
		const [exitCode, stdout, stderrBuffer] = await Promise.all([proc.exited, stdoutPromise, stderrPromise]);
		const stderr = stderrBuffer.toString("utf8");
		if (timedOut) throw new AsyncSubprocessError(`${command} timed out`, { code: "ETIMEDOUT", stderr, killed: true });
		if (aborted) throw new AsyncSubprocessError(`${command} aborted`, { code: "ABORT_ERR", stderr, killed: true });
		if (exitCode !== 0) throw new AsyncSubprocessError(`${command} exited with code ${exitCode}`, { code: String(exitCode), stderr });
		return { exitCode, stdout, stderr };
	} catch (error) {
		terminate();
		if (error instanceof AsyncSubprocessError) throw error;
		throw new AsyncSubprocessError(error instanceof Error ? error.message : String(error), { killed: true });
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
