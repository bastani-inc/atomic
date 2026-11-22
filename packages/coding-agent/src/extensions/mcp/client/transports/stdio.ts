import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import crossSpawn from "cross-spawn";
import {
	findHelperExecutableAsync,
	type HelperExecutableOptions,
	type HelperLaunch,
	helperLaunchAsync,
	missingHelperOptions,
} from "../../../../utils/helper-command.ts";
import {
	extractAuthorizationSecrets,
	isSensitiveKeyName,
	looksLikeSecretValue,
	redactOAuthErrorText,
	scrubUnknownErrorData,
} from "../oauth/redact.js";
import { isJsonRpcResponse, type JsonRpcMessage, McpConnectionClosedError } from "../protocol/jsonrpc.js";
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

/**
 * Ends `child` and the processes it started. On Windows, returns a promise that resolves once the kill command has
 * finished or failed to start; `undefined` when no kill command was started (elsewhere, already exited, or when
 * starting the kill command threw synchronously and the direct handle kill ran instead).
 */
function killProcessTree(
	child: ChildProcess,
	signal: NodeJS.Signals,
	onSettled?: () => void,
): Promise<void> | undefined {
	const pid = child.pid;
	if (process.platform === "win32" && pid !== undefined) {
		if (child.exitCode !== null || child.signalCode !== null) return undefined;
		// Windows has no graceful signals, and cross-spawn runs `.cmd` shims through cmd.exe; killing only
		// that would leave the server running. The kill command runs in the system directory, so it never keeps the
		// folder Atomic runs in, the project's, in use.
		const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
		try {
			const kill = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
				cwd: systemRoot,
				stdio: "ignore",
				windowsHide: true,
			});
			return new Promise((resolve) => {
				let settled = false;
				const finish = (fallback: boolean) => {
					if (settled) return;
					settled = true;
					onSettled?.();
					if (fallback && child.exitCode === null && child.signalCode === null) {
						try {
							child.kill(signal);
						} catch {}
					}
					resolve();
				};
				kill.once("error", () => finish(true));
				kill.once("exit", (code) => finish(code !== 0));
			});
		} catch {
			// Starting taskkill failed synchronously; fall through to killing the direct child handle.
		}
	}
	if (USE_PROCESS_GROUPS && pid !== undefined) {
		try {
			// Negative pid: the whole group, so wrappers like `npx` or `uvx` do not leave the server behind.
			process.kill(-pid, signal);
			return undefined;
		} catch {
			// The group is gone or was never created; fall back to the direct child.
		}
	}
	try {
		child.kill(signal);
	} catch {}
	return undefined;
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

/** How much of a script's start its interpreter line may take, as cross-spawn reads it. */
const SHEBANG_BYTES = 150;

/** What Windows starts itself, whose first bytes are no interpreter line. */
const DIRECT_EXTENSIONS = new Set([".com", ".exe"]);

/**
 * Windows: how `command` starts when its program is a script whose first line names an interpreter (`#!/usr/bin/env
 * node`), which cross-spawn starts by that interpreter, but with the interpreter looked up as the program is, never in
 * the project folder, and in a working directory configured outside it first, as for a program given by name. The
 * script is the program `launch` found or names, or, when nothing was found under a name
 * without an extension, a file of that very name in PATH's absolute directories, as cross-spawn also tries. Undefined
 * for a program that is no such script; a missing interpreter fails as a missing program does.
 */
async function interpretedLaunch(
	command: string,
	launch: HelperLaunch,
	cwd: string,
	search: HelperExecutableOptions,
	interpreterSearch: () => Promise<HelperExecutableOptions>,
): Promise<{ readonly launch: HelperLaunch; readonly args: readonly string[] } | undefined> {
	const script =
		launch.missing === undefined
			? resolve(cwd, launch.file)
			: extname(command) === ""
				? await findHelperExecutableAsync(command, { ...search, asIs: true })
				: undefined;
	if (script === undefined || DIRECT_EXTENSIONS.has(extname(script).toLowerCase())) return undefined;
	const interpreter = await readInterpreter(script);
	if (interpreter === undefined) return undefined;
	const [program, ...interpreterArgs] = interpreter;
	return {
		launch: await helperLaunchAsync(program, { ...(await interpreterSearch()), shellScripts: true }),
		args: [...interpreterArgs, script],
	};
}

/**
 * The interpreter and its argument a script's first line names, read as cross-spawn reads it: `#!/usr/bin/env node`
 * names `node`, `#!/bin/sh -e` names `sh` with `-e`. Undefined for a file without one, or one that cannot be read.
 */
async function readInterpreter(script: string): Promise<readonly [string, ...string[]] | undefined> {
	let start: string;
	try {
		const file = await open(script, "r");
		try {
			const buffer = Buffer.alloc(SHEBANG_BYTES);
			const { bytesRead } = await file.read(buffer, 0, SHEBANG_BYTES, 0);
			start = buffer.toString("utf8", 0, bytesRead);
		} finally {
			await file.close();
		}
	} catch {
		return undefined;
	}
	const line = /^#!(.*)/u.exec(start)?.[1];
	if (line === undefined) return undefined;
	const [path = "", argument] = line.replace(/^ /u, "").split(" ");
	const binary = path.split("/").pop() ?? "";
	if (binary === "env") return argument ? [argument] : undefined;
	if (binary === "") return undefined;
	return argument ? [binary, argument] : [binary];
}

