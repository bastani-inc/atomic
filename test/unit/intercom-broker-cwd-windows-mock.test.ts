import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
	dirs: new Set<string>(),
	files: new Set<string>(),
	realpaths: new Map<string, string>(),
	realpathHangs: new Set<string>(),
	symlinks: new Set<string>(),
	tmpdirValue: "C:\\Users\\tester\\AppData\\Local\\Temp",
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
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
	return { ...actual, statSync, lstatSync, realpathSync, default: { ...actual, statSync, lstatSync, realpathSync } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const stat = (async (path: Parameters<typeof actual.stat>[0]) => {
		const key = String(path);
		if (hooks.dirs.has(key)) return { isDirectory: () => true } as Stats;
		if (hooks.files.has(key)) return { isDirectory: () => false } as Stats;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.stat;
	const lstat = (async (path: Parameters<typeof actual.lstat>[0]) => {
		const key = String(path);
		if (hooks.symlinks.has(key)) return { isDirectory: () => false, isSymbolicLink: () => true } as Stats;
		if (hooks.dirs.has(key)) return { isDirectory: () => true, isSymbolicLink: () => false } as Stats;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.lstat;
	const realpath = (async (path: Parameters<typeof actual.realpath>[0]) => {
		const key = String(path);
		if (hooks.realpathHangs.has(key)) return new Promise<string>(() => {});
		const mapped = hooks.realpaths.get(key);
		if (mapped !== undefined) return mapped;
		if (hooks.dirs.has(key)) return key;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.realpath;
	return { ...actual, stat, lstat, realpath, default: { ...actual, stat, lstat, realpath } };
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const tmpdir = () => hooks.tmpdirValue;
	return { ...actual, tmpdir, default: { ...actual, tmpdir } };
});

vi.mock("@bastani/atomic", () => ({
	createChildProcessEnvironment: (overrides: Record<string, string> = {}) => ({ ...process.env, ...overrides }),
	IntercomBrokerUpgradeError: Error,
	isBunBinary: false,
	isIntercomBrokerStopTimeoutError: () => false,
	processSharedStorageSelection: () => undefined,
	processSharedStorageSelectionAsync: async () => undefined,
	takeTakeoverMutex: () => undefined,
	takeTakeoverMutexAsync: async () => undefined,
}));

import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getBrokerSpawnOptions, getBrokerSpawnOptionsAsync } from "../../packages/intercom/broker/spawn.js";
import {
	collectInstallProtectedDirs,
	resolveSafeWindowsWorkingDirectoryAsync,
} from "../../packages/intercom/broker/windows-cwd.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalCwd = process.cwd;
const savedEnv = {
	SystemRoot: process.env.SystemRoot,
	windir: process.env.windir,
	USERPROFILE: process.env.USERPROFILE,
	ATOMIC_CODING_AGENT_DIR: process.env.ATOMIC_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

function setupWindows(opts: {
	cwd?: string;
	systemRoot?: string;
	windir?: string;
	tmpdir?: string;
	agentDir?: string;
	dirs: readonly string[];
	realpaths?: Record<string, string>;
	realpathHangs?: readonly string[];
	symlinks?: readonly string[];
}) {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	process.cwd = () => opts.cwd ?? "C:\\Users\\dev\\project";
	if (opts.systemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = opts.systemRoot;
	if (opts.windir === undefined) delete process.env.windir;
	else process.env.windir = opts.windir;
	process.env.USERPROFILE = "C:\\Users\\dev";
	if (opts.agentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = opts.agentDir;
	delete process.env.PI_CODING_AGENT_DIR;
	hooks.tmpdirValue = opts.tmpdir ?? "C:\\Users\\dev\\AppData\\Local\\Temp";
	hooks.dirs.clear();
	for (const d of opts.dirs) hooks.dirs.add(d);
	hooks.realpaths.clear();
	for (const [k, v] of Object.entries(opts.realpaths ?? {})) hooks.realpaths.set(k, v);
	hooks.realpathHangs.clear();
	for (const h of opts.realpathHangs ?? []) hooks.realpathHangs.add(h);
	hooks.symlinks.clear();
	for (const s of opts.symlinks ?? []) hooks.symlinks.add(s);
}

afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform);
	process.cwd = originalCwd;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	hooks.dirs.clear();
	hooks.files.clear();
	hooks.realpaths.clear();
	hooks.realpathHangs.clear();
	hooks.symlinks.clear();
});

describe("Windows broker safe working directory selection (mocked Win32)", () => {
	test("collectInstallProtectedDirs protects npm global package, scope, and node_modules without promoting drive root", () => {
		const npmProtected = collectInstallProtectedDirs(
			"C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@bastani\\atomic\\dist\\builtin\\intercom",
		);
		assert.deepEqual(npmProtected, [
			"C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@bastani\\atomic\\dist\\builtin\\intercom",
			"C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@bastani\\atomic\\dist",
			"C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@bastani\\atomic",
			"C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@bastani",
			"C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules",
		]);

		const standaloneProtected = collectInstallProtectedDirs(
			"C:\\Users\\dev\\AppData\\Local\\atomic\\versions\\v0.10.5\\builtin\\intercom",
		);
		assert.deepEqual(standaloneProtected, [
			"C:\\Users\\dev\\AppData\\Local\\atomic\\versions\\v0.10.5\\builtin\\intercom",
			"C:\\Users\\dev\\AppData\\Local\\atomic\\versions\\v0.10.5",
			"C:\\Users\\dev\\AppData\\Local\\atomic\\versions",
			"C:\\Users\\dev\\AppData\\Local\\atomic",
		]);

		// Never promotes a drive root to an inferred protected ancestor.
		const rootAdjacent = collectInstallProtectedDirs("C:\\builtin\\intercom");
		assert.equal(rootAdjacent.includes("C:\\"), false);
	});

	test("rejects a SystemRoot junction into the npm install root and a TEMP inside the install root", async () => {
		const pkgRoot = "C:\\prefix\\node_modules\\@bastani\\atomic";
		const extDir = `${pkgRoot}\\dist\\builtin\\intercom`;
		const badJunction = "C:\\FakeWin";
		const badTemp = `${pkgRoot}\\dist\\tmp`;
		setupWindows({
			systemRoot: badJunction,
			windir: badJunction,
			tmpdir: badTemp,
			dirs: [badJunction, badTemp, extDir, pkgRoot, "C:\\"],
			realpaths: { [badJunction]: `${pkgRoot}\\dist` },
		});

		assert.equal(getBrokerSpawnOptions(extDir).cwd, "C:\\");
		assert.equal((await getBrokerSpawnOptionsAsync(extDir)).cwd, "C:\\");
	});

	test("prefers a short (<248-char) outside directory over a >=248-char SystemRoot so CreateProcessW succeeds with LongPathsEnabled=0", async () => {
		const pkgRoot = "C:\\prefix\\node_modules\\@bastani\\atomic";
		const extDir = `${pkgRoot}\\dist\\builtin\\intercom`;
		const longSys = `C:\\${"w".repeat(130)}\\${"s".repeat(130)}`;
		const longProbe = `\\\\?\\${longSys}`;
		setupWindows({
			systemRoot: longSys,
			windir: longSys,
			tmpdir: `${pkgRoot}\\tmp`,
			dirs: [longProbe, extDir, pkgRoot, "C:\\"],
			realpaths: { [longProbe]: longSys },
		});

		const syncCwd = getBrokerSpawnOptions(extDir).cwd;
		const asyncCwd = (await getBrokerSpawnOptionsAsync(extDir)).cwd;
		assert.equal(syncCwd, "C:\\");
		assert.equal(asyncCwd, "C:\\");
	});

	test("protects standalone install root so a candidate inside versions/ or atomic/ is rejected", async () => {
		const installRoot = "C:\\Users\\dev\\AppData\\Local\\atomic";
		const extDir = `${installRoot}\\versions\\v0.10.5\\builtin\\intercom`;
		setupWindows({
			systemRoot: `${installRoot}\\versions\\v0.10.5`,
			windir: `${installRoot}`,
			tmpdir: `${installRoot}\\tmp`,
			dirs: [installRoot, `${installRoot}\\versions\\v0.10.5`, `${installRoot}\\tmp`, extDir, "C:\\"],
		});

		assert.equal(getBrokerSpawnOptions(extDir).cwd, "C:\\");
		assert.equal((await getBrokerSpawnOptionsAsync(extDir)).cwd, "C:\\");
	});

	test("keeps canonical installDirs protection intact when process.cwd() is a hung UNC path", async () => {
		const pkgRoot = "C:\\prefix\\node_modules\\@bastani\\atomic";
		const badJunction = "C:\\BadSysRoot";
		setupWindows({
			cwd: "\\\\hung-server\\share\\proj",
			systemRoot: badJunction,
			windir: badJunction,
			tmpdir: `${pkgRoot}\\tmp`,
			dirs: ["\\\\hung-server\\share\\proj", badJunction, "S:\\", "S:\\dist\\builtin\\intercom", pkgRoot, "C:\\"],
			realpaths: {
				[badJunction]: pkgRoot,
				"S:\\": pkgRoot,
				"S:\\dist\\builtin\\intercom": `${pkgRoot}\\dist\\builtin\\intercom`,
				"C:\\": "C:\\",
			},
			realpathHangs: ["\\\\hung-server\\share\\proj"],
		});

		const chosen = await resolveSafeWindowsWorkingDirectoryAsync({
			installDirs: ["S:\\dist\\builtin\\intercom"],
			timeoutMs: 150,
		});
		assert.equal(chosen, "C:\\");
	});

	test("resolves drive-relative rooted and relative ATOMIC_CODING_AGENT_DIR against caller cwd and overwrites mixed-case env keys without duplicates", async () => {
		const extDir = "R:\\pkg\\dist\\builtin\\intercom";
		setupWindows({
			cwd: "R:\\proj",
			systemRoot: "C:\\Windows",
			windir: "C:\\Windows",
			agentDir: "\\r-agent",
			dirs: ["C:\\Windows", "C:\\", "R:\\proj", extDir],
		});

		const syncRooted = getBrokerSpawnOptions(extDir);
		const asyncRooted = await getBrokerSpawnOptionsAsync(extDir);
		assert.equal(syncRooted.cwd, "C:\\Windows");
		assert.equal(syncRooted.env.ATOMIC_CODING_AGENT_DIR, "R:\\r-agent");
		assert.equal(asyncRooted.env.ATOMIC_CODING_AGENT_DIR, "R:\\r-agent");
		// Parent and broker MUST compute the exact same Windows named pipe for rooted-without-drive agentDir!
		assert.equal(getBrokerSocketPath("win32"), getBrokerSocketPath("win32", "R:\\r-agent"));
		assert.equal(getBrokerSocketPath("win32", "\\r-agent"), getBrokerSocketPath("win32", "R:\\r-agent"));

		// Drive-relative `R:sub` resolves against caller's `R:\proj`.
		process.env.ATOMIC_CODING_AGENT_DIR = "R:sub-agent";
		assert.equal(getBrokerSpawnOptions(extDir).env.ATOMIC_CODING_AGENT_DIR, "R:\\proj\\sub-agent");
		assert.equal(getBrokerSocketPath("win32"), getBrokerSocketPath("win32", "R:\\proj\\sub-agent"));

		// Relative `.\rel-agent` produces the exact same Windows named pipe in parent and broker!
		process.env.ATOMIC_CODING_AGENT_DIR = ".\\rel-agent";
		assert.equal(getBrokerSocketPath("win32"), getBrokerSocketPath("win32", "R:\\proj\\rel-agent"));

		// Mixed-case key `atomic_coding_agent_dir` must be overwritten in place with zero case duplicates.
		delete process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.atomic_coding_agent_dir = ".\\rel-lower";
		try {
			const syncLower = getBrokerSpawnOptions(extDir);
			const asyncLower = await getBrokerSpawnOptionsAsync(extDir);
			for (const opts of [syncLower, asyncLower]) {
				const matches = Object.entries(opts.env).filter(([k]) => k.toLowerCase() === "atomic_coding_agent_dir");
				assert.equal(matches.length, 1, `expected single case-insensitive key, got ${JSON.stringify(matches)}`);
				assert.equal(matches[0]![1], "R:\\proj\\rel-lower");
			}
		} finally {
			delete process.env.atomic_coding_agent_dir;
		}
	});
});
