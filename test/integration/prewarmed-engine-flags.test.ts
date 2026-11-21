import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, readTextSync, sleep } from "../helpers/runtime.js";

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

interface QuitRun {
	readonly lines: TraceLine[];
	/** The files in the session's compile cache once its engine has loaded its resources, before the quit. */
	readonly cacheFilesBeforeQuit: number;
	readonly quitMs: number;
}

/**
 * Starts the real interactive CLI with `args` and `env` and a compile cache of its own that is still empty, as on its
 * first run, which the host and its engine both fill; waits until the engine has loaded its resources, then quits.
 */
async function quitWithEmptyCompileCache(args: readonly string[], env: Record<string, string>): Promise<QuitRun> {
	const root = makeTempDirectory("prewarmed-engine-quit-");
	const agentDir = join(root, "agent");
	const packageDir = join(root, "package");
	const project = join(root, "project");
	const trace = join(root, "startup.jsonl");
	const cache = join(root, "compile-cache");
	let program: PtyProgram | undefined;
	try {
		mkdirSync(project, { recursive: true });
		prepareAgentDir(agentDir, "http://127.0.0.1:9");
		prepareInstalledPackage(PACKAGE, packageDir);
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
				...env,
				TERM: "xterm-256color",
				CI: "0",
			},
			timeoutMs: REAL_STARTUP_TIMEOUT_MS,
			cols: 120,
			rows: 40,
		});
		await program.waitForScreen((screen) => screen.includes("❯"), REAL_STARTUP_TIMEOUT_MS, "the prompt");
		const deadline = Date.now() + REAL_STARTUP_TIMEOUT_MS;
		while (!(existsSync(trace) && readTrace(trace).some((line) => line.label === "engine-resources-ready"))) {
			assert.ok(Date.now() < deadline, "the engine never finished loading its resources");
			await sleep(50);
		}
		const cacheFilesBeforeQuit = filesBelow(cache);
		program.write("/quit");
		await program.waitForScreen((screen) => screen.includes("❯ /quit"), REAL_STARTUP_TIMEOUT_MS, "the quit command");
		const quitAt = performance.now();
		program.write("\r");
		const exited = await program.exited;
		const quitMs = performance.now() - quitAt;
		assert.equal(exited.exitCode, 0, program.screen());
		return { lines: readTrace(trace), cacheFilesBeforeQuit, quitMs };
	} finally {
		program?.kill();
		vi.unstubAllEnvs();
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

// A host that would have run its prewarmed engine before that engine carried what main() derives from the arguments and
// settings keeps its cache as it was: written as it quits. One that runs the engine only because it now carries that
// environment would have written its cache before starting a second engine; it still writes it then, so its quit does
// not wait for a cold cache.
test(
	"a host running an engine prewarmed for --offline writes a cold compile cache at the handover and quits at once",
	async () => {
		const run = await quitWithEmptyCompileCache(["--offline"], {});
		assert.equal(engineChildren(run.lines).length, 1, "the host ran the engine it prewarmed");
		assert.ok(run.cacheFilesBeforeQuit > 0, "the host wrote its cache at the handover");
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

// The prewarm reads the global settings before the host does. A setting edited in between makes the host's engine
// differ from the prewarmed one; the host then starts another, which gets the edited environment.
test(
	"an httpProxy setting removed while Atomic starts leaves the engine without that proxy",
	async () => {
		const root = makeTempDirectory("prewarmed-engine-edited-");
		const agentDir = join(root, "agent");
		const packageDir = join(root, "package");
		const project = join(root, "project");
		const trace = join(root, "startup.jsonl");
		const seen = join(root, "engine-proxy.txt");
		const extension = join(root, "proxy-probe.mjs");
		let program: PtyProgram | undefined;
		try {
			mkdirSync(project, { recursive: true });
			prepareAgentDir(agentDir, "http://127.0.0.1:9");
			const settingsFile = join(agentDir, "settings.json");
			const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
			writeFileSync(settingsFile, JSON.stringify({ ...settings, httpProxy: "http://127.0.0.1:9" }));
			writeFileSync(
				extension,
				`import { writeFileSync } from "node:fs";
export default (pi) => pi.on("session_start", () => writeFileSync(${JSON.stringify(seen)}, process.env.HTTP_PROXY ?? "unset"));
`,
			);
			prepareInstalledPackage(PACKAGE, packageDir);
			for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ATOMIC_DEBUG_SETTING"])
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
					TERM: "xterm-256color",
					CI: "0",
				},
				timeoutMs: REAL_STARTUP_TIMEOUT_MS,
				cols: 120,
				rows: 40,
			});
			// Once the prewarmed engine has started, with the proxy, and before the host reads its settings.
			const deadline = Date.now() + REAL_STARTUP_TIMEOUT_MS;
			const started = () => {
				const lines = existsSync(trace) ? readTrace(trace) : [];
				const host = lines.find((line) => line.label === "process-entry")?.pid;
				return lines.some((line) => line.label === "process-start" && line.ppid === host);
			};
			while (!started()) {
				assert.ok(Date.now() < deadline, "the prewarmed engine never started");
				await sleep(10);
			}
			assert.equal(
				readTrace(trace).some((line) => line.label === "main-entry"),
				false,
				"the host had already read its settings",
			);
			writeFileSync(settingsFile, JSON.stringify(settings));
			while (!existsSync(seen)) {
				assert.ok(Date.now() < deadline, "the engine never started its session");
				await sleep(50);
			}
			assert.equal(readFileSync(seen, "utf8"), "unset");
			while (!readTrace(trace).some((line) => line.label === "engine-resources-ready")) {
				assert.ok(Date.now() < deadline, "the engine never finished loading its resources");
				await sleep(50);
			}
			assert.equal(engineChildren(readTrace(trace)).length, 2, "the host started another engine");
		} finally {
			program?.kill();
			vi.unstubAllEnvs();
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	REAL_STARTUP_TEST_TIMEOUT_MS,
);
