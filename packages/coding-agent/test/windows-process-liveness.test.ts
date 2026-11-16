import { describe, expect, it } from "vitest";
import { keptExitedPid } from "../../../test/helpers/exited-process.js";
import { isWindowsProcessAlive } from "../src/utils/child-process.ts";

describe("isWindowsProcessAlive", () => {
	it("reports a running process as alive", () => {
		expect(isWindowsProcessAlive(process.pid)).toBe(true);
	});

	it("reports an exited child as gone", async () => {
		// A later process given the pid would run under it, so none is given it until this is checked.
		const exited = await keptExitedPid();
		try {
			expect(isWindowsProcessAlive(exited.pid)).toBe(false);
		} finally {
			await exited.release();
		}
	});
});
