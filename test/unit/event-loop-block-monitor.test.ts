import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	eventLoopBlockLogPath,
	eventLoopBlockThresholdMs,
	hotFrames,
} from "../../packages/coding-agent/src/core/event-loop-monitor.js";
import {
	type ByteStream,
	bunExecutable,
	decodeStream,
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readTextSync,
	removeTempDirectory,
	spawnProcess,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/event-loop-block-monitor.ts");

const THRESHOLD_MS = 200;
const LONG_BLOCK_MS = 1_000;
const SHORT_BLOCK_MS = 20;
/**
 * How much longer than the fixture's own timer saw the session phase's longest delay its record may say it was: the
 * monitor's and the fixture's timers run in the same turns, milliseconds apart. A long block counted in the session
 * phase makes it a second longer (#5520). A loaded machine's scheduler can hold the event loop in that phase for longer
 * than the block, so the record is compared with what the fixture saw there rather than with a fixed bound.
 */
const SESSION_DELAY_SLACK_MS = 50;
const SETTLE_MS = 500;
/** Structural: loading the monitor and the fixture, through jiti on Node, slows with the machine; a loaded runner took 55 s. */
const CHILD_LOAD_TIMEOUT_MS = 180_000;
/** The fixture's own work once loaded: at most two long blocks and seven settling waits. */
const CHILD_WORK_MS = 2 * LONG_BLOCK_MS + 7 * SETTLE_MS;
/** Once loaded, the child's work and its exit, three times over for a loaded runner: past it, the child is stuck. */
const CHILD_RUN_TIMEOUT_MS = 3 * CHILD_WORK_MS;
/** The budget of a test that starts one child. */
const CHILD_TEST_TIMEOUT_MS = CHILD_LOAD_TIMEOUT_MS + CHILD_RUN_TIMEOUT_MS + 10_000;
/** The line the fixture prints once it has loaded. */
const LOADED = "event-loop-block-monitor fixture loaded";

const RUNTIMES = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
] as const;

