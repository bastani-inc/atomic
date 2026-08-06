import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { hasEntryNewerThan } from "../../packages/subagents/src/runs/inprocess/runtime-support/nested-core.js";

const scanInstrumentation = vi.hoisted(() => ({ active: false, readdirCalls: [] as string[] }));

// Instrument readdirSync so the test can count directory reads, and normalize
// entry order so the fresh top-level entry is always scanned first.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
		const result = actual.readdirSync(...args);
		if (scanInstrumentation.active && Array.isArray(result) && typeof result[0] === "string") {
			scanInstrumentation.readdirCalls.push(String(args[0]));
			return [...result].sort();
		}
		return result;
	}) as typeof actual.readdirSync;
	return { ...actual, readdirSync, default: { ...actual, readdirSync } };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

function makeOld(target: string, cutoff: number): void {
	const old = new Date(cutoff - 10 * DAY_MS);
	fs.utimesSync(target, old, old);
}

/** Build a directory tree `depth` levels deep with `filesPerLevel` files per level, entirely older than cutoff. */
function buildOldTree(root: string, depth: number, filesPerLevel: number, cutoff: number): string {
	let current = root;
	for (let level = 0; level < depth; level++) {
		current = join(current, `level-${level}`);
		fs.mkdirSync(current, { recursive: true });
		for (let index = 0; index < filesPerLevel; index++) {
			const file = join(current, `file-${index}.txt`);
			fs.writeFileSync(file, "stale\n");
			makeOld(file, cutoff);
		}
	}
	for (let level = 0, dir = root; level < depth; level++) {
		dir = join(dir, `level-${level}`);
		makeOld(dir, cutoff);
	}
	makeOld(root, cutoff);
	return current;
}

function countingScan(root: string, cutoff: number): { result: boolean; readdirCalls: string[] } {
	scanInstrumentation.readdirCalls.length = 0;
	scanInstrumentation.active = true;
	try {
		return { result: hasEntryNewerThan(root, cutoff), readdirCalls: [...scanInstrumentation.readdirCalls] };
	} finally {
		scanInstrumentation.active = false;
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("hasEntryNewerThan short-circuit scan", () => {
	test("stops at the first fresh entry instead of walking the whole subtree", () => {
		const cutoff = Date.now() - 2 * DAY_MS;
		const root = fs.mkdtempSync(join(tmpdir(), "atomic-nested-scan-"));
		roots.push(root);
		buildOldTree(root, 6, 8, cutoff);
		// Sorts before "level-0", so the order-normalized scan sees it first.
		fs.writeFileSync(join(root, "aa-fresh.txt"), "fresh\n");
		makeOld(root, cutoff);

		const scan = countingScan(root, cutoff);

		assert.equal(scan.result, true);
		assert.deepEqual(scan.readdirCalls, [root], "scan must stop at the fresh top-level entry");
	});

	test("returns false for a tree entirely older than cutoff", () => {
		const cutoff = Date.now() - 2 * DAY_MS;
		const root = fs.mkdtempSync(join(tmpdir(), "atomic-nested-scan-"));
		roots.push(root);
		buildOldTree(root, 4, 3, cutoff);

		assert.equal(hasEntryNewerThan(root, cutoff), false);
	});

	test("finds a fresh file buried at the bottom of an otherwise old tree", () => {
		const cutoff = Date.now() - 2 * DAY_MS;
		const root = fs.mkdtempSync(join(tmpdir(), "atomic-nested-scan-"));
		roots.push(root);
		const deepest = buildOldTree(root, 4, 3, cutoff);
		fs.writeFileSync(join(deepest, "zz-fresh.txt"), "fresh\n");

		assert.equal(hasEntryNewerThan(root, cutoff), true);
	});
});
