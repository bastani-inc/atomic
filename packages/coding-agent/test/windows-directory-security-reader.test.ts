import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test, vi } from "vitest";

const { spawn, nativeReader } = vi.hoisted(() => ({ spawn: vi.fn(), nativeReader: vi.fn() }));

// Each PowerShell is the mocked child process, so every candidate is found under its own name.
vi.mock("../src/utils/helper-command.ts", () => ({
	helperLaunchAsync: async (name: string) => ({ file: name }),
	missingHelperOptions: () => ({}),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn };
});

vi.mock("../src/utils/module-require.js", () => ({
	createModuleRequire: () => () => ({ windowsDirectorySecurityAsync: nativeReader }),
}));

const {
	powershellCandidates,
	readWindowsDirectorySecurityAsync,
	resetWindowsDirectorySecurityStateForTesting,
	verifyWindowsDirectorySecurity,
	waitForWindowsDirectorySecurityReadsForTesting,
} = await import("../src/core/tools/windows-directory-security.js");

const EXPECTED_SECURITY = {
	currentSid: "S-1-5-21-1",
	ownerSid: "S-1-5-21-1",
	dacl: "D:(A;;FA;;;S-1-5-21-1)",
	accessRules: [{ allow: true, sid: "S-1-5-21-1" }],
};
const SECURITY_OUTPUT = "S-1-5-21-1\nS-1-5-21-1\nD:(A;;FA;;;S-1-5-21-1)\nAllow;S-1-5-21-1";

function childProcess() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
		ref: vi.fn(),
		unref: vi.fn(),
	});
	child.kill.mockImplementation(() => queueMicrotask(() => child.emit("close", null, "SIGTERM")));
	return child;
}

function triedExecutables(): string[] {
	return spawn.mock.calls.map(([executable]) => String(executable));
}

let dir: string;

beforeEach(() => {
	spawn.mockReset().mockImplementation(() => {
		throw new Error("unexpected PowerShell launch");
	});
	nativeReader.mockReset().mockReturnValue(null);
	resetWindowsDirectorySecurityStateForTesting();
	dir = mkdtempSync(join(tmpdir(), "atomic-native-descriptor-"));
});

afterEach(() => {
	resetWindowsDirectorySecurityStateForTesting();
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

test("a descriptor read uses the native reader without starting PowerShell (#5324)", async () => {
	nativeReader.mockReturnValue(EXPECTED_SECURITY);

	assert.deepEqual(await readWindowsDirectorySecurityAsync(dir), EXPECTED_SECURITY);
	assert.deepEqual(nativeReader.mock.calls, [[dir]]);
	assert.deepEqual(triedExecutables(), []);
});

test("a synchronous directory check defers its native read until after returning (#5324)", async () => {
	nativeReader.mockReturnValue(EXPECTED_SECURITY);

	assert.equal(verifyWindowsDirectorySecurity(dir), "its ownership is still being verified");
	assert.equal(nativeReader.mock.calls.length, 0);
	await waitForWindowsDirectorySecurityReadsForTesting();
	assert.equal(verifyWindowsDirectorySecurity(dir), undefined);
	assert.deepEqual(nativeReader.mock.calls, [[dir]]);
	assert.deepEqual(triedExecutables(), []);
});

test("a read abandoned before its deferred start never calls the native reader (#5324)", async () => {
	nativeReader.mockReturnValue(EXPECTED_SECURITY);
	const controller = new AbortController();
	const read = readWindowsDirectorySecurityAsync(dir, { signal: controller.signal });
	controller.abort();

	assert.equal(await read, undefined);
	assert.deepEqual(nativeReader.mock.calls, []);
	assert.deepEqual(triedExecutables(), []);
	assert.deepEqual(await readWindowsDirectorySecurityAsync(dir), EXPECTED_SECURITY);
	assert.deepEqual(nativeReader.mock.calls, [[dir]]);
});

test("a descriptor read shares one timeout across its PowerShell candidates (#5324)", async () => {
	const child = childProcess();
	spawn.mockReturnValue(child);

	assert.equal(await readWindowsDirectorySecurityAsync(dir, { timeoutMs: 50 }), undefined);
	assert.deepEqual(triedExecutables(), [powershellCandidates()[0]]);
	assert.equal(child.kill.mock.calls.length, 1);
});

test("a cancelled ACL fallback does not retry killing a child that reports a kill error (#5324)", async () => {
	const child = childProcess();
	child.kill.mockImplementation(() => {
		if (child.kill.mock.calls.length === 1) child.emit("error", new Error("kill failed"));
		queueMicrotask(() => child.emit("close", null, "SIGTERM"));
	});
	spawn.mockReturnValue(child);
	assert.equal(await readWindowsDirectorySecurityAsync(dir, { timeoutMs: 20 }), undefined);
	assert.equal(child.kill.mock.calls.length, 1);
});

test("a descriptor read still tries another PowerShell with the same name when its budget remains (#5324)", async () => {
	let attempts = 0;
	spawn.mockImplementation(() => {
		const child = childProcess();
		queueMicrotask(() => {
			if (attempts++ === 0) {
				child.emit("error", Object.assign(new Error("early host timeout"), { code: "ETIMEDOUT" }));
				child.emit("close", null, null);
			} else {
				child.stdout.write(SECURITY_OUTPUT);
				child.emit("close", 0, null);
			}
		});
		return child;
	});

	assert.deepEqual(await readWindowsDirectorySecurityAsync(dir), EXPECTED_SECURITY);
	assert.deepEqual(triedExecutables(), powershellCandidates().slice(0, 2));
});

test("a descriptor read that cannot start a PowerShell program still tries the next one of the same name (#5324)", async () => {
	spawn.mockImplementation(() => {
		const child = childProcess();
		queueMicrotask(() => {
			child.emit("error", Object.assign(new Error("missing host"), { code: "ENOENT" }));
			child.emit("close", null, null);
		});
		return child;
	});

	assert.equal(await readWindowsDirectorySecurityAsync(dir), undefined);
	assert.deepEqual(triedExecutables(), powershellCandidates());
});

test("an unavailable asynchronous native descriptor falls back to PowerShell (#5324)", async () => {
	nativeReader.mockResolvedValue(undefined);
	spawn.mockImplementation(() => {
		const child = childProcess();
		queueMicrotask(() => {
			child.stdout.write(SECURITY_OUTPUT);
			child.emit("close", 0, null);
		});
		return child;
	});
	assert.deepEqual(await readWindowsDirectorySecurityAsync(dir), EXPECTED_SECURITY);
	assert.deepEqual(triedExecutables(), [powershellCandidates()[0]]);
});

test("a native reader failure falls back to asynchronous PowerShell (#5324)", async () => {
	nativeReader.mockImplementation(() => {
		throw new Error("native read unavailable");
	});
	spawn.mockImplementation(() => {
		const child = childProcess();
		queueMicrotask(() => {
			child.stdout.write(SECURITY_OUTPUT);
			child.emit("close", 0, null);
		});
		return child;
	});

	assert.deepEqual(await readWindowsDirectorySecurityAsync(dir), EXPECTED_SECURITY);
	assert.deepEqual(nativeReader.mock.calls, [[dir]]);
	assert.deepEqual(triedExecutables(), [powershellCandidates()[0]]);
});
