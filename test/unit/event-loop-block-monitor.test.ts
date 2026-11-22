import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	eventLoopBlockLogPath,
	eventLoopBlockThresholdMs,
	hotFrames,
} from "../../packages/coding-agent/src/core/event-loop-monitor.js";
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

const THRESHOLD_MS = 200;
const LONG_BLOCK_MS = 1_000;
const SHORT_BLOCK_MS = 20;
/**
 * The long block of the tests that tell it apart from the session phase's own delays. On a loaded machine the scheduler
 * alone kept the event loop from turning for up to 1.2 s in that phase, so this block is well past that.
 */
const PHASED_LONG_BLOCK_MS = 3_000;
/**
 * Phase attribution distinguishes the injected long block from the session phase's own delays, a loaded machine's
 * scheduler included, not idle scheduler lag from the reporting threshold. The midpoint leaves equal headroom around
 * the two (#5520).
 */
const SESSION_PHASE_MAX_MS = (PHASED_LONG_BLOCK_MS + SHORT_BLOCK_MS) / 2;
const SETTLE_MS = 500;
/** Structural: each child compiles the monitor and the fixture, through jiti on Node; a loaded runner took over 20 s. */
const CHILD_TIMEOUT_MS = 60_000;
/** The budget of a test that starts one child. */
const CHILD_TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 10_000;

const RUNTIMES = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
] as const;

interface ChildReport {
	readonly started: boolean;
	readonly created: readonly string[];
	/** The longest the fixture's event loop went without a turn around its brief block, by the fixture's own timer. */
	readonly briefBlockGapMs: number;
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
	longBlockMs = LONG_BLOCK_MS,
): { report: ChildReport | undefined; stderr: string } {
	const [executable, ...preload] = runtime.command();
	const result = spawnSyncCollect(
		[executable, ...preload, FIXTURE, String(longBlockMs), String(SHORT_BLOCK_MS), String(SETTLE_MS), mode],
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
		test(
			"records a long block once, with a stack through the function that held the loop, and not a brief one",
			() => {
				const log = join(temp, "blocks.jsonl");
				const { report, stderr } = runChild(
					runtime,
					{ ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS), ATOMIC_EVENT_LOOP_BLOCK_LOG: log },
					"blocks",
					PHASED_LONG_BLOCK_MS,
				);
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
				assert.ok(
					long[0]?.hotFrames?.some((entry) => entry.frame.startsWith("holdTheEventLoopForLong ")),
					`the hot frames do not name the function: ${JSON.stringify(long[0]?.hotFrames)}`,
				);
				// A loaded machine's scheduler can hold the loop past the threshold while the brief block runs, and then the
				// monitor rightly records that block: the brief block is never recorded when the loop turned in time.
				if ((report?.briefBlockGapMs ?? Number.POSITIVE_INFINITY) < THRESHOLD_MS)
					assert.deepEqual(blocksNaming(records, "holdTheEventLoopBriefly"), []);

				const delays = records.filter((record) => record.type === "delay");
				assert.deepEqual(
					delays.map((record) => record.phase),
					["startup", "session", "shutdown"],
				);
				const [startup, session] = delays;
				assert.ok((startup?.maxMs ?? 0) >= PHASED_LONG_BLOCK_MS * 0.9, `startup max ${startup?.maxMs} ms`);
				assert.ok((session?.ticks ?? 0) > 0);
				assert.ok((session?.maxMs ?? Infinity) < SESSION_PHASE_MAX_MS, `session max ${session?.maxMs} ms`);
				assert.doesNotMatch(stderr, /debugger/i);
			},
			CHILD_TEST_TIMEOUT_MS,
		);

		test(
			"counts a block in the phase it ran in when the phase ends in the same task (#5520)",
			() => {
				const log = join(temp, "blocks.jsonl");
				const { report } = runChild(
					runtime,
					{ ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS), ATOMIC_EVENT_LOOP_BLOCK_LOG: log },
					"phase-inside-block",
					PHASED_LONG_BLOCK_MS,
				);
				assert.equal(report?.started, true);
				const records = readLog(log);
				const [startup, session] = records.filter((record) => record.type === "delay");
				assert.equal(startup?.phase, "startup");
				assert.equal(session?.phase, "session");
				const [long] = blocksNaming(records, "holdTheEventLoopForLong");
				assert.ok(long, `no record of the long block:\n${JSON.stringify(records, null, 1)}`);
				const blockEnd = Date.parse(long.at) + (long.durationMs ?? 0);
				assert.ok(
					blockEnd <= Date.parse(session.at) + 1,
					`the long block ends ${blockEnd - Date.parse(session.at)} ms into the session`,
				);
				assert.ok((startup.maxMs ?? 0) >= PHASED_LONG_BLOCK_MS * 0.9, `startup max ${startup.maxMs} ms`);
				assert.ok((session.maxMs ?? Infinity) < SESSION_PHASE_MAX_MS, `session max ${session.maxMs} ms`);
			},
			CHILD_TEST_TIMEOUT_MS,
		);

		test(
			"writes to event-loop-blocks.jsonl in the agent directory when no log is named",
			() => {
				const { report } = runChild(runtime, { ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS) });
				assert.equal(report?.started, true);
				assert.equal(
					blocksNaming(readLog(join(temp, "agent/event-loop-blocks.jsonl")), "holdTheEventLoopForLong").length,
					1,
				);
			},
			CHILD_TEST_TIMEOUT_MS,
		);

		test(
			"counts the current block at exit without printing to the terminal (#5377)",
			() => {
				const log = join(temp, "blocks.jsonl");
				const { stderr } = runChild(
					runtime,
					{
						ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS),
						ATOMIC_EVENT_LOOP_BLOCK_LOG: log,
					},
					"exit-inside-block",
				);
				assert.equal(stderr, "");
				const records = readLog(log);
				const startup = records.find((record) => record.type === "delay" && record.phase === "startup");
				assert.ok((startup?.maxMs ?? 0) >= LONG_BLOCK_MS * 0.9, `startup max ${startup?.maxMs} ms`);
				assert.ok(
					records.some((record) => record.type === "block" && (record.durationMs ?? 0) >= LONG_BLOCK_MS * 0.9),
				);
			},
			CHILD_TEST_TIMEOUT_MS,
		);

		test(
			"starts nothing and writes nothing while the threshold is unset",
			() => {
				const log = join(temp, "blocks.jsonl");
				const { report } = runChild(runtime, { ATOMIC_EVENT_LOOP_BLOCK_LOG: log });
				assert.deepEqual({ started: report?.started, created: report?.created }, { started: false, created: [] });
				assert.equal(fileExistsSync(log), false);
				assert.equal(fileExistsSync(join(temp, "agent/event-loop-blocks.jsonl")), false);
			},
			CHILD_TEST_TIMEOUT_MS,
		);
	});
}

