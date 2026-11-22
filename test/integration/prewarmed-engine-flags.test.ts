import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test, vi } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, readTextSync, sleep } from "../helpers/runtime.js";
import { messageText, startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const PACKAGE = join(ROOT, "packages/coding-agent");
const CLI = join(PACKAGE, "dist/cli.js");
/** A real host and engine start, all builtin loaders, then the startup benchmark's normal disposal path. */
const REAL_STARTUP_TIMEOUT_MS = 60_000;
const BROKER_CLEANUP_TIMEOUT_MS = 10_000;
const REAL_STARTUP_TEST_TIMEOUT_MS = REAL_STARTUP_TIMEOUT_MS + BROKER_CLEANUP_TIMEOUT_MS;
/** Quitting a started session takes about a second; a host that writes a cold compile cache as it exits takes seconds. */
const QUIT_BOUND_MS = 3_000;

interface TraceLine {
	readonly label: string;
	readonly pid: number;
	readonly ppid: number;
	readonly epochMs: number;
}

/**
 * Starts the real interactive CLI on a terminal with `args`, `env` and global `settings`, lets it finish starting, and
 * returns the startup trace:
 * one line per lifecycle mark of the host and of every engine child it started.
 */
async function startInteractive(
	args: readonly string[],
	env: Record<string, string | undefined>,
	settings: Record<string, unknown>,
	legacySettings?: string,
): Promise<TraceLine[]> {
	const root = makeTempDirectory("prewarmed-engine-flags-");
	// With legacy settings the agent directory is the home's, which the environment does not name, as for most users.
	const home = join(root, "home");
	const agentDir = legacySettings === undefined ? join(root, "agent") : join(home, ".atomic", "agent");
	const packageDir = join(root, "package");
	const project = join(root, "project");
	const trace = join(root, "startup.jsonl");
	let program: PtyProgram | undefined;
	try {
		mkdirSync(project, { recursive: true });
		prepareAgentDir(agentDir, "http://127.0.0.1:9");
		const settingsFile = join(agentDir, "settings.json");
		writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, "utf8")), ...settings }));
		if (legacySettings !== undefined) {
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			writeFileSync(join(home, ".pi", "agent", "settings.json"), legacySettings);
		}
		prepareInstalledPackage(PACKAGE, packageDir);
		// The native PTY starts the CLI with this process's environment underneath the one given here.
		for (const name of [
			"ATOMIC_OFFLINE",
			"PI_OFFLINE",
			"ATOMIC_DEBUG",
			"PI_DEBUG",
			"ATOMIC_DEBUG_SETTING",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"http_proxy",
			"https_proxy",
		])
			vi.stubEnv(name, undefined);
		if (legacySettings !== undefined)
			for (const name of ["ATOMIC_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) vi.stubEnv(name, undefined);
		for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
		program = startPtyProgram({
			executable: process.execPath,
			args: [CLI, ...args, "--no-session", "--approve"],
			cwd: project,
			env: {
				...(legacySettings === undefined
					? { ATOMIC_CODING_AGENT_DIR: agentDir }
					: { HOME: home, USERPROFILE: home }),
				ATOMIC_PACKAGE_DIR: packageDir,
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_TELEMETRY: "0",
				ATOMIC_STARTUP_BENCHMARK: "1",
				ATOMIC_STARTUP_TRACE: trace,
				...Object.fromEntries(
					Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
				),
				TERM: "xterm-256color",
				CI: "0",
			},
			timeoutMs: REAL_STARTUP_TIMEOUT_MS,
			cols: 120,
			rows: 40,
		});
		const exited = await program.exited;
		assert.equal(exited.timedOut, false, program.screen());
		assert.equal(exited.exitCode, 0, program.screen());
		return readTrace(trace);
	} finally {
		program?.kill();
		vi.unstubAllEnvs();
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

function readTrace(file: string): TraceLine[] {
	return readTextSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as TraceLine);
}

/** The engine children the host started: one when it adopted the engine it prewarmed, two when it started another. */
function engineChildren(lines: readonly TraceLine[]): number[] {
	const host = lines.find((line) => line.label === "tui-start");
	assert.ok(host, "the real interactive host started");
	const children = new Set(
		lines.filter((line) => line.label === "process-start" && line.ppid === host.pid).map((line) => line.pid),
	);
	assert.ok(
		lines.some((line) => line.label === "engine-resources-ready" && children.has(line.pid)),
		"an engine child finished loading its resources",
	);
	return [...children];
}

test.each([
	{ name: "--offline", args: ["--offline"], env: {}, settings: {} },
	{ name: "PI_OFFLINE=true", args: [], env: { PI_OFFLINE: "true" }, settings: {} },
	{ name: "--debug", args: ["--debug"], env: { ATOMIC_OFFLINE: "1" }, settings: {} },
	{ name: "the debug setting", args: [], env: { ATOMIC_OFFLINE: "1" }, settings: { debug: true } },
	{
		name: "an httpProxy setting",
		args: [],
		env: { ATOMIC_OFFLINE: "1" },
		settings: { httpProxy: "http://127.0.0.1:9" },
	},
	{
		// The settings manager then reads no global settings at all, so neither does the prewarmed engine.
		name: "an httpProxy setting beside a broken legacy settings file",
		args: [],
		env: { ATOMIC_OFFLINE: "1" },
		settings: { httpProxy: "http://127.0.0.1:9", debug: true },
		legacy: "{ broken",
	},
])(
	"a host started with $name runs the engine it prewarmed instead of starting a second one",
	async ({ args, env, settings, legacy }) => {
		assert.equal(engineChildren(await startInteractive(args, env, settings, legacy)).length, 1);
	},
	REAL_STARTUP_TEST_TIMEOUT_MS,
);

/** Every file below `directory`, or none when it does not exist. */
function filesBelow(directory: string): number {
	if (!existsSync(directory)) return 0;
	return readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
}

/** Preload that records each main-thread `module.flushCompileCache()` call with its wall-clock timestamp and role. */
const RECORD_COMPILE_CACHE_FLUSH = `
const { isMainThread } = require("node:worker_threads");
const fs = require("node:fs");
const m = require("node:module");
if (isMainThread && process.env.ATOMIC_TEST_FLUSH_LOG && typeof m.flushCompileCache === "function") {
	const original = m.flushCompileCache;
	const role = process.argv.includes(${JSON.stringify("--internal-engine-prewarm")})
		? "prewarm"
		: process.argv.some((arg) => arg.startsWith(${JSON.stringify("--internal-engine-bootstrap")}))
			? "fresh"
			: "host";
	m.flushCompileCache = function (...args) {
		const at = performance.timeOrigin + performance.now();
		const result = original.apply(this, args);
		fs.appendFileSync(process.env.ATOMIC_TEST_FLUSH_LOG, JSON.stringify({ pid: process.pid, role, at }) + "\\n");
		return result;
	};
	m.syncBuiltinESMExports();
}
`;

interface FlushRecord {
	readonly pid: number;
	readonly role: "host" | "prewarm" | "fresh";
	readonly at: number;
}

interface QuitRun {
	readonly lines: TraceLine[];
	readonly flushes: FlushRecord[];
	/** The files in the session's compile cache once startup settled, before the quit. */
	readonly cacheFilesBeforeQuit: number;
	readonly quitMs: number;
	readonly requestAt?: number;
}

/**
 * Starts the real interactive CLI with `args` and `env` and a compile cache of its own that is still empty, as on its
 * first run, which the host and its engine both fill; waits until startup settles (optionally submitting an early
 * prompt first), then quits.
 */
async function quitWithEmptyCompileCache(
	args: readonly string[],
	env: Record<string, string>,
	options: { readonly recordFlushes?: boolean; readonly earlyPrompt?: string } = {},
): Promise<QuitRun> {
	const root = makeTempDirectory("prewarmed-engine-quit-");
	const agentDir = join(root, "agent");
	const packageDir = join(root, "package");
	const project = join(root, "project");
	const trace = join(root, "startup.jsonl");
	const flushLog = join(root, "flushes.jsonl");
	const preload = join(root, "record-flush.cjs");
	const cache = join(root, "compile-cache");
	let requestAt: number | undefined;
	const server = options.earlyPrompt
		? await startScriptedChatServer((request) => {
				if (!request.messages.some((m) => m.role === "user" && messageText(m).includes(options.earlyPrompt!))) {
					throw new Error("unexpected prompt");
				}
				requestAt = performance.timeOrigin + performance.now();
				return { label: "ok", text: "PREWARM_EARLY_REPLY", chunks: 1, chunkDelayMs: 0 };
			})
		: undefined;
	let program: PtyProgram | undefined;
	try {
		mkdirSync(project, { recursive: true });
		prepareAgentDir(agentDir, server?.baseUrl ?? "http://127.0.0.1:9");
		prepareInstalledPackage(PACKAGE, packageDir);
		if (options.recordFlushes) writeFileSync(preload, RECORD_COMPILE_CACHE_FLUSH);
		for (const name of ["ATOMIC_OFFLINE", "PI_OFFLINE", "ATOMIC_DEBUG", "PI_DEBUG", "ATOMIC_DEBUG_SETTING"])
			vi.stubEnv(name, undefined);
		program = startPtyProgram({
			executable: process.execPath,
			args: [CLI, ...args, "--no-session", "--approve"],
			cwd: project,
			env: {
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_PACKAGE_DIR: packageDir,
				ATOMIC_TELEMETRY: "0",
				ATOMIC_STARTUP_TRACE: trace,
				NODE_COMPILE_CACHE: cache,
				...(options.recordFlushes
					? {
							NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
							ATOMIC_TEST_FLUSH_LOG: flushLog,
						}
					: {}),
				...env,
				TERM: "xterm-256color",
				CI: "0",
			},
			timeoutMs: REAL_STARTUP_TIMEOUT_MS,
			cols: 120,
			rows: 40,
		});
		await program.waitForScreen((screen) => screen.includes("❯"), REAL_STARTUP_TIMEOUT_MS, "the prompt");
		if (options.earlyPrompt) {
			program.write(options.earlyPrompt);
			await program.waitForScreen(
				(screen) => screen.includes(`❯ ${options.earlyPrompt}`),
				REAL_STARTUP_TIMEOUT_MS,
				"the early prompt echo",
			);
			program.write("\r");
			await program.waitForScreen(
				(screen) => screen.includes("PREWARM_EARLY_REPLY"),
				REAL_STARTUP_TIMEOUT_MS,
				"the early prompt reply",
			);
		}
		const deadline = Date.now() + REAL_STARTUP_TIMEOUT_MS;
		while (
			!(
				existsSync(trace) &&
				readTrace(trace).some((line) => line.label === "engine-resources-ready") &&
				readTrace(trace).some((line) => line.label === "startup-complete")
			)
		) {
			assert.ok(Date.now() < deadline, "startup never completed");
			await sleep(50);
		}
		if (options.recordFlushes) {
			// Give the deferred flush callback a moment to run once startup or prompt dispatch completes.
			const flushDeadline = Date.now() + 2_000;
			while (
				Date.now() < flushDeadline &&
				!(
					existsSync(flushLog) &&
					readTextSync(flushLog, "utf8")
						.split("\n")
						.some((line) => line.includes('"role":"host"'))
				)
			) {
				await sleep(25);
			}
		} else {
			await sleep(150);
		}
		const cacheFilesBeforeQuit = filesBelow(cache);
		program.write("/quit");
		await program.waitForScreen((screen) => screen.includes("❯ /quit"), REAL_STARTUP_TIMEOUT_MS, "the quit command");
		const quitAt = performance.now();
		program.write("\r");
		const exited = await program.exited;
		const quitMs = performance.now() - quitAt;
		assert.equal(exited.exitCode, 0, program.screen());
		const flushes: FlushRecord[] = existsSync(flushLog)
			? readTextSync(flushLog, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as FlushRecord)
			: [];
		return { lines: readTrace(trace), flushes, cacheFilesBeforeQuit, quitMs, requestAt };
	} finally {
		program?.kill();
		vi.unstubAllEnvs();
		await server?.close();
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

// A host that adopts a prewarmed engine with derived startup environment (such as --offline) does not block engine
// handover or first-prompt dispatch with a synchronous compile-cache flush; instead it flushes once startup settles (or
// after the first prompt is handed to the engine), so quitting still avoids waiting on a cold cache.
test(
	"a host running an engine prewarmed for --offline defers its cold compile cache off handover and quits at once",
	async () => {
		const run = await quitWithEmptyCompileCache(["--offline"], {}, { recordFlushes: true });
		assert.equal(engineChildren(run.lines).length, 1, "the host ran the engine it prewarmed");
		const hostBound = run.lines.find((line) => line.label === "engine-bound");
		assert.ok(hostBound, "the host bound its engine");
		const hostFlushes = run.flushes.filter((flush) => flush.role === "host");
		assert.equal(hostFlushes.length, 1, "the host flushed its compile cache once");
		assert.ok(
			hostFlushes[0]!.at > hostBound.epochMs,
			`expected host compile-cache flush (${Math.round(hostFlushes[0]!.at)}) after engine-bound (${Math.round(hostBound.epochMs)}), not synchronously at handover`,
		);
		assert.ok(run.cacheFilesBeforeQuit > 0, "the host wrote its cache before quitting");
		assert.ok(run.quitMs < QUIT_BOUND_MS, `quitting took ${Math.round(run.quitMs)} ms`);
	},
	REAL_STARTUP_TEST_TIMEOUT_MS,
);

test(
	"a host running an engine prewarmed for --offline dispatches an early prompt before flushing its cold compile cache",
	async () => {
		const run = await quitWithEmptyCompileCache(
			["--offline"],
			{},
			{ recordFlushes: true, earlyPrompt: "early-cache-check" },
		);
		assert.equal(engineChildren(run.lines).length, 1, "the host ran the engine it prewarmed");
		assert.ok(run.requestAt !== undefined, "the engine sent the early prompt request");
		const hostFlushes = run.flushes.filter((flush) => flush.role === "host");
		assert.equal(hostFlushes.length, 1, "the host flushed its compile cache once");
		assert.ok(
			hostFlushes[0]!.at >= run.requestAt,
			`expected host compile-cache flush (${Math.round(hostFlushes[0]!.at)}) after early prompt request (${Math.round(run.requestAt)})`,
		);
		assert.ok(run.cacheFilesBeforeQuit > 0, "the host wrote its cache before quitting");
		assert.ok(run.quitMs < QUIT_BOUND_MS, `quitting took ${Math.round(run.quitMs)} ms`);
	},
	REAL_STARTUP_TEST_TIMEOUT_MS,
);

test(
	"a host whose prewarmed engine needed no added environment leaves a cold compile cache to its quit",
	async () => {
		const run = await quitWithEmptyCompileCache([], { ATOMIC_OFFLINE: "1", ATOMIC_SKIP_VERSION_CHECK: "1" });
		assert.equal(engineChildren(run.lines).length, 1, "the host ran the engine it prewarmed");
		assert.equal(run.cacheFilesBeforeQuit, 0, "nothing wrote the cache before the quit");
	},
	REAL_STARTUP_TEST_TIMEOUT_MS,
);

// The prewarm reads the global settings before the host does. When a setting is edited in between, the host reconciles
// the settings-derived environment over the prewarm handshake and still adopts the prewarmed engine instead of starting
// a second one. A preload in the host edits the settings as the prewarmed engine is spawned, before the host reads them.
const EDIT_AFTER_PREWARM = `
const childProcess = require("node:child_process");
const fs = require("node:fs");
const spawn = childProcess.spawn;
let edited = false;
childProcess.spawn = function (command, args, ...rest) {
	const child = spawn.call(this, command, args, ...rest);
	if (!edited && Array.isArray(args) && args.includes(${JSON.stringify("--internal-engine-prewarm")})) {
		edited = true;
		fs.writeFileSync(process.env.ATOMIC_TEST_SETTINGS_FILE, process.env.ATOMIC_TEST_SETTINGS_EDIT);
	}
	return child;
};
require("node:module").syncBuiltinESMExports();
`;

test(
	"an httpProxy setting removed while Atomic starts adopts the prewarmed engine without that proxy",
	async () => {
		const root = makeTempDirectory("prewarmed-engine-edited-");
		const agentDir = join(root, "agent");
		const packageDir = join(root, "package");
		const project = join(root, "project");
		const trace = join(root, "startup.jsonl");
		const seen = join(root, "engine-proxy.json");
		const extension = join(root, "proxy-probe.mjs");
		const preload = join(root, "edit-after-prewarm.cjs");
		const directServer = createServer((_req, res) => res.end("DIRECT_OK"));
		await new Promise<void>((resolve) => directServer.listen(0, "127.0.0.1", resolve));
		const directPort = (directServer.address() as { port: number }).port;
		let program: PtyProgram | undefined;
		try {
			mkdirSync(project, { recursive: true });
			prepareAgentDir(agentDir, "http://127.0.0.1:9");
			const settingsFile = join(agentDir, "settings.json");
			const settings = readFileSync(settingsFile, "utf8");
			writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(settings), httpProxy: "http://127.0.0.1:9" }));
			writeFileSync(preload, EDIT_AFTER_PREWARM);
			writeFileSync(
				extension,
				`import { writeFileSync } from "node:fs";
export default (pi) => pi.on("session_start", async (_event, ctx) => {
	if (ctx.isPresentationOnly) return;
	let direct = "failed";
	try {
		direct = await (await fetch(${JSON.stringify(`http://127.0.0.1:${directPort}`)})).text();
	} catch (err) {
		direct = String(err);
	}
	writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
		httpProxy: process.env.HTTP_PROXY ?? "unset",
		httpsProxy: process.env.HTTPS_PROXY ?? "unset",
		direct,
	}));
});
`,
			);
			prepareInstalledPackage(PACKAGE, packageDir);
			for (const name of [
				"HTTP_PROXY",
				"HTTPS_PROXY",
				"http_proxy",
				"https_proxy",
				"NO_PROXY",
				"no_proxy",
				"ATOMIC_DEBUG_SETTING",
			])
				vi.stubEnv(name, undefined);
			program = startPtyProgram({
				executable: process.execPath,
				args: [CLI, "-e", extension, "--no-session", "--approve"],
				cwd: project,
				env: {
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ATOMIC_PACKAGE_DIR: packageDir,
					ATOMIC_OFFLINE: "1",
					ATOMIC_SKIP_VERSION_CHECK: "1",
					ATOMIC_TELEMETRY: "0",
					ATOMIC_STARTUP_TRACE: trace,
					NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
					ATOMIC_TEST_SETTINGS_FILE: settingsFile,
					ATOMIC_TEST_SETTINGS_EDIT: settings,
					TERM: "xterm-256color",
					CI: "0",
				},
				timeoutMs: REAL_STARTUP_TIMEOUT_MS,
				cols: 120,
				rows: 40,
			});
			await program.waitForScreen((screen) => screen.includes("❯"), REAL_STARTUP_TIMEOUT_MS, "the prompt");
			const deadline = Date.now() + REAL_STARTUP_TIMEOUT_MS;
			while (!existsSync(seen)) {
				assert.ok(Date.now() < deadline, "the engine never started its session");
				await sleep(50);
			}
			assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), {
				httpProxy: "unset",
				httpsProxy: "unset",
				direct: "DIRECT_OK",
			});
			// A line the trace is still writing is read on the next poll.
			const marked = () =>
				readTextSync(trace, "utf8")
					.split("\n")
					.some((line) => line.includes('"engine-resources-ready"'));
			while (!marked()) {
				assert.ok(Date.now() < deadline, "the engine never finished loading its resources");
				await sleep(50);
			}
			program.write("/quit");
			await program.waitForScreen(
				(screen) => screen.includes("❯ /quit"),
				REAL_STARTUP_TIMEOUT_MS,
				"the quit command",
			);
			program.write("\r");
			assert.equal((await program.exited).exitCode, 0, program.screen());
			assert.equal(engineChildren(readTrace(trace)).length, 1, "the host adopted the prewarmed engine");
		} finally {
			program?.kill();
			vi.unstubAllEnvs();
			await new Promise<void>((resolve) => directServer.close(() => resolve()));
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	REAL_STARTUP_TEST_TIMEOUT_MS,
);

test(
	"a debug setting toggled on while Atomic starts adopts the prewarmed engine with debug active",
	async () => {
		const root = makeTempDirectory("prewarmed-engine-debug-edited-");
		const agentDir = join(root, "agent");
		const packageDir = join(root, "package");
		const project = join(root, "project");
		const trace = join(root, "startup.jsonl");
		const seen = join(root, "engine-debug.json");
		const extension = join(root, "debug-probe.mjs");
		const preload = join(root, "edit-after-prewarm.cjs");
		let program: PtyProgram | undefined;
		try {
			mkdirSync(project, { recursive: true });
			prepareAgentDir(agentDir, "http://127.0.0.1:9");
			const settingsFile = join(agentDir, "settings.json");
			const baseSettings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
			writeFileSync(settingsFile, JSON.stringify({ ...baseSettings, debug: false }));
			writeFileSync(preload, EDIT_AFTER_PREWARM);
			writeFileSync(
				extension,
				`import { writeFileSync } from "node:fs";