/** `work`'s result, or `signal`'s reason as soon as it aborts, whatever `work` still waits for. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
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
	 * The server's program: a path is started as it is; a name only from PATH's absolute directories, never through an
	 * implicit search of the project folder (`projectCwd`) or Atomic's working directory. On Windows a name is also
	 * looked up in a `cwd` outside the project folder, as Windows looks in a program's working directory first, and may
	 * name a script without an extension, started by the interpreter its first line names.
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

/** Standard non-secret runtime env vars; all other configured `env` entries are scrubbed from stderr and logs. */
const NON_SECRET_STDIO_ENV_VARS = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TMPDIR",
	"TEMP",
	"TMP",
	"NODE_ENV",
	"NODE_OPTIONS",
	"DEBUG",
	"LOG_LEVEL",
	"HOST",
	"HOSTNAME",
	"PORT",
	"WORKSPACE",
	"ENV",
	"ENVIRONMENT",
	"STAGE",
	"REGION",
	"MODE",
	"FORMAT",
	"VERBOSE",
	"QUIET",
	"NO_COLOR",
	"FORCE_COLOR",
	"CI",
	"PWD",
	"OLDPWD",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"PROGRAMFILES",
]);

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
			onMessage: (message) => this.emitMessage(this.scrubIncomingMessage(message)),
			onError: (error) => {
				const message = redactOAuthErrorText(
					error instanceof Error ? error.message : String(error),
					this.activeSecrets(),
				);
				this.emitError(new Error(message));
			},
		});
	}

	/** Configured secret `env` values that must be scrubbed from stderr, errors, and logs. */
	activeSecrets(): string[] {
		const secrets: string[] = [];
		for (const [name, value] of Object.entries(this.options.env ?? {})) {
			if (NON_SECRET_STDIO_ENV_VARS.has(name.toUpperCase())) continue;
			if (isSensitiveKeyName(name) || looksLikeSecretValue(value)) {
				secrets.push(...extractAuthorizationSecrets(value));
			}
		}
		return secrets;
	}

	private scrubIncomingMessage(message: JsonRpcMessage): JsonRpcMessage {
		if (!isJsonRpcResponse(message) || !("error" in message)) return message;
		const secrets = this.activeSecrets();
		return {
			...message,
			error: {
				...message.error,
				message: redactOAuthErrorText(message.error.message, secrets),
				...(message.error.data === undefined ? {} : { data: scrubUnknownErrorData(message.error.data, secrets) }),
			},
		};
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
		/** What the program's command line starts with before the server's arguments: a script's interpreter's. */
		let leading: readonly string[] = [];
		try {
			// Windows looks in a program's working directory first: one configured outside the project folder.
			const firstFolder = async (): Promise<string | undefined> =>
				process.platform === "win32" &&
				cwd !== undefined &&
				projectCwd !== undefined &&
				cwd !== projectCwd &&
				(await untilAborted(outsideProject(cwd, projectCwd), this.lookup.signal))
					? cwd
					: undefined;
			const searchFrom = (searchFirst: string | undefined): HelperExecutableOptions => ({
				env,
				...(projectCwd === undefined ? {} : { cwd: projectCwd }),
				...(searchFirst === undefined ? {} : { searchFirst }),
				signal: this.lookup.signal,
			});
			// A program given by its path needs no search, unless it is a script whose interpreter is looked up.
			const named = !/[\\/:]/.test(this.options.command);
			const search = searchFrom(named ? await firstFolder() : undefined);
			// cross-spawn runs `.cmd` and `.bat` shims through cmd.exe.
			launch = await helperLaunchAsync(this.options.command, { ...search, shellScripts: true });
			if (process.platform === "win32") {
				const interpreted = await untilAborted(
					interpretedLaunch(this.options.command, launch, cwd ?? process.cwd(), search, async () =>
						named ? search : searchFrom(await firstFolder()),
					),
					this.lookup.signal,
				);
				if (interpreted !== undefined) ({ launch, args: leading } = interpreted);
			}
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
				? crossSpawn(launch.file, [...leading, ...(this.options.args ?? [])], options)
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
		/** The kill commands this close started that are still running, waited for once the server has closed. */
		const kills = new Set<Promise<void>>();
		const kill = (signal: NodeJS.Signals) => {
			let settled = false;
			const pending = killProcessTree(child, signal, () => {
				settled = true;
				if (pending !== undefined) kills.delete(pending);
			});
			if (pending !== undefined && !settled) kills.add(pending);
		};
		await new Promise<void>((resolve) => {
			const timers: ReturnType<typeof setTimeout>[] = [];
			child.once("close", () => {
				for (const timer of timers) clearTimeout(timer);
				// Children of the server that ignored stdin closing would otherwise outlive it.
				kill("SIGTERM");
				if (kills.size === 0) {
					resolve();
					return;
				}
				// A kill command still finishing ends the rest of the server's processes: wait for it, as long as the
				// server itself was given after SIGTERM, and no longer.
				const bound = setTimeout(resolve, closeTimeoutMs);
				void Promise.all(kills).then(() => {
					clearTimeout(bound);
					resolve();
				});
			});
			const grace = Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);
			timers.push(setTimeout(() => kill("SIGTERM"), grace));
			timers.push(setTimeout(() => kill("SIGKILL"), grace + closeTimeoutMs));
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
