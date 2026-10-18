import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { type EngineHeapInputs, engineHeapRuntimeArgs } from "../src/modes/interactive-engine/engine-heap.js";

const GIB = 1024 * 1024 * 1024;

const largeMachine: EngineHeapInputs = {
	runsOnNode: true,
	totalMemoryBytes: 64 * GIB,
	currentHeapLimitBytes: 4 * GIB,
	nodeOptions: undefined,
	execArgv: [],
	configuredHeapMb: undefined,
};

describe("interactive engine heap sizing", () => {
	it("gives the engine half of system memory when that exceeds the default limit", () => {
		assert.deepEqual(engineHeapRuntimeArgs(largeMachine), ["--max-old-space-size=32768"]);
	});

	it("keeps the default limit when half of system memory would not raise it", () => {
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, totalMemoryBytes: 8 * GIB }), []);
	});

	it("passes no V8 flags when the engine does not run on Node", () => {
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, runsOnNode: false }), []);
	});

	it("leaves an explicit NODE_OPTIONS heap size to the inherited environment", () => {
		for (const nodeOptions of ["--max-old-space-size=6144", "--trace-warnings --max_old_space_size=6144"]) {
			assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, nodeOptions }), []);
		}
	});

	it("forwards a heap size given on the host's own command line", () => {
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, execArgv: ["--max-old-space-size=12000"] }), [
			"--max-old-space-size=12000",
		]);
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, execArgv: ["--max-old-space-size", "12000"] }), [
			"--max-old-space-size",
			"12000",
		]);
	});

	it("uses ATOMIC_ENGINE_HEAP_MB as the size, or 0 to turn automatic sizing off", () => {
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, configuredHeapMb: "16384" }), [
			"--max-old-space-size=16384",
		]);
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, configuredHeapMb: "0" }), []);
	});

	it("ignores an invalid ATOMIC_ENGINE_HEAP_MB and sizes automatically", () => {
		for (const configuredHeapMb of ["lots", "-1", "1.5"]) {
			assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, configuredHeapMb }), ["--max-old-space-size=32768"]);
		}
	});
});
