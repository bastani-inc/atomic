import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";
import { type EngineHeapInputs, engineHeapRuntimeArgs } from "../src/modes/interactive-engine/engine-heap.js";

const GIB = 1024 * 1024 * 1024;
/** A Node process that prints its heap limit and exits; generous for a loaded machine. */
const HEAP_LIMIT_PROCESS_TIMEOUT_MS = 20_000;

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
		for (const nodeOptions of [
			'"--max-old-space-size=2048"',
			'--trace-warnings "--max-old-space-size=2048" "--title=a \\"b\\""',
		]) {
			assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, nodeOptions }), []);
		}
	});

	it("sizes the engine when NODE_OPTIONS names a heap size that Node does not apply", () => {
		for (const nodeOptions of [
			// Only a space separates options: a tab is part of the title.
			"--title=a\t--max-old-space-size=2048",
			// Node reads NODE_OPTIONS no further than a word that is neither an option nor an option's value.
			"--trace-warnings word --max-old-space-size=2048",
			'--title "a --max-old-space-size=2048"',
		]) {
			assert.deepEqual(
				engineHeapRuntimeArgs({ ...largeMachine, nodeOptions }),
				["--max-old-space-size=32768"],
				nodeOptions,
			);
		}
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

	it("gives the engine a heap percentage or total heap size from the host's command line", () => {
		for (const [execArgv, expected] of [
			[["--max-old-space-size-percentage=25"], ["--max-old-space-size-percentage=25"]],
			[
				["--max_old_space_size_percentage", "25"],
				["--max_old_space_size_percentage", "25"],
			],
			[["--max-heap-size=3000"], ["--max-heap-size=3000"]],
			[["--max_heap_size=3000"], ["--max_heap_size=3000"]],
			// V8 reads its own options with one dash too.
			[["-max-heap-size=3000"], ["-max-heap-size=3000"]],
			[["-max_old_space_size=3000"], ["-max_old_space_size=3000"]],
			[["--max-heap-size=1000", "-max_heap_size=3000"], ["-max_heap_size=3000"]],
		] as const) {
			assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, execArgv }), expected, execArgv.join(" "));
		}
	});

	it("gives the engine the host's last flag for each heap option, which together size the heap", () => {
		assert.deepEqual(
			engineHeapRuntimeArgs({
				...largeMachine,
				execArgv: [
					"--max-old-space-size=1000",
					"--max-heap-size=3000",
					"--trace-warnings",
					"--max-old-space-size=2000",
					"--max-old-space-size-percentage=10",
				],
			}),
			["--max-heap-size=3000", "--max-old-space-size=2000", "--max-old-space-size-percentage=10"],
		);
	});

	it("sizes the engine when the host's command line names a heap option Node does not read as one", () => {
		for (const execArgv of [["--title=--max-heap-size=3000"]]) {
			assert.deepEqual(
				engineHeapRuntimeArgs({ ...largeMachine, execArgv }),
				["--max-old-space-size=32768"],
				execArgv.join(" "),
			);
		}
	});

	it("leaves a heap percentage or total heap size in NODE_OPTIONS to the inherited environment", () => {
		for (const nodeOptions of [
			"--max-old-space-size-percentage=25",
			"--max_old_space_size_percentage 25",
			"--max-heap-size=3000",
		]) {
			assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, nodeOptions }), [], nodeOptions);
		}
	});

	it("gives the engine the host's young generation size along with the size it would get anyway", () => {
		const execArgv = ["--max-semi-space-size=64"];
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, execArgv }), [
			"--max-semi-space-size=64",
			"--max-old-space-size=32768",
		]);
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, execArgv, configuredHeapMb: "0" }), [
			"--max-semi-space-size=64",
		]);
		assert.deepEqual(engineHeapRuntimeArgs({ ...largeMachine, execArgv, nodeOptions: "--max-old-space-size=6144" }), [
			"--max-semi-space-size=64",
		]);
		assert.deepEqual(
			engineHeapRuntimeArgs({ ...largeMachine, execArgv: [...execArgv, "--max-old-space-size=12000"] }),
			["--max-semi-space-size=64", "--max-old-space-size=12000"],
		);
	});

	it("sizes the engine's heap as Node sized the host's when the host was given a heap size", () => {
		const heapLimit = (flags: readonly string[], nodeOptions: string): number => {
			const result = spawnSync(
				process.execPath,
				[...flags, "-e", 'process.stdout.write(String(require("node:v8").getHeapStatistics().heap_size_limit))'],
				{
					encoding: "utf8",
					env: { ...process.env, NODE_OPTIONS: nodeOptions },
					timeout: HEAP_LIMIT_PROCESS_TIMEOUT_MS,
				},
			);
			assert.equal(result.status, 0, result.stderr);
			return Number(result.stdout);
		};
		const cases: [readonly string[], string][] = [
			[["--max-heap-size=320"], ""],
			[["-max_heap_size=320"], ""],
			[["--max-old-space-size=192", "--max-heap-size=320"], ""],
			[["--max-old-space-size=192", "--max-semi-space-size=4"], ""],
		];
		// Early Node 22 releases have no percentage, and a host on one of them cannot be started with it.
		if (process.allowedNodeEnvironmentFlags.has("--max-old-space-size-percentage")) {
			cases.push(
				[["--max-old-space-size-percentage=1"], ""],
				[["--max-old-space-size=192"], "--max-old-space-size-percentage=1"],
			);
		}
		for (const [hostFlags, nodeOptions] of cases) {
			const engineFlags = engineHeapRuntimeArgs({ ...largeMachine, execArgv: hostFlags, nodeOptions });
			assert.equal(heapLimit(engineFlags, nodeOptions), heapLimit(hostFlags, nodeOptions), hostFlags.join(" "));
		}
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
