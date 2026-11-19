#!/usr/bin/env bun
/**
 * Cross-platform startup benchmark: how long `atomic` takes to become usable in each mode, on Linux and Windows, for
 * an npm install running under Node and for the compiled binary. See README.md.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LoopbackProviderCollector, type ProviderRequestRecord } from "../windows-startup/collector.js";
import { benchmarkEnvironment, createAgentTemplate } from "../windows-startup/fixtures.js";
import { type ScreenSnapshot, StartupScreenTracker } from "../windows-startup/screen.js";
import { type PtyProcess, startPty } from "./pty.js";
import {
	formatSummaryTable,
	formatTraceTable,
	type StartupSample,
	summarizeStartupSamples,
	toolSetDisagreements,
} from "./summary.js";

export const STARTUP_MODES = ["interactive", "typeahead", "version", "print", "rpc"] as const;
export type StartupMode = (typeof STARTUP_MODES)[number];
export const STARTUP_PROFILES = ["warm", "cold"] as const;
export type StartupProfile = (typeof STARTUP_PROFILES)[number];

export interface Target {
	readonly name: string;
	readonly binDirectory: string;
}

export interface Options {
	readonly output: string;
	readonly state: string;
	readonly cwd: string;
	readonly version: string;
	readonly targets: readonly Target[];
	readonly modes: readonly StartupMode[];
	readonly profiles: readonly StartupProfile[];
	readonly repeats: number;
	readonly port: number;
	readonly timeoutMs: number;
	readonly dropCaches: boolean;
	/** Arguments every start also gets, such as `--extension <path>`. */
	readonly extraArgs?: readonly string[];
	/** Environment every start also gets. */
	readonly extraEnv?: Readonly<Record<string, string>>;
}

const COLS = 120;
const ROWS = 40;
const PROVIDER = ["--provider", "benchmark-loopback", "--model", "benchmark-model"] as const;

/** Variables of the calling Atomic or pi session that must not reach the measured process. */
function leakedSessionVariables(): string[] {
	return Object.keys(process.env).filter((name) => /^(?:ATOMIC|PI)_/i.test(name));
}

function cleanBaseEnvironment(): NodeJS.ProcessEnv {
	const leaked = new Set(leakedSessionVariables());
	return Object.fromEntries(Object.entries(process.env).filter(([name]) => !leaked.has(name)));
}

function environmentFor(target: Target, agentDir: string, cacheDir: string, home: string): Record<string, string> {
	return {
		...benchmarkEnvironment(agentDir, target.binDirectory, cleanBaseEnvironment()),
		// Skills and settings in the operator's own home must not reach the measured process.
		HOME: home,
		USERPROFILE: home,
		// The persistent caches a cold start lacks: Node's on-disk module compile cache and Bun's transpiler cache.
		NODE_COMPILE_CACHE: join(cacheDir, "node-compile-cache"),
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(cacheDir, "bun-transpiler-cache"),
	};
}

/** The command line a shell runs: `atomic` resolves through the target's bin directory, first on PATH. */
function commandLine(args: readonly string[]): string {
	for (const arg of args) {
		if (/["\s%^&|<>]/.test(arg)) throw new Error(`benchmark argument needs quoting: ${arg}`);
	}
	return ["atomic", ...args].join(" ");
}

/**
 * A PTY command must also drop session variables the native PTY inherits from this process, except those the sample
 * sets itself.
 */
function ptyCommandLine(args: readonly string[], env: Readonly<Record<string, string>>): string {
	const leaked = leakedSessionVariables().filter((name) => !Object.hasOwn(env, name));
	if (process.platform === "win32") {
		if (leaked.length > 0) throw new Error(`run the benchmark without these variables: ${leaked.join(", ")}`);
		return commandLine(args);
	}
	return `exec env ${leaked.map((name) => `-u ${name} `).join("")}${commandLine(args)}`;
}

function elapsedMs(from: bigint, to: bigint): number {
	return Number(to - from) / 1e6;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
		}),
	]);
}

