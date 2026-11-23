import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
	dirs: new Set<string>(),
	files: new Set<string>(),
	realpaths: new Map<string, string>(),
	symlinks: new Set<string>(),
	tmpdirValue: "C:\\Users\\tester\\AppData\\Local\\Temp",
	spawnCalls: [] as Array<{ command: string; args: readonly string[]; options: SpawnOptions }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = ((command: string, args: readonly string[], options: SpawnOptions = {}) => {
		hooks.spawnCalls.push({ command, args, options });
		const child = Object.assign(new EventEmitter(), {
			pid: undefined,
			exitCode: null,
			signalCode: null,
			stdin: Object.assign(new EventEmitter(), { unref() {} }),
			unref() {},
			kill() {
				return true;
			},
		});
		return child;
	}) as unknown as typeof actual.spawn;
	return { ...actual, spawn, default: { ...actual, spawn } };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const existsSync = ((path: Parameters<typeof actual.existsSync>[0]) => {
		const key = String(path);
		return hooks.dirs.has(key) || hooks.files.has(key);
	}) as typeof actual.existsSync;
	const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], _encoding?: unknown) => {
		const key = String(path);
		if (hooks.files.has(key)) return "";
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.readFileSync;
	const statSync = ((path: Parameters<typeof actual.statSync>[0]) => {
		const key = String(path);
		if (hooks.dirs.has(key)) return { isDirectory: () => true } as Stats;
		if (hooks.files.has(key)) return { isDirectory: () => false } as Stats;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.statSync;
	const lstatSync = ((path: Parameters<typeof actual.lstatSync>[0]) => {
		const key = String(path);
		if (hooks.symlinks.has(key)) return { isDirectory: () => false, isSymbolicLink: () => true } as Stats;
		if (hooks.dirs.has(key)) return { isDirectory: () => true, isSymbolicLink: () => false } as Stats;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.lstatSync;
	const resolveReal = (path: Parameters<typeof actual.realpathSync>[0]) => {
		const key = String(path);
		const mapped = hooks.realpaths.get(key);
		if (mapped !== undefined) return mapped;
		if (hooks.dirs.has(key)) return key;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	};
	const realpathSync = Object.assign(resolveReal, { native: resolveReal }) as typeof actual.realpathSync;
	return {
		...actual,
		existsSync,
		readFileSync,
		statSync,
		lstatSync,
		realpathSync,
		default: { ...actual, existsSync, readFileSync, statSync, lstatSync, realpathSync },
	};
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const tmpdir = () => hooks.tmpdirValue;
	return { ...actual, tmpdir, default: { ...actual, tmpdir } };
});

import { compileCacheHelperLaunch } from "../../packages/coding-agent/src/utils/compile-cache-warmup-host.js";
import { startStartupPrefetch } from "../../packages/coding-agent/src/utils/startup-prefetch.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalCwd = process.cwd;
const originalExecArgv = process.execArgv;
const savedEnv = {
	SystemRoot: process.env.SystemRoot,
	windir: process.env.windir,
	UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE,
	ATOMIC_PACKAGE_DIR: process.env.ATOMIC_PACKAGE_DIR,
	PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
	ATOMIC_CODING_AGENT_DIR: process.env.ATOMIC_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	NODE_OPTIONS: process.env.NODE_OPTIONS,
};

function setupWindows(opts: {
	cwd?: string;
	systemRoot?: string;
	windir?: string;
	tmpdir?: string;
	dirs?: readonly string[];
	files?: readonly string[];
	realpaths?: Record<string, string>;
	symlinks?: readonly string[];
}) {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	process.cwd = () => opts.cwd ?? "C:\\Users\\dev\\project";
	process.execArgv = [];
	if (opts.systemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = opts.systemRoot;
	if (opts.windir === undefined) delete process.env.windir;
	else process.env.windir = opts.windir;
	delete process.env.UV_THREADPOOL_SIZE;
	delete process.env.ATOMIC_PACKAGE_DIR;
	delete process.env.PI_PACKAGE_DIR;
	delete process.env.NODE_OPTIONS;
	hooks.tmpdirValue = opts.tmpdir ?? "C:\\Users\\dev\\AppData\\Local\\Temp";
	hooks.dirs.clear();
	for (const d of opts.dirs ?? []) hooks.dirs.add(d);
	hooks.files.clear();
	for (const f of opts.files ?? []) hooks.files.add(f);
	hooks.realpaths.clear();
	for (const [k, v] of Object.entries(opts.realpaths ?? {})) hooks.realpaths.set(k, v);
	hooks.symlinks.clear();
	for (const s of opts.symlinks ?? []) hooks.symlinks.add(s);
	hooks.spawnCalls.length = 0;
}

afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform);
	process.cwd = originalCwd;
	process.execArgv = originalExecArgv;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	hooks.dirs.clear();
	hooks.files.clear();
	hooks.realpaths.clear();
	hooks.symlinks.clear();
	hooks.spawnCalls.length = 0;
});

describe("compile-cache warmup helper and startup-prefetch reader safe working directories", () => {
	test("compileCacheHelperLaunch never returns an empty cwd for relative scripts or an extended \\\\?\\ root when a short safe cwd exists", () => {
		const pkgRoot = "C:\\prefix\\node_modules\\@bastani\\atomic";
		const script = `${pkgRoot}\\dist\\utils\\compile-cache-warmup.js`;
		const longScript = `\\\\?\\C:\\${"a".repeat(130)}\\${"b".repeat(130)}\\node_modules\\@bastani\\atomic\\dist\\utils\\compile-cache-warmup.js`;
		setupWindows({
			systemRoot: "C:\\Windows",
			windir: "C:\\Windows",
			dirs: ["C:\\Windows", "C:\\", pkgRoot, `${pkgRoot}\\dist\\utils`],
		});

		const relLaunch = compileCacheHelperLaunch(
			{ execArgv: [], nodeOptions: "" },
			"build-1",
			"dist\\utils\\compile-cache-warmup.js",
		);
		assert.notEqual(relLaunch.cwd, "", "relative script must not leave warmup helper cwd empty");
		assert.equal(relLaunch.cwd, "C:\\Windows");

		const longLaunch = compileCacheHelperLaunch({ execArgv: [], nodeOptions: "" }, "build-2", longScript);
		assert.equal(longLaunch.cwd.startsWith("\\\\?\\"), false, `expected short plain cwd, got ${longLaunch.cwd}`);
		assert.equal(longLaunch.cwd, "C:\\Windows");

		const normalLaunch = compileCacheHelperLaunch({ execArgv: [], nodeOptions: "" }, "build-3", script);
		assert.equal(normalLaunch.cwd, "C:\\Windows");
	});

	test("compileCacheHelperLaunch avoids a hostile SystemRoot junction and subst drive mapped to the install root without blocking syscalls", () => {
		const pkgRoot = "C:\\prefix\\node_modules\\@bastani\\atomic";
		const script = "S:\\dist\\utils\\compile-cache-warmup.js";
		const badJunction = "C:\\BadSysRoot";
		setupWindows({
			systemRoot: badJunction,
			windir: badJunction,
			tmpdir: `${pkgRoot}\\tmp`,
			dirs: ["C:\\Windows", badJunction, `${pkgRoot}\\tmp`, "S:\\", "S:\\dist\\utils", pkgRoot, "C:\\"],
			realpaths: {
				[badJunction]: pkgRoot,
				"S:\\": pkgRoot,
				"S:\\dist\\utils": `${pkgRoot}\\dist\\utils`,
			},
		});

		const launch = compileCacheHelperLaunch({ execArgv: [], nodeOptions: "" }, "build-subst", script);
		assert.equal(launch.cwd, "C:\\Windows");
	});

	test("startStartupPrefetch spawns the reader with a safe Windows cwd outside both process.cwd() and packageDir", () => {
		const pkgRoot = "C:\\prefix\\node_modules\\@bastani\\atomic";
		setupWindows({
			cwd: pkgRoot,
			systemRoot: "C:\\Windows",
			windir: "C:\\Windows",
			dirs: ["C:\\Windows", "C:\\", pkgRoot],
			files: [
				`${pkgRoot}/dist/startup-files.json`,
				`${pkgRoot}/dist/utils/startup-prefetch-reader.js`,
				`${pkgRoot}\\dist\\startup-files.json`,
				`${pkgRoot}\\dist\\utils\\startup-prefetch-reader.js`,
			],
		});

		startStartupPrefetch(pkgRoot);

		assert.equal(hooks.spawnCalls.length, 1, "expected startup-prefetch reader to be spawned");
		const cwd = hooks.spawnCalls[0]!.options.cwd;
		assert.equal(typeof cwd, "string", "startup-prefetch reader must pass an explicit safe cwd");
		assert.equal(cwd, "C:\\Windows");
	});

	test("startStartupPrefetch absolutizes relative and drive-rooted packageDir and ATOMIC_CODING_AGENT_DIR against caller cwd", () => {
		const callerCwd = "R:\\work\\proj";
		const resolvedPkg = "R:\\work\\proj\\pkg";
		setupWindows({
			cwd: callerCwd,
			systemRoot: "C:\\Windows",
			windir: "C:\\Windows",
			dirs: ["C:\\Windows", "C:\\", callerCwd, resolvedPkg],
			files: [
				`${resolvedPkg}\\dist\\startup-files.json`,
				`${resolvedPkg}\\dist\\utils\\startup-prefetch-reader.js`,
				`${resolvedPkg}/dist/startup-files.json`,
				`${resolvedPkg}/dist/utils/startup-prefetch-reader.js`,
			],
		});
		process.env.ATOMIC_CODING_AGENT_DIR = ".\\rel-agent";
		delete process.env.PI_CODING_AGENT_DIR;

		startStartupPrefetch(".\\pkg");
		assert.equal(hooks.spawnCalls.length, 1, "expected reader spawn for relative packageDir and agentDir");
		const [readerPath, listPath, passedPkgDir, markerPath] = hooks.spawnCalls[0]!.args;
		assert.equal(readerPath, `${resolvedPkg}\\dist\\utils\\startup-prefetch-reader.js`);
		assert.equal(listPath, `${resolvedPkg}\\dist\\startup-files.json`);
		assert.equal(passedPkgDir, resolvedPkg);
		assert.equal(markerPath, "R:\\work\\proj\\rel-agent\\startup-files-read.json");
		assert.equal(hooks.spawnCalls[0]!.options.cwd, "C:\\Windows");

		// Drive-relative rooted path `\r-agent` on drive R: must resolve against R:, not C: (reader cwd).
		hooks.spawnCalls.length = 0;
		process.env.ATOMIC_CODING_AGENT_DIR = "\\r-agent";
		startStartupPrefetch("\\work\\proj\\pkg");
		assert.equal(hooks.spawnCalls.length, 1, "expected reader spawn for drive-rooted packageDir and agentDir");
		assert.equal(hooks.spawnCalls[0]!.args[0], `${resolvedPkg}\\dist\\utils\\startup-prefetch-reader.js`);
		assert.equal(hooks.spawnCalls[0]!.args[2], resolvedPkg);
		assert.equal(hooks.spawnCalls[0]!.args[3], "R:\\r-agent\\startup-files-read.json");
	});
});
