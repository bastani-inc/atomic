/**
 * A prewarmed interactive engine child: started at the beginning of an interactive host's startup, it loads the
 * application while the host loads its own, then waits on stdin for the arguments of the engine the host decides to
 * run. The host adopts it only when it would have started exactly that process, executable, runtime arguments, working
 * directory, environment and process group all the same, so an adopted child runs the same engine a fresh one would.
 * In every other case the host discards it and starts a fresh child, as it always did.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { ENV_AGENT_DIR, ENV_STARTUP_BENCHMARK, ENV_TIMING, getAgentDir, getEnvValue, VERSION } from "../../config.js";
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
 * Follows {@link INTERACTIVE_ENGINE_PREWARM_FLAG}, after `=`, with a per-spawn nonce that opts a same-build prewarmed
 * child into writing one `prewarm_ready` JSON line (its build identity, nonce, and env-handoff capability) to stdout
 * before waiting on stdin. An earlier host never passes this flag, so a newer child leaves its stdout untouched; an
 * earlier child ignores this flag and writes nothing, so a newer host never adopts it.
 */
export const INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG = `${INTERACTIVE_ENGINE_PREWARM_FLAG}-handoff`;

/**
 * The longest encoding of a host's arguments a prewarmed child is given, well within every platform's command line.
 * A host with longer arguments, such as a long first message, gives none: its child loads nothing before it is adopted.
 */
export const PREWARM_HOST_ARGUMENTS_MAX_LENGTH = 8192;

const PREWARM_READY_MAX_BYTES = 4096;
/**
 * Replaced at package build time (`scripts/split-dist.mjs`) with a deterministic 30-hex-char SHA-256 digest of the
 * bundled `dist` chunks, keeping exact length so source-map columns do not shift. Compared against a runtime-joined
 * copy so the build replacement touches only this stamp.
 */
const PREWARM_BUILD_STAMP = "__ATOMIC_PREWARM_BUILD_STAMP__";
const PREWARM_BUILD_STAMP_UNSTAMPED = ["__ATOMIC_PREWARM", "BUILD_STAMP__"].join("_");

/**
 * Identifies this running Atomic build when stamped at build time (`scripts/split-dist.mjs`), straight from loaded
 * module memory (zero I/O, immune to on-disk replacement after launch). Returns `undefined` in unstamped builds (such
 * as a direct source checkout), where prewarm adoption keeps only exact-launch matching and never adopts across an
 * environment edit.
 */
function prewarmBuildIdentity(): string | undefined {
	if (PREWARM_BUILD_STAMP === PREWARM_BUILD_STAMP_UNSTAMPED) return undefined;
	return `v1:${VERSION}:${PREWARM_BUILD_STAMP}:${import.meta.url}`;
}

/** The per-spawn handoff nonce a prewarmed child was started with, if its host opted into verified handoff. */
export function prewarmHandoffNonce(argv: readonly string[]): string | undefined {
	const prefix = `${INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG}=`;
	const flag = argv.find((arg) => arg.startsWith(prefix));
	if (flag === undefined) return undefined;
	const nonce = flag.slice(prefix.length);
	return nonce.length > 0 ? nonce : undefined;
}

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

type PrewarmHandoffState =
	| { readonly status: "pending" }
	| { readonly status: "invalid" }
	| { readonly status: "ready"; readonly build: string; readonly envHandoff: boolean };

interface PrewarmHandoffMonitor {
	readonly drain: () => PrewarmHandoffState;
	readonly waitUntilSettled: (timeoutMs: number) => Promise<PrewarmHandoffState>;
	readonly cleanup: () => void;
}