/**
 * Tools every start must send with its first request: Atomic's own and those of each bundled extension. A start that
 * dispatched before its extensions loaded would miss some. The full set is recorded per sample and compared across
 * targets by the summary.
 */
export const REQUIRED_STARTUP_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"subagent",
	"intercom",
	"web_search",
	"fetch_content",
] as const;

function validRequest(request: ProviderRequestRecord): readonly string[] {
	if (!request.nonceFound) throw new Error("provider request is missing the typed prompt");
	const missing = REQUIRED_STARTUP_TOOLS.filter((tool) => !request.toolNames.includes(tool));
	if (missing.length > 0) {
		throw new Error(`provider request lacks ${missing.join(", ")}; it sent ${request.toolNames.join(", ")}`);
	}
	return request.toolNames;
}

/** The last user message a provider request carried, to tell a duplicate from a different request. */
function describeRequest(request: ProviderRequestRecord): string {
	try {
		const body = JSON.parse(request.body) as { messages?: { role?: string; content?: unknown }[] };
		const user = body.messages?.filter((message) => message.role === "user").at(-1);
		const content = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? null);
		return `${body.messages?.length ?? 0} messages, last user: ${content.slice(0, 160)}`;
	} catch {
		return `unparsed body of ${request.body.length} bytes`;
	}
}

function dropPageCache(): boolean {
	if (process.platform !== "linux") return false;
	const result = spawnSync("sudo", ["-n", "sh", "-c", "sync && echo 3 > /proc/sys/vm/drop_caches"], {
		stdio: "ignore",
	});
	return result.status === 0;
}

interface SampleContext {
	readonly options: Options;
	readonly target: Target;
	readonly env: Record<string, string>;
	readonly sessionDir: string;
	readonly collector: LoopbackProviderCollector;
	readonly nonce: string;
	/** Records the launch on both clocks: monotonic for metrics, wall-clock to align the product's own trace. */
	launched(): bigint;
}

async function stopPty(child: PtyProcess, tracker: StartupScreenTracker | undefined): Promise<void> {
	try {
		child.write("/quit\r");
		await withTimeout(child.exited, 10_000, "atomic exit");
	} catch {
		child.kill();
		await child.exited.catch(() => undefined);
	} finally {
		tracker?.dispose();
	}
}

/**
 * The editor is on screen with the terminal cursor in it, so what the user types lands there. The startup identity
 * may still be animating above it.
 */
export function editorAcceptsInput(screen: Pick<ScreenSnapshot, "lines" | "cursor">): boolean {
	const row = screen.lines.findIndex((line) => line === "❯" || line.startsWith("❯ "));
	return row >= 0 && screen.cursor.y === row && screen.cursor.x >= 2;
}

/**
 * Interactive startup in a terminal: the first frame that shows the editor with the cursor in it, then a typed word
 * appearing in that editor, then Enter reaching the provider with every tool.
 */
