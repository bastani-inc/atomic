/**
 * A prewarmed interactive engine child: started at the beginning of an interactive host's startup, it loads the
 * application while the host loads its own, then waits on stdin for the arguments of the engine the host decides to
 * run. The host adopts it only when it would have started exactly that process, executable, runtime arguments, working
 * directory, environment and process group all the same, so an adopted child runs the same engine a fresh one would.
 * In every other case the host discards it and starts a fresh child, as it always did.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { ENV_AGENT_DIR, ENV_STARTUP_BENCHMARK, ENV_TIMING, getAgentDir, getEnvValue } from "../../config.js";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { engineCompileCacheMatchHostEnv, engineCompileCacheWarmupEnv } from "../../utils/compile-cache-deferral.ts";
import { INTERACTIVE_ENGINE_PREWARM_FLAG } from "../../utils/interactive-engine-bootstrap.ts";
import { scrubInteractiveEngineEnv } from "../../utils/interactive-engine-env.ts";
import { isPlainInteractiveSessionInvocation } from "../../utils/interactive-invocation.ts";
import { applyArgumentEnvironment, settingsEnvironmentForEarlyChild } from "../../utils/startup-environment.js";
import { engineHeapRuntimeArgsForHost } from "./engine-heap.ts";

/**
 * `INTERACTIVE_ENGINE_PREWARM_NO_DATABASE` of `interactive-engine-bootstrap.ts`, made here from the one flag every
 * version of that module exports: a process that loaded an earlier version of it, before an update replaced the
 * installation, loads this module from the new one, and a name that earlier version lacks would fail to link.
 */
const PREWARM_NO_DATABASE = `${INTERACTIVE_ENGINE_PREWARM_FLAG}-no-database`;

/** Everything that decides how an engine child process starts, apart from its engine arguments. */
export interface EngineLaunch {
	readonly command: string;
	/** Runtime arguments and the entry script; the engine arguments follow them. */
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly detached: boolean;
}