test(
	"on Node, an anonymous function's hot frame counts every sample, wherever in its body each landed (#5377)",
	() => {
		const log = join(temp, "blocks.jsonl");
		runChild(
			RUNTIMES[0],
			{ ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS), ATOMIC_EVENT_LOOP_BLOCK_LOG: log },
			"anonymous",
		);
		const fromFixture = (name: string) => (entry: { readonly frame: string }) =>
			entry.frame.startsWith(`${name} `) && entry.frame.includes("event-loop-block-monitor");
		const block = readLog(log).find(
			(record) => record.type === "block" && record.hotFrames?.some(fromFixture("(anonymous)")),
		);
		assert.ok(block, "the anonymous function's block was recorded");
		const frames = JSON.stringify(block.hotFrames);
		// A sample can land after the function returned and before the loop turns; only the function's own samples count.
		const anonymous = block.hotFrames?.filter(fromFixture("(anonymous)")) ?? [];
		const running = block.hotFrames?.find(fromFixture("runAnonymousBlock"));
		assert.equal(anonymous.length, 1, `one hot frame for the function wherever its samples landed: ${frames}`);
		assert.ok((running?.count ?? 0) > 1, `the function ran across several samples: ${frames}`);
		assert.ok((anonymous[0]?.count ?? 0) > 1, `the anonymous function has several samples: ${frames}`);
		assert.ok(
			(anonymous[0]?.count ?? Infinity) <= (running?.count ?? 0),
			`anonymous samples are contained in the caller's samples: ${frames}`,
		);
		// CPU profiles can also sample the caller itself, without a callee frame.
		assert.ok(typeof block.stacks === "object");
		for (const stack of block.stacks) {
			if (stack.frames.some((frame) => fromFixture("(anonymous)")({ frame }))) {
				assert.ok(
					stack.frames.some((frame) => fromFixture("runAnonymousBlock")({ frame })),
					frames,
				);
			}
		}
	},
	CHILD_TEST_TIMEOUT_MS,
);

test("hot frames count a function once per sample across sampled line and column changes (#5377)", () => {
	assert.deepEqual(
		hotFrames([
			["spin (file:///worker.ts:10:2)", "spin (file:///worker.ts:20:3)", "caller (file:///main.ts:1:1)"],
			["spin (file:///worker.ts:11:8)", "caller (file:///main.ts:1:1)"],
		]),
		[
			{ count: 2, frame: "spin (file:///worker.ts:10:2)" },
			{ count: 2, frame: "caller (file:///main.ts:1:1)" },
		],
	);
});

test("only a positive whole number of milliseconds turns the diagnostic on", () => {
	const threshold = (value: string | undefined) => eventLoopBlockThresholdMs({ ATOMIC_EVENT_LOOP_BLOCK_MS: value });
	assert.equal(threshold("250"), 250);
	assert.equal(threshold(" 250 "), 250);
	for (const off of [undefined, "", "0", "-5", "1.5", "1e3", "on", "99999999999999999999"]) {
		assert.equal(threshold(off), undefined, `${off} turned it on`);
	}
});

test("a relative log path resolves against the directory Atomic starts in", () => {
	const base = resolve(temp, "start");
	assert.equal(
		eventLoopBlockLogPath({ ATOMIC_EVENT_LOOP_BLOCK_LOG: join("logs", "blocks.jsonl") }, base),
		join(base, "logs", "blocks.jsonl"),
	);
});
