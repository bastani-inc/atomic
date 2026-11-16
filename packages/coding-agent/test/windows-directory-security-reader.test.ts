import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync };
});

const { powershellCandidates, readWindowsDirectorySecurity } = await import(
	"../src/core/tools/windows-directory-security.ts"
);

const QUERY_PATH = "C:\\Users\\alice\\AppData\\Local\\Temp\\atomic-alice";

function failedRead(code: string) {
	return {
		status: null,
		signal: code === "ETIMEDOUT" ? "SIGTERM" : null,
		stdout: "",
		stderr: "",
		error: Object.assign(new Error(`spawnSync powershell.exe ${code}`), { code }),
	};
}

function triedExecutables(): string[] {
	return spawnSync.mock.calls.map(([executable]) => String(executable));
}

beforeEach(() => {
	spawnSync.mockReset();
});

test("a descriptor read that times out is not retried with the same PowerShell program (#5324)", () => {
	spawnSync.mockImplementation(() => failedRead("ETIMEDOUT"));
	const [windowsPowerShell, , powerShellCore] = powershellCandidates();

	assert.equal(readWindowsDirectorySecurity(QUERY_PATH), undefined);
	assert.deepEqual(triedExecutables(), [windowsPowerShell, powerShellCore]);
});

test("a descriptor read that cannot start a PowerShell program still tries the next one of the same name (#5324)", () => {
	spawnSync.mockImplementation(() => failedRead("ENOENT"));

	assert.equal(readWindowsDirectorySecurity(QUERY_PATH), undefined);
	assert.deepEqual(triedExecutables(), powershellCandidates());
});
