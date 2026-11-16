/**
 * Removing a generation of the broker socket lock while a broker with an older judgment moves a generation it made into
 * that number (#5220). Removed in place, the generation is an empty directory for a moment once its record is deleted,
 * and a rename onto an empty directory replaces it (ext4, vfat), so the removal's final step found the directory full
 * again and failed with ENOTEMPTY, out of the broker's release. The test pauses the removal at that moment, as the
 * operating system can, and makes the other broker's move then.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** What another broker does while this one is removing a generation, between deleting its record and its directory. */
const race = vi.hoisted(() => ({ whileRemoving: undefined as (() => void) | undefined }));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	// A recursive removal deletes a directory's entries and then the directory, as Node's does; the pause falls between.
	const rmSync = ((path, options) => {
		const hook = race.whileRemoving;
		const isDirectory = actual.existsSync(path) && actual.statSync(path).isDirectory();
		if (hook === undefined || !isDirectory || !/\.(gen\d+|trash-[^/\\]+)$/.test(String(path))) {
			actual.rmSync(path, options);
			return;
		}
		race.whileRemoving = undefined;
		for (const entry of actual.readdirSync(path)) actual.rmSync(join(String(path), entry), options);
		hook();
		actual.rmdirSync(path);
	}) as typeof actual.rmSync;
	return { ...actual, default: { ...actual, rmSync }, rmSync };
});

const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const { acquireSocketReplacementLock } = await import("../../packages/intercom/broker/socket-replacement-lock.js");

const tempDir = makeTempDirectory("ic5220-gen-removal-");
afterAll(() => removeTempDirectory(tempDir));
afterEach(() => {
	race.whileRemoving = undefined;
});

let lockCount = 0;

describe("removing a socket-lock generation (#5220)", () => {
	test("a broker moving a generation into the number being removed never makes release or the next acquire fail (#5220)", async () => {
		const lockPath = join(tempDir, `broker.sock.lock-${lockCount++}`);
		const first = await acquireSocketReplacementLock(lockPath);
		const held = fs.readdirSync(tempDir).find((name) => /^broker\.sock\.lock-\d+\.gen\d+$/.test(name));
		assert.ok(held !== undefined, "the broker holds a generation");
		race.whileRemoving = () => {
			// A broker that judged the generation before it free moves one it made into the same number.
			const staging = join(tempDir, `staging-${process.pid}`);
			fs.mkdirSync(staging);
			fs.writeFileSync(join(staging, "owner"), "2147483646\n\n");
			try {
				fs.renameSync(staging, join(tempDir, held));
			} catch {
				// Where a rename never replaces a directory (Windows), the other broker's move fails instead.
				fs.rmSync(staging, { recursive: true, force: true });
			}
		};

		assert.doesNotThrow(() => first(), "releasing the lock");
		const next = await acquireSocketReplacementLock(lockPath);
		assert.equal(next.held(), true, "the next broker takes the lock");
		next();
	});
});
