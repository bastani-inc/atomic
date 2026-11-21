import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { readStartupFiles } from "../../packages/coding-agent/src/utils/startup-prefetch-reader.ts";
import { isGone, recordProcess, signalRecordedProcess, waitUntilGone } from "../helpers/recorded-process.js";
import { spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const codingAgent = new URL("../../packages/coding-agent/", import.meta.url);
const prefetchModule = new URL("dist/utils/startup-prefetch.js", codingAgent).href;
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
	// A native addon whose build for this platform is a package of its own beside it.
	file(join(nodeModules, "@bastani", "atomic-natives", "native", "index.js"));
	file(join(nodeModules, "@bastani", "atomic-natives-test-x64", "atomic_natives.test-x64.node"));
	// Nothing outside a package, and no FIFO a different install could name where a file was.
	file(join(nodeModules, "@bastani", "escape.js"));
	if (process.platform !== "win32") {
		mkdirSync(join(atomic, "dist"), { recursive: true });
		assert.equal(spawnSyncCollect(["mkfifo", join(atomic, "dist", "fifo.js")]).exitCode, 0);
	}
	const list = file(
		join(atomic, "dist", "startup-files.json"),
		JSON.stringify({
			version: 1,
			self: "@bastani/atomic",
			packages: ["@bastani/atomic", "dep", "@scope/pkg", "absent", "@bastani/atomic-natives"],
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
			],
		}),
	);

	// main.js, dep/inner.js from the nearer copy, @scope/pkg, the natives' index.js and its platform addon.
	assert.equal(await readStartupFiles(list, atomic), 5);
});

test("a list of another version reads nothing", async () => {
	const list = file(
		join(dir, "startup-files.json"),
		JSON.stringify({ version: 2, self: "x", packages: [], files: [] }),
	);
	assert.equal(await readStartupFiles(list, dir), 0);
});

test("the built list names files that this build loads, and the reader finds every one of them", async () => {
	const listPath = new URL("dist/startup-files.json", codingAgent);
	const list = JSON.parse(readFileSync(listPath, "utf8")) as {
		self: string;
		packages: string[];
		files: [number, string][];
	};
	assert.equal(list.self, "@bastani/atomic");
	assert.ok(list.files.some(([index, path]) => list.packages[index] === "@bastani/atomic" && path === "dist/main.js"));
	const read = await readStartupFiles(listPath.pathname, new URL(".", codingAgent).pathname);
	assert.ok(read >= list.files.length, `read ${read} of ${list.files.length}`);
});

interface ReaderStart {
	readonly argv: string[];
	readonly threads: string | undefined;
	readonly nodeOptions: string | undefined;
	readonly pid: number;
}

const marker = () => join(dir, "reader-started.json");

/**
 * A package directory whose reader only records how it was started and then waits, and a parent script that runs
 * `startStartupPrefetch` for it, waits for the reader to record, prints how many readers it started, and then exits or
 * (`stay`) keeps running.
 */
function prefetchFixture(stay: boolean): string {
	const packageDir = join(dir, "package");
	file(join(packageDir, "dist", "startup-files.json"), "{}");
	file(
		join(packageDir, "dist", "utils", "startup-prefetch-reader.js"),
		`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker())}, JSON.stringify({
	argv: process.argv.slice(2),
	threads: process.env.UV_THREADPOOL_SIZE,
	nodeOptions: process.env.NODE_OPTIONS,
	pid: process.pid,
}));
// Ends only when its standard input does, as the real reader does once its parent is gone.
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
setTimeout(() => {}, 60_000);
`,
	);
	file(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
	return file(
		join(dir, "parent.mjs"),
		`import childProcess from "node:child_process";
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
function startPrefetchIn(nodeFlags: readonly string[] = []): ReaderStart | undefined {
	const parent = prefetchFixture(false);
	const result = spawnSyncCollect([process.execPath, ...nodeFlags, parent], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		timeout: CHILD_TIMEOUT_MS,
		env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
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
		assert.deepEqual(start.argv, [join(packageDir, "dist", "startup-files.json"), packageDir]);
		// The reader's I/O pool is its own, and nothing of the user's NODE_OPTIONS runs in it.
		assert.equal(start.threads, "32");
		assert.equal(start.nodeOptions, "");
		await expectGone(start.pid);
	},
);

test.runIf(process.platform === "win32")("the reader ends when its parent is killed", async () => {
	const parentScript = prefetchFixture(true);
	const parent = spawnProcess([process.execPath, parentScript], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	assert.ok(parent.pid !== undefined);
	const recordedParent = await recordProcess(parent.pid);
	try {
		while (!existsSync(marker())) await new Promise((resolve) => setTimeout(resolve, 10));
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

test.skipIf(process.platform === "win32")("no reader starts outside Windows", () => {
	assert.equal(startPrefetchIn(), undefined);
});

test("no reader starts without the list the build writes", async () => {
	const packageDir = join(dir, "bare");
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	const { startStartupPrefetch } = (await import(prefetchModule)) as {
		startStartupPrefetch(packageDir: string): void;
	};
	startStartupPrefetch(packageDir);
	assert.equal(existsSync(marker()), false);
	assert.ok(pathToFileURL(packageDir));
});