import { isDebugEnabled } from "@bastani/atomic";
export default (pi) => pi.on("session_start", (_event, ctx) => {
	if (ctx.isPresentationOnly) return;
	writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
		env: process.env.ATOMIC_DEBUG_SETTING ?? "unset",
		enabled: isDebugEnabled(),
	}));
});
`,
			);
			prepareInstalledPackage(PACKAGE, packageDir);
			for (const name of ["ATOMIC_DEBUG", "PI_DEBUG", "ATOMIC_DEBUG_SETTING"]) vi.stubEnv(name, undefined);
			program = startPtyProgram({
				executable: process.execPath,
				args: [CLI, "-e", extension, "--no-session", "--approve"],
				cwd: project,
				env: {
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ATOMIC_PACKAGE_DIR: packageDir,
					ATOMIC_OFFLINE: "1",
					ATOMIC_SKIP_VERSION_CHECK: "1",
					ATOMIC_TELEMETRY: "0",
					ATOMIC_STARTUP_TRACE: trace,
					NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
					ATOMIC_TEST_SETTINGS_FILE: settingsFile,
					ATOMIC_TEST_SETTINGS_EDIT: JSON.stringify({ ...baseSettings, debug: true }),
					TERM: "xterm-256color",
					CI: "0",
				},
				timeoutMs: REAL_STARTUP_TIMEOUT_MS,
				cols: 120,
				rows: 40,
			});
			await program.waitForScreen((screen) => screen.includes("❯"), REAL_STARTUP_TIMEOUT_MS, "the prompt");
			const deadline = Date.now() + REAL_STARTUP_TIMEOUT_MS;
			while (!existsSync(seen)) {
				assert.ok(Date.now() < deadline, "the engine never started its session");
				await sleep(50);
			}
			assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), { env: "1", enabled: true });
			const marked = () =>
				readTextSync(trace, "utf8")
					.split("\n")
					.some((line) => line.includes('"engine-resources-ready"'));
			while (!marked()) {
				assert.ok(Date.now() < deadline, "the engine never finished loading its resources");
				await sleep(50);
			}
			program.write("/quit");
			await program.waitForScreen(
				(screen) => screen.includes("❯ /quit"),
				REAL_STARTUP_TIMEOUT_MS,
				"the quit command",
			);
			program.write("\r");
			assert.equal((await program.exited).exitCode, 0, program.screen());
			assert.equal(engineChildren(readTrace(trace)).length, 1, "the host adopted the prewarmed engine");
		} finally {
			program?.kill();
			vi.unstubAllEnvs();
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	REAL_STARTUP_TEST_TIMEOUT_MS,
);