async function runInteractive(context: SampleContext, typeAhead: boolean): Promise<Record<string, number>> {
	const { options, env, sessionDir, collector, nonce } = context;
	const tracker = new StartupScreenTracker(options.version, { cols: COLS, rows: ROWS });
	let firstFrame: bigint | undefined;
	let identity: bigint | undefined;
	let echo: bigint | undefined;
	let responded = false;
	let queue = Promise.resolve();
	const waiters = new Set<() => void>();
	const launch = context.launched();
	const child = startPty({
		command: ptyCommandLine(["--session-dir", sessionDir, ...PROVIDER, ...(options.extraArgs ?? [])], env),
		cwd: options.cwd,
		env,
		timeoutMs: options.timeoutMs * 3,
		cols: COLS,
		rows: ROWS,
		onChunk: (chunk, atNs) => {
			queue = queue.then(async () => {
				const observation = await tracker.write(chunk, atNs);
				if (!firstFrame && editorAcceptsInput(observation)) firstFrame = atNs;
				if (!identity && observation.coherent) identity = atNs;
				if (!echo && observation.text.includes(nonce)) echo = atNs;
				if (!responded && observation.text.includes("benchmark-ok")) responded = true;
				for (const wake of waiters) wake();
			});
		},
	});
	// Answer terminal queries (device attributes, cursor position, colors) the way a real terminal does. On Windows the
	// native PTY has already answered the console host's startup cursor-position query, so the second report reaches
	// Atomic as an F3 key press while it starts: input it must ignore, not type into the editor.
	tracker.terminal.onData((data) => child.write(data));
	const until = async (predicate: () => boolean, label: string): Promise<void> => {
		const deadline = Date.now() + options.timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`${label} timed out after ${options.timeoutMs} ms`);
			await Promise.race([new Promise<void>((wake) => waiters.add(wake)), delay(50)]);
			waiters.clear();
		}
	};
	try {
		if (typeAhead) {
			// Typed before Atomic has drawn anything: it must neither be lost nor sent without the full tool set.
			child.write(`${nonce}\r`);
			const request = await withTimeout(collector.waitForRequest(), options.timeoutMs, "typed-ahead dispatch");
			validRequest(request);
			await until(() => firstFrame !== undefined, "first frame");
			await until(() => responded, "provider response");
			return {
				firstFrameMs: elapsedMs(launch, firstFrame!),
				typeaheadDispatchMs: elapsedMs(launch, BigInt(request.firstByteNs)),
			};
		}
		await until(() => firstFrame !== undefined, "first frame");
		child.write(nonce);
		await until(() => echo !== undefined, "typed input echo");
		const enter = process.hrtime.bigint();
		child.write("\r");
		const request = await withTimeout(collector.waitForRequest(), options.timeoutMs, "first prompt dispatch");
		validRequest(request);
		await until(() => responded, "provider response");
		await until(() => identity !== undefined, "startup identity");
		return {
			firstFrameMs: elapsedMs(launch, firstFrame!),
			inputEchoMs: elapsedMs(launch, echo!),
			identityMs: elapsedMs(launch, identity!),
			firstPromptDispatchMs: elapsedMs(enter, BigInt(request.firstByteNs)),
		};
	} catch (error) {
		await queue.catch(() => undefined);
		if (process.env.BENCH_DEBUG) process.stderr.write(`--- screen at failure ---\n${tracker.snapshot().text}\n---\n`);
		throw error;
	} finally {
		await stopPty(child, undefined);
		await queue.catch(() => undefined);
		tracker.dispose();
	}
}

function spawnAtomic(context: SampleContext, args: readonly string[], stdin: "ignore" | "pipe"): ChildProcess {
	return spawn(commandLine(args), {
		cwd: context.options.cwd,
		env: context.env,
		shell: true,
		stdio: [stdin, "pipe", "pipe"],
	});
}

function exitOf(child: ChildProcess): Promise<number | null> {
	return new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolveExit(code));
	});
}

function collectOutput(child: ChildProcess): Promise<{ stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8").on("data", (data: string) => {
		stdout += data;
	});
	child.stderr?.setEncoding("utf8").on("data", (data: string) => {
		stderr += data;
	});
	return new Promise((resolveOutput) => {
		child.once("close", () => resolveOutput({ stdout, stderr }));
	});
}

async function runVersion(context: SampleContext): Promise<Record<string, number>> {
	const launch = context.launched();
	const child = spawnAtomic(context, ["--version"], "ignore");
	const output = collectOutput(child);
	const code = await withTimeout(exitOf(child), context.options.timeoutMs, "--version exit");
	const exited = process.hrtime.bigint();
	const { stdout, stderr } = await output;
	if (code !== 0 || stdout.trim() !== context.options.version) {
		throw new Error(`--version exited ${code} with ${JSON.stringify(stdout.trim())} ${stderr.slice(0, 500)}`);
	}
	return { versionMs: elapsedMs(launch, exited) };
}

