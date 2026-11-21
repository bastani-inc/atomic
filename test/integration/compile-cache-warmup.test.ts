import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	cpSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
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
const CLI_TIMEOUT_MS = 90_000;
/** How long the helpers may take to load and write the module graph on a loaded runner. */
const HELPER_WAIT_MS = 120_000;
/** Two real CLI sessions in a terminal, waiting between them for the helpers to warm the cache and end. */
const SESSIONS_TIMEOUT_MS = 2 * CLI_TIMEOUT_MS + 3 * HELPER_WAIT_MS;
/** One CLI session, then waiting for its helpers to end. */
const SESSION_AND_HELPERS_TIMEOUT_MS = CLI_TIMEOUT_MS + HELPER_WAIT_MS + 30_000;
const POLL_MS = 50;
/** Longer than a session takes after its first frame to start a helper for a cold cache. */
const WARM_SESSION_HELPER_WINDOW_MS = 3_000;
const windows = process.platform === "win32";
/** The sessions run the CLI with this runtime, and the compile cache handling they check is Node's. */
const onNode = !("bun" in process.versions);

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

/** This checkout's helper script; other jobs on the machine run their own. */
const HELPER_SCRIPT = join(PACKAGE, "dist", "utils", "compile-cache-warmup.js");

/** Compile-cache helpers of this checkout running now, by their command line. */
function helperProcesses(): number {
	const query = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			`@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${HELPER_SCRIPT}') }).Count`,
		],
		{ encoding: "utf8", timeout: 60_000 },
	);
	assert.equal(query.status, 0, query.stderr);
	return Number(query.stdout.trim());
}

/** Wait until no helper runs: a helper starts the next one of its chain before it ends, so none means all ended. */
async function waitForNoHelper(): Promise<void> {
	const deadline = Date.now() + HELPER_WAIT_MS;
	while (helperProcesses() > 0) {
		if (Date.now() >= deadline) throw new Error(`A compile-cache helper still runs after ${HELPER_WAIT_MS} ms`);
		await sleep(500);
	}
}

/** Wait until a helper holds the build lock. */
async function waitForWarmupStart(cacheBase: string): Promise<void> {
	const deadline = Date.now() + HELPER_WAIT_MS;
	while (!warmupRunning(cacheBase)) {
		if (Date.now() >= deadline) throw new Error(`No compile-cache helper started within ${HELPER_WAIT_MS} ms`);
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
		// A terminal adds the runner's environment to these, and no helper starts under CI.
		CI: "0",
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

describe.skipIf(!onNode)("the compile cache of an interactive session", () => {
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
				if (windows) await waitForNoHelper();
				await removeTempRootReleasingBroker(fixture.root, fixture.agentDir);
			}
		},
		SESSIONS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"a session that quits as soon as its helper starts still leaves the cache warm, and a warm session starts no helper (#6132)",
		async () => {
			const fixture = sessionFixture("atomic-compile-cache-short-");
			let program: PtyProgram | undefined;
			try {
				program = fixture.start(["--no-approve"]);
				await program.waitForScreen(
					(screen) => screen.includes("❯") && fixture.readReports().length === 1,
					CLI_TIMEOUT_MS,
					"the first session",
				);
				const [first] = fixture.readReports();
				assert.equal(first?.cacheDir, null, "a session with a cold cache runs without it");
				await waitForWarmupStart(fixture.cacheBase);
				await quit(program);
				// The helper goes on after its session and finishes warming the cache.
				await waitForWarmCache(fixture.cacheBase, first!);
				await waitForNoHelper();

				program = fixture.start(["--no-approve"]);
				await program.waitForScreen(
					(screen) => screen.includes("❯") && fixture.readReports().length === 2,
					CLI_TIMEOUT_MS,
					"the second session",
				);
				assert.notEqual(fixture.readReports()[1]?.cacheDir ?? null, null, "the next session reads the warm cache");
				// Past the point where a session with a cold cache starts its helper.
				await sleep(WARM_SESSION_HELPER_WINDOW_MS);
				assert.equal(helperProcesses(), 0, "a session with a warm cache starts no helper");
				await quit(program);
			} finally {
				program?.kill();
				await program?.exited;
				if (windows) await waitForNoHelper();
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
				// A helper may still finish the cache this session left cold.
				if (windows) await waitForNoHelper();
				await removeTempRootReleasingBroker(fixture.root, fixture.agentDir);
			}
		},
		SESSION_AND_HELPERS_TIMEOUT_MS,
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

test.skipIf(!onNode)(
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

/** How soon a helper ends once its installation starts to change, on a loaded runner. */
const STAND_DOWN_BOUND_MS = 5_000;

test.skipIf(!onNode).each(["moves the old package aside", "puts a new package beside it"])(
	"a helper stands down as soon as an installer %s, leaving no marker (#6132)",
	async (change) => {
		const root = makeTempDirectory("atomic-compile-cache-stand-down-");
		const installation = join(root, "node_modules", "atomic");
		const temp = join(root, "temp");
		mkdirSync(temp, { recursive: true });
		let helper: ChildProcess | undefined;
		try {
			const script = copyInstallation(installation);
			const launch = compileCacheHelperLaunch({ execArgv: [], nodeOptions: "" }, "stand-down-test", script, {
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
			const exited = new Promise<number | null>((resolve) => helper!.once("exit", () => resolve(Date.now())));
			const cacheBase = join(temp, "node-compile-cache");
			const deadline = Date.now() + HELPER_WAIT_MS;
			while (cacheEntryCount(cacheBase) === 0 && helper.exitCode === null) {
				if (Date.now() >= deadline) throw new Error("The helper did not start warming");
				await sleep(POLL_MS);
			}
			assert.equal(helper.exitCode, null, "the helper still warms");
			const changedAt = Date.now();
			if (change === "moves the old package aside") {
				// What npm does first when it replaces or removes a package.
				renameSync(installation, join(root, "node_modules", ".atomic-retired"));
			} else {
				// An installer that unpacks the new package next to the old one before it swaps them.
				mkdirSync(join(root, "node_modules", ".atomic-staged"));
			}
			const endedAt = await exited;
			assert.ok(
				endedAt !== null && endedAt - changedAt < STAND_DOWN_BOUND_MS,
				`ended ${endedAt! - changedAt} ms later`,
			);
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

test.skipIf(!windows || !onNode).each(["an uninstall", "an upgrade"])(
	"%s while the compile cache warms succeeds (#6132)",
	async (change) => {
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
			if (change === "an uninstall") {
				// An uninstall removes every file of the installation, the native module included.
				rmSync(installation, { recursive: true });
				assert.equal(existsSync(installation), false);
			} else {
				// An upgrade moves the installation aside, puts the new one in its place and removes the old one.
				renameSync(installation, `${installation}.old`);
				copyInstallation(installation);
				rmSync(`${installation}.old`, { recursive: true });
				assert.equal(existsSync(`${installation}.old`), false);
			}
			helper.kill();
			await exited;
		} finally {
			if (helper && helper.exitCode === null) helper.kill();
			rmSync(root, { recursive: true, force: true, maxRetries: 10 });
		}
	},
	UPGRADE_DURING_WARMUP_TIMEOUT_MS,
);