/** How an RPC client starts its child: the inputs `spawnRpcClientProcess` passes to `spawn`. */
export interface EngineLaunchOptions {
	readonly runtimeExecutable?: string;
	readonly runtimeArgs?: readonly string[];
	readonly cliPath?: string;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly interactiveEngine: boolean;
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The process an RPC client with these options starts now. */
export function engineLaunch(options: EngineLaunchOptions): EngineLaunch {
	return {
		command: options.runtimeExecutable ?? "bun",
		args: [...(options.runtimeArgs ?? []), ...(options.cliPath ? [options.cliPath] : [])],
		cwd: options.cwd ?? process.cwd(),
		env: definedEnvironment(scrubInteractiveEngineEnv(createChildProcessEnvironment(options.env))),
		detached: options.interactiveEngine && process.platform !== "win32",
	};
}

export function sameEngineLaunch(left: EngineLaunch, right: EngineLaunch): boolean {
	if (left.command !== right.command || left.cwd !== right.cwd || left.detached !== right.detached) return false;
	if (left.args.length !== right.args.length || left.args.some((arg, index) => arg !== right.args[index])) {
		return false;
	}
	const leftKeys = Object.keys(left.env);
	if (leftKeys.length !== Object.keys(right.env).length) return false;
	return leftKeys.every((key) => Object.hasOwn(right.env, key) && left.env[key] === right.env[key]);
}

/**
 * Environment overrides for the isolated engine of a host that runs the startup benchmark. The host prints the
 * session's timings once; the engine inherits the timing switch, so without this its own block would reach the
 * terminal through its relayed stderr as a second one (#4354).
 */
export function startupBenchmarkEngineEnv(
	value: string | undefined = getEnvValue(ENV_STARTUP_BENCHMARK),
): Record<string, string> {
	const on = !!value && (value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes");
	return on ? { [ENV_TIMING]: "0" } : {};
}

/** Environment the interactive host adds for its engine child. */
export function interactiveEngineEnvOverrides(engineRuntimeArgs: readonly string[] = []): Record<string, string> {
	const explicitAgentDir = getEnvValue(ENV_AGENT_DIR);
	return {
		...(explicitAgentDir !== undefined ? { [ENV_AGENT_DIR]: explicitAgentDir } : {}),
		...startupBenchmarkEngineEnv(),
		// This host warms the engine's cold compile cache too, so the engine leaves it alone like the host.
		...engineCompileCacheWarmupEnv(),
		// When this host auto-sized the engine's heap, align the engine's Node 22 compile-cache tag with the host's.
		...engineCompileCacheMatchHostEnv(engineRuntimeArgs),
	};
}

/** The RPC client options of this host's interactive engine child in `cwd`. */
export function interactiveEngineClientOptions(cwd: string): {
	runtimeExecutable: string;
	runtimeArgs: string[];
	cliPath: string;
	cwd: string;
	env: Record<string, string>;
} {
	const executableName = basename(process.execPath).toLowerCase();
	const launchedByRuntime = ["bun", "bun.exe", "node", "node.exe"].includes(executableName);
	const cliPath = launchedByRuntime ? process.argv[1] : "";
	if (launchedByRuntime && !cliPath)
		throw new Error("Cannot start isolated interactive engine: Atomic entrypoint is unavailable");
	const runtimeArgs = engineHeapRuntimeArgsForHost(["node", "node.exe"].includes(executableName));
	return {
		runtimeExecutable: process.execPath,
		runtimeArgs,
		cliPath: cliPath ?? "",
		cwd,
		env: interactiveEngineEnvOverrides(runtimeArgs),
	};
}

/**
 * Follows {@link INTERACTIVE_ENGINE_PREWARM_FLAG} for a prewarmed child whose host would otherwise have started a fresh
 * engine from its own written compile cache: the child writes its compile cache once it has loaded, if its host has
 * not taken it over by then, so that its exit has little left to write. Defined here, from the one flag every version
 * exports, and read by `cli.ts` from this module's namespace, so that a process holding an earlier version of either
 * module, loaded before an update replaced the installation, never fails to link; an earlier version ignores it.
 */
export const INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG = `${INTERACTIVE_ENGINE_PREWARM_FLAG}-write-cache`;

/**
 * Follows {@link INTERACTIVE_ENGINE_PREWARM_FLAG}, after `=`, with the host's arguments (JSON, base64url): while it
 * waits, the child reads them as the command line does and loads the API implementation of the model the settings
 * select, when the arguments leave the model to the settings. Read by `cli.ts` through {@link prewarmHostArguments} from
 * this module's namespace, as {@link INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG} is; an earlier version ignores it.
 */
export const INTERACTIVE_ENGINE_PREWARM_DEFAULT_MODEL_API_FLAG = `${INTERACTIVE_ENGINE_PREWARM_FLAG}-default-model-api`;

/**
 * The longest encoding of a host's arguments a prewarmed child is given, well within every platform's command line.
 * A host with longer arguments, such as a long first message, gives none: its child loads nothing before it is adopted.
 */
export const PREWARM_HOST_ARGUMENTS_MAX_LENGTH = 8192;

function hostArgumentsFlag(args: readonly string[]): string | undefined {
	const encoded = Buffer.from(JSON.stringify(args), "utf8").toString("base64url");
	return encoded.length > PREWARM_HOST_ARGUMENTS_MAX_LENGTH
		? undefined
		: `${INTERACTIVE_ENGINE_PREWARM_DEFAULT_MODEL_API_FLAG}=${encoded}`;
}

/** The host's arguments a prewarmed child was started with, if its host gave it them. */
export function prewarmHostArguments(argv: readonly string[]): string[] | undefined {
	const prefix = `${INTERACTIVE_ENGINE_PREWARM_DEFAULT_MODEL_API_FLAG}=`;
	const flag = argv.find((arg) => arg.startsWith(prefix));
	if (flag === undefined) return undefined;
	try {
		const args: unknown = JSON.parse(Buffer.from(flag.slice(prefix.length), "base64url").toString("utf8"));
		return Array.isArray(args) && args.every((arg) => typeof arg === "string") ? args : undefined;
	} catch {
		return undefined;
	}
}

/**
 * How a prewarmed engine's launch compares with the one a host prewarmed before it gave the prewarm the environment
 * `main()` derives from the arguments and the global settings: `"unchanged"` when that environment added nothing, so
 * such a host would have run the prewarmed engine too, and `"derived"` when it added something, so such a host would
 * have discarded it and started a second engine.
 */
export type PrewarmLaunchBasis = "unchanged" | "derived";

interface Prewarm {
	readonly launch: EngineLaunch;
	readonly child: ChildProcess;
	readonly basis: PrewarmLaunchBasis;
}

const PREWARM_KEY = Symbol.for("@bastani/atomic/engine-prewarm");
const prewarmState = globalThis as typeof globalThis & { [PREWARM_KEY]?: Prewarm };

/** What decides whether a host prewarms: its terminals and how many CPUs it can load both processes on. */
export interface PrewarmHost {
	readonly stdinIsTTY: boolean;
	readonly stdoutIsTTY: boolean;
	readonly cpus: number;
}

/** This process as a host, and the engine child it would start, unless given. */
export interface PrewarmOptions {
	readonly host?: PrewarmHost;
	readonly launch?: EngineLaunch;
	/** `"unchanged"` unless given. */
	readonly basis?: PrewarmLaunchBasis;
}

/**
 * Whether this process is an interactive host about to start an engine child: a terminal on both ends, at least two
 * CPUs to load both at once, and arguments that are only options (a subcommand or a prompt argument is never
 * prewarmed). A prewarm the host ends up not using is discarded.
 */
export function shouldPrewarmInteractiveEngine(
	args: readonly string[],
	host: PrewarmHost = {
		stdinIsTTY: process.stdin.isTTY === true,
		stdoutIsTTY: process.stdout.isTTY === true,
		cpus: availableParallelism(),
	},
): boolean {
	return host.cpus >= 2 && isPlainInteractiveSessionInvocation(args, host);
}

function setReferenced(child: ChildProcess, referenced: boolean): void {
	for (const handle of [child, child.stdin, child.stdout, child.stderr] as const) {
		const target = handle as { ref?: () => void; unref?: () => void } | null;
		if (referenced) target?.ref?.();
		else target?.unref?.();
	}
}

/**
 * Start the engine child this interactive host will most likely run, before the host has loaded its own code. It
 * starts with the environment a fresh engine would get: what `main()` derives from `args` is set first, and what the
 * global settings will add is given to this child alone, so the host can adopt it.
 */
export async function prewarmInteractiveEngineForArgs(args: readonly string[]): Promise<void> {
	if (prewarmState[PREWARM_KEY] || !shouldPrewarmInteractiveEngine(args)) return;
	const unchanged = engineLaunch({ ...interactiveEngineClientOptions(process.cwd()), interactiveEngine: true });
	await applyArgumentEnvironment(args);
	const settingsEnv = await settingsEnvironmentForEarlyChild(getAgentDir());
	const derived = engineLaunch({ ...interactiveEngineClientOptions(process.cwd()), interactiveEngine: true });
	const launch = { ...derived, env: { ...derived.env, ...settingsEnv } };
	prewarmInteractiveEngine(args, { launch, basis: sameEngineLaunch(unchanged, launch) ? "unchanged" : "derived" });
}

/** Start the engine child this interactive host will most likely run, before the host has loaded its own code. */
export function prewarmInteractiveEngine(args: readonly string[], options: PrewarmOptions = {}): void {
	if (prewarmState[PREWARM_KEY] || !shouldPrewarmInteractiveEngine(args, options.host)) return;
	let launch: EngineLaunch;
	let child: ChildProcess;
	try {
		launch =
			options.launch ?? engineLaunch({ ...interactiveEngineClientOptions(process.cwd()), interactiveEngine: true });
		// Off Windows a host waits for its engine's exit as it quits, the exit-time write of a cold compile cache included;
		// a fresh engine would have started from the host's written cache instead (a Windows host limits how long it waits
		// for its engine's exit work).
		// The write-cache flag follows the no-database marker, which the engine reads as its second argument.
		const writeCache = options.basis === "derived" && process.platform !== "win32";
		const hostArguments = hostArgumentsFlag(args);
		const prewarmArgs = [
			INTERACTIVE_ENGINE_PREWARM_FLAG,
			...(args.includes("--no-session") ? [PREWARM_NO_DATABASE] : []),
			...(writeCache ? [INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG] : []),
			...(hostArguments ? [hostArguments] : []),
		];
		child = spawn(launch.command, [...launch.args, ...prewarmArgs], {
			cwd: launch.cwd,
			env: launch.env,
			detached: launch.detached,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		return;
	}
	// Until it is adopted the child must neither keep this process alive nor fail it.
	child.on("error", () => {});
	child.stdin?.on("error", () => {});
	setReferenced(child, false);
	prewarmState[PREWARM_KEY] = { launch, child, basis: options.basis ?? "unchanged" };
	process.once("exit", discardPrewarmedEngine);
}

/** Stop the prewarmed child, if any: this host starts no engine, or a different one. */
export function discardPrewarmedEngine(): void {
	const prewarm = prewarmState[PREWARM_KEY];
	if (!prewarm) return;
	prewarmState[PREWARM_KEY] = undefined;
	process.off("exit", discardPrewarmedEngine);
	try {
		prewarm.child.stdin?.end();
		prewarm.child.kill();
	} catch {
		// Already gone.
	}
}

/**
 * The prewarmed child started as `launch` would start, now running with `engineArgs`; or undefined, after discarding
 * any prewarmed child, when there is none or it would differ from a fresh one. `onBasis` learns the adopted child's
 * {@link PrewarmLaunchBasis}. A callback, rather than another return value or export, so that a host whose module of an
 * earlier version is still loaded beside a later one keeps working either way: an earlier version ignores it.
 */
export function adoptPrewarmedEngine(
	launch: EngineLaunch,
	engineArgs: readonly string[],
	onBasis?: (basis: PrewarmLaunchBasis) => void,
): ChildProcess | undefined {
	const prewarm = prewarmState[PREWARM_KEY];
	if (!prewarm) return undefined;
	const { child } = prewarm;
	const alive = child.pid !== undefined && child.exitCode === null && child.signalCode === null && !child.killed;
	if (!alive || !sameEngineLaunch(prewarm.launch, launch)) {
		discardPrewarmedEngine();
		return undefined;
	}
	prewarmState[PREWARM_KEY] = undefined;
	process.off("exit", discardPrewarmedEngine);
	setReferenced(child, true);
	child.stdin?.write(`${JSON.stringify({ args: engineArgs })}\n`);
	onBasis?.(prewarm.basis ?? "unchanged");
	return child;
}

/**
 * In a prewarmed child: the engine arguments its host sends as the first stdin line. Everything after that line stays
 * on stdin for the engine. Exits quietly when the host closes stdin without adopting this child.
 */
export function readPrewarmedEngineArgs(): Promise<string[]> {
	return new Promise((resolve) => {
		let buffered = Buffer.alloc(0);
		const stdin = process.stdin;
		const onEnd = () => process.exit(0);
		// Pull-mode reads: once the 'readable' listener is gone the stream is neither flowing nor paused, so the engine's
		// own reader starts it as it would a stream nobody read.
		const onReadable = () => {
			for (let chunk = stdin.read() as Buffer | string | null; chunk !== null; chunk = stdin.read()) {
				buffered = Buffer.concat([buffered, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
				const newline = buffered.indexOf(0x0a);
				if (newline < 0) continue;
				stdin.off("readable", onReadable);
				stdin.off("end", onEnd);
				if (newline + 1 < buffered.length) stdin.unshift(buffered.subarray(newline + 1));
				const { args } = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as { args: string[] };
				process.argv.splice(2, process.argv.length - 2, ...args);
				resolve(args);
				return;
			}
		};
		stdin.on("readable", onReadable);
		stdin.on("end", onEnd);
	});
}
