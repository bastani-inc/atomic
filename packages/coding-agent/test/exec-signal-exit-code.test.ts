import assert from "node:assert/strict";
import { constants as osConstants, tmpdir } from "node:os";
import { afterEach, describe, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.js";

let signalCodeOverride: NodeJS.Signals | null | undefined;

vi.mock("../src/utils/child-process.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/child-process.js")>();
	return {
		...actual,
		waitForChildProcess: async (proc: Parameters<typeof actual.waitForChildProcess>[0]) => {
			await actual.waitForChildProcess(proc);
			if (signalCodeOverride !== undefined) {
				Object.defineProperty(proc, "signalCode", { value: signalCodeOverride, configurable: true });
			}
			return null;
		},
	};
});

describe("execCommand exit code when waitForChildProcess returns null", () => {
	afterEach(() => {
		signalCodeOverride = undefined;
	});

	it.skipIf(process.platform === "win32")(
		"reports 128 plus the signal number for a signal-killed process (#12089)",
		async () => {
			const result = await execCommand(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")'], tmpdir());
			assert.equal(result.code, 128 + osConstants.signals.SIGTERM);
			assert.equal(result.killed, false);
		},
	);

	it("reports 128 when proc.signalCode is an unrecognized signal name (#12089)", async () => {
		signalCodeOverride = "SIGUNKNOWN" as NodeJS.Signals;
		const result = await execCommand(process.execPath, ["-e", "process.exit(0)"], tmpdir());
		assert.equal(result.code, 128);
	});

	it("reports 1 when neither an exit code nor a signal is reported (#12089)", async () => {
		signalCodeOverride = null;
		const result = await execCommand(process.execPath, ["-e", "process.exit(0)"], tmpdir());
		assert.equal(result.code, 1);
	});
});
