import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { topLevelExpandedSnapshots } from "../../packages/workflows/src/extension/workflow-targets.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/run-inspect.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";
import { makeRun, makeStage } from "./overlay-graph-helpers.js";

function fixture() {
	const store = createStore();
	const work = { payloadReads: 0 };
	store.recordRunStart({
		...makeRun(
			Array.from({ length: 40 }, (_, index) => ({
				...makeStage(`stage-${index}`),
				status: "running" as const,
				result: `result-${index}`.repeat(1_000),
				structured: {
					nested: {
						get answer() {
							work.payloadReads++;
							return index;
						},
					},
				},
				toolEvents: [
					{
						name: "bash",
						input: { command: "work", bytes: Buffer.from([1, 2, 3]), date: new Date("2026-01-01T00:00:00.000Z") },
						output: "history".repeat(1_000),
						startedAt: 1,
					},
				],
			})),
		),
		id: "run-1",
		inputs: { prompt: "keep inputs", config: { value: 7 } },
		result: { custom: "keep outputs" },
	});
	return { store, work };
}

function views(store: ReturnType<typeof createStore>) {
	return { listing: topLevelExpandedSnapshots(store), detail: inspectRun("run-1", { store, now: 2 }) };
}

test.each(["list", "single"])(
	"clearing a store releases full payloads retained by %s status expansion (#5234)",
	(mode) => {
		const storePath = fileURLToPath(new URL("../../packages/workflows/src/shared/store.ts", import.meta.url));
		const targetsPath = fileURLToPath(
			new URL("../../packages/workflows/src/extension/workflow-targets.ts", import.meta.url),
		);
		const inspectPath = fileURLToPath(
			new URL("../../packages/workflows/src/runs/background/run-inspect.ts", import.meta.url),
		);
		const MEMORY_RELEASE_CHILD_TIMEOUT_MS = 20_000;
		const child = spawnSyncCollect(
			[
				bunExecutable(),
				"-e",
				`
		import { createStore } from ${JSON.stringify(storePath)};
		import { topLevelExpandedSnapshots } from ${JSON.stringify(targetsPath)};
		import { inspectRun } from ${JSON.stringify(inspectPath)};
		const store = createStore();
		store.recordRunStart({ id: "run", name: "cost", inputs: {}, status: "running", startedAt: 1, toolNodes: [], stages: [{ id: "stage", name: "stage", status: "running", parentIds: [], toolEvents: [], structured: { payload: "x".repeat(1_000_000) } }] });
		const ref = (() => new WeakRef(${mode === "list" ? "topLevelExpandedSnapshots(store)[0].stages[0].structured" : 'inspectRun("run", { store }).detail.stages[0].structured'}))();
		store.clear();
		if (topLevelExpandedSnapshots(store).length !== 0) throw new Error("Store did not clear");
		for (let cycle = 0; cycle < 5; cycle++) { await Bun.sleep(0); Bun.gc(true); }
		if (ref.deref() !== undefined) throw new Error("Cleared status payload is still retained");
	`,
			],
			{ timeout: MEMORY_RELEASE_CHILD_TIMEOUT_MS },
		);
		assert.equal(child.exitCode, 0, child.stderr.toString());
	},
);

test("status refresh reuses full raw views without whole-store snapshots or repeated deep clones (#5234)", () => {
	const { store, work } = fixture();
	const expected = JSON.stringify(views({ ...store, inspectionSnapshot: undefined }));
	assert.equal(
		JSON.stringify(views(store)),
		expected,
		"the cached view matches the legacy full-snapshot view byte for byte",
	);
	work.payloadReads = 0;
	const snapshots = vi.spyOn(store, "snapshot");
	const clones = vi.spyOn(globalThis, "structuredClone");
	try {
		assert.equal(JSON.stringify(views(store)), expected, "public output remains byte-identical");
		assert.equal(snapshots.mock.calls.length, 0);
		assert.equal(clones.mock.calls.length, 0);
		assert.equal(work.payloadReads, 0);
	} finally {
		snapshots.mockRestore();
		clones.mockRestore();
	}
});

test("a cold single-run inspection never materializes unrelated run payloads (#5234)", () => {
	const { store } = fixture();
	let unrelatedReads = 0;
	store.recordRunStart({
		...makeRun([
			{
				...makeStage("unrelated-stage"),
				structured: {
					get payload() {
						unrelatedReads++;
						return "unrelated";
					},
				},
			},
		]),
		id: "unrelated",
	});
	const detail = inspectRun("run-1", { store, now: 2 });
	assert.equal(detail.ok, true);
	assert.equal(unrelatedReads, 0);
	if (detail.ok) assert.equal(detail.detail.stages[0]!.result, "result-0".repeat(1_000));
});

test("a status refresh clones only the changed stage and preserves every raw stage field (#5234)", () => {
	const { store, work } = fixture();
	const before = views(store);
	work.payloadReads = 0;
	const clones = vi.spyOn(globalThis, "structuredClone");
	const snapshots = vi.spyOn(store, "snapshot");
	try {
		store.recordToolStart("run-1", "stage-0", { name: "read", input: { path: "changed.ts" }, startedAt: 2 });
		const after = views(store);
		assert.equal(snapshots.mock.calls.length, 0);
		assert.ok(clones.mock.calls.length <= 3, `cloned ${clones.mock.calls.length} objects for one changed stage`);
		assert.equal(work.payloadReads, 1, "only the changed stage materializes raw payloads");
		assert.equal(after.listing[0]!.stages[0]!.toolEvents.length, 2);
		assert.equal(before.listing[0]!.stages[0]!.toolEvents.length, 1);
		assert.deepEqual(after.listing[0]!.stages[1]!.structured, { nested: { answer: 1 } });
		assert.equal(after.listing[0]!.stages[1]!.result, "result-1".repeat(1_000));
		assert.equal(after.listing[0]!.stages[1]!.toolEvents[0]!.output, "history".repeat(1_000));
		assert.deepEqual(after.listing[0]!.inputs, { prompt: "keep inputs", config: { value: 7 } });
		assert.deepEqual(after.listing[0]!.result, { custom: "keep outputs" });
	} finally {
		clones.mockRestore();
		snapshots.mockRestore();
	}
});
