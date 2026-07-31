interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
	originalConsole: {
		log: typeof console.log;
		info: typeof console.info;
		debug: typeof console.debug;
		dir: typeof console.dir;
	};
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	// Some runtimes (notably Bun) implement console.log/info/debug/dir natively and
	// write directly to the stdout file descriptor, bypassing the patched
	// process.stdout.write above. Redirect the stdout-bound console methods to
	// stderr (via console.error, which formats identically) so non-interactive
	// modes keep real stdout clean for machine-readable output across runtimes.
	const originalConsole = {
		log: console.log.bind(console),
		info: console.info.bind(console),
		debug: console.debug.bind(console),
		dir: console.dir.bind(console),
	};
	const errorConsole = console.error.bind(console);
	console.log = ((...args: unknown[]): void => {
		errorConsole(...args);
	}) as typeof console.log;
	console.info = ((...args: unknown[]): void => {
		errorConsole(...args);
	}) as typeof console.info;
	console.debug = ((...args: unknown[]): void => {
		errorConsole(...args);
	}) as typeof console.debug;
	console.dir = ((...args: unknown[]): void => {
		errorConsole(...args);
	}) as typeof console.dir;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
		originalConsole,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	console.log = stdoutTakeoverState.originalConsole.log;
	console.info = stdoutTakeoverState.originalConsole.info;
	console.debug = stdoutTakeoverState.originalConsole.debug;
	console.dir = stdoutTakeoverState.originalConsole.dir;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

/** Hand a small control frame directly to the OS pipe before synchronous user code begins. */
export function writeRawStdoutControl(text: string): void {
	if (text.length === 0) return;
	try {
		getRawStdoutWrite()(text, (error) => {
			if (error) process.exit(1);
		});
	} catch {
		process.exit(1);
	}
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

/**
 * A `writeRawStdoutOnce` failure, carrying whether any byte of the payload
 * reached the stream.
 *
 * `emitted` is the answer to the only question the credential egress needs: may
 * these bytes be on stdout? Three cases produce it, and none of them guesses.
 *
 *   - the write call threw, before the stream could accept anything: `false`;
 *   - the callback reported an error and `bytesWritten` did not move, so the
 *     chunk was buffered and dropped without a syscall: `false`;
 *   - the callback reported an error after `bytesWritten` advanced, so part or
 *     all of the payload went out before the failure: `true`.
 *
 * `bytesWritten` exists on the socket stdout is when it is a TTY or a pipe. A
 * file redirect gets `SyncWriteStream`, which has no counter and writes
 * synchronously — there a callback error means the `writeSync` itself failed,
 * so nothing was emitted.
 */
export class RawStdoutWriteError extends Error {
	readonly emitted: boolean;

	constructor(message: string, options: { cause: unknown; emitted: boolean }) {
		super(message, { cause: options.cause });
		this.name = "RawStdoutWriteError";
		this.emitted = options.emitted;
	}
}

/** Bytes stdout has handed to the OS, when the stream counts them. */
function rawStdoutBytesWritten(): number | undefined {
	const counted = (process.stdout as { bytesWritten?: unknown }).bytesWritten;
	return typeof counted === "number" ? counted : undefined;
}

/**
 * Write one chunk to the real stdout as a single awaited operation.
 *
 * Differs from `writeRawStdout` in the two ways the credential egress needs.
 * The rejection reaches the caller instead of exiting the process, so the
 * caller can report a cause of its own. And the chunk is handed to stdout
 * exactly once — the ENOBUFS/EAGAIN retry in `writeRawStdoutChunk` would
 * re-send the whole payload, which for a secret risks emitting it twice.
 *
 * Rejects with `RawStdoutWriteError`, whose `emitted` says whether any byte
 * left. A caller that must never report a failure over a stream carrying a
 * credential — nor claim success over one that carries nothing — branches on it
 * rather than on the presence of an error.
 */
export function writeRawStdoutOnce(text: string): Promise<void> {
	if (text.length === 0) {
		return Promise.resolve();
	}
	const write = rawStdoutWriteTail.then(
		() =>
			new Promise<void>((resolve, reject) => {
				const before = rawStdoutBytesWritten();
				try {
					getRawStdoutWrite()(text, (error) => {
						if (!error) {
							resolve();
							return;
						}
						const after = rawStdoutBytesWritten();
						// Unknown counter means a synchronous stream, where a failed
						// write emitted nothing. A counter that has not moved means the
						// chunk never reached a syscall.
						const emitted = before !== undefined && after !== undefined && after > before;
						reject(new RawStdoutWriteError(error.message, { cause: error, emitted }));
					});
				} catch (error) {
					reject(
						new RawStdoutWriteError(error instanceof Error ? error.message : String(error), {
							cause: error,
							emitted: false,
						}),
					);
				}
			}),
	);
	// The failure belongs to this caller alone; the shared tail stays settled so
	// a later writer is not handed someone else's rejection.
	rawStdoutWriteTail = write.then(
		() => {},
		() => {},
	);
	return write;
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
