import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	type EngineHeapInputs,
	engineHeapRuntimeArgs,
	splitNodeOptions,
} from "../src/modes/interactive-engine/engine-heap.js";

const GIB = 1024 * 1024 * 1024;

const largeMachine: EngineHeapInputs = {
	runsOnNode: true,
	totalMemoryBytes: 64 * GIB,
	constrainedMemoryBytes: undefined,
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

	it("sizes from a container memory limit smaller than physical RAM", () => {
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, constrainedMemoryBytes: 2 * GIB }), []);
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, constrainedMemoryBytes: 16 * GIB }), [
			"--max-old-space-size=8192",
		]);
	});

	it("ignores an absent or larger-than-RAM container limit", () => {
		for (const constrainedMemoryBytes of [0, 2 ** 63]) {
			assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, constrainedMemoryBytes }), [
				"--max-old-space-size=32768",
			]);
		}
	});

	it("passes no V8 flags when the engine does not run on Node", () => {
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, runsOnNode: false }), []);
	});

	it("leaves an explicit NODE_OPTIONS heap size to the inherited environment", () => {
		for (const nodeOptions of ["--max-old-space-size=6144", "--trace-warnings --max_old_space_size=6144"]) {
			assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, nodeOptions }), []);
		}
	});

	it("recognizes a quoted heap size in NODE_OPTIONS", () => {
		assert.deepEqual(splitNodeOptions('--trace-warnings "--max-old-space-size=2048" "--title=a \\"b\\""'), [
			"--trace-warnings",
			"--max-old-space-size=2048",
			'--title=a "b"',
		]);
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, nodeOptions: '"--max-old-space-size=2048"' }), []);
	});

	it("forwards the host's last command-line heap size, which Node applies over NODE_OPTIONS", () => {
		assert.deepEqual(
			engineHeapRuntimeArgs({
				...largeMachine,
				nodeOptions: "--max-old-space-size=2048",
				execArgv: ["--max-old-space-size=3000", "--max-old-space-size=9000"],
			}),
			["--max-old-space-size=9000"],
		);
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

	it("uses ATOMIC_HEAP_MB as the size, or 0 to turn automatic sizing off", () => {
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, configuredHeapMb: "16384" }), [
			"--max-old-space-size=16384",
		]);
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, configuredHeapMb: "0" }), []);
	});

	it("ignores an invalid ATOMIC_HEAP_MB and sizes automatically", () => {
		for (const configuredHeapMb of ["lots", "-1", "1.5"]) {
			assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, configuredHeapMb }), ["--max-old-space-size=32768"]);
		}
	});
});
