import assert from "node:assert/strict";
import type * as ChildProcessModule from "node:child_process";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}));

vi.mock("node:child_process", async () => ({
	...(await vi.importActual<typeof ChildProcessModule>("node:child_process")),
	execFile: mocks.execFile,
	execFileSync: mocks.execFileSync,
}));

const POWERSHELL_7_MODULES = "C:\\Program Files\\PowerShell\\7\\Modules";

function moduleKeys(env: NodeJS.ProcessEnv | undefined): string[] {
	return Object.keys(env ?? {}).filter((key) => key.toLowerCase() === "psmodulepath");
}

describe("Windows PowerShell started without the PowerShell 7 parent's PSModulePath", () => {
	const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

	beforeEach(() => {
		vi.resetModules();
		mocks.execFile.mockReset();
		mocks.execFileSync.mockReset();
		vi.stubEnv("PSModulePath", POWERSHELL_7_MODULES);
		Object.defineProperty(process, "platform", { value: "win32" });
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", savedPlatform);
		vi.unstubAllEnvs();
	});

	test("the environment drops PSModulePath in any letter case and keeps the rest", async () => {
		const { windowsPowerShellEnvironment } = await import("../src/utils/windows-powershell.ts");
		assert.deepEqual(
			windowsPowerShellEnvironment({ PSMODULEPATH: "a", psmodulepath: "b", Path: "C:\\bin", X: "y" }),
			{
				Path: "C:\\bin",
				X: "y",
			},
		);
	});

	test("a process start read through Get-Process starts without it (#5324)", async () => {
		mocks.execFile.mockImplementation(
			(
				_file: string,
				_args: string[],
				_options: object,
				callback: (error: Error | null, stdout: string) => void,
			) => {
				callback(null, "132000000000000000\n");
				return { kill: () => true };
			},
		);
		const tokens = await import("../src/core/process-start-token.ts");
		tokens.setNativeProcessCreationTimeForTesting(null);
		try {
			await tokens.readProcessStartToken(4242);
			assert.equal(mocks.execFile.mock.calls.length, 1);
			const [file, , options] = mocks.execFile.mock.calls[0]!;
			assert.equal(file, "powershell.exe");
			assert.deepEqual(moduleKeys((options as { env?: NodeJS.ProcessEnv }).env), []);
			assert.ok((options as { env?: NodeJS.ProcessEnv }).env, "the read passes an environment");
		} finally {
			tokens.setNativeProcessCreationTimeForTesting(undefined);
		}
	});

	test("a synchronous process start read through Get-Process starts without it (#5324)", async () => {
		mocks.execFileSync.mockReturnValue("132000000000000000\n");
		const tokens = await import("../src/core/process-start-token.ts");
		tokens.setNativeProcessCreationTimeForTesting(null);
		try {
			tokens.processStartTokenForSynchronousTakeover(4343);
			assert.equal(mocks.execFileSync.mock.calls.length, 1);
			const [file, , options] = mocks.execFileSync.mock.calls[0]!;
			assert.equal(file, "powershell.exe");
			const env = (options as { env?: NodeJS.ProcessEnv }).env;
			assert.ok(env, "the read passes an environment");
			assert.deepEqual(moduleKeys(env), []);
		} finally {
			tokens.setNativeProcessCreationTimeForTesting(undefined);
		}
	});
});
