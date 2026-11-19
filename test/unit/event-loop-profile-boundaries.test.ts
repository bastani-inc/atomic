import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { EventLoopRecord } from "../../packages/coding-agent/src/core/event-loop-monitor.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	readTextSync,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/event-loop-profile-boundaries.ts");
const ROTATION_PRELOAD = join(ROOT, "test/fixtures/event-loop-profile-rotation-preload.cjs");
/** Load a real monitor, run both stalls, then allow its summaries to flush. */
const PROFILE_BOUNDARY_CHILD_TIMEOUT_MS = 20_000;
const BLOCK_THRESHOLD_MS = 200;
const RUNTIMES = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
];

function runChild(runtime: (typeof RUNTIMES)[number], mode: string): EventLoopRecord[] {
	const root = makeTempDirectory("event-loop-phase-boundary-");
	const log = join(root, "blocks.jsonl");
	try {
		const command = [
			...runtime.command(),
			...(mode === "rotation" ? ["--require", ROTATION_PRELOAD] : []),
			FIXTURE,
			mode,
		];
		const result = spawnSyncCollect(command, {
			cwd: ROOT,
			timeout: PROFILE_BOUNDARY_CHILD_TIMEOUT_MS,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
				ATOMIC_EVENT_LOOP_BLOCK_MS: String(mode === "rotation" ? 2_000 : BLOCK_THRESHOLD_MS),
				ATOMIC_EVENT_LOOP_BLOCK_STACKS: undefined,
				ATOMIC_EVENT_LOOP_BLOCK_LOG: log,
			},
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		return readTextSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as EventLoopRecord);
	} finally {
		removeTempDirectory(root);
	}
}

for (const runtime of RUNTIMES) {
	for (const mode of ["phase", "microtask", "microtask-shutdown", "coalesced"]) {
		const issue = mode === "microtask-shutdown" ? "#5638" : "#5544";
		test(`the profiler on ${runtime.name} preserves both stalls across a ${mode} boundary (${issue})`, () => {
			const records = runChild(runtime, mode);
			const naming = (name: string) =>
				records.filter(
					(record) =>
						record.type === "block" && record.hotFrames.some((entry) => entry.frame.startsWith(`${name} `)),
				);
			assert.equal(naming("holdStartupPhase").length, 1, JSON.stringify(records));
			assert.equal(naming("holdSessionPhase").length, 1, JSON.stringify(records));
			assert.notEqual(naming("holdStartupPhase")[0], naming("holdSessionPhase")[0]);
			const session = records.find((record) => record.type === "delay" && record.phase === "session");
			assert.ok(session?.type === "delay");
			assert.ok(
				session.maxMs >= BLOCK_THRESHOLD_MS,
				`the session summary must retain its stall: ${JSON.stringify(session)}`,
			);
		});
	}

	test(`the profiler on ${runtime.name} keeps a rotation's unobserved stall samples for the next heartbeat (#5544)`, () => {
		const records = runChild(runtime, "rotation");
		assert.ok(
			records.some(
				(record) =>
					record.type === "block" && record.hotFrames.some((entry) => entry.frame.startsWith("holdSessionPhase ")),
			),
			JSON.stringify(records),
		);
	});

	test(`the profiler on ${runtime.name} keeps different render definitions in the same file distinct (#5544)`, () => {
		const records = runChild(runtime, "names");
		const block = records.find((record) => record.type === "block");
		assert.ok(block?.type === "block");
		const renders = block.hotFrames.filter((entry) => entry.frame.startsWith("render "));
		assert.equal(renders.length, 2, JSON.stringify(block));
		assert.notEqual(renders[0]?.frame, renders[1]?.frame);
		assert.ok(renders.every((entry) => entry.count > 1));
		assert.ok(renders.reduce((sum, entry) => sum + entry.count, 0) <= block.samples);
	});
}
