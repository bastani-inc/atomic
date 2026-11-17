import assert from "node:assert/strict";
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accessSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	accessSync,
}));

const { getPowerShellConfig } = await import("../src/utils/shell.ts");

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalPath = process.env.PATH;

function notFound(): never {
	throw Object.assign(new Error("not found"), { code: "ENOENT" });
}

/** Lets only `found` exist; counts the checks of every other candidate as lookups. */
function onlyExists(found: string | undefined): void {
	accessSync.mockImplementation((path: string) => {
		if (path !== found) notFound();
	});
}

describe("PowerShell executable lookup", () => {
	beforeEach(() => {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		accessSync.mockReset();
		// Hide the installation-directory fallbacks so only PATH can supply PowerShell.
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
		process.env.PATH = "C:\\first-lookup-path";
		onlyExists("C:\\first-lookup-path\\pwsh.exe");
		expect(getPowerShellConfig().shell).toBe("C:\\first-lookup-path\\pwsh.exe");
		const lookups = accessSync.mock.calls.length;
		expect(getPowerShellConfig().shell).toBe("C:\\first-lookup-path\\pwsh.exe");
		expect(getPowerShellConfig().shell).toBe("C:\\first-lookup-path\\pwsh.exe");
		// A remembered path is only checked to still exist.
		expect(accessSync.mock.calls.length).toBe(lookups + 2);
	});

	it("looks PowerShell up again after PATH changes", () => {
		process.env.PATH = "C:\\second-lookup-path";
		onlyExists("C:\\second-lookup-path\\pwsh.exe");
		getPowerShellConfig();
		process.env.PATH = "C:\\third-lookup-path";
		onlyExists("C:\\third-lookup-path\\pwsh.exe");
		expect(getPowerShellConfig().shell).toBe("C:\\third-lookup-path\\pwsh.exe");
	});

	it("finds PowerShell installed after a missed lookup without a PATH change", () => {
		vi.useFakeTimers();
		process.env.PATH = "C:\\install-later-path";
		onlyExists(undefined);
		assert.throws(() => getPowerShellConfig(), /No PowerShell executable found/);
		const missedLookups = accessSync.mock.calls.length;
		assert.throws(() => getPowerShellConfig(), /No PowerShell executable found/);
		assert.equal(accessSync.mock.calls.length, missedLookups);

		onlyExists("C:\\install-later-path\\pwsh.exe");
		vi.advanceTimersByTime(30_000);
		assert.equal(getPowerShellConfig().shell, "C:\\install-later-path\\pwsh.exe");
	});
});
