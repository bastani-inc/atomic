import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { VERSION } from "../../packages/coding-agent/src/config.js";
import {
	machineStartTimeMs,
	STARTUP_FILES_READ_MARKER,
	startStartupPrefetch,
	startupFilesReadThisStart,
} from "../../packages/coding-agent/src/utils/startup-prefetch.ts";
import {
	readStartupFiles,
	readsFoundFilesInMemory,
	startupFilePaths,
} from "../../packages/coding-agent/src/utils/startup-prefetch-reader.ts";
import { NODE_TS_SOURCE_HOOK } from "../helpers/node-ts-sources.js";
import { isGone, recordProcess, signalRecordedProcess, waitUntilGone } from "../helpers/recorded-process.js";
import { spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const codingAgent = new URL("../../packages/coding-agent/", import.meta.url);
// The package bundles the module that starts the reader into its CLI, and ships the reader, which runs by path, as a file.
const prefetchModule = new URL("src/utils/startup-prefetch.ts", codingAgent).href;
const readerModule = new URL("dist/utils/startup-prefetch-reader.js", codingAgent).href;
/** One child process start: generous, since the child is only waited on. */
const CHILD_TIMEOUT_MS = 20_000;
/** How long a reader that outlived its parent may take to be ended. */
const READER_EXIT_TIMEOUT_MS = 10_000;

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-startup-prefetch-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function file(path: string, content = "x"): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

test("the reader finds each package where Node would and reads every listed file that exists", async () => {
	const nodeModules = join(dir, "app", "node_modules");
	const atomic = join(nodeModules, "@bastani", "atomic");
	file(join(atomic, "dist", "main.js"));
	// A package installed both beside Atomic and inside it: Node takes the copy inside, and so does the reader.
	file(join(atomic, "node_modules", "dep", "inner.js"));
	file(join(nodeModules, "dep", "outer.js"));
	file(join(nodeModules, "@scope", "pkg", "lib", "index.mjs"));
	// A native addon that ships every platform's build, and a platform package with this one's: Node loads only the
	// package's own build for this platform.
	file(join(nodeModules, "@bastani", "atomic-natives", "native", "index.js"));
	for (const build of ["win32-x64-msvc", "win32-arm64-msvc", "linux-x64-gnu", "darwin-arm64"])
		file(join(nodeModules, "@bastani", "atomic-natives", "native", `atomic_natives.${build}.node`));
	const platformPackage = join(nodeModules, "@bastani", `atomic-natives-win32-${process.arch}-msvc`);
	file(
		join(platformPackage, "package.json"),
		JSON.stringify({ main: `atomic_natives.win32-${process.arch}-msvc.node` }),
	);
	file(join(platformPackage, `atomic_natives.win32-${process.arch}-msvc.node`));
	// A package above the installation's own node_modules, where Node could look but the reader never does.
	file(join(dir, "node_modules", "outside", "index.js"));
	// Nothing outside a package, and no FIFO a different install could name where a file was.
	file(join(nodeModules, "@bastani", "escape.js"));
	if (process.platform !== "win32") {
		mkdirSync(join(atomic, "dist"), { recursive: true });
		assert.equal(spawnSyncCollect(["mkfifo", join(atomic, "dist", "fifo.js")]).exitCode, 0);
	}
	const list = file(
		join(atomic, "dist", "startup-files.json"),
		JSON.stringify({
			version: 2,
			self: "@bastani/atomic",
			packages: [
				["@bastani/atomic", -1],
				["dep", 0],
				["@scope/pkg", 0],
				["absent", 0],
				["@bastani/atomic-natives", 0],
				["outside", 0],
			],
			files: [
				[0, "dist/main.js"],
				[1, "inner.js"],
				[1, "outer.js"],
				[2, "lib/index.mjs"],
				[3, "gone.js"],
				[0, "dist/removed.js"],
				[0, "../escape.js"],
				[0, "dist/fifo.js"],
				[4, "native/index.js"],
				[5, "index.js"],
			],
		}),
	);

	// main.js, dep/inner.js from the nearer copy, @scope/pkg, the natives' index.js and, on Windows (the only platform
	// the reader runs on), the one build of the addon Node loads there, an x64 or arm64 one.
	const nativeBuild = process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64") ? 1 : 0;
	assert.equal(await readStartupFiles(list, atomic), 4 + nativeBuild);
});

test.runIf(process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64"))(
	"without its own build for this platform, the reader reads the addon's platform package's build, and no other",
	async () => {
		const nodeModules = join(dir, "app", "node_modules");
		const atomic = join(nodeModules, "@bastani", "atomic");
		file(join(nodeModules, "@bastani", "atomic-natives", "native", "index.js"));
		file(join(nodeModules, "@bastani", "atomic-natives", "native", "atomic_natives.linux-x64-gnu.node"));
		const platformPackage = join(nodeModules, "@bastani", `atomic-natives-win32-${process.arch}-msvc`);
		file(
			join(platformPackage, "package.json"),
			JSON.stringify({ main: `atomic_natives.win32-${process.arch}-msvc.node` }),
		);
		file(join(platformPackage, `atomic_natives.win32-${process.arch}-msvc.node`));
		const list = file(
			join(atomic, "dist", "startup-files.json"),
			JSON.stringify({
				version: 2,
				self: "@bastani/atomic",
				packages: [["@bastani/atomic-natives", -1]],
				files: [],
			}),
		);
		assert.equal(await readStartupFiles(list, atomic), 1);
	},
);

test("the reader reads nothing above the installation's own node_modules", async () => {
	const atomic = join(dir, "app", "node_modules", "@bastani", "atomic");
	file(join(dir, "node_modules", "outside", "index.js"));
	const list = file(
		join(atomic, "dist", "startup-files.json"),
		JSON.stringify({ version: 2, self: "@bastani/atomic", packages: [["outside", -1]], files: [[0, "index.js"]] }),
	);
	assert.equal(await readStartupFiles(list, atomic), 0);
});

test("the reader finds a package from the package that imports it, as Node does: a copy nested there first", async () => {
	const atomic = join(dir, "app", "node_modules", "@bastani", "atomic");
	// proper-lockfile's own copy of retry, and another version of retry beside Atomic's other packages.
	file(join(atomic, "node_modules", "proper-lockfile", "index.js"));
	file(join(atomic, "node_modules", "proper-lockfile", "node_modules", "retry", "nested.js"));
	file(join(atomic, "node_modules", "retry", "hoisted.js"));
	const list = file(
		join(atomic, "dist", "startup-files.json"),
		JSON.stringify({
			version: 2,
			self: "@bastani/atomic",
			packages: [
				["@bastani/atomic", -1],
				["proper-lockfile", 0],
				["retry", 1],
			],
			files: [
				[1, "index.js"],
				[2, "nested.js"],
				[2, "hoisted.js"],
			],
		}),
	);
	// proper-lockfile's index.js and its own retry's nested.js; never the other retry's file.
	assert.equal(await readStartupFiles(list, atomic), 2);
});

test("a list of another version reads nothing", async () => {
	const list = file(
		join(dir, "startup-files.json"),
		JSON.stringify({ version: 3, self: "x", packages: [], files: [] }),
	);
	assert.equal(await readStartupFiles(list, dir), 0);
});

test("the built list names files that this build loads, and the reader finds every one of them", async () => {
	const listPath = new URL("dist/startup-files.json", codingAgent);
	const list = JSON.parse(readFileSync(listPath, "utf8")) as {
		self: string;
		packages: [string, number][];
		files: [number, string][];
	};
	assert.equal(list.self, "@bastani/atomic");
	assert.ok(
		list.files.some(([index, path]) => list.packages[index]?.[0] === "@bastani/atomic" && path === "dist/main.js"),
	);
	const { modules } = await startupFilePaths(fileURLToPath(listPath), fileURLToPath(codingAgent));
	assert.equal(modules.length, list.files.length);
	const missing = modules.filter((path) => !existsSync(path));
	assert.deepEqual(missing, []);
});

test("files missing at the end of the list say nothing about a warm start: the reader reads every file there is", async () => {
	const atomic = join(dir, "app", "node_modules", "@bastani", "atomic");
	const files: [number, string][] = [];
	for (let index = 0; index < 64; index++) {
		// The last 16, which the reader times first, are gone, as after an upgrade that dropped them.
		if (index < 48) file(join(atomic, "dist", `module-${index}.js`));
		files.push([0, `dist/module-${index}.js`]);
	}
	const list = file(
		join(atomic, "dist", "startup-files.json"),
		JSON.stringify({ version: 2, self: "@bastani/atomic", packages: [["@bastani/atomic", -1]], files }),
	);
	// One read at a time beside the timed ones, as on a machine with one CPU: the reader must not stop early.
	const result = spawnSyncCollect(
		[
			process.execPath,
			"--input-type=module",
			"-e",
			`const { readStartupFiles } = await import(${JSON.stringify(readerModule)});
process.stdout.write(String(await readStartupFiles(${JSON.stringify(list)}, ${JSON.stringify(atomic)})));`,
		],
		{ env: { ...process.env, UV_THREADPOOL_SIZE: "1", NODE_OPTIONS: "" }, timeout: CHILD_TIMEOUT_MS },
	);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.equal(result.stdout.toString(), "48");
});

test("reads that found their files in memory tell a warm start from a first one, by their median", () => {
	assert.equal(readsFoundFilesInMemory([0.1, 0.3, 0.2, 0.4, 0.2, 0.3, 0.1, 0.2]), true);
	assert.equal(readsFoundFilesInMemory([0.2, 1.5, 40, 0.9, 0.1, 0.3, 0.2, 0.4, 0.5]), true);
	// After a restart, the disk and the antivirus scan make most of the first reads slow.
	assert.equal(readsFoundFilesInMemory([0.2, 12, 40, 9, 0.1, 15, 11, 30, 7]), false);
	// Too few reads tell nothing (files that are missing are no reads).
	assert.equal(readsFoundFilesInMemory([0.1, 0.2, 0.1]), false);
	assert.equal(readsFoundFilesInMemory([]), false);
});

interface ReaderStart {
	readonly priority: number;
	readonly argv: string[];
	readonly threads: string | undefined;
	readonly nodeOptions: string | undefined;
	readonly pid: number;
	readonly cwd: string;
}

const marker = () => join(dir, "reader-started.json");
const agentDir = () => join(dir, "agent");

/**
 * A package directory whose reader only records how it was started and then waits, and a parent script that runs
 * `startStartupPrefetch` for it, waits for the reader to record, prints how many readers it started, and then exits or
 * (`stay`) keeps running.
 */
function prefetchFixture(stay: boolean): string {
	// A record an earlier start's reader left would end the parent's wait before this start's reader has recorded.
	rmSync(marker(), { force: true });
	const packageDir = join(dir, "package");
	file(join(packageDir, "dist", "startup-files.json"), "{}");
	file(
		join(packageDir, "dist", "utils", "startup-prefetch-reader.js"),
		`import { renameSync, writeFileSync } from "node:fs";
// Written beside it, then renamed into place: the parent stops waiting once the record exists, and reads it whole.
writeFileSync(${JSON.stringify(`${marker()}.tmp`)}, JSON.stringify({
	priority: (await import("node:os")).getPriority(),
	argv: process.argv.slice(2),
	threads: process.env.UV_THREADPOOL_SIZE,
	nodeOptions: process.env.NODE_OPTIONS,
	pid: process.pid,
	cwd: process.cwd(),
}));
renameSync(${JSON.stringify(`${marker()}.tmp`)}, ${JSON.stringify(marker())});
// Ends only when its standard input does, as the real reader does once its parent is gone.
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
setTimeout(() => {}, 60_000);
`,
	);
	file(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
	return file(
		join(dir, "parent.mjs"),
		// The source's hook is registered by the script: with \`--import\`, no reader would start.
		`${NODE_TS_SOURCE_HOOK}
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
let started = 0;
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => { started++; return spawn(...args); };
syncBuiltinESMExports();
const { startStartupPrefetch } = await import(${JSON.stringify(prefetchModule)});
startStartupPrefetch(${JSON.stringify(packageDir)});
if (started > 0) while (!existsSync(${JSON.stringify(marker())})) await new Promise((resolve) => setTimeout(resolve, 10));
console.log(JSON.stringify({ started }));
${stay ? "setInterval(() => {}, 1000);" : ""}
`,
	);
}

/** Runs the parent to its end; returns how its reader was started, or undefined when it started none. */
function startPrefetchIn(nodeFlags: readonly string[] = [], env: Record<string, string> = {}): ReaderStart | undefined {
	const parent = prefetchFixture(false);
	const result = spawnSyncCollect([process.execPath, ...nodeFlags, parent], {
		// Not the test's directory: the reader takes the parent's, and on Windows a directory a process still ending
		// is in cannot be removed.
		cwd: tmpdir(),
		stdout: "pipe",
		stderr: "pipe",
		timeout: CHILD_TIMEOUT_MS,
		env: {
			...process.env,
			NODE_OPTIONS: "--max-old-space-size=4096",
			ATOMIC_CODING_AGENT_DIR: agentDir(),
			...env,
		},
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const { started } = JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "{}") as { started: number };
	if (started === 0) return undefined;
	assert.equal(started, 1);
	return JSON.parse(readFileSync(marker(), "utf8")) as ReaderStart;
}

async function expectGone(pid: number): Promise<void> {
	const reader = await recordProcess(pid);
	try {
		assert.equal(await waitUntilGone(reader, READER_EXIT_TIMEOUT_MS), true, "the reader ended with its parent");
	} finally {
		if (!(await isGone(reader))) await signalRecordedProcess(reader, "SIGKILL");
	}
}

test.runIf(process.platform === "win32")(
	"an interactive start on Windows reads its files in a reader process of its own, which ends with it",
	async () => {
		const start = startPrefetchIn();
		assert.ok(start, "a reader started");
		const packageDir = join(dir, "package");
		assert.deepEqual(start.argv, [
			join(packageDir, "dist", "startup-files.json"),
			packageDir,
			join(agentDir(), STARTUP_FILES_READ_MARKER),
			VERSION,
		]);
		// The reader's I/O pool is its own, sized by the CPUs, and nothing of the user's NODE_OPTIONS runs in it.
		const threads = Number(start.threads);
		assert.ok(threads >= 4 && threads <= Math.min(32, Math.max(4, 4 * availableParallelism())), `${threads} threads`);
		assert.equal(start.nodeOptions, "");
		// It runs below Atomic's own priority and outside the package directory and caller's cwd.
		assert.equal(start.priority, constants.priority.PRIORITY_BELOW_NORMAL);
		assert.ok(
			start.cwd.length < 248 && !start.cwd.startsWith("\\\\?\\"),
			`expected short safe cwd, got ${start.cwd}`,
		);
		assert.equal(
			start.cwd.toLowerCase().startsWith(packageDir.toLowerCase()),
			false,
			`reader cwd ${start.cwd} pinned ${packageDir}`,
		);
		assert.notEqual(start.cwd.toLowerCase(), tmpdir().toLowerCase(), `reader cwd ${start.cwd} inherited parent cwd`);
		await expectGone(start.pid);
	},
);

test.runIf(process.platform === "win32")(
	"a start after the files were read since the machine started starts no reader; another start, version or install does",
	() => {
		const packageDir = join(dir, "package");
		const markerPath = join(agentDir(), STARTUP_FILES_READ_MARKER);
		const record = (version: string, install: string, bootTimeMs: number) =>
			file(markerPath, JSON.stringify({ version, install, bootTimeMs }));
		record(VERSION, packageDir, machineStartTimeMs());
		assert.equal(startPrefetchIn(), undefined, "read since this start");
		record(VERSION, packageDir, machineStartTimeMs() - 24 * 60 * 60 * 1000);
		assert.ok(startPrefetchIn(), "read before the machine last started");
		record("0.0.1-other", packageDir, machineStartTimeMs());
		assert.ok(startPrefetchIn(), "read by another version");
		record(VERSION, join(dir, "other-install"), machineStartTimeMs());
		assert.ok(startPrefetchIn(), "read for another installation");
		file(markerPath, "{not json");
		assert.ok(startPrefetchIn(), "a marker that cannot be read");
	},
);

test("the marker tells this installation's files read since the machine started from anything else", () => {
	const now = machineStartTimeMs();
	const marker = (fields: Record<string, unknown>) => JSON.stringify({ version: "1.2.3", install: "/a", ...fields });
	assert.equal(startupFilesReadThisStart(marker({ bootTimeMs: now }), "1.2.3", "/a", now), true);
	// The clock moved a little since: the same start.
	assert.equal(startupFilesReadThisStart(marker({ bootTimeMs: now - 3_000 }), "1.2.3", "/a", now), true);
	assert.equal(startupFilesReadThisStart(marker({ bootTimeMs: now - 60 * 60 * 1000 }), "1.2.3", "/a", now), false);
	assert.equal(startupFilesReadThisStart(marker({ bootTimeMs: now }), "1.2.4", "/a", now), false);
	assert.equal(startupFilesReadThisStart(marker({ bootTimeMs: now }), "1.2.3", "/b", now), false);
	assert.equal(startupFilesReadThisStart(marker({ bootTimeMs: "now" }), "1.2.3", "/a", now), false);
	assert.equal(startupFilesReadThisStart("{not json", "1.2.3", "/a", now), false);
	assert.equal(startupFilesReadThisStart(undefined, "1.2.3", "/a", now), false);
});

test("the reader records that it read the files, only where the agent directory exists and it read some", async () => {
	const atomic = join(dir, "app", "node_modules", "@bastani", "atomic");
	file(join(atomic, "dist", "main.js"));
	const list = file(
		join(atomic, "dist", "startup-files.json"),
		JSON.stringify({
			version: 2,
			self: "@bastani/atomic",
			packages: [["@bastani/atomic", -1]],
			files: [[0, "dist/main.js"]],
		}),
	);
	// Its standard input stays open, as its parent's pipe does: it ends once it has read the files.
	const runReader = async (markerPath: string) => {
		const reader = spawnProcess([process.execPath, fileURLToPath(readerModule), list, atomic, markerPath, "1.2.3"], {
			env: { ...process.env, NODE_OPTIONS: "" },
			timeout: CHILD_TIMEOUT_MS,
			stdin: "pipe",
		});
		assert.equal(await reader.exited, 0);
	};
	mkdirSync(agentDir(), { recursive: true });
	const markerPath = join(agentDir(), STARTUP_FILES_READ_MARKER);
	await runReader(markerPath);
	const read = JSON.parse(readFileSync(markerPath, "utf8")) as {
		version: string;
		install: string;
		bootTimeMs: number;
	};
	assert.equal(read.version, "1.2.3");
	assert.equal(read.install, atomic);
	assert.ok(startupFilesReadThisStart(JSON.stringify(read), "1.2.3", atomic, machineStartTimeMs()));
	const elsewhere = join(dir, "no-agent-dir", STARTUP_FILES_READ_MARKER);
	await runReader(elsewhere);
	// A list naming nothing it could read records nothing either: the next start reads again.
	rmSync(markerPath);
	rmSync(join(atomic, "dist", "main.js"));
	await runReader(markerPath);
	assert.equal(existsSync(markerPath), false);
	assert.equal(existsSync(elsewhere), false);
	assert.equal(existsSync(dirname(elsewhere)), false);
});

test.runIf(process.platform === "win32")("the reader ends when its parent is killed", async () => {
	const parentScript = prefetchFixture(true);
	const parent = spawnProcess([process.execPath, parentScript], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
	assert.ok(parent.pid !== undefined);
	const recordedParent = await recordProcess(parent.pid);
	try {
		// Until the reader records its start, or the parent ends without one.
		const deadline = Date.now() + CHILD_TIMEOUT_MS;
		while (!existsSync(marker()) && parent.exitCode === null && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(existsSync(marker()), "the reader started");
		const start = JSON.parse(readFileSync(marker(), "utf8")) as ReaderStart;
		await signalRecordedProcess(recordedParent, "SIGKILL");
		await expectGone(start.pid);
	} finally {
		if (!(await isGone(recordedParent))) await signalRecordedProcess(recordedParent, "SIGKILL");
	}
});

test.runIf(process.platform === "win32")(
	"no reader starts in a process that runs a preload, which the reader would run too",
	() => {
		const preload = file(join(dir, "preload.cjs"), "");
		assert.equal(startPrefetchIn(["--require", preload]), undefined);
	},
);

test.runIf(process.platform === "win32")(
	"no reader starts when the package directory is overridden: it then names assets, not this installation's code",
	() => {
		assert.equal(startPrefetchIn([], { ATOMIC_PACKAGE_DIR: join(dir, "package") }), undefined);
	},
);

test.runIf(process.platform === "win32")("no reader starts when the user sets Node's I/O pool size", () => {
	assert.equal(startPrefetchIn([], { UV_THREADPOOL_SIZE: "1" }), undefined);
});

test.skipIf(process.platform === "win32")("no reader starts outside Windows", () => {
	assert.equal(startPrefetchIn(), undefined);
});

test("no reader starts without the list the build writes", () => {
	const packageDir = join(dir, "bare");
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	startStartupPrefetch(packageDir);
	assert.equal(existsSync(marker()), false);
	assert.ok(pathToFileURL(packageDir));
});
