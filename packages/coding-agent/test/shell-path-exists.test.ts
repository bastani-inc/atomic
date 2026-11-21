import assert from "node:assert/strict";
import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";

type ShellModule = typeof import("../src/utils/shell.js");

const { accessMock, accessSyncMock, execFileMock, spawnSyncMock, standIns } = vi.hoisted(() => ({
	accessMock: vi.fn(),
	accessSyncMock: vi.fn(),
	execFileMock: vi.fn(),
	spawnSyncMock: vi.fn(),
	standIns: { directories: new Set<string>(), aliases: new Set<string>(), directory: "", danglingLink: "" },
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	const lstatSync = ((path: Fs.PathLike, options?: Fs.StatSyncOptions) => {
		if (standIns.directories.has(String(path))) return actual.lstatSync(standIns.directory);
		if (standIns.aliases.has(String(path))) return actual.lstatSync(standIns.danglingLink);
		return actual.lstatSync(path, options);
	}) as typeof actual.lstatSync;
	const statSync = ((path: Fs.PathLike, options?: Fs.StatSyncOptions) => {
		if (standIns.aliases.has(String(path)))
			throw Object.assign(new Error(`EACCES: permission denied, stat '${String(path)}'`), { code: "EACCES" });
		return actual.statSync(path, options);
	}) as typeof actual.statSync;
	return { ...actual, accessSync: accessSyncMock, lstatSync, statSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const lstat = ((path: Fs.PathLike, options?: Fs.StatOptions) => {
		if (standIns.directories.has(String(path))) return actual.lstat(standIns.directory);
		if (standIns.aliases.has(String(path))) return actual.lstat(standIns.danglingLink);
		return actual.lstat(path, options);
	}) as typeof actual.lstat;
	const stat = ((path: Fs.PathLike, options?: Fs.StatOptions) => {
		if (standIns.aliases.has(String(path)))
			return Promise.reject(
				Object.assign(new Error(`EACCES: permission denied, stat '${String(path)}'`), { code: "EACCES" }),
			);
		return actual.stat(path, options);
	}) as typeof actual.stat;
	return { ...actual, access: accessMock, lstat, stat };
});

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	execFile: execFileMock,
	spawnSync: spawnSyncMock,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const standInRoot = mkdtempSync(join(tmpdir(), "atomic-shell-path-stand-ins-"));
standIns.directory = join(standInRoot, "directory");
mkdirSync(standIns.directory);
standIns.danglingLink = join(standInRoot, "dangling");
symlinkSync(join(standInRoot, "missing"), standIns.danglingLink, process.platform === "win32" ? "junction" : undefined);
const aliasesDir = "D:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps";
let shell: ShellModule;

function stubPlatform(platform: string) {
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

beforeEach(async () => {
	vi.stubEnv("ProgramFiles", undefined);
	vi.stubEnv("ProgramFiles(x86)", undefined);
	const missingInWorkingDirectory = (path: string) => {
		if (win32.dirname(path) === win32.resolve(process.cwd()))
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
	};
	accessMock.mockReset().mockImplementation(async (path: string) => missingInWorkingDirectory(path));
	accessSyncMock.mockReset().mockImplementation(missingInWorkingDirectory);
	execFileMock.mockReset();
	spawnSyncMock.mockReset();
	// Atomic memoizes PATH lookups per module instance; start each test without them.
	vi.resetModules();
	shell = await import("../src/utils/shell.js");
});

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.unstubAllEnvs();
	standIns.directories.clear();
	standIns.aliases.clear();
});

afterAll(() => {
	rmSync(standInRoot, { recursive: true, force: true });
});

// nodejs/node#36790: runnable Store aliases pass access(F_OK) but fail the extra
// stat check existsSync performs on Windows only.
describe("Windows Store shell aliases", () => {
	beforeEach(() => {
		stubPlatform("win32");
	});

	it.each(["bash.exe", "pwsh.exe"])("accepts %s found on PATH", (executable) => {
		const alias = `${aliasesDir}\\${executable}`;
		vi.stubEnv("PATH", aliasesDir);

		const config = executable === "pwsh.exe" ? shell.getPowerShellConfig() : shell.getShellConfig();

		assert.equal(config.shell, alias);
	});

	it("accepts an explicitly configured shell alias", () => {
		const alias = `${aliasesDir}\\bash.exe`;

		assert.equal(shell.getShellConfig(alias).shell, alias);
	});

	it("rejects an explicitly configured directory named like a shell (#5324)", () => {
		const directory = "D:\\tools\\bash.exe";
		standIns.directories.add(directory);

		assert.throws(() => shell.getShellConfig(directory), /Custom shell path not found/);
	});

	it("skips a directory named pwsh.exe in the known installation location (#5324)", () => {
		const directory = "D:\\Apps\\PowerShell\\7\\pwsh.exe";
		const executable = "E:\\Tools\\powershell.exe";
		standIns.directories.add(directory);
		vi.stubEnv("ProgramFiles", "D:\\Apps");
		vi.stubEnv("PATH", "E:\\Tools");
		accessSyncMock.mockImplementation((path: string) => {
			if (path !== directory && path !== executable) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		assert.equal(shell.getPowerShellConfig().shell, executable);
	});

	it("skips a directory named bash.exe in the known installation location (#5324)", () => {
		const directory = "D:\\Apps\\Git\\bin\\bash.exe";
		const executable = `${aliasesDir}\\bash.exe`;
		standIns.directories.add(directory);
		vi.stubEnv("ProgramFiles", "D:\\Apps");
		vi.stubEnv("PATH", aliasesDir);
		accessSyncMock.mockImplementation((path: string) => {
			if (path !== directory && path !== executable) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		assert.equal(shell.getShellConfig().shell, executable);
	});

	it("never takes a shell from a relative PATH entry, which names a directory in the project folder", () => {
		vi.stubEnv("PATH", "relative-bin");
		vi.stubEnv("SystemRoot", "D:\\Windows");

		assert.equal(shell.getPowerShellConfig().shell, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	});

	it("skips a directory named like the executable earlier on PATH (#5324)", () => {
		const shadowing = "D:\\first\\pwsh.exe";
		standIns.directories.add(shadowing);
		vi.stubEnv("PATH", `D:\\first;${aliasesDir}`);

		assert.equal(shell.getPowerShellConfig().shell, `${aliasesDir}\\pwsh.exe`);
	});

	it("keeps a Store alias whose link target cannot be read (#5324)", () => {
		const alias = `${aliasesDir}\\pwsh.exe`;
		standIns.aliases.add(alias);
		vi.stubEnv("PATH", aliasesDir);

		assert.equal(shell.getPowerShellConfig().shell, alias);
	});

	it("rejects an explicitly configured directory named like a shell when resolved asynchronously (#5324)", async () => {
		const directory = "D:\\tools\\bash.exe";
		standIns.directories.add(directory);

		await assert.rejects(shell.getShellConfigAsync(directory), /Custom shell path not found/);
		assert.equal(accessSyncMock.mock.calls.length, 0);
	});

	it("skips a directory named bash.exe in the known installation location when resolved asynchronously (#5324)", async () => {
		const directory = "D:\\Apps\\Git\\bin\\bash.exe";
		const executable = `${aliasesDir}\\bash.exe`;
		standIns.directories.add(directory);
		vi.stubEnv("ProgramFiles", "D:\\Apps");
		vi.stubEnv("PATH", aliasesDir);
		accessMock.mockImplementation(async (path: string) => {
			if (path !== directory && path !== executable) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		assert.equal((await shell.getShellConfigAsync()).shell, executable);
	});

	it("skips a directory named like the executable and a relative PATH entry when resolved asynchronously (#5324)", async () => {
		const shadowing = "D:\\first\\pwsh.exe";
		standIns.directories.add(shadowing);
		vi.stubEnv("PATH", `D:\\first;relative-bin;${aliasesDir}`);

		assert.equal((await shell.getPowerShellConfigAsync()).shell, `${aliasesDir}\\pwsh.exe`);
	});

	it("keeps a Store alias whose link target cannot be read when resolved asynchronously (#5324)", async () => {
		const alias = `${aliasesDir}\\pwsh.exe`;
		standIns.aliases.add(alias);
		vi.stubEnv("PATH", aliasesDir);

		assert.equal((await shell.getPowerShellConfigAsync()).shell, alias);
	});

	it("still rejects PATH results that fail the existence check", () => {
		const windowsPowerShell = "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		vi.stubEnv("PATH", `${aliasesDir};D:\\Windows\\System32\\WindowsPowerShell\\v1.0`);
		accessSyncMock.mockImplementation((path: string) => {
			if (path !== windowsPowerShell) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		assert.equal(shell.getPowerShellConfig().shell, windowsPowerShell);
	});
});

// The access(F_OK) check is intentionally used on every platform. On Unix it is
// the same syscall existsSync already performs.
describe("Unix shell existence checks", () => {
	beforeEach(() => {
		stubPlatform("linux");
	});

	it("accepts /bin/bash when access(F_OK) succeeds", () => {
		assert.equal(shell.getShellConfig().shell, "/bin/bash");
	});

	it("falls back to bash in a PATH directory when /bin/bash fails access(F_OK), without starting which", () => {
		accessSyncMock.mockImplementationOnce(() => {
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});
		const bin = mkdtempSync(join(tmpdir(), "atomic-shell-path-bin-"));
		try {
			writeFileSync(join(bin, "bash"), "");
			vi.stubEnv("PATH", bin);

			assert.equal(shell.getShellConfig().shell, join(bin, "bash"));
			assert.equal(spawnSyncMock.mock.calls.length, 0);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});

	it("rejects an explicitly configured shell path that fails access(F_OK)", () => {
		accessSyncMock.mockImplementationOnce(() => {
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		assert.throws(() => shell.getShellConfig("/missing/bash"), {
			message: "Custom shell path not found: /missing/bash",
		});
	});

	it("resolves bash in a PATH directory asynchronously when /bin/bash fails access(F_OK), without starting which", async () => {
		accessMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));
		const bin = mkdtempSync(join(tmpdir(), "atomic-shell-path-bin-"));
		try {
			writeFileSync(join(bin, "bash"), "");
			vi.stubEnv("PATH", bin);

			assert.equal((await shell.getShellConfigAsync()).shell, join(bin, "bash"));
			assert.equal(accessSyncMock.mock.calls.length, 0);
			assert.equal(spawnSyncMock.mock.calls.length, 0);
			assert.equal(execFileMock.mock.calls.length, 0);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});
});