async function runPrint(context: SampleContext): Promise<Record<string, number>> {
	const { collector, nonce, sessionDir, options } = context;
	const launch = context.launched();
	const child = spawnAtomic(
		context,
		["-p", nonce, "--session-dir", sessionDir, ...PROVIDER, ...(options.extraArgs ?? [])],
		"ignore",
	);
	const output = collectOutput(child);
	const exited = exitOf(child);
	try {
		const request = await withTimeout(
			Promise.race([
				collector.waitForRequest(),
				exited.then((code) => {
					throw new Error(`atomic -p exited ${code} before the provider request`);
				}),
			]),
			options.timeoutMs,
			"-p dispatch",
		);
		validRequest(request);
		const code = await withTimeout(exited, options.timeoutMs, "-p exit");
		const end = process.hrtime.bigint();
		const { stdout, stderr } = await output;
		if (code !== 0 || !stdout.includes("benchmark-ok")) {
			throw new Error(`atomic -p exited ${code}: ${stdout.slice(0, 300)} ${stderr.slice(0, 500)}`);
		}
		return { printDispatchMs: elapsedMs(launch, BigInt(request.firstByteNs)), printExitMs: elapsedMs(launch, end) };
	} finally {
		if (child.exitCode === null) child.kill();
	}
}

async function runRpc(context: SampleContext): Promise<Record<string, number>> {
	const { collector, nonce, sessionDir, options } = context;
	const launch = context.launched();
	const child = spawnAtomic(
		context,
		["--mode", "rpc", "--session-dir", sessionDir, ...PROVIDER, ...(options.extraArgs ?? [])],
		"pipe",
	);
	const exited = exitOf(child);
	let ready: bigint | undefined;
	let ended = false;
	let buffered = "";
	let stderr = "";
	child.stderr?.setEncoding("utf8").on("data", (data: string) => {
		stderr += data;
	});
	const settled = new Promise<void>((resolveSettled) => {
		child.stdout?.setEncoding("utf8").on("data", (data: string) => {
			buffered += data;
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				let message: { type?: string; id?: string; command?: string; success?: boolean };
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.type === "response" && message.id === "state" && message.success) {
					ready ??= process.hrtime.bigint();
				}
				if (message.type === "agent_end") {
					ended = true;
					resolveSettled();
				}
			}
		});
	});
	// Both are written before Atomic reads anything: what an SDK client does right after spawning it.
	child.stdin?.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
	child.stdin?.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: nonce })}\n`);
	try {
		const request = await withTimeout(
			Promise.race([
				collector.waitForRequest(),
				exited.then((code) => {
					throw new Error(`atomic --mode rpc exited ${code} before the provider request: ${stderr.slice(0, 500)}`);
				}),
			]),
			options.timeoutMs,
			"rpc dispatch",
		);
		validRequest(request);
		await withTimeout(settled, options.timeoutMs, "rpc agent_end");
		if (!ready || !ended) throw new Error("rpc get_state never succeeded");
		return {
			rpcReadyMs: elapsedMs(launch, ready),
			rpcDispatchMs: elapsedMs(launch, BigInt(request.firstByteNs)),
		};
	} finally {
		child.stdin?.end();
		await withTimeout(exited, 10_000, "rpc exit").catch(() => child.kill());
	}
}

export async function runSample(
	options: Options,
	target: Target,
	mode: StartupMode,
	profile: StartupProfile,
	ordinal: number,
	recorded: boolean,
): Promise<StartupSample> {
	const id = `${String(ordinal).padStart(4, "0")}-${target.name}-${profile}-${mode}-${randomUUID().slice(0, 8)}`;
	const nonce = `bench${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const targetState = join(options.state, target.name);
	const runRoot = join(targetState, "runs", id);
	const sessionDir = join(runRoot, "sessions");
	const template = join(options.state, "agent-template");
	const agentDir = profile === "warm" ? join(targetState, "warm-agent") : join(runRoot, "agent");
	const cacheDir = profile === "warm" ? join(targetState, "warm-cache") : join(runRoot, "cache");
	const home = join(targetState, "home");
	await mkdir(sessionDir, { recursive: true });
	await mkdir(home, { recursive: true });
	if (profile === "cold") await cp(template, agentDir, { recursive: true });
	else await cp(template, agentDir, { recursive: true, force: false, errorOnExist: false });
	const collector = new LoopbackProviderCollector(nonce, { port: options.port });
	const startedAt = new Date().toISOString();
	const traceFile = join(runRoot, "trace.jsonl");
	let launchEpochMs: number | undefined;
	let traceMs: Record<string, number> | undefined;
	let metricsMs: Record<string, number> | undefined;
	const failures: string[] = [];
	const pageCacheDropped = profile === "cold" && options.dropCaches ? dropPageCache() : false;
	try {
		await collector.start();
		const context: SampleContext = {
			options,
			target,
			env: {
				...environmentFor(target, agentDir, cacheDir, home),
				...options.extraEnv,
				ATOMIC_STARTUP_TRACE: traceFile,
			},
			sessionDir,
			collector,
			nonce,
			launched: () => {
				launchEpochMs = performance.timeOrigin + performance.now();
				return process.hrtime.bigint();
			},
		};
		if (mode === "interactive" || mode === "typeahead")
			metricsMs = await runInteractive(context, mode === "typeahead");
		else if (mode === "version") metricsMs = await runVersion(context);
		else if (mode === "print") metricsMs = await runPrint(context);
		else metricsMs = await runRpc(context);
		if (mode !== "version" && collector.requests.length !== 1) {
			throw new Error(
				`expected one provider request, received ${collector.requests.length}: ${collector.requests.map(describeRequest).join(" | ")}`,
			);
		}
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
		metricsMs = undefined;
	} finally {
		await collector.stop().catch(() => undefined);
		if (launchEpochMs !== undefined) traceMs = await readTrace(traceFile, launchEpochMs);
		await rm(runRoot, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
	}
	return {
		id,
		target: target.name,
		mode,
		profile,
		recorded,
		state: failures.length === 0 ? "success" : "failure",
		startedAt,
		platform: process.platform,
		pageCacheDropped,
		...(metricsMs ? { metricsMs } : {}),
		...(collector.requests[0] ? { toolNames: collector.requests[0].toolNames } : {}),
		...(traceMs ? { traceMs } : {}),
		failures,
	};
}

/**
 * The product's own startup trace (`ATOMIC_STARTUP_TRACE`), as milliseconds after launch. Each mark is keyed by its
 * process's depth below the launched process (`0:` the launched process, `1:` a child it started, such as the
 * interactive engine or a headless run relaunched with a larger heap). Builds without the trace yield nothing.
 */
async function readTrace(file: string, launchEpochMs: number): Promise<Record<string, number> | undefined> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return undefined;
	}
	const lines = text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as { label: string; epochMs: number; pid: number; ppid: number });
	const parents = new Map(lines.map((line) => [line.pid, line.ppid]));
	const depth = (pid: number): number => {
		let level = 0;
		for (let parent = parents.get(pid); parent !== undefined && parents.has(parent); parent = parents.get(parent)) {
			level += 1;
		}
		return level;
	};
	const marks: Record<string, number> = {};
	for (const line of lines) {
		const key = `${depth(line.pid)}:${line.label}`;
		marks[key] ??= line.epochMs - launchEpochMs;
	}
	return marks;
}

