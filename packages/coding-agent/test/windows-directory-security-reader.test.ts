import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync };
});

const {
	evaluateWindowsDirectorySecurity,
	powershellCandidates,
	readWindowsDirectorySecurity,
	readWindowsDirectorySecurityWithPowerShell,
} = await import("../src/core/tools/windows-directory-security.ts");

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

afterEach(() => {
	vi.restoreAllMocks();
});

test("a descriptor read shares one timeout across its PowerShell candidates (#5324)", () => {
	let now = 0;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	spawnSync.mockImplementation(() => {
		now += 30_000;
		return failedRead("ETIMEDOUT");
	});

	assert.equal(readWindowsDirectorySecurityWithPowerShell(QUERY_PATH), undefined);
	assert.deepEqual(triedExecutables(), [powershellCandidates()[0]]);
});

test("a descriptor read still tries another PowerShell with the same name when its budget remains (#5324)", () => {
	const expected = {
		currentSid: "S-1-5-21-1",
		ownerSid: "S-1-5-21-1",
		dacl: "D:(A;;FA;;;S-1-5-21-1)",
		accessRules: [{ allow: true, sid: "S-1-5-21-1" }],
	};
	spawnSync
		.mockReturnValueOnce(failedRead("ETIMEDOUT"))
		.mockReturnValueOnce({ status: 0, stdout: "S-1-5-21-1\nS-1-5-21-1\nD:(A;;FA;;;S-1-5-21-1)\nAllow;S-1-5-21-1" })
		.mockReturnValue(failedRead("ENOENT"));

	assert.deepEqual(readWindowsDirectorySecurityWithPowerShell(QUERY_PATH), expected);
	assert.deepEqual(triedExecutables(), powershellCandidates().slice(0, 2));
});

test("a descriptor read that cannot start a PowerShell program still tries the next one of the same name (#5324)", () => {
	spawnSync.mockImplementation(() => failedRead("ENOENT"));

	assert.equal(readWindowsDirectorySecurityWithPowerShell(QUERY_PATH), undefined);
	assert.deepEqual(triedExecutables(), powershellCandidates());
});

test.skipIf(process.platform !== "win32")(
	"a directory's descriptor is read without starting PowerShell, so a loaded host cannot hold the main thread on it (#5324)",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-native-descriptor-"));
		try {
			const security = readWindowsDirectorySecurity(dir);

			assert.ok(security, "the descriptor of an owned directory is readable");
			assert.match(security.currentSid, /^S-1-/);
			assert.match(security.ownerSid, /^S-1-/);
			assert.equal(evaluateWindowsDirectorySecurity(security), undefined);
			assert.deepEqual(triedExecutables(), [], "no PowerShell process was started");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
