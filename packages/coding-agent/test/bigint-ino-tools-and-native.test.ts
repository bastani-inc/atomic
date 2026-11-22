import assert from "node:assert/strict";
import type * as nodeChildProcess from "node:child_process";
import type * as nodeFs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, type TestContext, test, vi } from "vitest";

const COLLIDING_INO_A = 0x00f9_0000_0003_9deen;
const COLLIDING_INO_B = 0x00f9_0000_0003_9defn;
const DEV = 42n;
const FIXED_SIZE = 4096n;
const FIXED_TIME_NS = 1_795_343_551_522_500_700n;
const EXEC_MODE = 0o100755n;

interface FakeFileMeta {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	mode: bigint;
}

const mocks = vi.hoisted(() => ({
	stats: new Map<string, FakeFileMeta>(),
	gitVersionOutput: "git version 2.45.0\n",
	gitProbeCalls: 0,
	nativeBinding: { nativeVersion: () => "0.10.4" } as { nativeVersion?: () => string },
	nativeCache: undefined as Record<string, unknown> | undefined,
}));

function buildFakeStats(base: nodeFs.Stats | nodeFs.BigIntStats, meta: FakeFileMeta, bigint: boolean) {
	const mtimeMs = Number(meta.mtimeNs / 1_000_000_000n) * 1000 + Number(meta.mtimeNs % 1_000_000_000n) / 1_000_000;
	const ctimeMs = Number(meta.ctimeNs / 1_000_000_000n) * 1000 + Number(meta.ctimeNs % 1_000_000_000n) / 1_000_000;
	if (bigint) {
		return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
			dev: meta.dev,
			ino: meta.ino,
			size: meta.size,
			mode: meta.mode,
			mtimeNs: meta.mtimeNs,
			mtimeMs: meta.mtimeNs / 1_000_000n,
			ctimeNs: meta.ctimeNs,
			ctimeMs: meta.ctimeNs / 1_000_000n,
		});
	}
	return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
		dev: Number(meta.dev),
		ino: Number(meta.ino),
		size: Number(meta.size),
		mode: Number(meta.mode),
		mtimeMs,
		ctimeMs,
	});
}

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	const statSync = ((path: nodeFs.PathLike, options?: nodeFs.StatSyncOptions) => {
		const result = actual.statSync(path, options as never);
		if (result === undefined) return undefined;
		const meta = mocks.stats.get(resolve(String(path)));
		if (meta === undefined) return result;
		return buildFakeStats(result, meta, options?.bigint === true);
	}) as typeof actual.statSync;
	return { ...actual, default: { ...actual, statSync }, statSync };
});

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>();
	const stat = (async (path: nodeFs.PathLike, options?: { bigint?: boolean }) => {
		const result = await actual.stat(path, options as never);
		const meta = mocks.stats.get(resolve(String(path)));
		if (meta === undefined) return result;
		return buildFakeStats(result, meta, options?.bigint === true);
	}) as typeof actual.stat;
	return { ...actual, default: { ...actual, stat }, stat };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const stat = (async (path: nodeFs.PathLike, options?: { bigint?: boolean }) => {
		const result = await actual.stat(path, options as never);
		const meta = mocks.stats.get(resolve(String(path)));
		if (meta === undefined) return result;
		return buildFakeStats(result, meta, options?.bigint === true);
	}) as typeof actual.stat;
	return { ...actual, default: { ...actual, stat }, stat };
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	const spawnSync = ((command: string, args?: readonly string[], options?: nodeChildProcess.SpawnSyncOptions) => {
		if (mocks.stats.has(resolve(command)) && args?.[0] === "--version") {
			mocks.gitProbeCalls++;
			return {
				pid: 0,
				output: [null, mocks.gitVersionOutput, ""],
				stdout: mocks.gitVersionOutput,
				stderr: "",
				status: 0,
				signal: null,
			};
		}
		return actual.spawnSync(command, args, options as never);
	}) as typeof actual.spawnSync;
	const execFile = ((
		file: string,
		args: readonly string[],
		options: unknown,
		callback?: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		const cb = typeof options === "function" ? (options as typeof callback) : callback;
		if (mocks.stats.has(resolve(file)) && args?.[0] === "--version" && cb) {
			mocks.gitProbeCalls++;
			queueMicrotask(() => cb(null, mocks.gitVersionOutput, ""));
			return {} as nodeChildProcess.ChildProcess;
		}
		return actual.execFile(file, args, options as never, callback as never);
	}) as typeof actual.execFile;
	return { ...actual, default: { ...actual, spawnSync, execFile }, spawnSync, execFile };
});

const { getGitStatus, getGitStatusAsync, resetGitProvisionStateForTest } = await import(
	"../src/utils/tools-manager.js"
);

afterEach(() => {
	mocks.stats.clear();
	mocks.gitProbeCalls = 0;
	mocks.gitVersionOutput = "git version 2.45.0\n";
	resetGitProvisionStateForTest();
	vi.unstubAllEnvs();
});

