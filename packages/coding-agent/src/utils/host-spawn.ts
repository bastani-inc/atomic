/**
 * Starts the child processes the host runs for its own work, such as the Git commands of worktree snapshots, without
 * stalling its event loop in proportion to its memory.
 *
 * Node's `child_process` forks on Linux, and a fork copies the parent's page tables before the child can exec: about
 * 50 ms per gigabyte, all on the JavaScript thread. A host of several gigabytes running many agents starts a few
 * processes a second, which left it busy in the kernel most of the time. On Linux, {@link spawnHostProcess} starts the
 * process through the native module, which does not copy the address space and moves the process's input and output
 * on a thread of its own. Everywhere else (macOS's `child_process` already uses `posix_spawn`, and Windows never
 * forks), without the native module, or with `ATOMIC_HOST_SPAWN=child-process`, it is `child_process.spawn` itself.
 * Both return the same subset of `ChildProcess`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { constants as osConstants } from "node:os";
import { Readable, Writable } from "node:stream";
import type * as native from "@bastani/atomic-natives";
import { createModuleRequire } from "./module-require.js";

/** Which stream a child process gets: a pipe to the host, or nothing (`/dev/null`). */
export type HostStdio = "pipe" | "ignore";

export interface HostSpawnOptions {
	readonly cwd?: string;
	/** The child's complete environment; this process's when absent. */
	readonly env?: NodeJS.ProcessEnv;
	/** Standard input, output and error, or one choice for all three. Pipes by default. */
	readonly stdio?: HostStdio | readonly [HostStdio, HostStdio, HostStdio];
	/** Starts the child in a session (and process group) of its own on POSIX, as `child_process`'s `detached`. */
	readonly detached?: boolean;
	readonly windowsHide?: boolean;
	/**
	 * Ends the child with `SIGKILL` when this process ends, however it ends, where the child starts through the native
	 * module (Linux); not the processes the child starts. Not for a detached child.
	 */
	readonly endWithParent?: boolean;
}

/** The part of `ChildProcess` both ways of starting a host process provide. */
export interface HostChildProcess {
	readonly pid?: number | undefined;
	readonly stdin: Writable | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	readonly killed: boolean;
	kill(signal?: NodeJS.Signals | number): boolean;
	ref(): void;
	unref(): void;
	on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "spawn", listener: () => void): this;
	once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: "spawn", listener: () => void): this;
	removeListener(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	removeListener(event: "error", listener: (error: Error) => void): this;
	removeListener(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

/** Where a host process starts. */
export type HostSpawnBackend = "native" | "child-process";

/** The environment variable that sends every host process through `child_process`, as a way out. */
export const HOST_SPAWN_ENV = "ATOMIC_HOST_SPAWN";

/**
 * Where a host process starts: through the native module on Linux when it provides the native start and
 * {@link HOST_SPAWN_ENV} is not `child-process`, and through `child_process` in every other case.
 */
export function chooseHostSpawnBackend({
	platform,
	nativeAvailable,
	override,
}: {
	readonly platform: NodeJS.Platform;
	readonly nativeAvailable: boolean;
	readonly override: string | undefined;
}): HostSpawnBackend {
	if (override === "child-process") return "child-process";
	return platform === "linux" && nativeAvailable ? "native" : "child-process";
}

type StartHostProcess = typeof native.startHostProcess;

let nativeStart: StartHostProcess | null | undefined;

/** The native start, or null when the native module cannot be loaded or predates it. */
function loadNativeStart(): StartHostProcess | null {
	if (nativeStart === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as Partial<typeof native>;
			nativeStart = binding.startHostProcess ?? null;
		} catch {
			nativeStart = null;
		}
	}
	return nativeStart;
}

/**
 * Whether {@link chooseHostSpawnBackend}'s answer depends on the native start being available: only then is the
 * native module loaded, and taking it as unavailable otherwise does not change the answer.
 */
function nativeStartMatters(platform: NodeJS.Platform, override: string | undefined): boolean {
	return platform === "linux" && override !== "child-process";
}

/** Where host processes of this process start now. */
export function hostSpawnBackend(): HostSpawnBackend {
	const override = process.env[HOST_SPAWN_ENV];
	const nativeAvailable = nativeStartMatters(process.platform, override) && loadNativeStart() !== null;
	return chooseHostSpawnBackend({ platform: process.platform, nativeAvailable, override });
}

function stdioOf(options: HostSpawnOptions): readonly [HostStdio, HostStdio, HostStdio] {
	const stdio = options.stdio ?? "pipe";
	return typeof stdio === "string" ? [stdio, stdio, stdio] : stdio;
}

/**
 * Starts `file` with `args`, as `child_process.spawn(file, args, options)` would, through the native module where
 * {@link hostSpawnBackend} says so.
 */
export function spawnHostProcess(
	file: string,
	args: readonly string[],
	options: HostSpawnOptions = {},
): HostChildProcess {
	const start = hostSpawnBackend() === "native" ? loadNativeStart() : null;
	if (start === null) {
		return nodeSpawn(file, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: [...stdioOf(options)],
			detached: options.detached,
			windowsHide: options.windowsHide,
		});
	}
	return new NativeChildProcess(start, file, args, options);
}

