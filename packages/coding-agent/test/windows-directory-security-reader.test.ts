import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const { execFile, spawnSync } = vi.hoisted(() => ({ execFile: vi.fn(), spawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile, spawnSync };
});

const { powershellCandidates, readWindowsDirectorySecurity, readWindowsDirectorySecurityAsync } = await import(
	"../src/core/tools/windows-directory-security.ts"
);

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

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

function execFileAnswers(answer: (callback: ExecFileCallback) => void): void {
	execFile.mockImplementation((_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
		answer(callback);
	});
}

function triedAsynchronously(): string[] {
	return execFile.mock.calls.map(([executable]) => String(executable));
}

beforeEach(() => {
	spawnSync.mockReset();
	execFile.mockReset();
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

test("an asynchronous descriptor read that times out is not retried with the same PowerShell program (#5324)", async () => {
	execFileAnswers((callback) =>
		callback(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }), "", ""),
	);
	const [windowsPowerShell, , powerShellCore] = powershellCandidates();

	assert.equal(await readWindowsDirectorySecurityAsync(QUERY_PATH), undefined);
	assert.deepEqual(triedAsynchronously(), [windowsPowerShell, powerShellCore]);
	assert.equal(spawnSync.mock.calls.length, 0, "nothing was read on the main thread");
});

test("an asynchronous descriptor read returns the first PowerShell program's answer (#5324)", async () => {
	const sid = "S-1-5-21-1000000000-2000000000-3000000000-1001";
	execFileAnswers((callback) => callback(null, `${sid}\n${sid}\nD:PAI(A;OICI;FA;;;${sid})\nAllow;${sid}`, ""));

	assert.deepEqual(await readWindowsDirectorySecurityAsync(QUERY_PATH), {
		currentSid: sid,
		ownerSid: sid,
		dacl: `D:PAI(A;OICI;FA;;;${sid})`,
		accessRules: [{ allow: true, sid }],
	});
	assert.deepEqual(triedAsynchronously(), powershellCandidates().slice(0, 1));
	assert.equal(execFile.mock.calls[0]?.[2].env.ATOMIC_SECURITY_QUERY_PATH, QUERY_PATH);
});
