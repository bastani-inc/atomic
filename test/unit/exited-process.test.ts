import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { exitedProcess } from "../helpers/exited-process.js";
import { bunExecutable } from "../helpers/runtime.js";

test("exited holders use the configured Bun executable without a PATH entry (#5331)", () => {
	const executable = bunExecutable();
	vi.stubEnv("ATOMIC_BUN_EXECUTABLE", executable);
	vi.stubEnv("PATH", "");
	try {
		const holder = exitedProcess();
		assert.ok(Number.isInteger(holder.pid) && holder.pid > 0);
	} finally {
		vi.unstubAllEnvs();
	}
});
