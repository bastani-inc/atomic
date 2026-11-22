import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
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
	readonly epochMs: number;
}

interface Started {
	/** The host's startup marks, in the order it recorded them. */
	readonly hostMarks: string[];
	/** What the session the host started holds once the start is over. */
	readonly sessionEntryTypes: string[];
	readonly sessionName: string | undefined;
}

/** Starts the real interactive CLI on a terminal in a trusted folder with `args`, lets it finish starting, and quits. */
async function startInteractive(args: readonly string[]): Promise<Started> {
	const root = makeTempDirectory("isolated-engine-early-start-");
	const agentDir = join(root, "agent");
	const packageDir = join(root, "package");
	const project = join(root, "project");
	const sessions = join(root, "sessions");
	const trace = join(root, "startup.jsonl");
	let program: PtyProgram | undefined;
	try {
		mkdirSync(project, { recursive: true });
		prepareAgentDir(agentDir, "http://127.0.0.1:9");
		prepareInstalledPackage(PACKAGE, packageDir);
		for (const name of ["ATOMIC_OFFLINE", "PI_OFFLINE", "ATOMIC_DEBUG", "PI_DEBUG", "ATOMIC_DEBUG_SETTING"])
			vi.stubEnv(name, undefined);
		program = startPtyProgram({
			executable: process.execPath,
			args: [CLI, ...args, "--session-dir", sessions, "--offline", "--approve"],
			cwd: project,
			env: {
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_PACKAGE_DIR: packageDir,
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_TELEMETRY: "0",
				ATOMIC_STARTUP_BENCHMARK: "1",
				ATOMIC_STARTUP_TRACE: trace,
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
		const lines = readTextSync(trace, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as TraceLine);
		const host = lines.find((line) => line.label === "tui-start");
		assert.ok(host, "the real interactive host started");
		assert.ok(
			lines.some((line) => line.label === "engine-resources-ready" && line.ppid === host.pid),
			"its engine child finished loading its resources",
		);
		const files = readdirSync(sessions, { recursive: true }).filter((name) => String(name).endsWith(".jsonl"));
		assert.equal(files.length, 1, JSON.stringify(files));
		const records = readFileSync(join(sessions, String(files[0])), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; name?: string });
		return {
			hostMarks: lines.filter((line) => line.pid === host.pid).map((line) => line.label),
			sessionEntryTypes: records.map((record) => record.type),
			sessionName: records.find((record) => record.type === "session_info")?.name,
		};
	} finally {
		program?.kill();
		vi.unstubAllEnvs();
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

test(
	"a host in a trusted folder starts its engine before it has created its own runtime",
	async () => {
		const { hostMarks, sessionName } = await startInteractive([]);
		const spawned = hostMarks.indexOf("interactive-engine-spawn");
		assert.ok(spawned >= 0, hostMarks.join(", "));
		assert.ok(spawned < hostMarks.indexOf("runtime-created"), hostMarks.join(", "));
		assert.equal(sessionName, undefined);
	},
	REAL_STARTUP_TEST_TIMEOUT_MS,
);

test(
	"a host started with --name names the session before its engine opens it",
	async () => {
		const { hostMarks, sessionEntryTypes, sessionName } = await startInteractive(["--name", "early start"]);
		const spawned = hostMarks.indexOf("interactive-engine-spawn");
		assert.ok(spawned > hostMarks.indexOf("runtime-created"), hostMarks.join(", "));
		assert.equal(sessionName, "early start");
		assert.deepEqual(sessionEntryTypes.slice(0, 2), ["session", "session_info"]);
	},
	REAL_STARTUP_TEST_TIMEOUT_MS,
);
