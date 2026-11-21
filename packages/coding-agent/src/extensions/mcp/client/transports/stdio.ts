import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import process from "node:process";
import crossSpawn from "cross-spawn";
import { type HelperLaunch, helperLaunchAsync, missingHelperOptions } from "../../../../utils/helper-command.ts";
import { type JsonRpcMessage, McpConnectionClosedError } from "../protocol/jsonrpc.js";
import { JsonRpcLineReader } from "./lines.js";
import { type McpTransport, TransportEvents } from "./transport.js";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** How long a server gets to exit on its own after stdin closes, before it is sent SIGTERM. */
const STDIN_CLOSE_GRACE_MS = 500;
/** After SIGKILL, how long the pipes may stay open, held by a process outside the group, before they are destroyed. */
const PIPE_RELEASE_AFTER_KILL_MS = 1_000;
const USE_PROCESS_GROUPS = process.platform !== "win32";

/** Process groups of running servers, killed if the host exits without closing them. */
const liveProcessGroups = new Set<number>();
let exitHookInstalled = false;

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (process.platform === "win32" && pid !== undefined) {
		if (child.exitCode !== null) return;
		// Windows has no graceful signals, and cross-spawn runs `.cmd` shims through cmd.exe; killing only
		// that would leave the server running.
		const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
		spawn(join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		}).on("error", () => {});
		return;
	}
	if (USE_PROCESS_GROUPS && pid !== undefined) {
		try {
			// Negative pid: the whole group, so wrappers like `npx` or `uvx` do not leave the server behind.
			process.kill(-pid, signal);
			return;
		} catch {
			// The group is gone or was never created; fall back to the direct child.
		}
	}
	try {
		child.kill(signal);
	} catch {}
}

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const pid of liveProcessGroups) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {}
		}
	});
}

/**
 * The server's environment: `configured` over `inherited`. Windows reads a variable's name in any letter case, so there a
 * configured variable replaces the inherited one however either is spelled, for the program's lookup and the program.
 */
function serverEnvironment(inherited: NodeJS.ProcessEnv, configured: Record<string, string> = {}): NodeJS.ProcessEnv {
	if (process.platform !== "win32") return { ...inherited, ...configured };
	const replaced = new Set(Object.keys(configured).map((name) => name.toUpperCase()));
	const kept = Object.entries(inherited).filter(([name]) => !replaced.has(name.toUpperCase()));
	return { ...Object.fromEntries(kept), ...configured };
}

/**
 * Whether `directory` is certainly outside the project folder, with links and other spellings of either resolved: only
 * there may a program be looked up by name. Not when either cannot be read.
 */
async function outsideProject(directory: string, projectCwd: string): Promise<boolean> {
	try {
		const [real, project] = await Promise.all([realpath(directory), realpath(projectCwd)]);
		const fromProject = relative(project, real);
		return fromProject === ".." || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject);
	} catch {
		return false;
	}
}

export interface StdioTransportOptions {
	/**
	 * The server's program: a path is started as it is; a name only from PATH's absolute directories, never from the
	 * project folder (`projectCwd`) or Atomic's working directory. On Windows a name is also looked up in a `cwd` that is
	 * neither, as Windows looks in a program's working directory first.
	 */
	command: string;
	args?: readonly string[];
	cwd?: string;
	/** The folder of the session the server serves; default `cwd`. */
	projectCwd?: string;
	env?: Record<string, string>;
	inheritEnv?: boolean;
	stderr?: "pipe" | "inherit";
	onStderr?: (chunk: string) => void;
	maxMessageBytes?: number;
	maxStderrBytes?: number;
	/** Time to wait for the server to exit after SIGTERM before sending SIGKILL. Default: 2000. */
	closeTimeoutMs?: number;
}

export class StdioTransport extends TransportEvents implements McpTransport {
	readonly options: Readonly<StdioTransportOptions>;
	private child: ChildProcess | undefined;
	private readonly lines: JsonRpcLineReader;
	private started = false;
	private closed = false;
	/** Ends a lookup of the server's program that `close()` cuts short. */
	private readonly lookup = new AbortController();

