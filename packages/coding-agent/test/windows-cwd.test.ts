import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
	dirs: new Set<string>(),
	files: new Set<string>(),
	realpaths: new Map<string, string>(),
	symlinks: new Set<string>(),
	realpathThrows: new Set<string>(),
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
	const realpath = (async (path: Parameters<typeof actual.realpath>[0]) => {
		const key = String(path);
		if (hooks.realpathThrows.has(key)) throw Object.assign(new Error(`EACCES: ${key}`), { code: "EACCES" });
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
}

afterEach(() => {
	hooks.dirs.clear();
	hooks.files.clear();
	hooks.realpaths.clear();
	hooks.symlinks.clear();
	hooks.realpathThrows.clear();
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
		const { isDriveRootWindowsPath, normalizeWindowsPathForCompare, windowsDriveRoot } = await import(
			"../src/utils/windows-cwd.js"
		);

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

	test("async and sync selectors agree on junctions, subst roots, drive-root cwd, and unverified symlinks", async () => {
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
	});

	test("cached synchronous helper uses warmed realpath result and invalidates on env or cwd change", async () => {
		const {
			getCachedOrLexicalSafeWindowsWorkingDirectory,
			resolveSafeWindowsWorkingDirectoryLexical,
			warmSafeWindowsWorkingDirectoryAsync,
		} = await import("../src/utils/windows-cwd.js");

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
		await warmSafeWindowsWorkingDirectoryAsync();
		assert.equal(getCachedOrLexicalSafeWindowsWorkingDirectory(), "C:\\Windows");

		// Lexical-only fallback still rejects extended-prefix in-project alias and bare drive C: synchronously.
		setupWin({
			cwd: "C:\\repo\\project",
			systemRoot: "\\\\?\\C:\\repo\\project\\win",
			windir: "C:",
		});
		assert.equal(resolveSafeWindowsWorkingDirectoryLexical(), "C:\\Windows");
		assert.equal(getCachedOrLexicalSafeWindowsWorkingDirectory(), "C:\\Windows");
	});
});