function attachPrewarmReadyReader(
	child: ChildProcess,
	stdout: Readable | null,
	expectedNonce: string,
): PrewarmHandoffMonitor {
	let state: PrewarmHandoffState = { status: "pending" };
	const waiters = new Set<() => void>();
	const notifySettled = (): void => {
		for (const wake of waiters) wake();
		waiters.clear();
	};
	if (!stdout) {
		state = { status: "invalid" };
		return { drain: () => state, waitUntilSettled: async () => state, cleanup: () => {} };
	}
	let buffered = Buffer.alloc(0);
	let detached = false;

	const detach = (): void => {
		if (detached) return;
		detached = true;
		stdout.off("readable", onReadable);
		stdout.off("end", onEnd);
		stdout.off("error", onError);
		child.off("exit", onExit);
	};

	const cleanup = (): void => {
		detach();
		notifySettled();
	};

	const finishLine = (lineBuffer: Buffer): void => {
		const withoutCr = lineBuffer.at(-1) === 0x0d ? lineBuffer.subarray(0, -1) : lineBuffer;
		try {
			const parsed: unknown = JSON.parse(withoutCr.toString("utf8"));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed) &&
				(parsed as { type?: unknown }).type === "prewarm_ready" &&
				(parsed as { nonce?: unknown }).nonce === expectedNonce &&
				(parsed as { envHandoff?: unknown }).envHandoff === true &&
				typeof (parsed as { build?: unknown }).build === "string" &&
				(parsed as { build: string }).build.length > 0
			) {
				state = {
					status: "ready",
					build: (parsed as { build: string }).build,
					envHandoff: true,
				};
				return;
			}
		} catch {
			// Invalid JSON or non-ready stdout line.
		}
		state = { status: "invalid" };
	};

	const readAvailable = (): PrewarmHandoffState => {
		if (detached || state.status !== "pending") return state;
		for (let chunk = stdout.read() as Buffer | string | null; chunk !== null; chunk = stdout.read()) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			buffered = Buffer.concat([buffered, bytes]);
			const newline = buffered.indexOf(0x0a);
			if (newline >= 0) {
				detach();
				if (newline + 1 < buffered.length) stdout.unshift(buffered.subarray(newline + 1));
				finishLine(buffered.subarray(0, newline));
				buffered = Buffer.alloc(0);
				notifySettled();
				return state;
			}
			if (buffered.length > PREWARM_READY_MAX_BYTES) {
				detach();
				buffered = Buffer.alloc(0);
				state = { status: "invalid" };
				notifySettled();
				return state;
			}
		}
		return state;
	};

	const onReadable = (): void => {
		readAvailable();
	};
	const onEnd = (): void => {
		if (state.status === "pending") state = { status: "invalid" };
		cleanup();
	};
	const onError = (): void => {
		if (state.status === "pending") state = { status: "invalid" };
		cleanup();
	};
	const onExit = (): void => {
		if (state.status === "pending") state = { status: "invalid" };
		cleanup();
	};

	const waitUntilSettled = (timeoutMs: number): Promise<PrewarmHandoffState> => {
		const current = readAvailable();
		if (current.status !== "pending" || timeoutMs <= 0) return Promise.resolve(current);
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				waiters.delete(finish);
				resolve(state);
			};
			const timer = setTimeout(finish, timeoutMs);
			timer.unref?.();
			waiters.add(finish);
		});
	};

	// Pull-mode reads: once the ready line is consumed and these listeners detach, stdout stays clean for RpcClient.
	stdout.on("readable", onReadable);
	stdout.on("end", onEnd);
	stdout.on("error", onError);
	child.once("exit", onExit);
	return { drain: readAvailable, waitUntilSettled, cleanup };
}

interface Prewarm {
	readonly launch: EngineLaunch;
	readonly child: ChildProcess;
	readonly basis: PrewarmLaunchBasis;
	readonly handoff?: PrewarmHandoffMonitor;
	buildIdentity?: string;
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
	/** Expected build identity for the prewarmed child, unless derived from this running build. */
	readonly buildIdentity?: string;
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
	prewarmInteractiveEngine(args, {
		launch,
		basis: sameEngineLaunch(unchanged, launch) ? "unchanged" : "derived",
	});
}