describe("64-bit BigInt file identity in tools-manager and native-module", () => {
	test("tools-manager invalidates cached system git probe (sync and async) when replaced with a colliding 64-bit inode", async (t: TestContext) => {
		assert.equal(Number(COLLIDING_INO_A), Number(COLLIDING_INO_B));

		const dir = realpathSync(mkdtempSync(join(tmpdir(), "atomic-bigint-git-")));
		t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const gitExe = join(binDir, process.platform === "win32" ? "git.exe" : "git");
		writeFileSync(gitExe, "stub");
		if (process.platform !== "win32") chmodSync(gitExe, 0o755);

		vi.stubEnv("PATH", binDir);
		if (process.platform === "win32") vi.stubEnv("Path", binDir);

		// First probe (sync): git 2.45.0 with colliding inode A.
		mocks.gitVersionOutput = "git version 2.45.0\n";
		mocks.stats.set(resolve(gitExe), {
			dev: DEV,
			ino: COLLIDING_INO_A,
			size: FIXED_SIZE,
			mtimeNs: FIXED_TIME_NS,
			ctimeNs: FIXED_TIME_NS,
			mode: EXEC_MODE,
		});
		const firstSync = getGitStatus();
		assert.equal(firstSync.source, "system");
		if (firstSync.source !== "system") return;
		assert.equal(firstSync.version, "2.45.0");
		assert.equal(mocks.gitProbeCalls, 1);

		// Same file probed asynchronously hits the shared cache without re-spawning.
		const cachedAsync = await getGitStatusAsync();
		assert.equal(cachedAsync.source, "system");
		if (cachedAsync.source !== "system") return;
		assert.equal(cachedAsync.version, "2.45.0");
		assert.equal(mocks.gitProbeCalls, 1, "unchanged git binary should hit shared cache");

		// Replace git binary with identical size, timestamps, and mode, but colliding 64-bit inode B.
		mocks.gitVersionOutput = "git version 2.46.1\n";
		mocks.stats.set(resolve(gitExe), {
			dev: DEV,
			ino: COLLIDING_INO_B,
			size: FIXED_SIZE,
			mtimeNs: FIXED_TIME_NS,
			ctimeNs: FIXED_TIME_NS,
			mode: EXEC_MODE,
		});

		const updatedSync = getGitStatus();
		assert.equal(updatedSync.source, "system");
		if (updatedSync.source !== "system") return;
		assert.equal(updatedSync.version, "2.46.1", "sync probe must invalidate cache on colliding 64-bit inode change");
		assert.equal(mocks.gitProbeCalls, 2);

		// Replace again (back to inode A) and verify async probe also invalidates cache.
		mocks.gitVersionOutput = "git version 2.47.0\n";
		mocks.stats.set(resolve(gitExe), {
			dev: DEV,
			ino: COLLIDING_INO_A,
			size: FIXED_SIZE,
			mtimeNs: FIXED_TIME_NS,
			ctimeNs: FIXED_TIME_NS,
			mode: EXEC_MODE,
		});
		const updatedAsync = await getGitStatusAsync();
		assert.equal(updatedAsync.source, "system");
		if (updatedAsync.source !== "system") return;
		assert.equal(
			updatedAsync.version,
			"2.47.0",
			"async probe must invalidate cache on colliding 64-bit inode change",
		);
		assert.equal(mocks.gitProbeCalls, 3);
	});

	test("native-module detects reinstall when the replacement binary has identical size/mtime and a colliding 64-bit inode", async (t: TestContext) => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "atomic-bigint-native-")));
		t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const file = join(dir, "node_modules/@bastani/atomic-natives-win32-x64-msvc/atomic_natives.win32-x64-msvc.node");
		const manifest = join(dir, "node_modules/@bastani/atomic-natives-win32-x64-msvc/package.json");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "old binary");
		writeFileSync(manifest, JSON.stringify({ version: "0.10.4" }));

		mocks.stats.set(resolve(file), {
			dev: DEV,
			ino: COLLIDING_INO_A,
			size: FIXED_SIZE,
			mtimeNs: FIXED_TIME_NS,
			ctimeNs: FIXED_TIME_NS,
			mode: EXEC_MODE,
		});

		vi.resetModules();
		vi.doMock("../src/config.js", async (importOriginal) => ({
			...(await importOriginal<typeof import("../src/config.js")>()),
			VERSION: "0.10.5",
			NATIVES_VERSION: "0.10.5",
			isBunBinary: false,
			detectInstallChangeAsync: async () => undefined,
		}));
		vi.doMock("../src/utils/module-require.js", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/utils/module-require.js")>();
			return {
				...actual,
				createModuleRequire: (url: string | URL) => {
					const real = actual.createModuleRequire(url);
					return Object.assign(
						(id: string) => (id === "@bastani/atomic-natives" ? mocks.nativeBinding : real(id)),
						real,
						{ cache: { [file]: {} } },
					);
				},
			};
		});

		const { nativeModuleProblem, nativeModuleUnavailable, NativeModuleUnavailableError } = await import(
			"../src/utils/native-module.js"
		);

		const firstProblem = nativeModuleProblem();
		assert.ok(firstProblem !== undefined);
		const firstError = await nativeModuleUnavailable(firstProblem).catch((err: unknown) => err);
		assert.ok(firstError instanceof NativeModuleUnavailableError);
		assert.match(firstError.message, /Reinstall atomic/);

		// Reinstall replaces the .node file with identical size & mtime, colliding 64-bit inode B, and release 0.10.5.
		writeFileSync(manifest, JSON.stringify({ version: "0.10.5" }));
		mocks.stats.set(resolve(file), {
			dev: DEV,
			ino: COLLIDING_INO_B,
			size: FIXED_SIZE,
			mtimeNs: FIXED_TIME_NS,
			ctimeNs: FIXED_TIME_NS,
			mode: EXEC_MODE,
		});

		const secondProblem = nativeModuleProblem();
		assert.ok(secondProblem !== undefined);
		const secondError = await nativeModuleUnavailable(secondProblem).catch((err: unknown) => err);
		assert.ok(secondError instanceof NativeModuleUnavailableError);
		assert.equal(
			secondError.message,
			"atomic's native module was reinstalled while this process was running; restart it.",
		);
	});
});