/** A process {@link spawnContainedProcess} started: it and every process it starts are in a job of its own. */
export interface ContainedChildProcess extends HostChildProcess {
	/**
	 * Ends the process and, while it runs, the processes below it, and then every process still in its job. False once
	 * {@link releaseTree} let them go.
	 */
	endTree(): boolean;
	/** Lets the processes still in its job run on: neither {@link endTree} nor this process's exit ends them then. */
	releaseTree(): void;
}

/** A drive or UNC path: libuv looks a program given so up without the working directory or `PATH`. */
const FULL_WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;

function hasNul(text: string): boolean {
	return text.includes("\0");
}

/**
 * On Windows, starts `file` (a full path) with `args` as `child_process.spawn(file, args, { ...options,
 * windowsHide: true })` would, with the same command line, environment and pipes, but suspended and in a job of its
 * own, which holds it before its first instruction and every process it starts after, unless one asks to leave it:
 * {@link ContainedChildProcess.endTree} ends, while `file` runs, it and the processes below it through handles, and
 * then those in the job, by no process ID, also once `file` exited. While the job is held, this process's exit ends
 * those in it too; {@link ContainedChildProcess.releaseTree} lets them run on. Its streams are this process's own
 * sockets on a pipe server it listens on, as `child_process`'s are. Undefined elsewhere, with {@link HOST_SPAWN_ENV}
 * set to `child-process`, without a native module that can contain it, for a `file` that is not a full path, and for a
 * NUL in the input, which `child_process` refuses itself: the caller then starts it through `child_process`.
 */
export async function spawnContainedProcess(
	file: string,
	args: readonly string[],
	options: HostSpawnOptions = {},
): Promise<ContainedChildProcess | undefined> {
	if (process.platform !== "win32" || process.env[HOST_SPAWN_ENV] === "child-process") return undefined;
	if (!FULL_WINDOWS_PATH.test(file) || options.detached === true) return undefined;
	const environment = options.env ?? process.env;
	if (
		[file, ...args, options.cwd ?? ""].some(hasNul) ||
		Object.entries(environment).some(([key, value]) => hasNul(key) || (value !== undefined && hasNul(value)))
	) {
		return undefined;
	}
	const start = loadNativeStart();
	if (start === null) return undefined;
	const piped = stdioOf(options).map((stdio) => stdio === "pipe");
	const prefix = randomBytes(STREAM_PREFIX_BYTES);
	const name = `\\\\.\\pipe\\atomic-host-process-${process.pid}-${randomBytes(16).toString("hex")}`;
	const server = piped.some(Boolean) ? createServer() : undefined;
	// A server that cannot listen leaves the native start nothing to connect to: it refuses, and the caller falls back.
	server?.on("error", () => {});
	const streams = server === undefined ? undefined : acceptStreams(server, prefix, piped);
	server?.listen(name);
	const child = new ContainedProcess();
	let started: native.HostProcess;
	try {
		started = start(
			{
				file,
				args: [...args],
				cwd: options.cwd,
				env: environmentOf(options.env),
				pipeStdin: piped[0] === true,
				pipeStdout: piped[1] === true,
				pipeStderr: piped[2] === true,
				detached: false,
				pipe: server === undefined ? undefined : name,
				pipePrefix: server === undefined ? undefined : prefix,
			},
			(event) => child.event(event),
		);
	} catch (failure) {
		server?.close();
		streams?.cancel();
		// A native module that cannot start one here (ENOSYS), cannot contain it or connect its streams (ENOTSUP) ran
		// nothing.
		const code = (failure as NodeJS.ErrnoException).code ?? "EIO";
		if (code === "ENOSYS" || code === "ENOTSUP") return undefined;
		const error = spawnError(code, file, args);
		if (!ASYNC_SPAWN_ERRORS.has(code)) throw error;
		child.failedStart(error, piped);
		return child;
	}
	child.pid = started.pid;
	const sockets = streams === undefined ? [] : await streams.accepted;
	server?.close();
	child.attach(started, sockets);
	return child;
}