	constructor(options: StdioTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, args: options.args ? [...options.args] : undefined });
		this.lines = new JsonRpcLineReader({
			maxMessageBytes: this.options.maxMessageBytes,
			maxStderrBytes: this.options.maxStderrBytes,
			onStderr: this.options.onStderr,
			onMessage: (message) => this.emitMessage(message),
			onError: (error) => this.emitError(error),
		});
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get stderr(): string {
		return this.lines.stderr;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP stdio transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
		const env = serverEnvironment(this.options.inheritEnv === false ? {} : process.env, this.options.env);
		const projectCwd = this.options.projectCwd ?? this.options.cwd;
		const { cwd } = this.options;
		let launch: HelperLaunch;
		try {
			// Windows looks in a program's working directory first: one configured outside the project folder.
			const searchFirst =
				process.platform === "win32" &&
				cwd !== undefined &&
				projectCwd !== undefined &&
				(await outsideProject(cwd, projectCwd))
					? cwd
					: undefined;
			launch = await helperLaunchAsync(this.options.command, {
				env,
				...(projectCwd === undefined ? {} : { cwd: projectCwd }),
				...(searchFirst === undefined ? {} : { searchFirst }),
				// cross-spawn runs `.cmd` and `.bat` shims through cmd.exe.
				shellScripts: true,
				signal: this.lookup.signal,
			});
		} catch (error) {
			if (this.closed) throw new McpConnectionClosedError();
			throw error;
		}
		// Closed while the program was looked up: nothing starts.
		if (this.closed) throw new McpConnectionClosedError();
		const options: SpawnOptions = {
			cwd: this.options.cwd,
			env,
			stdio: ["pipe", "pipe", this.options.stderr === "inherit" ? "inherit" : "pipe"],
			windowsHide: true,
			// Own process group, so closing the transport can terminate the server's children too.
			detached: USE_PROCESS_GROUPS,
		};
		// A program found nowhere fails as a missing one does; cross-spawn would look in the working directory.
		const child =
			launch.missing === undefined
				? crossSpawn(launch.file, this.options.args ?? [], options)
				: spawn(launch.file, this.options.args ?? [], { ...options, ...missingHelperOptions(launch) });
		this.child = child;
		const pid = child.pid;
		if (USE_PROCESS_GROUPS && pid !== undefined) {
			installExitHook();
			liveProcessGroups.add(pid);
			// Not on "exit": children of the server can outlive it while still holding its pipes.
			child.once("close", () => liveProcessGroups.delete(pid));
		}
		child.stdout?.on("data", (chunk: Buffer) => this.lines.readStdout(chunk));
		child.stdout?.on("error", (error) => this.emitError(error));
		child.stdin?.on("error", (error) => {
			if (!this.closed) this.emitError(error);
		});
		child.stderr?.on("data", (chunk: Buffer) => this.lines.readStderr(chunk));
		child.stderr?.on("error", (error) => this.emitError(error));
		child.on("close", () => {
			this.child = undefined;
			this.lines.end();
			this.emitClose();
		});

		await new Promise<void>((resolve, reject) => {
			const onSpawn = () => {
				child.off("error", onError);
				resolve();
			};
			const onError = (error: Error) => {
				child.off("spawn", onSpawn);
				reject(error);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
		child.on("error", (error) => {
			if (!this.closed) this.emitError(error);
		});
	}

	async send(message: JsonRpcMessage): Promise<void> {
		const stdin = this.child?.stdin;
		if (!this.started || this.closed || !stdin?.writable) throw new McpConnectionClosedError();
		const payload = `${JSON.stringify(message)}\n`;
		await new Promise<void>((resolve, reject) => {
			stdin.write(payload, (error) => (error ? reject(error) : resolve()));
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.lookup.abort();
		const child = this.child;
		if (!child) {
			this.emitClose();
			return;
		}
		// With process groups, a server that already exited can leave children holding its pipes; the
		// group cleanup below still has to run for them.
		if (!USE_PROCESS_GROUPS && (child.exitCode !== null || child.signalCode !== null)) {
			child.stdin?.end();
			return;
		}
		// Shutdown per the spec: close stdin and let the server exit, then SIGTERM, then SIGKILL.
		const closeTimeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		await new Promise<void>((resolve) => {
			const timers: ReturnType<typeof setTimeout>[] = [];
			child.once("close", () => {
				for (const timer of timers) clearTimeout(timer);
				// Children of the server that ignored stdin closing would otherwise outlive it.
				killProcessTree(child, "SIGTERM");
				resolve();
			});
			const grace = Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);
			timers.push(setTimeout(() => killProcessTree(child, "SIGTERM"), grace));
			timers.push(setTimeout(() => killProcessTree(child, "SIGKILL"), grace + closeTimeoutMs));
			// A process that left the server's group can keep the pipes open after the kill; stop waiting for it.
			timers.push(
				setTimeout(
					() => {
						child.stdin?.destroy();
						child.stdout?.destroy();
						child.stderr?.destroy();
					},
					grace + closeTimeoutMs + PIPE_RELEASE_AFTER_KILL_MS,
				),
			);
			child.stdin?.end();
		});
	}
}
