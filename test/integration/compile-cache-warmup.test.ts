import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	constants,
	cpSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "vitest";
import { compileCacheWarmMarker } from "../../packages/coding-agent/src/utils/compile-cache.js";
import { compileCacheHelperLaunch } from "../../packages/coding-agent/src/utils/compile-cache-warmup-host.js";
import { WINDOWS_EXCLUSIVE_OPEN_FLAG } from "../../packages/coding-agent/src/utils/compile-cache-warmup-status.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";

const REPO = join(moduleDir(import.meta.url), "../..");
const PACKAGE = join(REPO, "packages/coding-agent");
/** A real CLI session in a terminal, started twice, with a helper process loading the whole module graph between. */
const SESSIONS_TIMEOUT_MS = 240_000;
const CLI_TIMEOUT_MS = 90_000;
/** How long the helper may take to load and write the module graph on a loaded runner. */
const HELPER_WAIT_MS = 120_000;
const POLL_MS = 50;
const windows = process.platform === "win32";

interface SessionReport {
	readonly cacheDir: string | null;
	readonly version: string;
	readonly arch: string;
	readonly tag: number;
	readonly uid: number | null;
}

/** Files under the compile cache directory, with when each was last written; a file removed meanwhile is left out. */
function cacheFiles(cacheBase: string): Map<string, number> {
	const files = new Map<string, number>();
	const record = (path: string) => {
		try {
			files.set(path, statSync(path).mtimeMs);
		} catch (error) {
			// A temporary file Node renamed into place after the listing.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	if (!existsSync(cacheBase)) return files;
	for (const entry of readdirSync(cacheBase, { withFileTypes: true })) {
		const path = join(cacheBase, entry.name);
		if (!entry.isDirectory()) record(path);
		else for (const name of readdirSync(path)) record(join(path, name));
	}
	return files;
}

/** How many entries the cache directories hold, by name only. */
function cacheEntryCount(cacheBase: string): number {
	if (!existsSync(cacheBase)) return 0;
	return readdirSync(cacheBase, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.reduce((count, entry) => count + readdirSync(join(cacheBase, entry.name)).length, 0);
}

/** Whether a helper holds a build lock: it keeps the file open in exclusive sharing mode while it runs. */
function warmupRunning(cacheBase: string): boolean {
	if (!existsSync(cacheBase)) return false;
	const lock = readdirSync(cacheBase).find((name) => name.endsWith(".lock"));
	if (!lock) return false;
	try {
		closeSync(openSync(join(cacheBase, lock), constants.O_RDWR | WINDOWS_EXCLUSIVE_OPEN_FLAG));
		return false;
	} catch {
		return true;
	}
}

/** Files added or rewritten between two listings. */
function writtenBetween(before: Map<string, number>, after: Map<string, number>): string[] {
	return [...after].filter(([path, mtime]) => before.get(path) !== mtime).map(([path]) => path);
}

/** The directory Node caches into for the session that sent `report`, as Atomic names its marker there. */
function sessionCacheDir(cacheBase: string, report: SessionReport): string {
	return dirname(
		compileCacheWarmMarker({
			baseDir: cacheBase,
			nodeVersion: report.version,
			arch: report.arch,
			versionTag: report.tag,
			uid: report.uid ?? undefined,
			buildId: "",
		}),
	);
}

/** Wait until the session's own cache is marked warm: its helpers run last for the session's own runtime flags. */
async function waitForWarmCache(cacheBase: string, report: SessionReport): Promise<void> {
	const dir = sessionCacheDir(cacheBase, report);
	const marked = () => existsSync(dir) && readdirSync(dir).some((name) => name.startsWith("atomic-warm-"));
	const deadline = Date.now() + HELPER_WAIT_MS;
	while (!marked() || warmupRunning(cacheBase)) {
		if (Date.now() >= deadline) {
			throw new Error(
				`No warm compile cache within ${HELPER_WAIT_MS} ms: ${[...cacheFiles(cacheBase).keys()].length} files`,
			);
		}
		await sleep(POLL_MS);
	}
}

function sessionFixture(prefix: string) {
	const root = makeTempDirectory(prefix);
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const installed = join(root, "installed");
	const temp = join(root, "temp");
	const reports = join(root, "reports.jsonl");
	const extension = join(root, "report.mjs");
	mkdirSync(project, { recursive: true });
	mkdirSync(temp, { recursive: true });
	prepareAgentDir(agentDir, "http://127.0.0.1:9");
	prepareInstalledPackage(PACKAGE, installed);
	writeFileSync(
		extension,
		`import { appendFileSync } from "node:fs";
import nodeModule from "node:module";
import { cachedDataVersionTag } from "node:v8";
export default (pi) => pi.on("session_start", () => {
	appendFileSync(${JSON.stringify(reports)}, JSON.stringify({
		cacheDir: nodeModule.getCompileCacheDir() ?? null,
		version: process.version,
		arch: process.arch,
		tag: cachedDataVersionTag(),
		uid: process.getuid ? process.getuid() : null,
	}) + "\\n");
});`,
	);
	const env = {
		HOME: root,
		USERPROFILE: root,
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_PACKAGE_DIR: installed,
		ATOMIC_SKIP_VERSION_CHECK: "1",
		ATOMIC_TELEMETRY: "0",
		TERM: "xterm-256color",
		TEMP: temp,
		TMP: temp,
		TMPDIR: temp,
		// The default location, where an interactive session decides about the cache itself.
		NODE_COMPILE_CACHE: "",
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		...(process.env.PATH ? { PATH: process.env.PATH } : {}),
	};
	const start = (hostArgs: readonly string[]): PtyProgram =>
		startPtyProgram({
			executable: process.execPath,
			args: [join(PACKAGE, "dist/cli.js"), "--offline", "--no-mcp", ...hostArgs, "-e", extension],
			cwd: project,
			env,
			timeoutMs: CLI_TIMEOUT_MS,
			cols: 120,
			rows: 40,
		});
	const readReports = (): SessionReport[] =>
		existsSync(reports)
			? readFileSync(reports, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as SessionReport)
			: [];
	return { root, agentDir, cacheBase: join(temp, "node-compile-cache"), start, readReports };
}

async function quit(program: PtyProgram): Promise<void> {
	program.write("/quit\r");
	const exit = await program.exited;
	assert.equal(exit.timedOut, false, program.screen());
	assert.equal(exit.exitCode, 0, program.screen());
}

describe("the compile cache of an interactive session", () => {
	test(
		"the first session after an install writes no compile cache when it quits, and the next one reads it (#6132)",
		async () => {
			const fixture = sessionFixture("atomic-compile-cache-warmup-");
			let program: PtyProgram | undefined;
			try {
				// Ignoring the project's files keeps this session in one process, as an unanswered trust question does.
				program = fixture.start(["--no-approve"]);
				await program.waitForScreen(
					(screen) => screen.includes("❯") && fixture.readReports().length === 1,
					CLI_TIMEOUT_MS,
					"the first session",
				);
				const [first] = fixture.readReports();
				assert.ok(first, "the session reported its compile cache");
				if (!windows) {
					// Elsewhere the exit-time write is short, and the cache works as it always did.
					assert.notEqual(first.cacheDir, null);
					await quit(program);
					return;
				}
				assert.equal(first.cacheDir, null, "a session with a cold cache runs without it");
				await waitForWarmCache(fixture.cacheBase, first);
				const beforeQuit = cacheFiles(fixture.cacheBase);
				await quit(program);
				assert.deepEqual(
					writtenBetween(beforeQuit, cacheFiles(fixture.cacheBase)),
					[],
					"quitting wrote compile cache files",
				);

				program = fixture.start(["--no-approve"]);
				await program.waitForScreen(
					(screen) => screen.includes("❯") && fixture.readReports().length === 2,
					CLI_TIMEOUT_MS,
					"the second session",
				);
				assert.notEqual(fixture.readReports()[1]?.cacheDir ?? null, null, "the next session reads the warm cache");
				await quit(program);
			} finally {
				program?.kill();
				await program?.exited;
				await removeTempRootReleasingBroker(fixture.root, fixture.agentDir);
			}
		},
		SESSIONS_TIMEOUT_MS,
	);

	test(
		"the engine of a session with a cold cache leaves it to the helper as well (#6132)",
		async () => {
			const fixture = sessionFixture("atomic-compile-cache-engine-");
			let program: PtyProgram | undefined;
			try {
				program = fixture.start([]);
				await program.waitForScreen(
					(screen) => screen.includes("❯") && fixture.readReports().length === 1,
					CLI_TIMEOUT_MS,
					"the session",
				);
				// The engine runs the session, so the report comes from the engine.
				const [engine] = fixture.readReports();
				assert.ok(engine, "the engine reported its compile cache");
				assert.equal(engine.cacheDir === null, windows);
				await quit(program);
			} finally {
				program?.kill();
				await program?.exited;
				await removeTempRootReleasingBroker(fixture.root, fixture.agentDir);
			}
		},
		CLI_TIMEOUT_MS + 30_000,
	);
});

/** Copy the package's files an upgrade replaces, sharing its dependencies except the native module. */
function copyInstallation(target: string): string {
	cpSync(join(PACKAGE, "dist"), join(target, "dist"), { recursive: true });
	cpSync(join(PACKAGE, "package.json"), join(target, "package.json"));
	const modules = join(REPO, "node_modules");
	mkdirSync(join(target, "node_modules", "@bastani"), { recursive: true });
	for (const name of readdirSync(modules)) {
		if (name === "@bastani" || name.startsWith(".")) continue;
		symlinkSync(join(modules, name), join(target, "node_modules", name), "junction");
	}
	for (const name of readdirSync(join(modules, "@bastani"))) {
		const from = join(modules, "@bastani", name);
		const to = join(target, "node_modules", "@bastani", name);
		if (name === "atomic-natives") cpSync(from, to, { recursive: true, dereference: true });
		else symlinkSync(from, to, "junction");
	}
	return join(target, "dist", "utils", "compile-cache-warmup.js");
}

/** A copied installation and a helper that loads the whole module graph from it. */
const HELPER_RUN_TIMEOUT_MS = 180_000;

test(
	"a helper that cannot load the session's modules leaves the cache unmarked (#6132)",
	async () => {
		const root = makeTempDirectory("atomic-compile-cache-partial-");
		const installation = join(root, "installation");
		const temp = join(root, "temp");
		mkdirSync(temp, { recursive: true });
		let helper: ChildProcess | undefined;
		try {
			const script = copyInstallation(installation);
			// An installation an upgrade is replacing: part of it is already gone.
			rmSync(join(installation, "dist", "index.js"));
			const launch = compileCacheHelperLaunch({ execArgv: [], nodeOptions: "" }, "partial-test", script, {
				...process.env,
				TEMP: temp,
				TMP: temp,
				TMPDIR: temp,
				NODE_COMPILE_CACHE: "",
			});
			helper = spawn(launch.command, [...launch.args], {
				cwd: launch.cwd,
				env: launch.env,
				detached: launch.detached,
				stdio: ["pipe", "ignore", "ignore"],
			});
			const code = await new Promise<number | null>((resolve) => helper!.once("exit", resolve));
			assert.notEqual(code, 0);
			const cacheBase = join(temp, "node-compile-cache");
			const markers = [...cacheFiles(cacheBase).keys()].filter((path) => /atomic-warm-/.test(path));
			assert.deepEqual(markers, []);
		} finally {
			if (helper && helper.exitCode === null) helper.kill();
			rmSync(root, { recursive: true, force: true, maxRetries: 10 });
		}
	},
	HELPER_RUN_TIMEOUT_MS,
);

/** An upgrade replaces a few hundred files; the helper loads the module graph from them meanwhile. */
const UPGRADE_DURING_WARMUP_TIMEOUT_MS = 180_000;

test.skipIf(!windows)(
	"an upgrade or an uninstall while the compile cache warms succeeds (#6132)",
	async () => {
		const root = makeTempDirectory("atomic-compile-cache-upgrade-");
		const installation = join(root, "installation");
		const temp = join(root, "temp");
		mkdirSync(temp, { recursive: true });
		let helper: ChildProcess | undefined;
		try {
			const script = copyInstallation(installation);
			const launch = compileCacheHelperLaunch({ execArgv: [], nodeOptions: "" }, "upgrade-test", script, {
				...process.env,
				TEMP: temp,
				TMP: temp,
				NODE_COMPILE_CACHE: "",
			});
			helper = spawn(launch.command, [...launch.args], {
				cwd: launch.cwd,
				env: launch.env,
				detached: launch.detached,
				stdio: ["pipe", "ignore", "ignore"],
			});
			const exited = new Promise<number | null>((resolve) => helper!.once("exit", resolve));
			const cacheBase = join(temp, "node-compile-cache");
			const deadline = Date.now() + HELPER_WAIT_MS;
			// Wait until it holds the build lock and has compiled part of the graph.
			while (!warmupRunning(cacheBase) || cacheEntryCount(cacheBase) < 100) {
				if (helper.exitCode !== null || Date.now() >= deadline) {
					throw new Error(`The helper did not start warming: exit ${helper.exitCode}`);
				}
				await sleep(POLL_MS);
			}
			// An uninstall removes every file of the installation, the native module included.
			rmSync(installation, { recursive: true });
			assert.equal(existsSync(installation), false);
			helper.kill();
			await exited;
		} finally {
			if (helper && helper.exitCode === null) helper.kill();
			rmSync(root, { recursive: true, force: true, maxRetries: 10 });
		}
	},
	UPGRADE_DURING_WARMUP_TIMEOUT_MS,
);
