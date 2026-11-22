import assert from "node:assert/strict";
import type { ExecFileOptions, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";

interface ExecCall {
	readonly file: string;
	readonly args: readonly string[];
	readonly options: ExecFileOptions;
}

interface SpawnCall {
	readonly file: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
}

const hooks = vi.hoisted(() => ({
	execCalls: [] as ExecCall[],
	spawnCalls: [] as SpawnCall[],
	existingDirs: new Set<string>(),
	existingFiles: new Set<string>(),
	realpaths: new Map<string, string>(),
	symlinks: new Set<string>(),
	realpathThrows: new Set<string>(),
	tmpdirValue: "C:\\Users\\tester\\AppData\\Local\\Temp",
	processCreationTime: undefined as string | undefined,
}));

vi.mock("@bastani/atomic", () => ({
	nativeTerminateProcess: undefined,
	readProcessCreationTime: async () => hooks.processCreationTime,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const execFile = ((
		file: string,
		args: readonly string[],
		options: ExecFileOptions,
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		hooks.execCalls.push({ file, args, options });
		queueMicrotask(() => callback(null, "ok\n", ""));
		return { stdin: { end() {} } };
	}) as unknown as typeof actual.execFile;
	const spawn = ((file: string, args: readonly string[], options: SpawnOptions = {}) => {
		hooks.spawnCalls.push({ file, args, options });
		const child = Object.assign(new EventEmitter(), { unref() {} });
		queueMicrotask(() => child.emit("exit", 0, null));
		return child;
	}) as unknown as typeof actual.spawn;
	return { ...actual, execFile, spawn, default: { ...actual, execFile, spawn } };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const statSync = ((path: Parameters<typeof actual.statSync>[0]) => {
		const key = String(path);
		if (key.includes("\0")) {
			throw Object.assign(new TypeError("The argument 'path' must be a string without null bytes"), {
				code: "ERR_INVALID_ARG_VALUE",
			});
		}
		if (hooks.existingDirs.has(key)) {
			return { isDirectory: () => true } as Stats;
		}
		if (hooks.existingFiles.has(key)) {
			return { isDirectory: () => false } as Stats;
		}
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.statSync;
	const lstatSync = ((path: Parameters<typeof actual.lstatSync>[0]) => {
		const key = String(path);
		if (hooks.symlinks.has(key)) {
			return { isDirectory: () => false, isSymbolicLink: () => true } as Stats;
		}
		if (hooks.existingDirs.has(key)) {
			return { isDirectory: () => true, isSymbolicLink: () => false } as Stats;
		}
		if (hooks.existingFiles.has(key)) {
			return { isDirectory: () => false, isSymbolicLink: () => false } as Stats;
		}
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.lstatSync;
	const resolveReal = (path: Parameters<typeof actual.realpathSync>[0]) => {
		const key = String(path);
		if (hooks.realpathThrows.has(key)) {
			throw Object.assign(new Error(`EACCES: ${key}`), { code: "EACCES" });
		}
		const mapped = hooks.realpaths.get(key);
		if (mapped !== undefined) return mapped;
		if (hooks.existingDirs.has(key) || hooks.existingFiles.has(key)) return key;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	};
	const realpathSync = Object.assign(resolveReal, { native: resolveReal }) as typeof actual.realpathSync;
	return { ...actual, statSync, lstatSync, realpathSync, default: { ...actual, statSync, lstatSync, realpathSync } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const stat = (async (path: Parameters<typeof actual.stat>[0]) => {
		const key = String(path);
		if (key.includes("\0")) {
			throw Object.assign(new TypeError("The argument 'path' must be a string without null bytes"), {
				code: "ERR_INVALID_ARG_VALUE",
			});
		}
		if (hooks.existingDirs.has(key)) return { isDirectory: () => true } as Stats;
		if (hooks.existingFiles.has(key)) return { isDirectory: () => false } as Stats;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.stat;
	const lstat = (async (path: Parameters<typeof actual.lstat>[0]) => {
		const key = String(path);
		if (hooks.symlinks.has(key)) return { isDirectory: () => false, isSymbolicLink: () => true } as Stats;
		if (hooks.existingDirs.has(key)) return { isDirectory: () => true, isSymbolicLink: () => false } as Stats;
		if (hooks.existingFiles.has(key)) return { isDirectory: () => false, isSymbolicLink: () => false } as Stats;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.lstat;
	const realpath = (async (path: Parameters<typeof actual.realpath>[0]) => {
		const key = String(path);
		if (hooks.realpathThrows.has(key)) throw Object.assign(new Error(`EACCES: ${key}`), { code: "EACCES" });
		const mapped = hooks.realpaths.get(key);
		if (mapped !== undefined) return mapped;
		if (hooks.existingDirs.has(key) || hooks.existingFiles.has(key)) return key;
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

function setWindowsEnv(opts: {
	cwd?: string;
	systemRoot?: string;
	windir?: string;
	dirs?: readonly string[];
	files?: readonly string[];
	realpaths?: Record<string, string>;
	symlinks?: readonly string[];
	realpathThrows?: readonly string[];
	tmpdir?: string;
}) {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	process.cwd = () => opts.cwd ?? "C:\\repo\\project";
	if (opts.systemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = opts.systemRoot;
	if (opts.windir === undefined) delete process.env.windir;
	else process.env.windir = opts.windir;
	hooks.existingDirs.clear();
	for (const d of opts.dirs ?? []) hooks.existingDirs.add(d);
	hooks.existingFiles.clear();
	for (const f of opts.files ?? []) hooks.existingFiles.add(f);
	hooks.realpaths.clear();
	for (const [k, v] of Object.entries(opts.realpaths ?? {})) hooks.realpaths.set(k, v);
	hooks.symlinks.clear();
	for (const s of opts.symlinks ?? []) hooks.symlinks.add(s);
	hooks.realpathThrows.clear();
	for (const t of opts.realpathThrows ?? []) hooks.realpathThrows.add(t);
	hooks.tmpdirValue = opts.tmpdir ?? "C:\\Users\\tester\\AppData\\Local\\Temp";
}

const savedSystemRoot = process.env.SystemRoot;
const savedWindir = process.env.windir;

afterEach(() => {
	hooks.execCalls.length = 0;
	hooks.spawnCalls.length = 0;
	hooks.existingDirs.clear();
	hooks.existingFiles.clear();
	hooks.realpaths.clear();
	hooks.symlinks.clear();
	hooks.realpathThrows.clear();
	hooks.processCreationTime = undefined;
	Object.defineProperty(process, "platform", originalPlatform);
	process.cwd = originalCwd;
	if (savedSystemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = savedSystemRoot;
	if (savedWindir === undefined) delete process.env.windir;
	else process.env.windir = savedWindir;
	vi.resetModules();
});

async function runHostCommand(command: string): Promise<ExecCall> {
	const { systemSources } = await import("../../packages/intercom/broker/broker-instance.js");
	await systemSources().run(command, []);
	assert.equal(hooks.execCalls.length, 1);
	return hooks.execCalls[0]!;
}

describe("intercom systemSources().run() Windows cwd selection", () => {
	test("uses SystemRoot when it is an existing absolute directory outside the project folder", async () => {
		setWindowsEnv({
			systemRoot: "Q:\\Windows",
			dirs: ["Q:\\Windows", "C:\\Windows", "C:\\Users\\tester\\AppData\\Local\\Temp"],
		});
		const call = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "Q:\\Windows");
	});

	test("uses windir when SystemRoot is unset and windir is an existing absolute directory outside the project", async () => {
		setWindowsEnv({
			systemRoot: undefined,
			windir: "Q:\\Windows",
			dirs: ["Q:\\Windows", "C:\\Windows"],
		});
		const call = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "Q:\\Windows");
	});

	test("falls back to tmpdir when SystemRoot, windir, and default C:\\Windows do not exist", async () => {
		setWindowsEnv({
			systemRoot: "Z:\\NoSuchWindows",
			windir: "Z:\\NoSuchWindows",
			dirs: ["C:\\Users\\tester\\AppData\\Local\\Temp", "D:\\Tools"],
		});
		const call = await runHostCommand("D:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "C:\\Users\\tester\\AppData\\Local\\Temp");
	});

	test("falls back to the explicit command's own directory when SystemRoot, windir, C:\\Windows, and tmpdir are unavailable", async () => {
		setWindowsEnv({
			systemRoot: "Z:\\NoSuchWindows",
			windir: "Z:\\NoSuchWindows",
			tmpdir: "Z:\\NoSuchTemp",
			dirs: ["D:\\Tools"],
		});
		const call = await runHostCommand("D:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "D:\\Tools");
	});

	test("rejects a file-as-SystemRoot and falls back to an existing absolute directory outside the project", async () => {
		setWindowsEnv({
			systemRoot: "C:\\temp\\not-a-dir.txt",
			windir: "C:\\temp\\not-a-dir.txt",
			files: ["C:\\temp\\not-a-dir.txt"],
			dirs: ["C:\\Users\\tester\\AppData\\Local\\Temp"],
		});
		const call = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "C:\\Users\\tester\\AppData\\Local\\Temp");
	});

	test("rejects relative, bare-drive, drive-relative, and NUL-byte SystemRoot values even if stat reports a directory", async () => {
		for (const badSystemRoot of ["Windows", "C:", "\\Windows", "/Windows", "C:\\Windows\0bad"]) {
			hooks.execCalls.length = 0;
			setWindowsEnv({
				systemRoot: badSystemRoot,
				windir: badSystemRoot,
				// Pretend Windows/libuv would stat the relative or bare-drive path as a directory.
				dirs: [badSystemRoot, "C:\\Users\\tester\\AppData\\Local\\Temp"],
			});
			const call = await runHostCommand("C:\\Tools\\node.exe");
			assert.equal(
				call.options.cwd,
				"C:\\Users\\tester\\AppData\\Local\\Temp",
				`rejected ${JSON.stringify(badSystemRoot)}`,
			);
		}
	});

	test("never selects the project folder or a subdirectory of it when an outside directory exists", async () => {
		setWindowsEnv({
			cwd: "C:\\repo\\project",
			systemRoot: "C:\\repo\\project\\fake-win",
			windir: "C:\\repo\\project",
			tmpdir: "C:\\repo\\project\\tmp",
			dirs: ["C:\\repo\\project", "C:\\repo\\project\\fake-win", "C:\\repo\\project\\tmp", "C:\\"],
		});
		const call = await runHostCommand("C:\\repo\\project\\tool.exe");
		assert.equal(call.options.cwd, "C:\\");
	});

	test("still selects an existing absolute directory when process.cwd() itself is the drive root", async () => {
		setWindowsEnv({
			cwd: "C:\\",
			systemRoot: "C:\\Windows",
			dirs: ["C:\\", "C:\\Windows"],
		});
		const call = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "C:\\Windows");
	});

	test("rejects an external junction whose real target is inside the project folder", async () => {
		setWindowsEnv({
			cwd: "C:\\repo\\project",
			systemRoot: "C:\\temp\\win-junc",
			windir: "C:\\temp\\win-junc",
			dirs: ["C:\\repo\\project", "C:\\temp\\win-junc", "C:\\Windows"],
			symlinks: ["C:\\temp\\win-junc"],
			realpaths: {
				"C:\\repo\\project": "C:\\repo\\project",
				"C:\\temp\\win-junc": "C:\\repo\\project\\fake-win",
				"C:\\Windows": "C:\\Windows",
			},
		});
		const call = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "C:\\Windows");
	});

	test("rejects a candidate inside the project when process.cwd() is reached through a junction or 8.3 short name", async () => {
		setWindowsEnv({
			cwd: "E:\\junc-project",
			systemRoot: "C:\\repo\\project\\fake-win",
			windir: "C:\\repo\\project\\fake-win",
			dirs: ["E:\\junc-project", "C:\\repo\\project\\fake-win", "C:\\Windows"],
			symlinks: ["E:\\junc-project"],
			realpaths: {
				"E:\\junc-project": "C:\\repo\\project",
				"C:\\repo\\project\\fake-win": "C:\\repo\\project\\fake-win",
				"C:\\Windows": "C:\\Windows",
			},
		});
		const juncCall = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(juncCall.options.cwd, "C:\\Windows");

		hooks.execCalls.length = 0;
		setWindowsEnv({
			cwd: "C:\\Users\\RUNNER~1\\project",
			systemRoot: "C:\\Users\\runneradmin\\project\\fake-win",
			windir: "C:\\Users\\runneradmin\\project\\fake-win",
			dirs: ["C:\\Users\\RUNNER~1\\project", "C:\\Users\\runneradmin\\project\\fake-win", "C:\\Windows"],
			realpaths: {
				"C:\\Users\\RUNNER~1\\project": "C:\\Users\\runneradmin\\project",
				"C:\\Users\\runneradmin\\project\\fake-win": "C:\\Users\\runneradmin\\project\\fake-win",
				"C:\\Windows": "C:\\Windows",
			},
		});
		const shortCall = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(shortCall.options.cwd, "C:\\Windows");
	});

	test("rejects extended-length and device-prefixed aliases of the project folder even when realpath is unavailable", async () => {
		for (const [cwd, alias] of [
			["C:\\repo\\project", "\\\\?\\C:\\repo\\project\\fake-win"],
			["C:\\repo\\project", "\\\\.\\C:\\repo\\project\\fake-win"],
			["\\\\server\\share\\project", "\\\\?\\UNC\\server\\share\\project\\fake-win"],
		] as const) {
			hooks.execCalls.length = 0;
			setWindowsEnv({
				cwd,
				systemRoot: alias,
				windir: alias,
				dirs: [cwd, alias, "C:\\Windows"],
				realpathThrows: [cwd, alias, "C:\\Windows"],
			});
			const call = await runHostCommand("C:\\Tools\\node.exe");
			assert.equal(call.options.cwd, "C:\\Windows", `rejected alias ${alias}`);
		}
	});

	test("rejects raw volume device paths and incomplete UNC roots even if stat reports a directory", async () => {
		for (const badPath of [
			"\\\\?\\C:",
			"\\\\.\\C:",
			"\\\\?\\UNC\\",
			"\\\\?\\UNC\\server",
			"\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}",
		]) {
			hooks.execCalls.length = 0;
			setWindowsEnv({
				systemRoot: badPath,
				windir: badPath,
				dirs: [badPath, "C:\\Users\\tester\\AppData\\Local\\Temp"],
			});
			const call = await runHostCommand("C:\\Tools\\node.exe");
			assert.equal(
				call.options.cwd,
				"C:\\Users\\tester\\AppData\\Local\\Temp",
				`rejected ${JSON.stringify(badPath)}`,
			);
		}
	});

	test("falls back to process.cwd()'s drive root when SystemRoot/windir are inside the project and tmpdir/command are relative", async () => {
		setWindowsEnv({
			cwd: "D:\\repo\\project",
			systemRoot: "D:\\repo\\project\\fake-win",
			windir: "D:\\repo\\project\\fake-win",
			tmpdir: "relative-tmp",
			dirs: ["D:\\repo\\project", "D:\\repo\\project\\fake-win", "D:\\"],
		});
		const call = await runHostCommand("bin\\tool.exe");
		assert.equal(call.options.cwd, "D:\\");
	});

	test("treats a subst drive mapped to a project folder as a removable project and escapes to the real drive root", async () => {
		setWindowsEnv({
			cwd: "S:\\",
			systemRoot: "S:\\fake-win",
			windir: "C:\\repo\\project\\fake-win",
			tmpdir: "relative-tmp",
			dirs: ["S:\\", "S:\\fake-win", "C:\\repo\\project\\fake-win", "C:\\"],
			realpaths: {
				"S:\\": "C:\\repo\\project",
				"S:\\fake-win": "C:\\repo\\project\\fake-win",
				"C:\\repo\\project\\fake-win": "C:\\repo\\project\\fake-win",
				"C:\\": "C:\\",
			},
		});
		const call = await runHostCommand("tool.exe");
		assert.equal(call.options.cwd, "C:\\");
	});

	test("when process.cwd() is a genuine drive root, prefers SystemRoot on that drive over an explicit command on another drive", async () => {
		setWindowsEnv({
			cwd: "C:\\",
			systemRoot: "C:\\Windows",
			dirs: ["C:\\", "C:\\Windows", "D:\\Tools", "D:\\"],
			realpaths: {
				"C:\\": "C:\\",
				"C:\\Windows": "C:\\Windows",
				"D:\\Tools": "D:\\Tools",
				"D:\\": "D:\\",
			},
		});
		const call = await runHostCommand("D:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "C:\\Windows");
	});

	test("when process.cwd() is a genuine drive root and SystemRoot is that same drive root, prefers another directory and falls back to the root if none exists", async () => {
		setWindowsEnv({
			cwd: "C:\\",
			systemRoot: "C:\\",
			windir: "C:\\",
			dirs: ["C:\\", "C:\\Windows"],
			realpaths: {
				"C:\\": "C:\\",
				"C:\\Windows": "C:\\Windows",
			},
		});
		const withWindows = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(withWindows.options.cwd, "C:\\Windows");

		hooks.execCalls.length = 0;
		setWindowsEnv({
			cwd: "C:\\",
			systemRoot: "C:\\",
			windir: "C:\\",
			tmpdir: "Z:\\NoSuchTemp",
			dirs: ["C:\\"],
			realpaths: { "C:\\": "C:\\" },
		});
		const onlyRoot = await runHostCommand("Z:\\NoSuch\\node.exe");
		assert.equal(onlyRoot.options.cwd, "C:\\");
	});

	test("skips an unverified symlink/junction when realpath fails and a verified outside directory exists", async () => {
		setWindowsEnv({
			cwd: "C:\\repo\\project",
			systemRoot: "C:\\temp\\unverified-junc",
			windir: "C:\\temp\\unverified-junc",
			dirs: ["C:\\repo\\project", "C:\\temp\\unverified-junc", "C:\\Windows"],
			symlinks: ["C:\\temp\\unverified-junc"],
			realpathThrows: ["C:\\temp\\unverified-junc"],
		});
		const call = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "C:\\Windows");
	});

	test("resolves an external junction pointing outside the project to its canonical target", async () => {
		setWindowsEnv({
			cwd: "C:\\repo\\project",
			systemRoot: "C:\\temp\\alt-win",
			dirs: ["C:\\repo\\project", "C:\\temp\\alt-win", "C:\\Windows"],
			symlinks: ["C:\\temp\\alt-win"],
			realpaths: {
				"C:\\repo\\project": "C:\\repo\\project",
				"C:\\temp\\alt-win": "C:\\Windows",
				"C:\\Windows": "C:\\Windows",
			},
		});
		const call = await runHostCommand("C:\\Tools\\node.exe");
		assert.equal(call.options.cwd, "C:\\Windows");
	});

	test("leaves cwd unset on POSIX platforms", async () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
		const call = await runHostCommand("/usr/bin/env");
		assert.equal(call.options.cwd, undefined);
	});
});

describe("intercom stopWindowsProcess() Windows cwd selection", () => {
	test("never runs PowerShell in a junction pointing into the project folder or an invalid SystemRoot", async () => {
		hooks.processCreationTime = "2026-11-22T00:00:00.0000000Z";
		setWindowsEnv({
			cwd: "C:\\repo\\project",
			systemRoot: "C:\\temp\\win-junc",
			windir: "C:\\temp\\win-junc",
			dirs: ["C:\\repo\\project", "C:\\temp\\win-junc", "C:\\Windows"],
			symlinks: ["C:\\temp\\win-junc"],
			realpaths: {
				"C:\\repo\\project": "C:\\repo\\project",
				"C:\\temp\\win-junc": "C:\\repo\\project\\fake-win",
				"C:\\Windows": "C:\\Windows",
			},
		});
		const { stopWindowsProcess } = await import("../../packages/intercom/broker/broker-process.js");
		await stopWindowsProcess(12345, hooks.processCreationTime, { waitMs: 500, descendants: false });
		assert.equal(hooks.spawnCalls.length, 1);
		assert.equal(hooks.spawnCalls[0]!.options.cwd, "C:\\Windows");
	});
});
