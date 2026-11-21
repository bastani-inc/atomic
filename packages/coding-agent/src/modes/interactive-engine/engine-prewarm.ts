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
import { COMPILE_CACHE_ENGINE_WARMUP_ENV, compileCacheDeferral } from "../../utils/compile-cache.ts";
import { INTERACTIVE_ENGINE_PREWARM_FLAG } from "../../utils/interactive-engine-bootstrap.ts";
import { scrubInteractiveEngineEnv } from "../../utils/interactive-engine-env.ts";
import { isPlainInteractiveSessionInvocation } from "../../utils/interactive-invocation.ts";
import { applyArgumentEnvironment, settingsEnvironmentForEarlyChild } from "../../utils/startup-environment.js";
import { engineHeapRuntimeArgsForHost } from "./engine-heap.ts";

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
export function interactiveEngineEnvOverrides(): Record<string, string> {
	const explicitAgentDir = getEnvValue(ENV_AGENT_DIR);
	return {
		...(explicitAgentDir !== undefined ? { [ENV_AGENT_DIR]: explicitAgentDir } : {}),
		...startupBenchmarkEngineEnv(),
		// This host warms the engine's cold compile cache too, so the engine leaves it alone like the host.
		...(compileCacheDeferral() ? { [COMPILE_CACHE_ENGINE_WARMUP_ENV]: "1" } : {}),
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
	return {
		runtimeExecutable: process.execPath,
		runtimeArgs: engineHeapRuntimeArgsForHost(["node", "node.exe"].includes(executableName)),
		cliPath: cliPath ?? "",
		cwd,
		env: interactiveEngineEnvOverrides(),
	};
}

interface Prewarm {
	readonly launch: EngineLaunch;
	readonly child: ChildProcess;
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
	await applyArgumentEnvironment(args);
	const settingsEnv = await settingsEnvironmentForEarlyChild(getAgentDir());
	const launch = engineLaunch({ ...interactiveEngineClientOptions(process.cwd()), interactiveEngine: true });
	prewarmInteractiveEngine(args, { launch: { ...launch, env: { ...launch.env, ...settingsEnv } } });
}

/** Start the engine child this interactive host will most likely run, before the host has loaded its own code. */
export function prewarmInteractiveEngine(args: readonly string[], options: PrewarmOptions = {}): void {
	if (prewarmState[PREWARM_KEY] || !shouldPrewarmInteractiveEngine(args, options.host)) return;
	let launch: EngineLaunch;
	let child: ChildProcess;
	try {
		launch =
			options.launch ?? engineLaunch({ ...interactiveEngineClientOptions(process.cwd()), interactiveEngine: true });
		child = spawn(launch.command, [...launch.args, INTERACTIVE_ENGINE_PREWARM_FLAG], {
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
	prewarmState[PREWARM_KEY] = { launch, child };
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
 * any prewarmed child, when there is none or it would differ from a fresh one.
 */
export function adoptPrewarmedEngine(launch: EngineLaunch, engineArgs: readonly string[]): ChildProcess | undefined {
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