interface ChildReport {
	readonly started: boolean;
	readonly created: readonly string[];
	/**
	 * The longest two gaps in a row between the fixture's event loop turns around its brief block, by its own timer: the
	 * longest any timer of the monitor's can have seen there.
	 */
	readonly briefBlockGapsMs: number;
	/**
	 * The longest two gaps in a row between the fixture's event loop turns in the session phase, by its own timer: the
	 * longest any timer of the monitor's can have seen there.
	 */
	readonly sessionGapsMs: number;
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

type PipeName = "stdout" | "stderr";

interface TwoPhaseChild {
	readonly stdout: ByteStream | null;
	readonly stderr: ByteStream | null;
	readonly exited: Promise<number>;
	kill(): void;
}

interface TwoPhaseChildOptions {
	readonly loadedMarker: string;
	readonly loadTimeoutMs: number;
	readonly runTimeoutMs: number;
}

interface PipeReader {
	readonly done: Promise<void>;
	cancel(): void;
}

interface PipeError {
	readonly pipe: PipeName;
	readonly error: unknown;
}

type WaitOutcome =
	| { readonly kind: "exited"; readonly exitCode: number }
	| { readonly kind: "spawn-error"; readonly error: unknown }
	| { readonly kind: "pipe-error"; readonly pipeError: PipeError }
	| { readonly kind: "timeout"; readonly phase: "loading" | "running" };

function readPipe(
	stream: ByteStream | null,
	onText: (text: string) => void,
	onError: (error: unknown) => void,
): PipeReader {
	if (!stream) return { done: Promise.resolve(), cancel: () => {} };
	const reader = decodeStream(stream).getReader();
	let cancelled = false;
	let finished = false;
	const done = (async () => {
		try {
			for (;;) {
				const { done: eof, value } = await reader.read();
				if (eof) break;
				if (!cancelled) onText(value);
			}
		} catch (error) {
			if (!cancelled) onError(error);
		} finally {
			finished = true;
			reader.releaseLock();
		}
	})();
	return {
		done,
		cancel: () => {
			cancelled = true;
			if (!finished) void reader.cancel().catch(() => {});
		},
	};
}

function pipeReadError(pipeError: PipeError, stderr: string): Error {
	const detail = pipeError.error instanceof Error ? pipeError.error.message : String(pipeError.error);
	return new Error(`the child's ${pipeError.pipe} pipe errored (${detail}):\n${stderr}`, {
		cause: pipeError.error,
	});
}

/**
 * Waits for `child` under two separate time budgets: `loadTimeoutMs` before `loadedMarker` appears on stdout, then
 * `runTimeoutMs` until exit. Pipe read errors settle deterministically without leaving unhandled rejections.
 */
async function collectTwoPhaseChild(
	child: TwoPhaseChild,
	options: TwoPhaseChildOptions,
): Promise<{ stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	let loaded = false;
	let exited = false;
	let settled = false;
	let firstPipeError: PipeError | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	let resolveWait!: (outcome: WaitOutcome) => void;
	const wait = new Promise<WaitOutcome>((resolve) => {
		resolveWait = resolve;
	});

	const settle = (outcome: WaitOutcome): void => {
		if (settled) return;
		settled = true;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		resolveWait(outcome);
	};

	const recordPipeError = (pipe: PipeName, error: unknown): void => {
		const pipeError: PipeError = { pipe, error };
		if (firstPipeError === undefined) firstPipeError = pipeError;
		settle({ kind: "pipe-error", pipeError: firstPipeError });
	};

	void child.exited.then(
		(exitCode) => {
			exited = true;
			settle({ kind: "exited", exitCode });
		},
		(error) => {
			exited = true;
			settle({ kind: "spawn-error", error });
		},
	);

	const stdoutReader = readPipe(
		child.stdout,
		(text) => {
			stdout += text;
			if (!loaded && stdout.includes(options.loadedMarker)) {
				loaded = true;
				if (!settled) {
					if (timer !== undefined) clearTimeout(timer);
					timer = setTimeout(() => settle({ kind: "timeout", phase: "running" }), options.runTimeoutMs);
				}
			}
		},
		(error) => recordPipeError("stdout", error),
	);

	const stderrReader = readPipe(
		child.stderr,
		(text) => {
			stderr += text;
		},
		(error) => recordPipeError("stderr", error),
	);

	if (!settled) {
		timer = setTimeout(() => settle({ kind: "timeout", phase: "loading" }), options.loadTimeoutMs);
	}

	const outcome = await wait;
	const stopReaders = async (): Promise<void> => {
		stdoutReader.cancel();
		stderrReader.cancel();
		await Promise.all([stdoutReader.done, stderrReader.done]);
	};

	if (outcome.kind === "timeout") {
		if (!exited) child.kill();
		await child.exited.catch(() => {});
		await stopReaders();
		assert.fail(
			outcome.phase === "loading"
				? `the child did not load within ${options.loadTimeoutMs} ms:\n${stderr}`
				: `the child loaded, then did not finish within ${options.runTimeoutMs} ms:\n${stderr}`,
		);
	}

	if (outcome.kind === "pipe-error") {
		if (!exited) child.kill();
		await child.exited.catch(() => {});
		await stopReaders();
		throw pipeReadError(outcome.pipeError, stderr);
	}

	if (outcome.kind === "spawn-error") {
		await stopReaders();
		throw outcome.error;
	}

	await Promise.all([stdoutReader.done, stderrReader.done]);
	if (firstPipeError !== undefined) throw pipeReadError(firstPipeError, stderr);
	assert.equal(outcome.exitCode, 0, `the child failed:\n${stderr}`);
	return { stdout, stderr };
}

/**
 * Runs the fixture in `runtime` and returns its report and what it wrote to stderr. Loading and running are bounded
 * apart: loading slows with the machine, while a child that loaded and then does not finish its work in time is stuck.
 */
async function runChild(
	runtime: (typeof RUNTIMES)[number],
	env: Record<string, string | undefined>,
	mode = "blocks",
): Promise<{ report: ChildReport | undefined; stderr: string }> {
	const [executable, ...preload] = runtime.command();
	const child = spawnProcess(
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
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const { stdout, stderr } = await collectTwoPhaseChild(child, {
		loadedMarker: LOADED,
		loadTimeoutMs: CHILD_LOAD_TIMEOUT_MS,
		runTimeoutMs: CHILD_RUN_TIMEOUT_MS,
	});
	const line = stdout
		.trim()
		.split("\n")
		.filter((output) => output !== LOADED)
		.at(-1);
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
			async () => {
				const log = join(temp, "blocks.jsonl");
				const { report, stderr } = await runChild(runtime, {
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
				assert.ok(
					long[0]?.hotFrames?.some((entry) => entry.frame.startsWith("holdTheEventLoopForLong ")),
					`the hot frames do not name the function: ${JSON.stringify(long[0]?.hotFrames)}`,
				);
				// A loaded machine's scheduler can hold the loop past the threshold while the brief block runs, and the monitor
				// then rightly records it: the brief block is never recorded when the loop turned in time.
				if ((report?.briefBlockGapsMs ?? Number.POSITIVE_INFINITY) < THRESHOLD_MS)
					assert.deepEqual(blocksNaming(records, "holdTheEventLoopBriefly"), []);

				const delays = records.filter((record) => record.type === "delay");
				assert.deepEqual(
					delays.map((record) => record.phase),
					["startup", "session", "shutdown"],
				);
				const [startup, session] = delays;
				assert.ok((startup?.maxMs ?? 0) >= LONG_BLOCK_MS * 0.9, `startup max ${startup?.maxMs} ms`);
				assert.ok((session?.ticks ?? 0) > 0);
				assert.ok(
					(session?.maxMs ?? Infinity) <= (report?.sessionGapsMs ?? 0) + SESSION_DELAY_SLACK_MS,
					`session max ${session?.maxMs} ms, the fixture's longest two gaps ${report?.sessionGapsMs} ms`,
				);
				assert.doesNotMatch(stderr, /debugger/i);
			},
			CHILD_TEST_TIMEOUT_MS,
		);

		test(
			"counts a block in the phase it ran in when the phase ends in the same task (#5520)",
			async () => {
				const log = join(temp, "blocks.jsonl");
				const { report } = await runChild(
					runtime,
					{ ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS), ATOMIC_EVENT_LOOP_BLOCK_LOG: log },
					"phase-inside-block",
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
				assert.ok((startup.maxMs ?? 0) >= LONG_BLOCK_MS * 0.9, `startup max ${startup.maxMs} ms`);
				assert.ok(
					(session.maxMs ?? Infinity) <= (report?.sessionGapsMs ?? 0) + SESSION_DELAY_SLACK_MS,
					`session max ${session.maxMs} ms, the fixture's longest two gaps ${report?.sessionGapsMs} ms`,
				);
			},
			CHILD_TEST_TIMEOUT_MS,
		);

		test(
			"writes to event-loop-blocks.jsonl in the agent directory when no log is named",
			async () => {
				const { report } = await runChild(runtime, { ATOMIC_EVENT_LOOP_BLOCK_MS: String(THRESHOLD_MS) });
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
			async () => {
				const log = join(temp, "blocks.jsonl");
				const { stderr } = await runChild(
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
			async () => {
				const log = join(temp, "blocks.jsonl");
				const { report } = await runChild(runtime, { ATOMIC_EVENT_LOOP_BLOCK_LOG: log });
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
	async () => {
		const log = join(temp, "blocks.jsonl");
		await runChild(
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

/** Node reports a rejection left unhandled once the turn that left it has run its microtasks. */
function flushUnhandledRejections(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function createFakePipe(): {
	stream: ByteStream;
	write: (text: string) => void;
	close: () => void;
	error: (err: Error) => void;
} {
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>;
	const stream: ByteStream = new ReadableStream({
		start(c) {
			controller = c;
		},
	});
	return {
		stream,
		write: (text) => controller.enqueue(encoder.encode(text)),
		close: () => controller.close(),
		error: (err) => controller.error(err),
	};
}

describe("two-phase child helper pipe error handling (#6423)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("surfaces a stdout pipe error while the child is running, kills it, and leaves no unhandled rejection (#6423)", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const stdout = createFakePipe();
			const stderr = createFakePipe();
			let resolveExit!: (code: number) => void;
			let killed = 0;
			const exited = new Promise<number>((resolve) => {
				resolveExit = resolve;
			});
			const injected = new Error("injected stdout EPIPE");
			const run = collectTwoPhaseChild(
				{
					stdout: stdout.stream,
					stderr: stderr.stream,
					exited,
					kill: () => {
						killed++;
						resolveExit(143);
					},
				},
				{ loadedMarker: LOADED, loadTimeoutMs: 60_000, runTimeoutMs: 60_000 },
			);
			const failure = assert.rejects(run, (error: Error) => {
				assert.match(error.message, /stdout pipe errored \(injected stdout EPIPE\)/);
				assert.match(error.message, /partial stderr/);
				assert.equal(error.cause, injected);
				return true;
			});
			await flushUnhandledRejections();
			stderr.write("partial stderr\n");
			stdout.error(injected);
			await failure;
			await flushUnhandledRejections();
			assert.deepEqual(unhandled, []);
			assert.equal(killed, 1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("surfaces a stdout pipe error during post-exit drain without killing or leaving an unhandled rejection (#6423)", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const stdout = createFakePipe();
			const stderr = createFakePipe();
			let resolveExit!: (code: number) => void;
			let killed = 0;
			const exited = new Promise<number>((resolve) => {
				resolveExit = resolve;
			});
			const injected = new Error("post-exit stdout EPIPE");
			const run = collectTwoPhaseChild(
				{
					stdout: stdout.stream,
					stderr: stderr.stream,
					exited,
					kill: () => {
						killed++;
					},
				},
				{ loadedMarker: LOADED, loadTimeoutMs: 60_000, runTimeoutMs: 60_000 },
			);
			const failure = assert.rejects(run, (error: Error) => {
				assert.match(error.message, /stdout pipe errored \(post-exit stdout EPIPE\)/);
				assert.equal(error.cause, injected);
				return true;
			});
			resolveExit(0);
			await flushUnhandledRejections();
			stdout.error(injected);
			stderr.close();
			await failure;
			await flushUnhandledRejections();
			assert.deepEqual(unhandled, []);
			assert.equal(killed, 0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("surfaces a stderr pipe error and absorbs a second pipe error without an unhandled rejection (#6423)", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const stdout = createFakePipe();
			const stderr = createFakePipe();
			let resolveExit!: (code: number) => void;
			const exited = new Promise<number>((resolve) => {
				resolveExit = resolve;
			});
			const stderrErr = new Error("injected stderr EIO");
			const stdoutErr = new Error("injected secondary stdout EPIPE");
			const run = collectTwoPhaseChild(
				{
					stdout: stdout.stream,
					stderr: stderr.stream,
					exited,
					kill: () => {
						stdout.error(stdoutErr);
						resolveExit(143);
					},
				},
				{ loadedMarker: LOADED, loadTimeoutMs: 60_000, runTimeoutMs: 60_000 },
			);
			const failure = assert.rejects(run, (error: Error) => {
				assert.match(error.message, /stderr pipe errored \(injected stderr EIO\)/);
				assert.equal(error.cause, stderrErr);
				return true;
			});
			await flushUnhandledRejections();
			stderr.error(stderrErr);
			await failure;
			await flushUnhandledRejections();
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("leaves no unhandled rejection when a pipe errors during timeout teardown (#6423)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const stdout = createFakePipe();
			const stderr = createFakePipe();
			let resolveExit!: (code: number) => void;
			const exited = new Promise<number>((resolve) => {
				resolveExit = resolve;
			});
			const run = collectTwoPhaseChild(
				{
					stdout: stdout.stream,
					stderr: stderr.stream,
					exited,
					kill: () => {
						stdout.error(new Error("pipe broken during kill"));
						setImmediate(() => resolveExit(143));
					},
				},
				{ loadedMarker: LOADED, loadTimeoutMs: 1_000, runTimeoutMs: 500 },
			);
			const failure = assert.rejects(run, /the child did not load within 1000 ms/);
			await vi.advanceTimersByTimeAsync(1_000);
			await failure;
			await flushUnhandledRejections();
			assert.deepEqual(unhandled, []);
			assert.equal(vi.getTimerCount(), 0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("keeps the phase timeout active even when both pipes reach EOF before the child exits (#6423)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const stdout = createFakePipe();
		const stderr = createFakePipe();
		let resolveExit!: (code: number) => void;
		let killed = 0;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const run = collectTwoPhaseChild(
			{
				stdout: stdout.stream,
				stderr: stderr.stream,
				exited,
				kill: () => {
					killed++;
					resolveExit(143);
				},
			},
			{ loadedMarker: LOADED, loadTimeoutMs: 10_000, runTimeoutMs: 500 },
		);
		const failure = assert.rejects(run, /the child loaded, then did not finish within 500 ms/);
		stdout.write(LOADED.slice(0, 12));
		stdout.write(`${LOADED.slice(12)}\n`);
		stdout.close();
		stderr.close();
		await flushUnhandledRejections();
		await vi.advanceTimersByTimeAsync(500);
		await failure;
		assert.equal(killed, 1);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("does not arm a phase-2 timer when the loaded marker drains after the child has already exited (#6423)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const stdout = createFakePipe();
		const stderr = createFakePipe();
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const run = collectTwoPhaseChild(
			{
				stdout: stdout.stream,
				stderr: stderr.stream,
				exited,
				kill: () => {
					assert.fail("should not kill a child that already exited");
				},
			},
			{ loadedMarker: LOADED, loadTimeoutMs: 10_000, runTimeoutMs: 5_000 },
		);
		resolveExit(0);
		await flushUnhandledRejections();
		stdout.write(`${LOADED}\n{"ok":true}\n`);
		stdout.close();
		stderr.close();
		const output = await run;
		assert.match(output.stdout, /\{"ok":true\}/);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("propagates a spawn error, stops readers, and leaves no unhandled rejection (#6423)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const stdout = createFakePipe();
			const stderr = createFakePipe();
			let rejectExit!: (error: Error) => void;
			const exited = new Promise<number>((_resolve, reject) => {
				rejectExit = reject;
			});
			const spawnErr = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
			const run = collectTwoPhaseChild(
				{
					stdout: stdout.stream,
					stderr: stderr.stream,
					exited,
					kill: () => {
						assert.fail("should not kill a child that failed to spawn");
					},
				},
				{ loadedMarker: LOADED, loadTimeoutMs: 10_000, runTimeoutMs: 5_000 },
			);
			const failure = assert.rejects(run, (error: unknown) => {
				assert.equal(error, spawnErr);
				return true;
			});
			await flushUnhandledRejections();
			rejectExit(spawnErr);
			await failure;
			await flushUnhandledRejections();
			assert.deepEqual(unhandled, []);
			assert.equal(vi.getTimerCount(), 0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("surfaces a destroyed Node Readable.toWeb pipe error without an uncaught error or unhandled rejection (#6423)", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const nodeStdout = new Readable({ read() {} });
			const nodeStderr = new Readable({ read() {} });
			let resolveExit!: (code: number) => void;
			let killed = 0;
			const exited = new Promise<number>((resolve) => {
				resolveExit = resolve;
			});
			const injected = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
			const run = collectTwoPhaseChild(
				{
					stdout: Readable.toWeb(nodeStdout) as unknown as ByteStream,
					stderr: Readable.toWeb(nodeStderr) as unknown as ByteStream,
					exited,
					kill: () => {
						killed++;
						resolveExit(143);
					},
				},
				{ loadedMarker: LOADED, loadTimeoutMs: 60_000, runTimeoutMs: 60_000 },
			);
			const failure = assert.rejects(run, (error: Error) => {
				assert.match(error.message, /stdout pipe errored \(read ECONNRESET\)/);
				assert.equal(error.cause, injected);
				return true;
			});
			await flushUnhandledRejections();
			nodeStdout.push(`${LOADED}\n`);
			nodeStdout.destroy(injected);
			await failure;
			await flushUnhandledRejections();
			assert.deepEqual(unhandled, []);
			assert.equal(killed, 1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