/** Alternates the target order every round so neither target always runs first. */
export function roundOrder<T>(targets: readonly T[], round: number): T[] {
	const rotated = targets.map((_, index) => targets[(index + round) % targets.length]!);
	return round % 2 === 0 ? rotated : rotated.reverse();
}

/** A fresh state directory with the agent template every sample copies, and the working directory. */
export async function prepareBenchmarkState(options: Options): Promise<void> {
	await mkdir(options.output, { recursive: true });
	await rm(options.state, { recursive: true, force: true });
	await mkdir(options.cwd, { recursive: true });
	await createAgentTemplate(join(options.state, "agent-template"), options.port);
}

async function runBenchmark(options: Options): Promise<StartupSample[]> {
	await prepareBenchmarkState(options);
	const samplesPath = join(options.output, "samples.jsonl");
	const samples: StartupSample[] = [];
	let ordinal = 0;
	for (const profile of options.profiles) {
		for (const mode of options.modes) {
			if (profile === "warm") {
				// One untimed start per target fills the warm caches and agent state.
				for (const target of options.targets) await runSample(options, target, mode, profile, ++ordinal, false);
			}
			for (let round = 0; round < options.repeats; round += 1) {
				for (const target of roundOrder(options.targets, round)) {
					const sample = await runSample(options, target, mode, profile, ++ordinal, true);
					samples.push(sample);
					await appendFile(samplesPath, `${JSON.stringify(sample)}\n`);
					const metrics = sample.metricsMs
						? Object.entries(sample.metricsMs)
								.map(([name, value]) => `${name}=${value.toFixed(1)}`)
								.join(" ")
						: sample.failures.join("; ");
					process.stdout.write(`${sample.id} ${sample.state} ${metrics}\n`);
				}
			}
		}
	}
	return samples;
}