/** Start the engine child this interactive host will most likely run, before the host has loaded its own code. */
export function prewarmInteractiveEngine(args: readonly string[], options: PrewarmOptions = {}): void {
	if (prewarmState[PREWARM_KEY] || !shouldPrewarmInteractiveEngine(args, options.host)) return;
	let launch: EngineLaunch;
	let child: ChildProcess;
	const buildIdentity = options.buildIdentity ?? prewarmBuildIdentity();
	const nonce = buildIdentity !== undefined ? randomBytes(12).toString("hex") : undefined;
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
			...(nonce !== undefined ? [`${INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG}=${nonce}`] : []),
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
	child.stdout?.on("error", () => {});
	const handoff = nonce !== undefined ? attachPrewarmReadyReader(child, child.stdout, nonce) : undefined;
	setReferenced(child, false);
	prewarmState[PREWARM_KEY] = {
		launch,
		child,
		basis: options.basis ?? "unchanged",
		handoff,
		buildIdentity,
	};
	process.once("exit", discardPrewarmedEngine);
}

/** Stop the prewarmed child, if any: this host starts no engine, or a different one. */
export function discardPrewarmedEngine(): void {
	const prewarm = prewarmState[PREWARM_KEY];
	if (!prewarm) return;
	prewarmState[PREWARM_KEY] = undefined;
	process.off("exit", discardPrewarmedEngine);
	prewarm.handoff?.cleanup();
	try {
		prewarm.child.stdin?.end();
		prewarm.child.kill();
	} catch {
		// Already gone.
	}
}

/**
 * Settings-derived environment variables that `main()` can update from global `settings.json` between the early prewarm
 * read and engine adoption. When only these keys differ, the host adopts the prewarmed child and sends their final
 * values (`string` to set, `null` to unset) in the stdin handshake instead of discarding the child and starting a second
 * engine. Written as literals here so this module imports no new names from startup modules cached across updates.
 */
const PREWARM_HANDOFF_ENV_KEYS: ReadonlySet<string> = new Set(["ATOMIC_DEBUG_SETTING", "HTTP_PROXY", "HTTPS_PROXY"]);

function prewarmHandoffEnvDelta(
	prewarmed: EngineLaunch,
	settled: EngineLaunch,
): Record<string, string | null> | undefined {
	if (
		prewarmed.command !== settled.command ||
		prewarmed.cwd !== settled.cwd ||
		prewarmed.detached !== settled.detached
	) {
		return undefined;
	}
	if (
		prewarmed.args.length !== settled.args.length ||
		prewarmed.args.some((arg, index) => arg !== settled.args[index])
	) {
		return undefined;
	}
	const delta: Record<string, string | null> = {};
	for (const key of Object.keys(prewarmed.env)) {
		if (Object.hasOwn(settled.env, key)) {
			if (prewarmed.env[key] === settled.env[key]) continue;
			if (!PREWARM_HANDOFF_ENV_KEYS.has(key)) return undefined;
			delta[key] = settled.env[key]!;
		} else {
			if (!PREWARM_HANDOFF_ENV_KEYS.has(key)) return undefined;
			delta[key] = null;
		}
	}
	for (const key of Object.keys(settled.env)) {
		if (Object.hasOwn(prewarmed.env, key)) continue;
		if (!PREWARM_HANDOFF_ENV_KEYS.has(key)) return undefined;
		delta[key] = settled.env[key]!;
	}
	return delta;
}

function applyPrewarmedEngineEnv(env: Readonly<Record<string, string | null>> | undefined): void {
	if (!env || typeof env !== "object") return;
	for (const [key, value] of Object.entries(env)) {
		if (!PREWARM_HANDOFF_ENV_KEYS.has(key)) continue;
		if (value === null) delete process.env[key];
		else if (typeof value === "string") process.env[key] = value;
	}
}

/**
 * Wait briefly for an already-spawned prewarmed child to finish emitting its `prewarm_ready` announcement before
 * `adoptPrewarmedEngine()` runs. Returns immediately with no timer when no prewarm is active or when the child has
 * already announced (the normal case); bounded so an older release that never announces is discarded without stalling.
 */
