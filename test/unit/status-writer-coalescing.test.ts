import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeRun, makeStage } from "./overlay-graph-helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		mkdir: async () => undefined,
		writeFile: async () => undefined,
		rename: async () => undefined,
	};
});

test("throttles 5ms-spaced status updates independently of disk latency (#5234)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live" });
	const reads = vi.spyOn(store, "inspectionSnapshot");
	const writer = createStatusWriter(store, {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask",
		statusFile: true,
		statusFilePath: "status.json",
	});
	try {
		await vi.runAllTimersAsync();
		await writer.flush();
		reads.mockClear();
		for (let step = 0; step < 60; step++) {
			store.recordRunSummary!("live", `step-${step}`, step);
			await vi.advanceTimersByTimeAsync(5);
		}
		assert.equal(reads.mock.calls.length, 1, "300ms of updates produces one scheduled status read");
		const flushing = writer.flush();
		await vi.runAllTimersAsync();
		await flushing;
		assert.equal(reads.mock.calls.length, 2, "flush reads the final pending update once");
	} finally {
		writer.unsubscribe();
		await vi.runAllTimersAsync();
		reads.mockRestore();
		vi.useRealTimers();
	}
});
