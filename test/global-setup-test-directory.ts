import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLeftoverTestDirectories } from "./helpers/test-directory-removal.js";

const LEFTOVER_REMOVAL_RETRIES = { retries: 28, retryDelayMs: 50 };

/** Every fork inherits a sandbox parent. Only the process that created it removes it, after all workers exit. */
export default function setup(): (() => Promise<void>) | undefined {
	if (process.env.ATOMIC_TEST_RUN_DIR !== undefined) return undefined;
	const runDirectory = mkdtempSync(join(tmpdir(), "atomic-test-run-"));
	process.env.ATOMIC_TEST_RUN_DIR = runDirectory;
	return async () => {
		delete process.env.ATOMIC_TEST_RUN_DIR;
		const kept = await removeLeftoverTestDirectories(runDirectory, LEFTOVER_REMOVAL_RETRIES);
		if (kept.length > 0)
			console.warn(`Could not remove ${kept.length} test directories Windows still holds: ${kept.join(", ")}`);
		try {
			rmSync(runDirectory, { recursive: true, force: true });
		} catch {
			// A failed removal is only a leaked temp dir; never fail the run for it.
		}
	};
}
