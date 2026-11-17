import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	bunExecutable,
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readTextSync,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/event-loop-block-monitor.ts");

/**
 * The block threshold the children run with. Far above the few milliseconds an idle loop is late, and high enough
 * that a scheduler stall on a loaded runner would have to last most of it, and land on the brief block, to carry that
 * block over it.
 */
const THRESHOLD_MS = 200;
/**
 * The block the log must name. On Node the watchdog attaches the debugger only once a block crosses the threshold,
 * and attaching took the main thread 30–140 ms (measured with the coding-agent module graph loaded), so the first
 * stack arrives a little after `THRESHOLD_MS` plus that. A second of block leaves room for several samples under load.
 */
const LONG_BLOCK_MS = 1_000;
/** The block the log must not record: a tenth of the threshold. */
const SHORT_BLOCK_MS = 20;
/**
 * Idle time around each block. The Node watchdog worker must be running before the long block starts (it booted in
 * about 50 ms idle), and the delay records need ticks on either side of the phase boundary.
 */
const SETTLE_MS = 500;
/**
 * One child: loading the module through jiti (about 1 s on Node idle), four settles and the blocks, 3.3 s in all
 * idle. The budget leaves a loaded runner six times that and still ends the child before the test's own timeout.
 */
const CHILD_TIMEOUT_MS = 20_000;

const RUNTIMES = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
] as const;

interface ChildReport {
	readonly started: boolean;
	/** On Node, the async resources that starting the monitor created; Bun does not report them. */
	readonly created: readonly string[];
}

interface LogRecord {
	readonly type: string;
	readonly role: string;
	readonly pid: number;
	readonly at: string;
	readonly durationMs?: number;
	readonly samples?: number;
	readonly hotFrames?: readonly { readonly count: number; readonly frame: string }[];
	readonly stacks?: string | readonly { readonly count: number; readonly frames: readonly string[] }[];
	readonly phase?: string;
	readonly ticks?: number;
	readonly maxMs?: number;
}

let temp: string;
beforeEach(() => {
	temp = makeTempDirectory("atomic-event-loop-block-");
});
afterEach(() => removeTempDirectory(temp));

function runChild(
	runtime: (typeof RUNTIMES)[number],
	env: Record<string, string | undefined>,
	mode = "blocks",
): { report: ChildReport | undefined; stderr: string } {
	const [executable, ...preload] = runtime.command();
	const result = spawnSyncCollect(
		[executable, ...preload, FIXTURE, String(LONG_BLOCK_MS), String(SHORT_BLOCK_MS), String(SETTLE_MS), mode],
		{
			cwd: ROOT,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: join(temp, "agent"),
				ATOMIC_EVENT_LOOP_BLOCK_MS: undefined,
				ATOMIC_EVENT_LOOP_BLOCK_LOG: undefined,
				...env,
			},
			timeout: CHILD_TIMEOUT_MS,
		},
	);
	const stderr = result.stderr.toString();
	assert.equal(result.exitCode, 0, `the child failed:\n${stderr}`);
	const line = result.stdout.toString().trim().split("\n").at(-1);
	return { report: line ? (JSON.parse(line) as ChildReport) : undefined, stderr };
}

function readLog(path: string): LogRecord[] {
	return readTextSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as LogRecord);
}

/** The block records with a stack that passes through `functionName`. */
function blocksNaming(records: readonly LogRecord[], functionName: string): LogRecord[] {
	return records.filter(
		(record) =>
			record.type === "block" &&
			typeof record.stacks === "object" &&
			record.stacks.some((stack) => stack.frames.some((frame) => frame.startsWith(`${functionName} `))),
	);
}

for (const runtime of RUNTIMES) {
	describe(`the event-loop block diagnostic on ${runtime.name}`, () => {
		test("records a long block once, with a stack through the function that held the loop, and not a brief one", () => {
			const log = join(temp, "blocks.jsonl");
			const { report, stderr } = runChild(runtime, {
				ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS),
				ATOMIC_EVENT_LOOP_BLOCK_LOG: log,
			});
			assert.equal(report?.started, true);
			const records = readLog(log);
			const [start] = records;
			assert.equal(start?.type, "start");
			assert.equal(start?.role, "host");

			const long = blocksNaming(records, "holdTheEventLoopForLong");
			assert.equal(long.length, 1, `expected one record of the long block:\n${JSON.stringify(records, null, 1)}`);
			assert.ok(
				(long[0]?.durationMs ?? 0) >= THRESHOLD_MS,
				`the long block's record is under the threshold: ${long[0]?.durationMs} ms`,
			);
			assert.equal(long[0]?.pid, start?.pid);
			// Every sample of the block passed through the function, and the hot frames say so.
			const hot = long[0]?.hotFrames?.find((entry) => entry.frame.startsWith("holdTheEventLoopForLong "));
			assert.equal(hot?.count, long[0]?.samples);
			assert.deepEqual(blocksNaming(records, "holdTheEventLoopBriefly"), []);

			const delays = records.filter((record) => record.type === "delay");
			assert.deepEqual(
				delays.map((record) => record.phase),
				["startup", "session"],
			);
			const [startup, session] = delays;
			assert.ok((startup?.maxMs ?? 0) >= LONG_BLOCK_MS * 0.9, `startup max ${startup?.maxMs} ms`);
			assert.ok((session?.ticks ?? 0) > 0);
			assert.ok((session?.maxMs ?? Infinity) < THRESHOLD_MS, `session max ${session?.maxMs} ms`);
			// An inspector session still attached at exit makes Node print this to the terminal.
			assert.doesNotMatch(stderr, /debugger/i);
		});

		test("writes to event-loop-blocks.jsonl in the agent directory when no log is named", () => {
			const { report } = runChild(runtime, { ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS) });
			assert.equal(report?.started, true);
			assert.equal(
				blocksNaming(readLog(join(temp, "agent/event-loop-blocks.jsonl")), "holdTheEventLoopForLong").length,
				1,
			);
		});

		test("prints nothing to the terminal when the process exits inside a block it is sampling", () => {
			const { stderr } = runChild(
				runtime,
				{
					ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS),
					ATOMIC_EVENT_LOOP_BLOCK_LOG: join(temp, "blocks.jsonl"),
				},
				"exit-inside-block",
			);
			assert.equal(stderr, "");
		});

		test("starts nothing and writes nothing while the threshold is unset", () => {
			const log = join(temp, "blocks.jsonl");
			const { report } = runChild(runtime, { ATOMIC_EVENT_LOOP_BLOCK_LOG: log });
			assert.deepEqual(report, { started: false, created: [] });
			assert.equal(fileExistsSync(log), false);
			assert.equal(fileExistsSync(join(temp, "agent/event-loop-blocks.jsonl")), false);
		});
	});
}
