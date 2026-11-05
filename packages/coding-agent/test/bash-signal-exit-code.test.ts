import assert from "node:assert/strict";
import { constants as osConstants, tmpdir } from "node:os";
import { describe, it, vi } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.js";

vi.mock("../src/utils/child-process.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/child-process.js")>();
	return {
		...actual,
		waitForChildProcess: async (...args: Parameters<typeof actual.waitForChildProcess>) => {
			await actual.waitForChildProcess(...args);
			return null;
		},
	};
});

describe.skipIf(process.platform === "win32")("bash exit code of a shell killed by a signal", () => {
	it("is 128 plus the signal number when the child process reports no exit code", async () => {
		const result = await createLocalBashOperations().exec("kill -TERM $$", tmpdir(), { onData: () => {} });
		assert.equal(result.exitCode, 128 + osConstants.signals.SIGTERM);
	});
});
