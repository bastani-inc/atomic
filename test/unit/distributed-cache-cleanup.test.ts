import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { cacheFile } from "../distributed/harness/cache.mjs";
import { DistributedProvisionError } from "../distributed/harness/errors.mjs";

const remove = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	rmSync: remove,
}));

test("cache cleanup failures are typed and never replace the producer's primary failure (#4331)", async () => {
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	const dir = mkdtempSync(join(tmpdir(), "distributed-cache-cleanup-"));
	const cleanupCause = new Error("filesystem cleanup failed");
	remove.mockImplementation(() => {
		throw cleanupCause;
	});
	try {
		const primary = new DistributedProvisionError({ step: "validate", resource: "artifact" });
		await assert.rejects(
			cacheFile(join(dir, "failed"), async () => {
				throw primary;
			}),
			(error) => {
				assert.equal(error, primary);
				assert.ok(primary.cleanupCause instanceof DistributedProvisionError);
				assert.equal(primary.cleanupCause.fields.step, "remove cache staging");
				assert.equal(primary.cleanupCause.cause, cleanupCause);
				return true;
			},
		);
		await assert.rejects(
			cacheFile(join(dir, "success"), async (temporary) => {
				writeFileSync(temporary, "complete");
			}),
			(error) => {
				assert.ok(error instanceof DistributedProvisionError);
				assert.equal(error.fields.step, "remove cache staging");
				assert.equal(error.cause, cleanupCause);
				return true;
			},
		);
		assert.equal(remove.mock.calls.length, 2);
	} finally {
		remove.mockReset();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