/** How many random bytes the native start writes first into each of a contained process's streams. */
const STREAM_PREFIX_BYTES = 16;

/**
 * The connections to `server` that carry `prefix` and the number of a stream `piped` names, one per stream, in stream
 * order; any other connection is closed. A connection's bytes after its prefix and number stay in it.
 */
function acceptStreams(
	server: Server,
	prefix: Buffer,
	piped: readonly boolean[],
): { readonly accepted: Promise<(Socket | undefined)[]>; cancel(): void } {
	const sockets: (Socket | undefined)[] = piped.map(() => undefined);
	const open = new Set<Socket>();
	let resolveAccepted: (sockets: (Socket | undefined)[]) => void = () => {};
	const accepted = new Promise<(Socket | undefined)[]>((resolve) => {
		resolveAccepted = resolve;
	});
	server.on("connection", (socket: Socket) => {
		open.add(socket);
		// Until it is known as a stream: a connection that fails is only closed.
		const ignoreError = () => {};
		socket.on("error", ignoreError);
		const head = prefix.length + 1;
		const onReadable = () => {
			const bytes: Buffer | null = socket.read(head);
			if (bytes === null) return;
			socket.removeListener("readable", onReadable);
			socket.removeListener("end", onEnd);
			const stream = bytes.length === head ? bytes[prefix.length] : undefined;
			const own =
				stream !== undefined &&
				piped[stream] === true &&
				sockets[stream] === undefined &&
				timingSafeEqual(bytes.subarray(0, prefix.length), prefix);
			if (!own) {
				open.delete(socket);
				socket.destroy();
				return;
			}
			socket.removeListener("error", ignoreError);
			sockets[stream] = socket;
			if (piped.every((wanted, index) => !wanted || sockets[index] !== undefined)) resolveAccepted(sockets);
		};
		const onEnd = () => {
			socket.removeListener("readable", onReadable);
			open.delete(socket);
			socket.destroy();
		};
		socket.on("readable", onReadable);
		socket.once("end", onEnd);
	});
	return {
		accepted,
		cancel: () => {
			for (const socket of open) socket.destroy();
		},
	};
}

/** Start failures `child_process` reports through an `error` event rather than by throwing, as libuv sorts them. */
const ASYNC_SPAWN_ERRORS: ReadonlySet<string> = new Set(["EACCES", "EAGAIN", "EMFILE", "ENFILE", "ENOENT"]);

const SIGNAL_NAMES = new Map<number, NodeJS.Signals>(
	Object.entries(osConstants.signals).map(([name, number]) => [number, name as NodeJS.Signals]),
);

function signalNumber(signal: NodeJS.Signals | number | undefined): number {
	if (typeof signal === "number") return signal;
	const number = osConstants.signals[signal ?? "SIGTERM"];
	if (number === undefined) {
		const error: NodeJS.ErrnoException = new TypeError(`Unknown signal: ${String(signal)}`);
		error.code = "ERR_UNKNOWN_SIGNAL";
		throw error;
	}
	return number;
}

/** The error `child_process` gives for a failed start, with the same code, message and fields. */
function spawnError(code: string, file: string, args: readonly string[]): NodeJS.ErrnoException {
	const errno = osConstants.errno[code as keyof typeof osConstants.errno];
	const error: NodeJS.ErrnoException & { spawnargs?: string[] } = new Error(`spawn ${file} ${code}`);
	error.errno = errno === undefined ? undefined : -errno;
	error.code = code;
	error.syscall = `spawn ${file}`;
	error.path = file;
	error.spawnargs = [...args];
	return error;
}

