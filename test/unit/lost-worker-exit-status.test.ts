import assert from "node:assert/strict";
import { test } from "vitest";
import { decodeExit } from "../global-setup-lost-workers.js";

test("a lost worker's exit status 1 is reported as ambiguous on Windows and never as a kill (#5325)", () => {
	const windows = decodeExit(1, null, "win32");
	assert.match(windows, /^exit status 1, cause ambiguous: /);
	assert.match(windows, /TerminateProcess/);
	assert.match(windows, /process\.exit\(1\)/);
	assert.match(windows, /uncaught exception/);
	assert.match(windows, /IPC channel/);

	const linux = decodeExit(1, null, "linux");
	assert.match(linux, /^exit status 1, cause ambiguous: /);
	assert.match(linux, /process\.exit\(1\)/);
	assert.doesNotMatch(linux, /TerminateProcess/);

	assert.equal(decodeExit(3221225477, null, "win32"), "access violation");
	assert.equal(decodeExit(-1073741819, null, "win32"), "access violation");
	assert.match(decodeExit(null, "SIGKILL", "linux"), /^killed/);
	assert.equal(decodeExit(7, null, "linux"), "exit status 7");
	assert.equal(decodeExit(7, null, "win32"), "exit status 7");
});
