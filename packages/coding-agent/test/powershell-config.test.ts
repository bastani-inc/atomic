import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ShellModule = typeof import("../src/utils/shell.ts");

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
	shellModule = await import("../src/utils/shell.ts");
});

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.unstubAllEnvs();
});

// #9490: discover PowerShell outside PATH without assuming a drive or Windows directory name.
describe("getPowerShellConfig", () => {
	it("prefers PowerShell 7 on PATH over known installation locations (#9490)", () => {
		const shell = "E:\\Tools\\pwsh.exe";
		spawnSyncMock.mockReturnValue({ status: 0, stdout: `${shell}\r\n` });
		accessSyncMock.mockReturnValue(undefined);

		expect(shellModule.getPowerShellConfig()).toEqual({ shell, args: [...shellModule.POWERSHELL_ARGS] });
	});

	it("finds PowerShell 7 under ProgramFiles before Windows PowerShell on PATH (#9490)", () => {
		spawnSyncMock.mockImplementation((_command: string, args: string[]) => ({
			status: args[0] === "powershell.exe" ? 0 : 1,
			stdout: args[0] === "powershell.exe" ? windowsPowerShell : "",
		}));
		accessSyncMock.mockImplementation((path: string) => {
			if (![pwsh7, windowsPowerShell].includes(path)) notFound();
		});

		expect(shellModule.getPowerShellConfig()).toEqual({ shell: pwsh7, args: [...shellModule.POWERSHELL_ARGS] });
	});

	it("prefers Windows PowerShell on PATH over its system installation (#9490)", () => {
		const shell = "E:\\Tools\\powershell.exe";
		spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "" }).mockReturnValueOnce({ status: 0, stdout: shell });
		accessSyncMock.mockImplementation((path: string) => {
			if (![shell, windowsPowerShell].includes(path)) notFound();
		});

		expect(shellModule.getPowerShellConfig()).toEqual({ shell, args: [...shellModule.POWERSHELL_ARGS] });
	});

	it("finds Windows PowerShell under SystemRoot when PATH lookup is unavailable (#9490)", () => {
		spawnSyncMock.mockReturnValue({ status: null, stdout: null, error: new Error("spawn where ENOENT") });
		accessSyncMock.mockImplementation((path: string) => {
			if (path !== windowsPowerShell) notFound();
		});

		expect(shellModule.getPowerShellConfig()).toEqual({
			shell: windowsPowerShell,
			args: [...shellModule.POWERSHELL_ARGS],
		});
	});

	it("reports an error when no PowerShell installation exists (#9490)", () => {
		expect(() => shellModule.getPowerShellConfig()).toThrow("No PowerShell executable found");
	});
});
