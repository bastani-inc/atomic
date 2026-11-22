import assert from "node:assert/strict";
import type { ExecFileOptions } from "node:child_process";
import type { Stats } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";

interface ExecCall {
	readonly file: string;
	readonly args: readonly string[];
	readonly options: ExecFileOptions;
}

const hooks = vi.hoisted(() => ({
	execCalls: [] as ExecCall[],
	existingDirs: new Set<string>(),
	existingFiles: new Set<string>(),
	tmpdirValue: "C:\\Users\\tester\\AppData\\Local\\Temp",
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
	return { ...actual, execFile, default: { ...actual, execFile } };
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
	return { ...actual, statSync, default: { ...actual, statSync } };
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
	hooks.tmpdirValue = opts.tmpdir ?? "C:\\Users\\tester\\AppData\\Local\\Temp";
}

const savedSystemRoot = process.env.SystemRoot;
const savedWindir = process.env.windir;

afterEach(() => {
	hooks.execCalls.length = 0;
	hooks.existingDirs.clear();
	hooks.existingFiles.clear();
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
			dirs: ["C:\\Windows"],
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
