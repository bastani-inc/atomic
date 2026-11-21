import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, readTextSync } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const PACKAGE = join(ROOT, "packages/coding-agent");
const CLI = join(PACKAGE, "dist/cli.js");
/** A real host and engine start, all builtin loaders, then the startup benchmark's normal disposal path. */
const REAL_STARTUP_TIMEOUT_MS = 60_000;
const BROKER_CLEANUP_TIMEOUT_MS = 10_000;
const REAL_STARTUP_TEST_TIMEOUT_MS = REAL_STARTUP_TIMEOUT_MS + BROKER_CLEANUP_TIMEOUT_MS;

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
		return readTextSync(trace, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as TraceLine);
	} finally {
		program?.kill();
		vi.unstubAllEnvs();
		await removeTempRootReleasingBroker(root, agentDir);
	}
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
