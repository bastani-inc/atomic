import assert from "node:assert/strict";
import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";

type ShellModule = typeof import("../src/utils/shell.js");

const { accessSyncMock, spawnSyncMock, standIns } = vi.hoisted(() => ({
	accessSyncMock: vi.fn(),
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

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
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
	accessSyncMock.mockReset();
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

	it("returns a relative PATH entry's match as an absolute path, so it starts from any working directory (#5324)", () => {
		vi.stubEnv("PATH", "relative-bin");

		const found = shell.getPowerShellConfig().shell;

		assert.equal(found, win32.resolve(process.cwd(), "relative-bin", "pwsh.exe"));
		assert.ok(win32.isAbsolute(found), found);
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

	it("falls back to bash on PATH when /bin/bash fails access(F_OK)", () => {
		accessSyncMock.mockImplementationOnce(() => {
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});
		spawnSyncMock.mockReturnValue({ status: 0, stdout: "/usr/local/bin/bash\n" });

		assert.equal(shell.getShellConfig().shell, "/usr/local/bin/bash");
	});

	it("rejects an explicitly configured shell path that fails access(F_OK)", () => {
		accessSyncMock.mockImplementationOnce(() => {
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		assert.throws(() => shell.getShellConfig("/missing/bash"), {
			message: "Custom shell path not found: /missing/bash",
		});
	});
});
