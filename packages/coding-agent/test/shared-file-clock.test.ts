import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { sharedFilesystemNow } from "../src/core/shared-file-clock.js";

/** How far this host's clock is off the file system's in these tests. */
const SKEW_MS = 10 * 60_000;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-shared-clock-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

test("the shared file system's time is read from a file written there, whatever this host's clock says, and the file is removed (#5058)", () => {
	const before = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(before + SKEW_MS);
	const now = sharedFilesystemNow(dir);
	assert.ok(Math.abs(now - before) < SKEW_MS / 2, `${now - before} ms off the file system's clock`);
	assert.deepEqual(readdirSync(dir), []);
});

test("where no file can be written, the shared time is this host's clock (#5058)", () => {
	vi.spyOn(Date, "now").mockReturnValue(1_234);
	assert.equal(sharedFilesystemNow(join(dir, "missing")), 1_234);
});