/**
 * The child's complete environment, as `child_process` takes it from `env`: on Windows, where names ignore case, only
 * the first of the names that differ only in case, in sort order, and without it if its value is undefined.
 */
function environmentOf(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
	const complete: Record<string, string> = {};
	const source = env ?? process.env;
	let keys = Object.keys(source);
	if (process.platform === "win32") {
		const seen = new Set<string>();
		keys = keys.sort().filter((key) => {
			const name = key.toUpperCase();
			if (seen.has(name)) return false;
			seen.add(name);
			return true;
		});
	}
	for (const key of keys) {
		const value = source[key];
		if (value !== undefined) complete[key] = value;
	}
	return complete;
}

/** A process started through the native module, with the events and streams `child_process` gives one. */
class NativeChildProcess extends EventEmitter implements HostChildProcess {
	pid: number | undefined;
	readonly stdin: Writable | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	#process: native.HostProcess | undefined;
	#exited = false;
	#openOutputs = 0;
	#closed = false;

	constructor(start: StartHostProcess, file: string, args: readonly string[], options: HostSpawnOptions) {
		super();
		const [input, output, error] = stdioOf(options);
		this.stdout = output === "pipe" ? this.#output() : null;
		this.stderr = error === "pipe" ? this.#output() : null;
		this.stdin =
			input === "pipe"
				? new Writable({
						write: (chunk: Buffer, _encoding, done) => {
							done(this.#process?.write(chunk) === false ? spawnError("EPIPE", file, args) : null);
						},
						final: (done) => {
							this.#process?.end();
							done();
						},
						destroy: (cause, done) => {
							this.#process?.end();
							done(cause);
						},
					})
				: null;
		try {
			this.#process = start(
				{
					file,
					args: [...args],
					cwd: options.cwd,
					env: environmentOf(options.env),
					pipeStdin: input === "pipe",
					pipeStdout: output === "pipe",
					pipeStderr: error === "pipe",
					detached: options.detached === true,
					endWithParent: options.endWithParent === true,
				},
				(event) => this.#event(event),
			);
		} catch (failure) {
			const code = (failure as NodeJS.ErrnoException).code ?? "EIO";
			const error = spawnError(code, file, args);
			if (!ASYNC_SPAWN_ERRORS.has(code)) throw error;
			this.exitCode = error.errno ?? -1;
			process.nextTick(() => this.#failedStart(error));
			return;
		}
		this.pid = this.#process.pid;
		process.nextTick(() => this.emit("spawn"));
	}

	#output(): Readable {
		this.#openOutputs++;
		const stream = new Readable({ read() {} });
		stream.once("close", () => {
			this.#openOutputs--;
			this.#maybeClose();
		});
		return stream;
	}

	/** As `child_process` reports a failed start: `error`, then `close` once the streams closed. */
	#failedStart(error: NodeJS.ErrnoException): void {
		this.#exited = true;
		this.emit("error", error);
		this.stdin?.destroy();
		for (const stream of [this.stdout, this.stderr]) stream?.push(null);
		for (const stream of [this.stdout, this.stderr]) stream?.resume();
		this.#maybeClose();
	}

	#event(event: native.HostProcessEvent): void {
		switch (event.kind) {
			case "stdout":
				this.stdout?.push(event.data);
				return;
			case "stderr":
				this.stderr?.push(event.data);
				return;
			case "stdout-end":
				this.stdout?.push(null);
				return;
			case "stderr-end":
				this.stderr?.push(null);
				return;
			case "stdin-error":
				this.stdin?.destroy(spawnError(event.errno ?? "EPIPE", "write", []));
				return;
			case "exit":
				this.#exited = true;
				this.exitCode = event.code ?? null;
				this.signalCode = event.signal === undefined ? null : (SIGNAL_NAMES.get(event.signal) ?? null);
				this.emit("exit", this.exitCode, this.signalCode);
				this.#maybeClose();
				return;
		}
	}

	#maybeClose(): void {
		if (this.#closed || !this.#exited || this.#openOutputs > 0) return;
		this.#closed = true;
		process.nextTick(() => {
			this.emit("close", this.exitCode, this.signalCode);
			// Reaped only now: until `close` was handled, the process's ID and its group's could not name another
			// process, so a signal sent to either before it reached only what this process started.
			this.#process?.release();
		});
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		const number = signalNumber(signal);
		if (this.#process === undefined || this.#exited) return false;
		const sent = this.#process.kill(number, false);
		if (sent) this.killed = true;
		return sent;
	}

	ref(): void {
		this.#process?.ref();
	}

	unref(): void {
		this.#process?.unref();
	}
}