export async function waitForPrewarmedEngineReady(timeoutMs = 200): Promise<void> {
	const prewarm = prewarmState[PREWARM_KEY];
	if (!prewarm?.handoff) return;
	const { child } = prewarm;
	const alive = child.pid !== undefined && child.exitCode === null && child.signalCode === null && !child.killed;
	if (!alive) return;
	await prewarm.handoff.waitUntilSettled(timeoutMs);
}

/**
 * The prewarmed child started as `launch` would start (or, in a build-stamped install whose child advertised a matching
 * build identity and env-handoff capability, differing only in settings-derived environment keys which travel in the
 * stdin handshake), now running with `engineArgs`; or undefined, after discarding any prewarmed child, when there is
 * none or it would differ from a fresh one. In unstamped builds (such as a direct source checkout), keeps exact-launch
 * matching only and never adopts across an environment edit. `onBasis` learns the adopted child's
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
	if (prewarm.buildIdentity === undefined) {
		// Unstamped build (or a prewarm created by an earlier release without verified handoff): exact-launch matching
		// only; never adopt across an environment edit.
		if (!alive || !sameEngineLaunch(prewarm.launch, launch)) {
			discardPrewarmedEngine();
			return undefined;
		}
		prewarmState[PREWARM_KEY] = undefined;
		process.off("exit", discardPrewarmedEngine);
		prewarm.handoff?.cleanup();
		setReferenced(child, true);
		child.stdin?.write(`${JSON.stringify({ args: engineArgs })}\n`);
		onBasis?.(prewarm.basis);
		return child;
	}
	const ready = alive ? prewarm.handoff?.drain() : undefined;
	const sameBuild = ready?.status === "ready" && ready.envHandoff && ready.build === prewarm.buildIdentity;
	const envDelta = sameBuild ? prewarmHandoffEnvDelta(prewarm.launch, launch) : undefined;
	if (!alive || !sameBuild || envDelta === undefined) {
		discardPrewarmedEngine();
		return undefined;
	}
	prewarmState[PREWARM_KEY] = undefined;
	process.off("exit", discardPrewarmedEngine);
	prewarm.handoff?.cleanup();
	setReferenced(child, true);
	const hasEnvDelta = Object.keys(envDelta).length > 0;
	const handshake = hasEnvDelta ? { args: engineArgs, env: envDelta } : { args: engineArgs };
	child.stdin?.write(`${JSON.stringify(handshake)}\n`);
	onBasis?.(prewarm.basis === "derived" || hasEnvDelta ? "derived" : "unchanged");
	return child;
}

/**
 * In a prewarmed child: if this build is stamped (or an explicit `buildIdentity` is supplied) and the host opted into
 * verified handoff via {@link INTERACTIVE_ENGINE_PREWARM_HANDOFF_FLAG}, advertises this build's identity and
 * env-handoff capability as one JSON line on stdout before reading the engine arguments (plus any settings-derived
 * environment updates) from the first stdin line. Everything after that line stays on stdin for the engine. Exits
 * quietly when the host closes stdin without adopting this child.
 */
export function readPrewarmedEngineArgs(options?: { readonly buildIdentity?: string }): Promise<string[]> {
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
				const { args, env } = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as {
					args: string[];
					env?: Record<string, string | null>;
				};
				applyPrewarmedEngineEnv(env);
				process.argv.splice(2, process.argv.length - 2, ...args);
				resolve(args);
				return;
			}
		};
		const nonce = prewarmHandoffNonce(process.argv.slice(2));
		const build = options?.buildIdentity ?? prewarmBuildIdentity();
		if (nonce !== undefined && build !== undefined) {
			try {
				process.stdout.write(`${JSON.stringify({ type: "prewarm_ready", nonce, build, envHandoff: true })}\n`);
			} catch {
				// Host closed the pipe before adoption.
			}
		}
		stdin.on("readable", onReadable);
		stdin.on("end", onEnd);
	});
}
