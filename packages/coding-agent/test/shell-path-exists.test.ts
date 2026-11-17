import assert from "node:assert/strict";
import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

type ShellModule = typeof import("../src/utils/shell.js");

const { accessMock, accessSyncMock, execFileMock, spawnSyncMock } = vi.hoisted(() => ({
	accessMock: vi.fn(),
	accessSyncMock: vi.fn(),
	execFileMock: vi.fn(),
	spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	accessSync: accessSyncMock,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof FsPromises>()),
	access: accessMock,
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	execFile: execFileMock,
	spawnSync: spawnSyncMock,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const aliasesDir = "D:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps";
let shell: ShellModule;

function stubPlatform(platform: string) {
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

beforeEach(async () => {
	vi.stubEnv("ProgramFiles", undefined);
	vi.stubEnv("ProgramFiles(x86)", undefined);
	accessMock.mockReset();
	accessMock.mockResolvedValue(undefined);
	accessSyncMock.mockReset();
	execFileMock.mockReset();
	spawnSyncMock.mockReset();
	// Atomic memoizes PATH lookups per module instance; start each test without them.
	vi.resetModules();
	shell = await import("../src/utils/shell.js");
});

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.unstubAllEnvs();
});

// nodejs/node#36790: runnable Store aliases pass access(F_OK) but fail the extra
// stat check existsSync performs on Windows only.
describe("Windows Store shell aliases", () => {
	beforeEach(() => {
		stubPlatform("win32");
	});

	it.each(["bash.exe", "pwsh.exe"])("accepts %s found on PATH", (executable) => {
		const alias = `${aliasesDir}\\${executable}`;
		vi.stubEnv("PATH", `D:\\Tools;${aliasesDir}`);
		accessSyncMock.mockImplementation((path: string) => {
			if (path !== alias) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		const config = executable === "pwsh.exe" ? shell.getPowerShellConfig() : shell.getShellConfig();

		assert.equal(config.shell, alias);
	});

	it("accepts an explicitly configured shell alias", () => {
		const alias = `${aliasesDir}\\bash.exe`;

		assert.equal(shell.getShellConfig(alias).shell, alias);
	});

	it("skips PATH directories where the executable fails the existence check", () => {
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

	it("resolves bash on PATH asynchronously with execFile when /bin/bash fails access(F_OK)", async () => {
		accessMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));
		execFileMock.mockImplementation(
			(_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
				cb(null, "/usr/local/bin/bash\n");
			},
		);

		assert.equal((await shell.getShellConfigAsync()).shell, "/usr/local/bin/bash");
		assert.equal(accessSyncMock.mock.calls.length, 0);
		assert.equal(spawnSyncMock.mock.calls.length, 0);
	});
});