/**
 * A process {@link spawnContainedProcess} started, with the events `child_process` gives one and its streams as
 * `child_process` gives them: sockets of this process on pipes whose other ends are the program's. Its exit comes from
 * the native module, after its `spawn`.
 */
class ContainedProcess extends EventEmitter implements ContainedChildProcess {
	pid: number | undefined;
	stdin: Writable | null = null;
	stdout: Readable | null = null;
	stderr: Readable | null = null;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	#process: native.HostProcess | undefined;
	#spawned = false;
	#heldExit: native.HostProcessEvent | undefined;
	#exited = false;
	#openOutputs = 0;
	#closed = false;

	/** The native module's events: only the exit, held until `spawn` was emitted. */
	event(event: native.HostProcessEvent): void {
		if (event.kind !== "exit") return;
		if (this.#spawned) this.#exit(event);
		else this.#heldExit = event;
	}

	/** The started process and its streams' sockets, in stream order; `spawn` follows once the caller has the child. */
	attach(started: native.HostProcess, sockets: readonly (Socket | undefined)[]): void {
		this.#process = started;
		const [input, output, error] = sockets;
		if (input !== undefined) {
			// As `child_process`'s, which can only write: once its writes are done, the program reads to its end.
			input.pause();
			input.once("finish", () => input.destroy());
			this.stdin = input;
		}
		this.stdout = output === undefined ? null : this.#output(output);
		this.stderr = error === undefined ? null : this.#output(error);
		setImmediate(() => {
			this.#spawned = true;
			this.emit("spawn");
			if (this.#heldExit !== undefined) this.#exit(this.#heldExit);
		});
	}

	#output<T extends Readable>(stream: T): T {
		this.#openOutputs++;
		stream.once("close", () => {
			this.#openOutputs--;
			this.#maybeClose();
		});
		return stream;
	}

	/** As `child_process` reports a failed start: `error`, then `close` once its streams closed. */
	failedStart(error: NodeJS.ErrnoException, piped: readonly boolean[]): void {
		this.exitCode = error.errno ?? -1;
		this.stdin = piped[0] === true ? new Writable({ write: (_chunk, _encoding, done) => done(error) }) : null;
		const empty = () => {
			const stream = this.#output(new Readable({ read() {} }));
			stream.push(null);
			stream.resume();
			return stream;
		};
		this.stdout = piped[1] === true ? empty() : null;
		this.stderr = piped[2] === true ? empty() : null;
		// After the caller, which gets the child asynchronously, has listened for it.
		setImmediate(() => {
			this.#exited = true;
			this.emit("error", error);
			this.stdin?.destroy();
			this.#maybeClose();
		});
	}

	#exit(event: native.HostProcessEvent): void {
		this.#exited = true;
		this.exitCode = event.code ?? null;
		this.signalCode = event.signal === undefined ? null : (SIGNAL_NAMES.get(event.signal) ?? null);
		this.stdin?.destroy();
		this.emit("exit", this.exitCode, this.signalCode);
		this.#maybeClose();
	}

	#maybeClose(): void {
		if (this.#closed || !this.#exited || this.#openOutputs > 0) return;
		this.#closed = true;
		process.nextTick(() => {
			this.emit("close", this.exitCode, this.signalCode);
			this.#process?.release();
		});
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		const number = signalNumber(signal);
		if (this.#process === undefined || this.#exited) return false;
		const sent = this.#process.kill(number, false);
		if (sent) this.killed = true;
		return sent;
	}

	endTree(): boolean {
		return this.#process?.endTree() ?? false;
	}

	releaseTree(): void {
		this.#process?.releaseTree();
	}

	ref(): void {
		this.#process?.ref();
	}

	unref(): void {
		this.#process?.unref();
	}
}
