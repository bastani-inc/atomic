import assert from "node:assert/strict";
import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

type ShellModule = typeof import("../src/utils/shell.js");

const { accessSyncMock, spawnSyncMock } = vi.hoisted(() => ({
	accessSyncMock: vi.fn(),
	spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	accessSync: accessSyncMock,
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawnSync: spawnSyncMock,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const pwsh7 = "D:\\Applications\\PowerShell\\7\\pwsh.exe";
const windowsPowerShell = "E:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
let shellModule: ShellModule;

function notFound(): never {
	throw Object.assign(new Error("not found"), { code: "ENOENT" });
}

beforeEach(async () => {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	vi.stubEnv("ProgramFiles", "D:\\Applications");
	vi.stubEnv("SystemRoot", "E:\\WinNT");
	accessSyncMock.mockReset().mockImplementation(notFound);
	spawnSyncMock.mockReset().mockReturnValue({ status: 1, stdout: "" });
	// Atomic memoizes PATH lookups per module instance; start each test without them.
	vi.resetModules();
	shellModule = await import("../src/utils/shell.js");
});

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.unstubAllEnvs();
});

// #9490: discover PowerShell outside PATH without assuming a drive or Windows directory name.
describe("getPowerShellConfig", () => {
	it("prefers PowerShell 7 on PATH over known installation locations (#9490)", () => {
		const shell = "E:\\Tools\\pwsh.exe";
		vi.stubEnv("PATH", "E:\\Tools");
		accessSyncMock.mockImplementation((path: string) => {
			if (![shell, pwsh7, windowsPowerShell].includes(path)) notFound();
		});

		assert.deepEqual(shellModule.getPowerShellConfig(), { shell, args: [...shellModule.POWERSHELL_ARGS] });
	});

	it("finds PowerShell 7 under ProgramFiles before Windows PowerShell on PATH (#9490)", () => {
		vi.stubEnv("PATH", "E:\\WinNT\\System32\\WindowsPowerShell\\v1.0");
		accessSyncMock.mockImplementation((path: string) => {
			if (![pwsh7, windowsPowerShell].includes(path)) notFound();
		});

		assert.deepEqual(shellModule.getPowerShellConfig(), { shell: pwsh7, args: [...shellModule.POWERSHELL_ARGS] });
	});

	it("prefers Windows PowerShell on PATH over its system installation (#9490)", () => {
		const shell = "E:\\Tools\\powershell.exe";
		vi.stubEnv("PATH", "E:\\Tools");
		accessSyncMock.mockImplementation((path: string) => {
			if (![shell, windowsPowerShell].includes(path)) notFound();
		});

		assert.deepEqual(shellModule.getPowerShellConfig(), { shell, args: [...shellModule.POWERSHELL_ARGS] });
	});

	it("finds Windows PowerShell under SystemRoot when it is not on PATH (#9490)", () => {
		vi.stubEnv("PATH", "");
		accessSyncMock.mockImplementation((path: string) => {
			if (path !== windowsPowerShell) notFound();
		});

		assert.deepEqual(shellModule.getPowerShellConfig(), {
			shell: windowsPowerShell,
			args: [...shellModule.POWERSHELL_ARGS],
		});
	});

	it("looks PowerShell up without starting another process", () => {
		vi.stubEnv("PATH", "E:\\Tools");
		accessSyncMock.mockImplementation((path: string) => {
			if (path !== windowsPowerShell) notFound();
		});

		shellModule.getPowerShellConfig();
		assert.equal(spawnSyncMock.mock.calls.length, 0);
	});

	it("reports an error when no PowerShell installation exists (#9490)", () => {
		assert.throws(() => shellModule.getPowerShellConfig(), /No PowerShell executable found/);
	});
});
