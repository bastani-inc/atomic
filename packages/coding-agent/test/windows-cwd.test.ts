import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
	dirs: new Set<string>(),
	files: new Set<string>(),
	realpaths: new Map<string, string>(),
	symlinks: new Set<string>(),
	realpathThrows: new Set<string>(),
	realpathHangs: new Set<string>(),
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
		if (hooks.realpathThrows.has(key)) throw Object.assign(new Error(`EACCES: ${key}`), { code: "EACCES" });
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
	const realpath = ((path: Parameters<typeof actual.realpath>[0]) => {
		const key = String(path);
		if (hooks.realpathHangs.has(key)) return new Promise<string>(() => {});
		if (hooks.realpathThrows.has(key)) {
			return Promise.reject(Object.assign(new Error(`EACCES: ${key}`), { code: "EACCES" }));
		}
		const mapped = hooks.realpaths.get(key);
		if (mapped !== undefined) return Promise.resolve(mapped);
		if (hooks.dirs.has(key)) return Promise.resolve(key);
		return Promise.reject(Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" }));
	}) as typeof actual.realpath;
	return { ...actual, stat, lstat, realpath, default: { ...actual, stat, lstat, realpath } };
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const tmpdir = () => hooks.tmpdirValue;
	return { ...actual, tmpdir, default: { ...actual, tmpdir } };
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalCwd = process.cwd;
const savedSystemRoot = process.env.SystemRoot;
const savedWindir = process.env.windir;

function setupWin(opts: {
	cwd?: string;
	systemRoot?: string;
	windir?: string;
	tmpdir?: string;
	dirs?: readonly string[];
	files?: readonly string[];
	realpaths?: Record<string, string>;
	symlinks?: readonly string[];
	realpathThrows?: readonly string[];
	realpathHangs?: readonly string[];
}) {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	process.cwd = () => opts.cwd ?? "C:\\repo\\project";
	if (opts.systemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = opts.systemRoot;
	if (opts.windir === undefined) delete process.env.windir;
	else process.env.windir = opts.windir;
	hooks.tmpdirValue = opts.tmpdir ?? "C:\\Users\\tester\\AppData\\Local\\Temp";
	hooks.dirs.clear();
	for (const d of opts.dirs ?? []) hooks.dirs.add(d);
	hooks.files.clear();
	for (const f of opts.files ?? []) hooks.files.add(f);
	hooks.realpaths.clear();
	for (const [k, v] of Object.entries(opts.realpaths ?? {})) hooks.realpaths.set(k, v);
	hooks.symlinks.clear();
	for (const s of opts.symlinks ?? []) hooks.symlinks.add(s);
	hooks.realpathThrows.clear();
	for (const t of opts.realpathThrows ?? []) hooks.realpathThrows.add(t);
	hooks.realpathHangs.clear();
	for (const h of opts.realpathHangs ?? []) hooks.realpathHangs.add(h);
}

afterEach(() => {
	hooks.dirs.clear();
	hooks.files.clear();
	hooks.realpaths.clear();
	hooks.symlinks.clear();
	hooks.realpathThrows.clear();
	hooks.realpathHangs.clear();
	Object.defineProperty(process, "platform", originalPlatform);
	process.cwd = originalCwd;
	if (savedSystemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = savedSystemRoot;
	if (savedWindir === undefined) delete process.env.windir;
	else process.env.windir = savedWindir;
	vi.resetModules();
});

describe("windows-cwd helper", () => {
	test("normalizes drive, UNC, extended-length, and volume GUID paths while rejecting invalid forms", async () => {
		const { isDriveRootWindowsPath, normalizeWindowsPathForCompare, toSpawnWindowsPath, windowsDriveRoot } =
			await import("../src/utils/windows-cwd.js");

		assert.equal(normalizeWindowsPathForCompare("C:\\"), "C:\\");
		assert.equal(normalizeWindowsPathForCompare("C:/Windows/"), "C:\\Windows");
		assert.equal(normalizeWindowsPathForCompare("\\\\?\\C:\\"), "C:\\");
		assert.equal(normalizeWindowsPathForCompare("\\\\?\\C:\\repo\\project\\"), "C:\\repo\\project");
		assert.equal(normalizeWindowsPathForCompare("\\\\.\\C:\\repo\\project"), "C:\\repo\\project");
		assert.equal(normalizeWindowsPathForCompare("//?/C:/repo/project"), "C:\\repo\\project");
		assert.equal(normalizeWindowsPathForCompare("\\\\server\\share\\dir"), "\\\\server\\share\\dir");
		assert.equal(normalizeWindowsPathForCompare("\\\\?\\UNC\\server\\share\\dir"), "\\\\server\\share\\dir");
		assert.equal(
			normalizeWindowsPathForCompare("\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\sub\\"),
			"\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\sub",
		);

		assert.equal(toSpawnWindowsPath("C:\\Windows"), "C:\\Windows");
		const longTail = Array.from({ length: 12 }, (_, i) => `seg_${String(i).padStart(2, "0")}_1234567890123456`).join(
			"\\",
		);
		assert.equal(toSpawnWindowsPath(`C:\\long\\${longTail}`), `\\\\?\\C:\\long\\${longTail}`);
		assert.equal(toSpawnWindowsPath(`\\\\srv\\share\\${longTail}`), `\\\\?\\UNC\\srv\\share\\${longTail}`);

		assert.equal(windowsDriveRoot("\\\\?\\C:\\repo\\project"), "C:\\");
		assert.equal(windowsDriveRoot("\\\\?\\UNC\\server\\share\\dir"), "\\\\server\\share\\");
		assert.equal(
			windowsDriveRoot("\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\sub"),
			"\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\",
		);
		assert.equal(isDriveRootWindowsPath("C:\\"), true);
		assert.equal(isDriveRootWindowsPath("C:\\Windows"), false);
		assert.equal(isDriveRootWindowsPath("\\\\server\\share\\"), true);
		assert.equal(isDriveRootWindowsPath("\\\\server\\share\\sub"), false);

		for (const invalid of [
			"",
			"Windows",
			"C:",
			"C:Windows",
			"\\Windows",
			"/tmp",
			"\\\\",
			"\\\\server",
			"\\\\server\\",
			"\\\\?\\",
			"\\\\?\\C:",
			"\\\\.\\C:",
			"\\\\.\\pipe\\foo",
			"\\\\?\\UNC\\",
			"\\\\?\\UNC\\server",
			"\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}",
			"C:\\Windows\0bad",
		]) {
			assert.equal(normalizeWindowsPathForCompare(invalid), undefined, `rejected ${JSON.stringify(invalid)}`);
		}
	});

	test("async and sync selectors agree on junctions, subst roots, drive-root cwd, long \\\\?\\ paths, and unverified symlinks", async () => {
		const { resolveSafeWindowsWorkingDirectoryAsync, resolveSafeWindowsWorkingDirectorySync } = await import(
			"../src/utils/windows-cwd.js"
		);

		// 1. External junction into project
		setupWin({
			cwd: "C:\\repo\\project",
			systemRoot: "C:\\temp\\junc-in",
			windir: "C:\\temp\\junc-in",
			dirs: ["C:\\repo\\project", "C:\\temp\\junc-in", "C:\\Windows"],
			symlinks: ["C:\\temp\\junc-in"],
			realpaths: {
				"C:\\repo\\project": "C:\\repo\\project",
				"C:\\temp\\junc-in": "C:\\repo\\project\\win",
				"C:\\Windows": "C:\\Windows",
			},
		});
		assert.equal(resolveSafeWindowsWorkingDirectorySync(), "C:\\Windows");
		assert.equal(await resolveSafeWindowsWorkingDirectoryAsync(), "C:\\Windows");

		// 2. subst drive S:\ mapped to removable project -> escapes to C:\
		setupWin({
			cwd: "S:\\",
			systemRoot: "S:\\win",
			windir: "C:\\repo\\project\\win",
			tmpdir: "relative-tmp",
			dirs: ["S:\\", "S:\\win", "C:\\repo\\project\\win", "C:\\"],
			realpaths: {
				"S:\\": "C:\\repo\\project",
				"S:\\win": "C:\\repo\\project\\win",
				"C:\\repo\\project\\win": "C:\\repo\\project\\win",
				"C:\\": "C:\\",
			},
		});
		assert.equal(resolveSafeWindowsWorkingDirectorySync({ commandPath: "tool.exe" }), "C:\\");
		assert.equal(await resolveSafeWindowsWorkingDirectoryAsync({ commandPath: "tool.exe" }), "C:\\");

		// 3. Genuine drive root C:\ prefers C:\Windows over D:\Tools
		setupWin({
			cwd: "C:\\",
			systemRoot: "C:\\Windows",
			dirs: ["C:\\", "C:\\Windows", "D:\\Tools"],
			realpaths: { "C:\\": "C:\\", "C:\\Windows": "C:\\Windows", "D:\\Tools": "D:\\Tools" },
		});
		assert.equal(resolveSafeWindowsWorkingDirectorySync({ commandPath: "D:\\Tools\\node.exe" }), "C:\\Windows");
		assert.equal(
			await resolveSafeWindowsWorkingDirectoryAsync({ commandPath: "D:\\Tools\\node.exe" }),
			"C:\\Windows",
		);

		// 4. Unverified symlink skipped when realpath throws
		setupWin({
			cwd: "C:\\repo\\project",
			systemRoot: "C:\\temp\\broken-link",
			windir: "C:\\temp\\broken-link",
			dirs: ["C:\\repo\\project", "C:\\temp\\broken-link", "C:\\Windows"],
			symlinks: ["C:\\temp\\broken-link"],
			realpathThrows: ["C:\\temp\\broken-link"],
		});
		assert.equal(resolveSafeWindowsWorkingDirectorySync(), "C:\\Windows");
		assert.equal(await resolveSafeWindowsWorkingDirectoryAsync(), "C:\\Windows");

		// 5. Long >248-char paths yield to a short (<248-char) verified outside directory when one exists (so
		// CreateProcessW succeeds with LongPathsEnabled=0), and preserve \\?\ / \\?\UNC\ when only long paths exist.
		const longTail = Array.from({ length: 12 }, (_, i) => `seg_${String(i).padStart(2, "0")}_1234567890123456`).join(
			"\\",
		);
		const longPlain = `D:\\a\\_temp\\${longTail}`;
		const longExt = `\\\\?\\${longPlain}`;
		const longUncPlain = `\\\\srv\\share\\${longTail}`;
		const longUncExt = `\\\\?\\UNC\\srv\\share\\${longTail}`;
		const longInProj = `\\\\?\\D:\\a\\project\\${longTail}`;

		// Short C:\Windows exists -> prefer short C:\Windows over >=248-char longExt or longUncExt
		setupWin({
			cwd: "D:\\a\\project",
			systemRoot: longExt,
			windir: longExt,
			dirs: ["D:\\a\\project", longExt, "C:\\Windows"],
			realpaths: { "D:\\a\\project": "D:\\a\\project", [longExt]: longPlain, "C:\\Windows": "C:\\Windows" },
		});
		assert.equal(resolveSafeWindowsWorkingDirectorySync(), "C:\\Windows");
		assert.equal(await resolveSafeWindowsWorkingDirectoryAsync(), "C:\\Windows");

		setupWin({
			cwd: "D:\\a\\project",
			systemRoot: longUncExt,
			windir: longUncExt,
			dirs: ["D:\\a\\project", longUncExt, "C:\\Windows"],
			realpaths: {
				"D:\\a\\project": "D:\\a\\project",
				[longUncExt]: longUncPlain,
				"C:\\Windows": "C:\\Windows",
			},
		});
		assert.equal(resolveSafeWindowsWorkingDirectorySync(), "C:\\Windows");
		assert.equal(await resolveSafeWindowsWorkingDirectoryAsync(), "C:\\Windows");

		// No short outside directory exists -> Tier 2 preserves \\?\ and \\?\UNC\
		setupWin({
			cwd: "D:\\a\\project",
			systemRoot: longExt,
			windir: longExt,
			tmpdir: "Z:\\NoSuchTemp",
			dirs: ["D:\\a\\project", longExt],
			realpaths: { "D:\\a\\project": "D:\\a\\project", [longExt]: longPlain },
		});
		assert.equal(resolveSafeWindowsWorkingDirectorySync(), longExt);
		assert.equal(await resolveSafeWindowsWorkingDirectoryAsync(), longExt);

		setupWin({
			cwd: "D:\\a\\project",
			systemRoot: longUncExt,
			windir: longUncExt,
			tmpdir: "Z:\\NoSuchTemp",
			dirs: ["D:\\a\\project", longUncExt],
			realpaths: {
				"D:\\a\\project": "D:\\a\\project",
				[longUncExt]: longUncPlain,
			},
		});
		assert.equal(resolveSafeWindowsWorkingDirectorySync(), longUncExt);
		assert.equal(await resolveSafeWindowsWorkingDirectoryAsync(), longUncExt);

		setupWin({
			cwd: "D:\\a\\project",
			systemRoot: longInProj,
			windir: longInProj,
			dirs: ["D:\\a\\project", longInProj, "C:\\Windows"],
			realpaths: {
				"D:\\a\\project": "D:\\a\\project",
				[longInProj]: longInProj,
				"C:\\Windows": "C:\\Windows",
			},
		});
		assert.equal(resolveSafeWindowsWorkingDirectorySync(), "C:\\Windows");
		assert.equal(await resolveSafeWindowsWorkingDirectoryAsync(), "C:\\Windows");
	});

	test("bounds hung UNC process.cwd() realpath and supports immediate AbortSignal cancellation", async () => {
		const { resolveSafeWindowsWorkingDirectoryAsync } = await import("../src/utils/windows-cwd.js");

		setupWin({
			cwd: "\\\\hung-server\\share\\project",
			systemRoot: "C:\\Windows",
			dirs: ["\\\\hung-server\\share\\project", "C:\\Windows"],
			realpathHangs: ["\\\\hung-server\\share\\project"],
		});
		const startedAt = Date.now();
		const chosen = await resolveSafeWindowsWorkingDirectoryAsync({ timeoutMs: 80 });
		assert.equal(chosen, "C:\\Windows");
		assert.ok(Date.now() - startedAt < 1_000);

		const abort = new AbortController();
		const pending = resolveSafeWindowsWorkingDirectoryAsync({ timeoutMs: 5_000, signal: abort.signal });
		abort.abort();
		assert.equal(await pending, undefined);
	});

	test("synchronous kill lexical selector avoids unverified TMP, external junctions on C:, and non-C: hardcoded C:\\Windows", async () => {
		const { resolveSafeWindowsKillCwdLexical } = await import("../src/utils/windows-cwd.js");

		// cwd=C:\Windows + nonexistent TMP -> picks C:\ (never Z:\NoSuchTmp)
		setupWin({
			cwd: "C:\\Windows",
			systemRoot: "C:\\Windows",
			windir: "C:\\Windows",
			tmpdir: "Z:\\NoSuchTmp",
		});
		assert.equal(resolveSafeWindowsKillCwdLexical({ commandPath: "C:\\Windows\\System32\\taskkill.exe" }), "C:\\");

		// SystemRoot is an unverified path on C: (e.g. junction into project) -> prefers C:\Windows
		setupWin({
			cwd: "C:\\repo\\project",
			systemRoot: "C:\\temp\\ext-junc-in",
			windir: "C:\\temp\\ext-junc-in",
		});
		assert.equal(
			resolveSafeWindowsKillCwdLexical({ commandPath: "C:\\temp\\ext-junc-in\\System32\\taskkill.exe" }),
			"C:\\Windows",
		);

		// Non-C: Windows install (D:\Windows, cwd=D:\repo\project) -> picks D:\ ahead of hardcoded C:\Windows
		setupWin({
			cwd: "D:\\repo\\project",
			systemRoot: "D:\\Windows",
			windir: "D:\\Windows",
		});
		assert.equal(resolveSafeWindowsKillCwdLexical({ commandPath: "D:\\Windows\\System32\\taskkill.exe" }), "D:\\");

		// Extended-prefix in-project alias and bare drive C: rejected
		setupWin({
			cwd: "C:\\repo\\project",
			systemRoot: "\\\\?\\C:\\repo\\project\\win",
			windir: "C:",
		});
		assert.equal(resolveSafeWindowsKillCwdLexical(), "C:\\Windows");

		// Long >=248-char SystemRoot on D: prefers short drive root D:\ (works with LongPathsEnabled=0)
		const longTail = Array.from({ length: 12 }, (_, i) => `seg_${String(i).padStart(2, "0")}_1234567890123456`).join(
			"\\",
		);
		setupWin({
			cwd: "D:\\a\\atomic\\atomic",
			systemRoot: `\\\\?\\D:\\a\\_temp\\${longTail}`,
			windir: `\\\\?\\D:\\a\\_temp\\${longTail}`,
		});
		assert.equal(
			resolveSafeWindowsKillCwdLexical({
				commandPath: `\\\\?\\D:\\a\\_temp\\${longTail}\\System32\\taskkill.exe`,
			}),
			"D:\\",
		);
	});

	test("protects enclosing install roots across subst drives, junctions, and npm/standalone layouts via installDirs", async () => {
		const { resolveSafeWindowsWorkingDirectoryAsync, resolveSafeWindowsWorkingDirectorySync } = await import(
			"../src/utils/windows-cwd.js"
		);
		const pkgRoot = "C:\\prefix\\node_modules\\@bastani\\atomic";
		const badJunction = "C:\\BadSysRoot";
		setupWin({
			cwd: "C:\\repo\\project",
			systemRoot: badJunction,
			windir: badJunction,
			tmpdir: `${pkgRoot}\\tmp`,
			dirs: [badJunction, `${pkgRoot}\\tmp`, "S:\\", "S:\\dist\\utils", pkgRoot, "C:\\"],
			realpaths: {
				[badJunction]: pkgRoot,
				"S:\\": pkgRoot,
				"S:\\dist\\utils": `${pkgRoot}\\dist\\utils`,
			},
		});

		assert.equal(resolveSafeWindowsWorkingDirectorySync({ installDirs: ["S:\\dist\\utils"] }), "C:\\");
		assert.equal(await resolveSafeWindowsWorkingDirectoryAsync({ installDirs: ["S:\\dist\\utils"] }), "C:\\");
	});
});
