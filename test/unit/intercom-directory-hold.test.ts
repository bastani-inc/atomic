import assert from "node:assert/strict";
import type { BigIntStats } from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { type HeldDirectory, holdDirectory } from "../../packages/intercom/broker/directory-hold.js";

/** Whether the stats the directory hold reads report the change time as the creation time, as without `statx`. */
const noCreationTime = vi.hoisted(() => ({ on: false }));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const withChangeTime = <T>(stats: T): T => {
		if (!noCreationTime.on || stats === undefined || typeof (stats as BigIntStats).ctimeNs !== "bigint") return stats;
		const bigint = stats as BigIntStats;
		return Object.assign(Object.create(Object.getPrototypeOf(bigint)), bigint, { birthtimeNs: bigint.ctimeNs });
	};
	return {
		...fs,
		statSync: ((...args: Parameters<typeof fs.statSync>) =>
			withChangeTime(fs.statSync(...args))) as typeof fs.statSync,
		fstatSync: ((...args: Parameters<typeof fs.fstatSync>) =>
			withChangeTime(fs.fstatSync(...args))) as typeof fs.fstatSync,
	};
});

const roots: string[] = [];
const holds: HeldDirectory[] = [];
afterEach(() => {
	noCreationTime.on = false;
	for (const hold of holds.splice(0)) hold.release();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function heldDirectory(): { readonly path: string; readonly hold: HeldDirectory } {
	const root = mkdtempSync(join(tmpdir(), "directory-hold-"));
	roots.push(root);
	const path = join(root, "intercom");
	mkdirSync(path, { mode: 0o700 });
	const hold = holdDirectory(path);
	assert.ok(hold, "a directory that exists is held");
	holds.push(hold);
	return { path, hold };
}

// Where the system cannot report a creation time (statx refused, or an old kernel), Node and Bun report the change time
// in its place. Windows always reports it, and its change time moves with every file written in the directory.
const reports =
	process.platform === "win32"
		? (["its creation time"] as const)
		: (["its creation time", "its change time as its creation time"] as const);
for (const reported of reports)
	test(`a directory files are written in and whose mode changes is still held, where the system reports ${reported}`, () => {
		noCreationTime.on = reported !== "its creation time";
		const { path, hold } = heldDirectory();

		writeFileSync(join(path, "broker.pid"), "1\n");
		rmSync(join(path, "broker.pid"));
		writeFileSync(join(path, "broker.log"), "started\n");
		if (process.platform !== "win32") chmodSync(path, 0o700);

		assert.equal(hold.held(), true);
	});

test("a directory removed is no longer held, nor one made again at its path", () => {
	const { path, hold } = heldDirectory();

	rmSync(path, { recursive: true });
	assert.equal(hold.held(), false, "removed");
	// A directory made at once after one was removed is often given its inode on Linux.
	for (let attempt = 0; attempt < 20; attempt++) {
		mkdirSync(path, { mode: 0o700 });
		assert.equal(hold.held(), false, "made again");
		rmSync(path, { recursive: true });
	}
});

test("a path that is no directory is not held", () => {
	const root = mkdtempSync(join(tmpdir(), "directory-hold-"));
	roots.push(root);
	writeFileSync(join(root, "file"), "");

	assert.equal(holdDirectory(join(root, "file")), undefined);
	assert.equal(holdDirectory(join(root, "missing")), undefined);
});