function parseList<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T[] {
	if (!value) return [...allowed];
	const items = value.split(",").map((item) => item.trim());
	for (const item of items) {
		if (!allowed.includes(item as T)) throw new Error(`unknown ${name}: ${item} (expected ${allowed.join(", ")})`);
	}
	return items as T[];
}

function parseOptions(argv: readonly string[]): Options {
	const values = new Map<string, string>();
	const targets: Target[] = [];
	let dropCaches = false;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index]!;
		if (flag === "--drop-caches") {
			dropCaches = true;
			continue;
		}
		const value = argv[index + 1];
		if (!flag.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${flag}`);
		index += 1;
		if (flag === "--target") {
			const separator = value.indexOf("=");
			if (separator <= 0) throw new Error("--target takes NAME=BIN_DIRECTORY");
			targets.push({ name: value.slice(0, separator), binDirectory: resolve(value.slice(separator + 1)) });
		} else values.set(flag.slice(2), value);
	}
	const output = values.get("output");
	if (!output || targets.length === 0) {
		throw new Error("required: --output DIR --target NAME=BIN_DIRECTORY [--target NAME=BIN_DIRECTORY]");
	}
	const integer = (name: string, fallback: number): number => {
		const parsed = Number(values.get(name) ?? fallback);
		if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
		return parsed;
	};
	return {
		output: resolve(output),
		state: resolve(values.get("state") ?? join(output, "state")),
		cwd: resolve(values.get("cwd") ?? join(output, "cwd")),
		version: values.get("version") ?? "0.0.0",
		targets,
		modes: parseList(values.get("modes"), STARTUP_MODES, "mode"),
		profiles: parseList(values.get("profiles"), STARTUP_PROFILES, "profile"),
		repeats: integer("repeats", 15),
		port: integer("port", 43_171),
		timeoutMs: integer("timeout-ms", 60_000),
		dropCaches,
	};
}

if (import.meta.main) {
	const options = parseOptions(process.argv.slice(2));
	const samples = await runBenchmark(options);
	const summary = summarizeStartupSamples(samples);
	await writeFile(join(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	const table = `${formatSummaryTable(summary)}\n\n${formatTraceTable(samples)}`;
	await writeFile(join(options.output, "summary.md"), `${table}\n`);
	process.stdout.write(`\n${table}\n`);
	const disagreements = toolSetDisagreements(samples);
	if (disagreements.length > 0) process.stdout.write(`\nTool sets differ:\n${disagreements.join("\n")}\n`);
	if (samples.some((sample) => sample.state !== "success") || disagreements.length > 0) process.exitCode = 1;
}
