import assert from "node:assert/strict";
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { accessSync, existing, spawnSync } = vi.hoisted(() => {
	const existing = new Set<string>();
	return {
		existing,
		spawnSync: vi.fn(),
		accessSync: vi.fn((path: string) => {
			if (!existing.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		}),
	};
});

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	accessSync,
}));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync };
});

const { getPowerShellConfig } = await import("../src/utils/shell.ts");

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalPath = process.env.PATH;

function lookupsIn(directory: string): number {
	return accessSync.mock.calls.filter(([path]) => String(path).startsWith(`${directory}\\`)).length;
}

describe("PowerShell executable lookup", () => {
	beforeEach(() => {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		spawnSync.mockReset();
		accessSync.mockClear();
		existing.clear();
		vi.stubEnv("ProgramFiles", undefined);
		vi.stubEnv("SystemRoot", undefined);
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", platform);
		process.env.PATH = originalPath;
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("resolves PowerShell with one PATH lookup per PATH value", () => {
		process.env.PATH = "C:\\first-empty;C:\\first-lookup-path";
		existing.add("C:\\first-lookup-path\\pwsh.exe");
		expect(getPowerShellConfig().shell).toBe("C:\\first-lookup-path\\pwsh.exe");
		const lookups = accessSync.mock.calls.length;
		expect(getPowerShellConfig().shell).toBe("C:\\first-lookup-path\\pwsh.exe");
		expect(getPowerShellConfig().shell).toBe("C:\\first-lookup-path\\pwsh.exe");
		expect(accessSync.mock.calls.length).toBe(lookups + 2);
		expect(lookupsIn("C:\\first-empty")).toBe(1);
	});

	it("looks PowerShell up again after PATH changes", () => {
		existing.add("C:\\second-lookup-path\\pwsh.exe");
		process.env.PATH = "C:\\second-empty;C:\\second-lookup-path";
		getPowerShellConfig();
		process.env.PATH = "C:\\second-empty;C:\\third-lookup-path";
		existing.add("C:\\third-lookup-path\\pwsh.exe");
		expect(getPowerShellConfig().shell).toBe("C:\\third-lookup-path\\pwsh.exe");
		expect(lookupsIn("C:\\second-empty")).toBe(2);
	});

	it("never takes PowerShell from a relative PATH entry, in whichever project folder Atomic works", () => {
		process.env.PATH = "relative-bin";
		existing.add("C:\\first-project\\relative-bin\\pwsh.exe");
		existing.add("C:\\second-project\\relative-bin\\pwsh.exe");
		const cwd = vi.spyOn(process, "cwd").mockReturnValue("C:\\first-project");
		try {
			assert.throws(() => getPowerShellConfig(), /No PowerShell executable found/);
			cwd.mockReturnValue("C:\\second-project");
			assert.throws(() => getPowerShellConfig(), /No PowerShell executable found/);
		} finally {
			cwd.mockRestore();
		}
	});

	it("finds PowerShell installed after a missed lookup without a PATH change", () => {
		vi.useFakeTimers();
		process.env.PATH = "C:\\install-later-path";
		assert.throws(() => getPowerShellConfig(), /No PowerShell executable found/);
		const missedLookups = accessSync.mock.calls.length;
		assert.throws(() => getPowerShellConfig(), /No PowerShell executable found/);
		assert.equal(accessSync.mock.calls.length, missedLookups);

		existing.add("C:\\install-later-path\\pwsh.exe");
		vi.advanceTimersByTime(30_000);
		assert.equal(getPowerShellConfig().shell, "C:\\install-later-path\\pwsh.exe");
	});

	it("resolves PowerShell on PATH without starting a process, so a loaded host cannot hold the main thread on it (#5324)", () => {
		process.env.PATH = '"C:\\quoted path";C:\\no-pwsh;C:\\windows-powershell';
		existing.add("C:\\windows-powershell\\powershell.exe");

		assert.equal(getPowerShellConfig().shell, "C:\\windows-powershell\\powershell.exe");
		assert.ok(lookupsIn("C:\\quoted path") >= 1, "a quoted PATH entry is searched without its quotes");
		assert.equal(spawnSync.mock.calls.length, 0, "no process was started");
	});
});
