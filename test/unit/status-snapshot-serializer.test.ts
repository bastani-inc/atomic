import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { StatusSnapshotSerializer } from "../../packages/workflows/src/extension/status-snapshot-serializer.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeRun, makeStage } from "./overlay-graph-helpers.js";

test("status serialization retains per-run chunks instead of assembling the whole file (#5234)", async () => {
	const store = createStore();
	for (let index = 0; index < 40; index++) {
		store.recordRunStart({
			...makeRun([{ ...makeStage("stage"), result: "payload".repeat(10_000) }]),
			id: `run-${index}`,
		});
	}
	const snapshot = store.inspectionSnapshot!();
	const serializer = new StatusSnapshotSerializer();
	try {
		const chunks = await serializer.serialize(snapshot);
		assert.ok(Array.isArray(chunks), "the writer receives independently writable chunks");
		assert.ok(
			chunks.every((chunk) => chunk.length < 100_000),
			"no chunk combines multiple runs' payloads",
		);
		assert.equal(chunks.join(""), JSON.stringify(snapshot, null, 2));
	} finally {
		serializer.close();
	}
});

test("cold status serialization yields after at most 25 uncached runs per macrotask (#5234)", async () => {
	const store = createStore();
	for (let index = 0; index < 100; index++) {
		store.recordRunStart({
			...makeRun([makeStage("stage")]),
			id: `run-${index}`,
		});
	}
	const snapshot = store.inspectionSnapshot!();
	const runs = new Set(snapshot.runs);
	const perMacrotask: number[] = [];
	let bucketOpen = false;
	const originalStringify = JSON.stringify;
	const stringify = vi.spyOn(JSON, "stringify").mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
		if (runs.has(args[0] as (typeof snapshot.runs)[number])) {
			if (!bucketOpen) {
				bucketOpen = true;
				perMacrotask.push(0);
				setTimeout(() => {
					bucketOpen = false;
				}, 0);
			}
			perMacrotask[perMacrotask.length - 1]!++;
		}
		return Reflect.apply(originalStringify, JSON, args);
	}) as typeof JSON.stringify);
	const serializer = new StatusSnapshotSerializer();
	try {
		const chunks = await serializer.serialize(snapshot);
		assert.equal(
			perMacrotask.reduce((sum, count) => sum + count, 0),
			100,
		);
		assert.ok(
			perMacrotask.every((count) => count <= 25),
			`expected at most 25 uncached runs per macrotask, got ${perMacrotask.join(", ")}`,
		);
		stringify.mockRestore();
		assert.equal(chunks.join(""), JSON.stringify(snapshot, null, 2));
	} finally {
		stringify.mockRestore();
		serializer.close();
	}
});
