import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { appendFile, mkdir, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	EventSourceError,
	isEventSourceError,
	isSubscriptionConfigError,
	SubscriptionClosedError,
	SubscriptionConfigError,
} from "../../packages/coding-agent/src/core/event-subscriptions/errors.js";
import {
	type GitHubCommandRunner,
	githubChecks,
	githubReviews,
	interval,
	logTail,
	webhook,
} from "../../packages/coding-agent/src/core/event-subscriptions/sources.js";
import type { EventSource, SubscriptionEvent } from "../../packages/coding-agent/src/core/event-subscriptions/types.js";
import {
	createWakeDispatcher,
	type WakeDispatcher,
} from "../../packages/coding-agent/src/core/event-subscriptions/wake-dispatcher.js";
import {
	chmodSync,
	fileExistsSync,
	makeTempDirectory,
	readText,
	removeTempDirectory,
	sleep,
	writeTextSync,
} from "../helpers/runtime.js";

/**
 * Seams on the two Node modules the sources talk to, for the failures a real file system or socket cannot produce on
 * demand: a read that returns fewer bytes than asked, a failing `close`, a transient `stat` error, and a server
 * `error` after it listens. Without a fault set they pass straight through.
 */
const fsProbe = vi.hoisted(() => ({
	statCalls: 0,
	statFaults: [] as (() => Promise<never>)[],
	opens: 0,
	closes: 0,
	readLengths: [] as number[],
	readCap: undefined as number | undefined,
	readEof: false,
	readFailure: undefined as Error | undefined,
	closeFailure: undefined as Error | undefined,
}));
const httpProbe = vi.hoisted(() => ({ servers: [] as Server[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		stat: (...args: Parameters<typeof actual.stat>) => {
			fsProbe.statCalls++;
			const fault = fsProbe.statFaults.shift();
			return fault === undefined ? actual.stat(...args) : fault();
		},
		open: async (...args: Parameters<typeof actual.open>) => {
			fsProbe.opens++;
			const handle = await actual.open(...args);
			// The real read still fills the whole range; reporting fewer bytes makes the caller read the rest itself.
			const read = async (buffer: Buffer, offset: number, length: number, position: number) => {
				fsProbe.readLengths.push(length);
				if (fsProbe.readFailure !== undefined) throw fsProbe.readFailure;
				if (fsProbe.readEof) return { bytesRead: 0, buffer };
				const result = await handle.read(buffer, offset, length, position);
				const bytesRead =
					fsProbe.readCap === undefined ? result.bytesRead : Math.min(result.bytesRead, fsProbe.readCap);
				return { bytesRead, buffer };
			};
			const close = async () => {
				fsProbe.closes++;
				await handle.close();
				if (fsProbe.closeFailure !== undefined) throw fsProbe.closeFailure;
			};
			return new Proxy(handle, {
				get: (target, property) => {
					if (property === "read") return read;
					if (property === "close") return close;
					return Reflect.get(target, property, target);
				},
			});
		},
	};
});

vi.mock("node:http", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:http")>();
	return {
		...actual,
		createServer: (...args: Parameters<typeof actual.createServer>) => {
			const server = actual.createServer(...args);
			httpProbe.servers.push(server);
			return server;
		},
	};
});

const TICK_MS = 20;
const POLL_MS = 20;
const WAIT_TIMEOUT_MS = 10_000;
const SETTLE_MS = 15 * POLL_MS;
/** The largest range one `logTail` read asks for; larger appends are read in several steps. */
const LOG_READ_LIMIT_BYTES = 1_048_576;
/** `setTimeout`'s ceiling, which `interval` and the polling sources accept as their longest period. */
const LONGEST_TIMER_MS = 2_147_483_647;

interface RunningSource {
	readonly events: SubscriptionEvent[];
	readonly finished: Promise<void>;
	readonly controller: AbortController;
	stop(): Promise<void>;
}

const running: RunningSource[] = [];
const tempDirs: string[] = [];
const originalPath = process.env.PATH;

/** Starts `source`. `afterEmit` runs right after each recorded event, for tests that abort mid-delivery. */
function run(
	source: EventSource,
	emitted: SubscriptionEvent[] = [],
	afterEmit?: (controller: AbortController) => void,
): RunningSource {
	const controller = new AbortController();
	const finished = Promise.resolve(
		source.start(controller.signal, (event) => {
			if (controller.signal.aborted) throw new SubscriptionClosedError("test", "emit");
			emitted.push(event);
			afterEmit?.(controller);
		}),
	);
	const handle: RunningSource = {
		events: emitted,
		finished,
		controller,
		async stop() {
			controller.abort();
			await finished;
		},
	};
	running.push(handle);
	return handle;
}

/** Starts `source` with an `emit` that keeps working after the signal aborts, to observe what the source does then. */
function runWithEmit(source: EventSource, emit: (event: SubscriptionEvent) => void): RunningSource {
	const controller = new AbortController();
	const finished = Promise.resolve(source.start(controller.signal, emit));
	const handle: RunningSource = {
		events: [],
		finished,
		controller,
		async stop() {
			controller.abort();
			await finished;
		},
	};
	running.push(handle);
	return handle;
}

function eventIds(handle: RunningSource): string[] {
	return handle.events.map((event) => event.id);
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (!condition()) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
		await sleep(5);
	}
}

/** Fails fast, rather than at the suite timeout, when `promise` never settles. */
async function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new assert.AssertionError({ message: `timed out waiting for ${what}` })),
			WAIT_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await bounded(promise, "the promise to reject");
	} catch (error) {
		if (error instanceof assert.AssertionError) throw error;
		return error;
	}
	return assert.fail("expected the promise to reject");
}

interface ManualTimer {
	readonly at: number;
	readonly callback: () => void;
}

/** A dispatcher whose clock only moves when the test advances it. */
function manualDispatcher(start = 1_000) {
	let time = start;
	const timers = new Set<ManualTimer>();
	const dispatcher = createWakeDispatcher({
		now: () => time,
		elapsed: () => time,
		setTimer: (callback, ms) => {
			const timer: ManualTimer = { at: time + ms, callback };
			timers.add(timer);
			return { cancel: () => timers.delete(timer) };
		},
	});
	function advance(ms: number): void {
		time += ms;
		for (;;) {
			const due = [...timers].filter((timer) => timer.at <= time).sort((a, b) => a.at - b.at);
			if (due.length === 0) return;
			for (const timer of due) {
				timers.delete(timer);
				timer.callback();
			}
		}
	}
	/** Waits until the source is asleep on one wake, moves the clock, and waits until it is asleep again. */
	async function step(ms: number): Promise<void> {
		await waitFor(() => dispatcher.pending === 1, "the source to sleep");
		advance(ms);
		await waitFor(() => dispatcher.pending === 1, "the source to sleep again");
	}
	return { dispatcher, advance, step, hostTimers: () => timers.size };
}

function assertNoLeakedWakes(clock: ReturnType<typeof manualDispatcher>): void {
	assert.equal(clock.dispatcher.pending, 0);
	assert.equal(clock.hostTimers(), 0);
}

function configError(factory: () => unknown): SubscriptionConfigError {
	try {
		factory();
	} catch (error) {
		assert.ok(isSubscriptionConfigError(error));
		assert.ok(error instanceof SubscriptionConfigError);
		return error;
	}
	return assert.fail("expected the factory to throw");
}

function tempDir(): string {
	const dir = makeTempDirectory("event-sources-");
	tempDirs.push(dir);
	return dir;
}

function errnoError(code: string): Error {
	return Object.assign(new Error(`simulated ${code}`), { code });
}

/** A dispatcher that cannot wait, to prove a failing dispatcher fails the source rather than ending it quietly. */
function failingDispatcher(failure: Error): WakeDispatcher {
	return {
		now: () => 0,
		elapsed: () => 0,
		schedule: () => ({ cancel: () => undefined }),
		sleep: () => Promise.reject(failure),
	};
}

beforeEach(() => {
	running.length = 0;
	httpProbe.servers.length = 0;
	fsProbe.statCalls = 0;
	fsProbe.statFaults.length = 0;
	fsProbe.opens = 0;
	fsProbe.closes = 0;
	fsProbe.readLengths.length = 0;
	fsProbe.readCap = undefined;
	fsProbe.readEof = false;
	fsProbe.readFailure = undefined;
	fsProbe.closeFailure = undefined;
});

afterEach(async () => {
	process.env.PATH = originalPath;
	for (const handle of running) {
		handle.controller.abort();
		await handle.finished.catch(() => undefined);
	}
	for (const dir of tempDirs.splice(0)) removeTempDirectory(dir);
});

test("interval emits ticks with unique ids at its scheduled times and holds no wake after abort", async () => {
	const clock = manualDispatcher(1_000);
	const source = interval(TICK_MS, { dispatcher: clock.dispatcher });
	assert.equal(source.id, `interval:${TICK_MS}`);
	const handle = run(source);
	await waitFor(() => clock.dispatcher.pending === 1, "the first wake");
	assert.deepEqual(handle.events, []);

	await clock.step(TICK_MS);
	await clock.step(TICK_MS);
	await waitFor(() => handle.events.length === 2, "two ticks");
	assert.deepEqual(handle.events, [
		{ id: "interval:20:1000:1", type: "tick", payload: { tick: 1, at: 1_020 } },
		{ id: "interval:20:1000:2", type: "tick", payload: { tick: 2, at: 1_040 } },
	]);

	await handle.stop();
	assertNoLeakedWakes(clock);
	clock.advance(10 * TICK_MS);
	assert.equal(handle.events.length, 2);
});

test("interval skips ticks missed during a stall instead of replaying them", async () => {
	const clock = manualDispatcher(1_000);
	const handle = run(interval(TICK_MS, { dispatcher: clock.dispatcher }));
	await clock.step(5 * TICK_MS);
	assert.deepEqual(handle.events, [{ id: "interval:20:1000:1", type: "tick", payload: { tick: 1, at: 1_100 } }]);
	clock.advance(TICK_MS - 1);
	await sleep(5);
	assert.equal(handle.events.length, 1);
	clock.advance(1);
	await waitFor(() => handle.events.length === 2, "the next tick");
	assert.deepEqual(handle.events[1], { id: "interval:20:1000:2", type: "tick", payload: { tick: 2, at: 1_120 } });
});

test("interval waits a full period before its first tick", async () => {
	const clock = manualDispatcher(1_000);
	const handle = run(interval(TICK_MS, { dispatcher: clock.dispatcher }));
	await waitFor(() => clock.dispatcher.pending === 1, "the first wake");
	clock.advance(TICK_MS - 1);
	await sleep(5);
	assert.equal(handle.events.length, 0);
	clock.advance(1);
	await waitFor(() => handle.events.length === 1, "the first tick");
	assert.equal(handle.events[0]?.id, "interval:20:1000:1");
});

test("interval accepts the longest period a timer can hold", () => {
	assert.equal(interval(LONGEST_TIMER_MS).id, `interval:${LONGEST_TIMER_MS}`);
});

test("a source fails, rather than ending quietly, when its dispatcher cannot wait", async () => {
	const failure = new Error("dispatcher failed");
	const dir = tempDir();
	const file = join(dir, "d.log");
	await writeFile(file, "");
	const gh: GitHubCommandRunner = async () => "[]";
	for (const source of [
		interval(TICK_MS, { dispatcher: failingDispatcher(failure) }),
		logTail(file, { dispatcher: failingDispatcher(failure) }),
		githubReviews({ repo: "acme/widgets", pr: 7, gh, dispatcher: failingDispatcher(failure) }),
	]) {
		assert.equal(
			await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined))),
			failure,
		);
	}
});

test("interval ticks on the shared dispatcher by default and stops on abort", async () => {
	const handle = run(interval(TICK_MS));
	await waitFor(() => handle.events.length >= 2, "two ticks");
	await handle.stop();
	const emitted = handle.events.length;
	assert.equal(new Set(handle.events.map((event) => event.id)).size, emitted);
	await sleep(SETTLE_MS);
	assert.equal(handle.events.length, emitted);
});

test("interval resolves immediately when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const events: SubscriptionEvent[] = [];
	await interval(TICK_MS).start(controller.signal, (event) => events.push(event));
	assert.deepEqual(events, []);
});

test("interval rejects a non-positive-integer period before returning a source", () => {
	for (const ms of [0, -5, 1.5, Number.NaN, 2 ** 31]) {
		const error = configError(() => interval(ms));
		assert.equal(error.code, "invalid-option");
		assert.equal(error.field, "interval.ms");
		assert.equal(error.reason, "not-positive-integer");
	}
});

test("logTail emits only lines appended after it starts, with byte-offset ids", async () => {
	const dir = tempDir();
	const file = join(dir, "app.log");
	await writeFile(file, "old line\n");
	const clock = manualDispatcher();
	const source = logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher });
	assert.equal(source.id, `log:${file}`);
	const handle = run(source);
	await clock.step(POLL_MS);
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, []);

	await appendFile(file, "first\r\nsecond\n");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, [
		{ id: `${file}:9`, type: "line", payload: { path: file, line: "first", offset: 9 } },
		{ id: `${file}:16`, type: "line", payload: { path: file, line: "second", offset: 16 } },
	]);

	await handle.stop();
	assertNoLeakedWakes(clock);
});

test("logTail holds a partial line until its newline arrives", async () => {
	const dir = tempDir();
	const file = join(dir, "partial.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "half a li");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, []);

	await appendFile(file, "ne\nnext");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, [
		{ id: `${file}:0`, type: "line", payload: { path: file, line: "half a line", offset: 0 } },
	]);
	await clock.step(POLL_MS);
	assert.equal(handle.events.length, 1);

	await appendFile(file, "\n");
	await clock.step(POLL_MS);
	assert.equal(eventIds(handle)[1], `${file}:12`);
});

test("logTail waits for a missing file and reads it from the start", async () => {
	const dir = tempDir();
	const file = join(dir, "later.log");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, []);
	await writeFile(file, "created\n");
	await clock.step(POLL_MS);
	assert.equal(eventIds(handle)[0], `${file}:0`);
});

test("logTail restarts from the beginning when the file is truncated", async () => {
	const dir = tempDir();
	const file = join(dir, "rotate.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "aaaaaaaaaa\nbbbbbbbbbb\n");
	await clock.step(POLL_MS);
	assert.equal(handle.events.length, 2);

	await truncate(file, 0);
	await clock.step(POLL_MS);
	await appendFile(file, "c\n");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events[2], { id: `${file}:0`, type: "line", payload: { path: file, line: "c", offset: 0 } });
});

test("logTail resolves on abort and emits nothing afterwards", async () => {
	const dir = tempDir();
	const file = join(dir, "stop.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await waitFor(() => clock.dispatcher.pending === 1, "the first wake");
	await handle.stop();
	assertNoLeakedWakes(clock);
	await appendFile(file, "late\n");
	clock.advance(10 * POLL_MS);
	await sleep(SETTLE_MS);
	assert.deepEqual(handle.events, []);
});

test("logTail rejects a read failure other than ENOENT with the errno code as detail", async () => {
	const dir = tempDir();
	const notDirectory = join(dir, "file");
	await writeFile(notDirectory, "x");
	const failing = run(logTail(join(notDirectory, "child.log"), { pollMs: POLL_MS }));
	const error = await rejection(failing.finished);
	assert.ok(isEventSourceError(error));
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.code, "source-failed");
	assert.equal(error.phase, "read");
	assert.equal(error.detail, "ENOTDIR");
	assert.equal(error.retryable, false);
	assert.ok(error.cause !== undefined);
});

test("logTail rejects invalid options before touching the file system", () => {
	const missingPath = configError(() => logTail(""));
	assert.equal(missingPath.field, "logTail.path");
	assert.equal(missingPath.reason, "not-string");
	const badPoll = configError(() => logTail("/tmp/x.log", { pollMs: 0 }));
	assert.equal(badPoll.field, "logTail.pollMs");
	assert.equal(badPoll.reason, "not-positive-integer");
	for (const path of [42, undefined, null, ["/tmp/x.log"]]) {
		const notString = configError(() => logTail(path as never));
		assert.equal(notString.field, "logTail.path");
		assert.equal(notString.reason, "not-string");
	}
});

test("logTail follows a file with the default options", async () => {
	const dir = tempDir();
	const file = join(dir, "defaults.log");
	await writeFile(file, "");
	const source = logTail(file);
	assert.equal(source.id, `log:${file}`);
	const handle = run(source);
	await waitFor(() => fsProbe.statCalls >= 2, "the first poll");
	await appendFile(file, "hello\n");
	await waitFor(() => handle.events.length === 1, "the appended line");
	assert.equal(handle.events[0]?.id, `${file}:0`);
});

test("logTail costs one stat per poll and opens the file only when bytes arrived", async () => {
	const dir = tempDir();
	const file = join(dir, "cost.log");
	await writeFile(file, "old\n");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await clock.step(POLL_MS);
	assert.equal(fsProbe.statCalls, 4);
	assert.equal(fsProbe.opens, 0);

	await appendFile(file, "a\n");
	await clock.step(POLL_MS);
	assert.equal(fsProbe.statCalls, 5);
	assert.equal(fsProbe.opens, 1);
	assert.deepEqual(fsProbe.readLengths, [2]);
	assert.equal(handle.events.length, 1);

	await clock.step(POLL_MS);
	assert.equal(fsProbe.statCalls, 6);
	assert.equal(fsProbe.opens, 1);
	assert.equal(fsProbe.closes, 1);
});

test("logTail reads an append larger than one read in steps and joins a line that spans them", async () => {
	const dir = tempDir();
	const file = join(dir, "big.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	const longLine = "x".repeat(LOG_READ_LIMIT_BYTES + 10);
	await appendFile(file, `${longLine}\ntail\n`);
	await clock.step(POLL_MS);

	assert.deepEqual(fsProbe.readLengths, [LOG_READ_LIMIT_BYTES, 16]);
	assert.equal(handle.events.length, 2);
	assert.equal(handle.events[0]?.id, `${file}:0`);
	const first = handle.events[0]?.payload;
	assert.ok(typeof first === "object" && first !== null && "line" in first);
	assert.ok(first.line === longLine, "the long line is delivered whole");
	assert.deepEqual(handle.events[1], {
		id: `${file}:${LOG_READ_LIMIT_BYTES + 11}`,
		type: "line",
		payload: { path: file, line: "tail", offset: LOG_READ_LIMIT_BYTES + 11 },
	});
	assert.equal(fsProbe.closes, fsProbe.opens);
});

test("logTail finishes a range the file system returns in pieces", async () => {
	const dir = tempDir();
	const file = join(dir, "pieces.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "alpha\nbravo\ncharlie\n");
	fsProbe.readCap = 7;
	await clock.step(POLL_MS);

	assert.deepEqual(fsProbe.readLengths, [20, 13, 6]);
	assert.deepEqual(
		handle.events.map((event) => event.payload),
		[
			{ path: file, line: "alpha", offset: 0 },
			{ path: file, line: "bravo", offset: 6 },
			{ path: file, line: "charlie", offset: 12 },
		],
	);
});

test("logTail waits for the next poll when a file reports bytes it cannot return", async () => {
	const dir = tempDir();
	const file = join(dir, "shrunk.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "data\n");
	fsProbe.readEof = true;
	await clock.step(POLL_MS);
	assert.equal(handle.events.length, 0);
	assert.equal(fsProbe.opens, 1);
	assert.deepEqual(fsProbe.readLengths, [5]);

	fsProbe.readEof = false;
	await clock.step(POLL_MS);
	assert.equal(handle.events[0]?.id, `${file}:0`);
});

test("logTail restarts from the start when the file is truncated below a held partial line", async () => {
	const dir = tempDir();
	const file = join(dir, "partial-truncate.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "abcdefgh");
	await clock.step(POLL_MS);
	await truncate(file, 3);
	await clock.step(POLL_MS);
	await appendFile(file, "\n");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, [
		{ id: `${file}:0`, type: "line", payload: { path: file, line: "abc", offset: 0 } },
	]);
});

test("logTail starts over when the file is deleted and created again", async () => {
	const dir = tempDir();
	const file = join(dir, "recreated.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "abc");
	await clock.step(POLL_MS);
	await unlink(file);
	await clock.step(POLL_MS);
	await writeFile(file, "defg\n");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, [
		{ id: `${file}:0`, type: "line", payload: { path: file, line: "defg", offset: 0 } },
	]);
});

test("logTail keeps empty lines, with or without a carriage return", async () => {
	const dir = tempDir();
	const file = join(dir, "empty-lines.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "\n\r\nx\r\n\n");
	await clock.step(POLL_MS);
	assert.deepEqual(
		handle.events.map((event) => event.payload),
		[
			{ path: file, line: "", offset: 0 },
			{ path: file, line: "", offset: 1 },
			{ path: file, line: "x", offset: 3 },
			{ path: file, line: "", offset: 6 },
		],
	);
});

test("logTail stops delivering a batch of lines once its signal aborts", async () => {
	const dir = tempDir();
	const file = join(dir, "batch.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }), [], (controller) =>
		controller.abort(),
	);
	await clock.step(POLL_MS);
	await appendFile(file, "a\nb\n");
	clock.advance(POLL_MS);
	await handle.finished;
	assert.deepEqual(eventIds(handle), [`${file}:0`]);
});

test("logTail rejects a read failure in the middle of a run with the errno code as detail", async () => {
	const dir = tempDir();
	const folder = join(dir, "sub");
	await mkdir(folder);
	const file = join(folder, "app.log");
	await writeFile(file, "old\n");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await waitFor(() => clock.dispatcher.pending === 1, "the first poll");
	await rm(folder, { recursive: true });
	await writeFile(folder, "now a file");
	clock.advance(POLL_MS);
	const error = await rejection(handle.finished);
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.phase, "read");
	assert.equal(error.detail, "ENOTDIR");
	assert.equal(error.sourceId, `log:${file}`);
	assert.ok(error.cause !== undefined);
});

test("logTail does not replay the file when its first stat fails for a reason other than a missing file", async () => {
	const dir = tempDir();
	const file = join(dir, "denied.log");
	await writeFile(file, "old\n");
	fsProbe.statFaults.push(() => Promise.reject(errnoError("EACCES")));
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	const error = await rejection(handle.finished);
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.phase, "read");
	assert.equal(error.detail, "EACCES");
	assert.deepEqual(handle.events, []);
});

test("logTail resolves, rather than failing, when it is stopped while its first stat is failing", async () => {
	const dir = tempDir();
	const file = join(dir, "stopped.log");
	await writeFile(file, "old\n");
	const stat = Promise.withResolvers<never>();
	fsProbe.statFaults.push(() => stat.promise);
	const handle = run(logTail(file, { pollMs: POLL_MS }));
	await waitFor(() => fsProbe.statCalls === 1, "the first stat");
	handle.controller.abort();
	stat.reject(errnoError("EACCES"));
	await bounded(handle.finished, "the source to stop");
	assert.deepEqual(handle.events, []);
});

test("logTail resolves, rather than failing, when it is stopped while a poll is failing", async () => {
	const dir = tempDir();
	const file = join(dir, "stopped-poll.log");
	await writeFile(file, "old\n");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	const stat = Promise.withResolvers<never>();
	fsProbe.statFaults.push(() => stat.promise);
	clock.advance(POLL_MS);
	await waitFor(() => fsProbe.statCalls === 4, "the next poll to start");
	handle.controller.abort();
	stat.reject(errnoError("EIO"));
	await bounded(handle.finished, "the source to stop");
	assert.deepEqual(handle.events, []);
});

test("logTail reports a failing read with the file closed and the read error as the cause", async () => {
	const dir = tempDir();
	const file = join(dir, "failing-read.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "data\n");
	const readFailure = errnoError("EIO");
	fsProbe.readFailure = readFailure;
	clock.advance(POLL_MS);
	const error = await rejection(handle.finished);
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.phase, "read");
	assert.equal(error.detail, "EIO");
	assert.equal(error.cause, readFailure);
	assert.equal(fsProbe.closes, 1);
});

test("logTail reports a failing close as a read failure", async () => {
	const dir = tempDir();
	const file = join(dir, "failing-close.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "data\n");
	const closeFailure = errnoError("EBADF");
	fsProbe.closeFailure = closeFailure;
	clock.advance(POLL_MS);
	const error = await rejection(handle.finished);
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.phase, "read");
	assert.equal(error.detail, "EBADF");
	assert.equal(error.cause, closeFailure);
});

test("logTail keeps the read error, not the close error, when both fail", async () => {
	const dir = tempDir();
	const file = join(dir, "failing-both.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "data\n");
	const readFailure = errnoError("EIO");
	fsProbe.readFailure = readFailure;
	fsProbe.closeFailure = errnoError("EBADF");
	clock.advance(POLL_MS);
	const error = await rejection(handle.finished);
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.detail, "EIO");
	assert.equal(error.cause, readFailure);
	assert.equal(fsProbe.closes, 1);
});

async function startWebhook(
	options: Parameters<typeof webhook>[0],
): Promise<{ readonly handle: RunningSource; readonly url: string }> {
	const source = webhook(options);
	const handle = run(source);
	return { handle, url: await source.listening() };
}

test("webhook accepts a JSON POST, using x-github-delivery as the event id", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/hooks\/ci$/);

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-delivery": "delivery-1",
			"x-github-event": "check_suite",
		},
		body: JSON.stringify({ id: "body-id", action: "completed" }),
	});
	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), { accepted: true, id: "delivery-1" });
	assert.deepEqual(handle.events, [
		{ id: "delivery-1", type: "check_suite", payload: { id: "body-id", action: "completed" } },
	]);
});

test("webhook falls back to the body id and type, then to a generated id", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	const headers = { "content-type": "application/json" };

	await fetch(url, { method: "POST", headers, body: JSON.stringify({ id: 42, type: "deploy" }) });
	await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "opened" }) });
	await fetch(url, { method: "POST", body: "plain text" });

	assert.equal(handle.events.length, 3);
	assert.equal(handle.events[0]?.id, "42");
	assert.equal(handle.events[0]?.type, "deploy");
	assert.equal(handle.events[1]?.type, "opened");
	assert.match(handle.events[1]?.id ?? "", /^[0-9a-f-]{36}$/);
	assert.equal(handle.events[2]?.type, undefined);
	assert.equal(handle.events[2]?.payload, "plain text");
});

test("webhook prefers x-request-id and idempotency-key over the body id", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	await fetch(url, { method: "POST", headers: { "x-request-id": "req-1" }, body: "a" });
	await fetch(url, { method: "POST", headers: { "idempotency-key": "idem-1" }, body: "b" });
	assert.deepEqual(
		handle.events.map((event) => event.id),
		["req-1", "idem-1"],
	);
});

test("webhook answers 404 for other paths and 405 for other methods, emitting nothing", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	const base = new URL(url).origin;

	assert.equal((await fetch(`${base}/other`, { method: "POST", body: "x" })).status, 404);
	const wrongMethod = await fetch(url, { method: "GET" });
	assert.equal(wrongMethod.status, 405);
	assert.equal(wrongMethod.headers.get("allow"), "POST");
	assert.deepEqual(handle.events, []);
});

test("webhook answers 400 for invalid JSON and 413 for a body over the limit", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci", maxBodyBytes: 64 });

	const invalid = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
	assert.equal(invalid.status, 400);
	const tooLarge = await fetch(url, { method: "POST", body: "x".repeat(65) });
	assert.equal(tooLarge.status, 413);
	const atLimit = await fetch(url, { method: "POST", body: "x".repeat(64) });
	assert.equal(atLimit.status, 202);
	assert.equal(handle.events.length, 1);
});

test("webhook responds 503 when the subscription no longer accepts events", async () => {
	const source = webhook({ path: "/hooks/ci" });
	const controller = new AbortController();
	let closed = false;
	const finished = Promise.resolve(
		source.start(controller.signal, () => {
			if (closed) throw new SubscriptionClosedError("test", "emit");
		}),
	);
	running.push({ events: [], finished, controller, stop: async () => undefined });
	const url = await source.listening();
	closed = true;
	assert.equal((await fetch(url, { method: "POST", body: "x" })).status, 503);
});

test("webhook stops listening and resolves when the signal aborts", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	await handle.stop();
	const error = await rejection(fetch(url, { method: "POST", body: "x" }));
	assert.ok(error instanceof Error);
	assert.deepEqual(handle.events, []);
});

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

test("webhook rejects with a listen failure when another process holds the port", async () => {
	const occupier = createServer();
	await new Promise<void>((resolve) => occupier.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = occupier.address() as AddressInfo;
		const source = webhook({ path: "/hooks/ci", port });
		const finished = Promise.resolve(source.start(new AbortController().signal, () => undefined));
		const error = await rejection(finished);
		assert.ok(isEventSourceError(error));
		assert.ok(error instanceof EventSourceError);
		assert.equal(error.code, "source-failed");
		assert.equal(error.phase, "listen");
		assert.equal(error.detail, "EADDRINUSE");
		assert.equal(error.sourceId, "webhook:/hooks/ci");
		assert.equal(await rejection(source.listening()), error);
	} finally {
		await new Promise<void>((resolve) => occupier.close(() => resolve()));
	}
});

test("webhook sources on one fixed port share a server that closes with the last of them", async () => {
	const port = await freePort();
	const ci = await startWebhook({ path: "/hooks/ci", port });
	const deploy = await startWebhook({ path: "/hooks/deploy", port });
	assert.equal(new URL(ci.url).port, String(port));
	assert.equal(new URL(deploy.url).port, String(port));

	await fetch(ci.url, { method: "POST", headers: { "x-request-id": "ci-1" }, body: "a" });
	await fetch(deploy.url, { method: "POST", headers: { "x-request-id": "deploy-1" }, body: "b" });
	assert.deepEqual(
		ci.handle.events.map((event) => event.id),
		["ci-1"],
	);
	assert.deepEqual(
		deploy.handle.events.map((event) => event.id),
		["deploy-1"],
	);

	await ci.handle.stop();
	assert.equal((await fetch(ci.url, { method: "POST", body: "x" })).status, 404);
	assert.equal((await fetch(deploy.url, { method: "POST", body: "x" })).status, 202);

	await deploy.handle.stop();
	assert.ok((await rejection(fetch(deploy.url, { method: "POST", body: "x" }))) instanceof Error);

	const reopened = await startWebhook({ path: "/hooks/ci", port });
	assert.equal(new URL(reopened.url).port, String(port));
});

test("webhook rejects a second source registering the same path on a shared port", async () => {
	const port = await freePort();
	const first = await startWebhook({ path: "/hooks/ci", port });
	const second = webhook({ path: "/hooks/ci", port });
	const error = await rejection(Promise.resolve(second.start(new AbortController().signal, () => undefined)));
	assert.ok(isSubscriptionConfigError(error));
	assert.ok(error instanceof SubscriptionConfigError);
	assert.equal(error.code, "invalid-option");
	assert.equal(error.field, "webhook.path");
	assert.equal(error.reason, "duplicate-id");
	assert.equal(await rejection(second.listening()), error);
	assert.equal((await fetch(first.url, { method: "POST", body: "x" })).status, 202);
});

test("webhook sources on the ephemeral port each get their own server", async () => {
	const first = await startWebhook({ path: "/hooks/ci" });
	const second = await startWebhook({ path: "/hooks/ci" });
	assert.notEqual(new URL(first.url).port, new URL(second.url).port);
	await first.handle.stop();
	assert.equal((await fetch(second.url, { method: "POST", body: "x" })).status, 202);
});

test("webhook rejects invalid options before listening", () => {
	for (const options of [undefined, {}, { path: 42 }, { path: null }, { path: "" }, { path: "hooks" }]) {
		const path = configError(() => webhook(options as never));
		assert.equal(path.field, "webhook.path");
		assert.equal(path.reason, "not-string");
	}
	for (const port of [70_000, 65_536, -1, 1.5, Number.NaN]) {
		const error = configError(() => webhook({ path: "/h", port }));
		assert.equal(error.field, "webhook.port");
		assert.equal(error.reason, "not-positive-integer");
	}
	for (const hostname of ["", 42 as never]) {
		const error = configError(() => webhook({ path: "/h", hostname }));
		assert.equal(error.field, "webhook.hostname");
		assert.equal(error.reason, "not-string");
	}
	for (const maxBodyBytes of [0, -1, 1.5, Number.NaN]) {
		const error = configError(() => webhook({ path: "/h", maxBodyBytes }));
		assert.equal(error.field, "webhook.maxBodyBytes");
		assert.equal(error.reason, "not-positive-integer");
	}
});

test("webhook accepts the lowest and highest port and the smallest body limit", () => {
	assert.equal(webhook({ path: "/h", port: 0, maxBodyBytes: 1 }).id, "webhook:/h");
	assert.equal(webhook({ path: "/h", port: 65_535 }).id, "webhook:/h");
});

interface RawConnection {
	write(text: string): void;
	received(): string;
	/** Settles when the server (or this client) closes the connection. */
	readonly closed: Promise<void>;
	destroy(): void;
}

/** A bare TCP client, for requests `fetch` will not send: a body that never arrives, chunked bodies, aborted uploads. */
function rawConnection(port: number): Promise<RawConnection> {
	return new Promise((resolve, reject) => {
		const socket = connect({ port, host: "127.0.0.1" });
		let received = "";
		const closed = new Promise<void>((done) => socket.once("close", () => done()));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			received += chunk;
		});
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.off("error", reject);
			socket.on("error", () => socket.destroy());
			resolve({
				write: (text) => void socket.write(text),
				received: () => received,
				closed,
				destroy: () => socket.destroy(),
			});
		});
	});
}

function parseHttp(text: string): { readonly status: number; readonly body: string } | undefined {
	const split = text.indexOf("\r\n\r\n");
	if (split === -1) return undefined;
	const head = text.slice(0, split);
	const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
	const body = text.slice(split + 4);
	return body.length < length ? undefined : { status: Number(head.split(" ")[1]), body: body.slice(0, length) };
}

async function rawResponse(connection: RawConnection): Promise<{ readonly status: number; readonly body: string }> {
	await waitFor(() => parseHttp(connection.received()) !== undefined, "a complete HTTP response");
	return parseHttp(connection.received()) ?? assert.fail("the response disappeared");
}

function chunked(...parts: string[]): string {
	return `${parts.map((part) => `${part.length.toString(16)}\r\n${part}\r\n`).join("")}0\r\n\r\n`;
}

function portOf(url: string): number {
	return Number(new URL(url).port);
}

/** Resolves with the next request the (single) server of this test receives, after the source has handled it. */
function nextRequest(server: Server): Promise<ServerResponse> {
	return new Promise((resolve) => server.once("request", (_request, response) => resolve(response)));
}

function lastServer(): Server {
	return httpProbe.servers.at(-1) ?? assert.fail("no server was created");
}

test("webhook answers every request with a JSON body a sender can read", async () => {
	const { url } = await startWebhook({ path: "/hooks/ci", maxBodyBytes: 64 });
	const origin = new URL(url).origin;
	const responses = [
		{ response: await fetch(`${origin}/other`, { method: "POST", body: "x" }), body: { error: "not-found" } },
		{ response: await fetch(url), body: { error: "method-not-allowed" } },
		{
			response: await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
			body: { error: "invalid-json" },
		},
		{ response: await fetch(url, { method: "POST", body: "x".repeat(65) }), body: { error: "payload-too-large" } },
		{
			response: await fetch(url, { method: "POST", headers: { "x-request-id": "r-1" }, body: "x" }),
			body: { accepted: true, id: "r-1" },
		},
	];
	for (const { response, body } of responses) {
		assert.equal(response.headers.get("content-type"), "application/json");
		assert.deepEqual(await response.json(), body);
	}
});

test("webhook gives up on a body over the limit without reading it all, then closes the connection", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci", maxBodyBytes: 64 });
	const connection = await rawConnection(portOf(url));
	connection.write("POST /hooks/ci HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n");
	const response = await rawResponse(connection);
	assert.equal(response.status, 413);
	assert.deepEqual(JSON.parse(response.body), { error: "payload-too-large" });
	assert.match(connection.received().split("\r\n\r\n")[0] ?? "", /^connection: close$/im);
	await bounded(connection.closed, "the server to close the connection");
	assert.deepEqual(handle.events, []);
});

test("webhook counts the chunks of a body that declares no length against the limit", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci", maxBodyBytes: 64 });
	const post = async (body: string): Promise<number> => {
		const connection = await rawConnection(portOf(url));
		connection.write(
			`POST /hooks/ci HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body}`,
		);
		const { status } = await rawResponse(connection);
		await bounded(connection.closed, "the connection to close");
		return status;
	};
	assert.equal(await post(chunked("a".repeat(40), "b".repeat(40))), 413);
	assert.equal(await post(chunked("a".repeat(32), "b".repeat(32))), 202);
	assert.equal(handle.events.length, 1);
	assert.equal(handle.events[0]?.payload, `${"a".repeat(32)}${"b".repeat(32)}`);
});

test("webhook takes the id from the first header present, then the body, and the type from the event header, type or action", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	const deliver = async (headers: Record<string, string>, body: string): Promise<SubscriptionEvent> => {
		const before = handle.events.length;
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body,
		});
		assert.equal(response.status, 202);
		assert.equal(handle.events.length, before + 1);
		return handle.events[before] ?? assert.fail("no event was emitted");
	};

	const all = await deliver(
		{ "x-github-delivery": "d", "x-request-id": "r", "idempotency-key": "i", "x-github-event": "ev" },
		JSON.stringify({ id: "b", type: "t", action: "a" }),
	);
	assert.deepEqual([all.id, all.type], ["d", "ev"]);
	assert.equal((await deliver({ "x-request-id": "r", "idempotency-key": "i" }, "{}")).id, "r");
	assert.equal((await deliver({ "idempotency-key": "i" }, JSON.stringify({ id: "b" }))).id, "i");

	const fromBody = await deliver({}, JSON.stringify({ id: "b", type: "t", action: "a" }));
	assert.deepEqual([fromBody.id, fromBody.type], ["b", "t"]);
	const fromNumber = await deliver({}, JSON.stringify({ id: 7, action: "a" }));
	assert.deepEqual([fromNumber.id, fromNumber.type], ["7", "a"]);

	for (const body of [
		'{"id":""}',
		'{"id":null}',
		'{"id":true}',
		'{"id":{"n":1}}',
		'{"id":[1]}',
		'{"id":1e999}',
		"{}",
	]) {
		assert.match((await deliver({}, body)).id, /^[0-9a-f-]{36}$/);
	}
});

test("webhook ignores request headers that are empty", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	const connection = await rawConnection(portOf(url));
	connection.write(
		"POST /hooks/ci HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 16\r\n" +
			'X-GitHub-Delivery:\r\nX-Request-Id: r-2\r\nX-GitHub-Event:\r\n\r\n{"type":"build"}',
	);
	assert.equal((await rawResponse(connection)).status, 202);
	assert.deepEqual(handle.events, [{ id: "r-2", type: "build", payload: { type: "build" } }]);
});

test("webhook delivers JSON bodies that are not objects, and bodies without a content type", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	const headers = { "content-type": "Application/JSON; charset=utf-8" };
	for (const body of ["null", "[1,2]", '"text"', "42"]) {
		assert.equal((await fetch(url, { method: "POST", headers, body })).status, 202);
	}
	assert.equal((await fetch(url, { method: "POST" })).status, 202);

	assert.deepEqual(
		handle.events.map((event) => event.payload),
		[null, [1, 2], "text", 42, ""],
	);
	for (const event of handle.events) {
		assert.match(event.id, /^[0-9a-f-]{36}$/);
		assert.equal(Object.hasOwn(event, "type"), false);
	}
});

test("webhook routes by path and ignores the query string", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	assert.equal((await fetch(`${url}?token=1&x=2`, { method: "POST", body: "x" })).status, 202);
	assert.equal((await fetch(`${url}?`, { method: "POST", body: "y" })).status, 202);
	assert.equal(handle.events.length, 2);
});

test("webhook answers 500, not 202, when the subscription fails to take an event for another reason", async () => {
	const source = webhook({ path: "/hooks/ci" });
	runWithEmit(source, () => {
		throw new Error("journal unavailable");
	});
	const response = await fetch(await source.listening(), { method: "POST", body: "x" });
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: "internal-error" });
});

test("webhook tells a sender that the subscription is closed with a 503 body", async () => {
	const source = webhook({ path: "/hooks/ci" });
	runWithEmit(source, () => {
		throw new SubscriptionClosedError("test", "emit");
	});
	const response = await fetch(await source.listening(), { method: "POST", body: "x" });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { accepted: false });
});

test("webhook answers 503 to a delivery in flight when its source stops, and the shared server keeps serving", async () => {
	const port = await freePort();
	const delivered: SubscriptionEvent[] = [];
	const source = webhook({ path: "/hooks/ci", port });
	const handle = runWithEmit(source, (event) => void delivered.push(event));
	const other = await startWebhook({ path: "/hooks/deploy", port });
	await source.listening();

	const arrived = nextRequest(lastServer());
	const connection = await rawConnection(port);
	connection.write("POST /hooks/ci HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nab");
	await bounded(arrived, "the request");
	await handle.stop();
	connection.write("cde");

	const response = await rawResponse(connection);
	assert.equal(response.status, 503);
	assert.deepEqual(JSON.parse(response.body), { accepted: false });
	assert.deepEqual(delivered, []);
	assert.equal((await fetch(other.url, { method: "POST", body: "x" })).status, 202);
});

test("webhook stops promptly even while a sender is still uploading", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	const arrived = nextRequest(lastServer());
	const connection = await rawConnection(portOf(url));
	connection.write("POST /hooks/ci HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nab");
	await bounded(arrived, "the request");
	await bounded(handle.stop(), "the source to stop");
	await bounded(connection.closed, "the server to drop the upload");
});

test("webhook finishes the handler of an upload the sender abandons, and keeps serving", async () => {
	const { url } = await startWebhook({ path: "/hooks/ci" });
	const arrived = nextRequest(lastServer());
	const connection = await rawConnection(portOf(url));
	connection.write("POST /hooks/ci HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nab");
	const response = await bounded(arrived, "the request");
	connection.destroy();
	await waitFor(() => response.writableEnded, "the abandoned request to be answered");
	assert.equal((await fetch(url, { method: "POST", body: "x" })).status, 202);
});

test("webhook reports the url it listens on every time it is asked", async () => {
	const source = webhook({ path: "/hooks/ci" });
	run(source);
	const url = await source.listening();
	assert.equal(await source.listening(), url);
});

test("webhook rejects a listening() asked before a listen failure with that failure", async () => {
	const occupier = createServer();
	await new Promise<void>((resolve) => occupier.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = occupier.address() as AddressInfo;
		const source = webhook({ path: "/hooks/ci", port });
		const early = rejection(source.listening());
		const finished = rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
		const error = await finished;
		assert.ok(error instanceof EventSourceError);
		assert.equal(await early, error);
	} finally {
		await new Promise<void>((resolve) => occupier.close(() => resolve()));
	}
});

test("webhook started with an aborted signal resolves without opening a server", async () => {
	const source = webhook({ path: "/hooks/ci" });
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	await source.start(controller.signal, () => undefined);
	assert.equal(httpProbe.servers.length, 0);
	assert.equal(await rejection(source.listening()), controller.signal.reason);
});

test("webhook stopped while it is starting resolves and never reports a url", async () => {
	const source = webhook({ path: "/hooks/ci" });
	const controller = new AbortController();
	const finished = Promise.resolve(source.start(controller.signal, () => undefined));
	controller.abort();
	await bounded(finished, "the source to stop");
	assert.equal(await rejection(source.listening()), controller.signal.reason);
});

test("webhook stopped while its port is taken resolves instead of failing", async () => {
	const occupier = createServer();
	await new Promise<void>((resolve) => occupier.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = occupier.address() as AddressInfo;
		const source = webhook({ path: "/hooks/ci", port });
		const controller = new AbortController();
		const finished = Promise.resolve(source.start(controller.signal, () => undefined));
		controller.abort();
		await bounded(finished, "the source to stop");
		assert.equal(await rejection(source.listening()), controller.signal.reason);
	} finally {
		await new Promise<void>((resolve) => occupier.close(() => resolve()));
	}
});

test("webhook keeps its url when the same source is started a second time", async () => {
	const source = webhook({ path: "/hooks/ci", port: await freePort() });
	run(source);
	const url = await source.listening();
	const error = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
	assert.ok(error instanceof SubscriptionConfigError);
	assert.equal(error.reason, "duplicate-id");
	assert.equal(await source.listening(), url);
});

test("webhook fails with a listen error when its server breaks after it listens, and releases what it held", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	const server = lastServer();
	assert.equal(server.listenerCount("error"), 1);
	assert.equal(getEventListeners(handle.controller.signal, "abort").length, 1);

	const failure = errnoError("EMFILE");
	server.emit("error", failure);
	const error = await rejection(handle.finished);
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.phase, "listen");
	assert.equal(error.detail, "EMFILE");
	assert.equal(error.sourceId, "webhook:/hooks/ci");
	assert.equal(error.cause, failure);
	assert.equal(server.listenerCount("error"), 0);
	assert.equal(getEventListeners(handle.controller.signal, "abort").length, 0);
	assert.ok((await rejection(fetch(url, { method: "POST", body: "x" }))) instanceof Error);
});

test("webhook stopped at the moment its server breaks resolves instead of failing", async () => {
	const { handle } = await startWebhook({ path: "/hooks/ci" });
	handle.controller.abort();
	lastServer().emit("error", errnoError("EMFILE"));
	await bounded(handle.finished, "the source to stop");
});

test("webhook sources on different fixed ports listen on their own ports", async () => {
	const first = await startWebhook({ path: "/hooks/ci", port: await freePort() });
	const second = await startWebhook({ path: "/hooks/ci", port: await freePort() });
	assert.notEqual(portOf(first.url), portOf(second.url));
	assert.equal((await fetch(second.url, { method: "POST", body: "x" })).status, 202);
	assert.equal(second.handle.events.length, 1);
	assert.equal(first.handle.events.length, 0);
});

test("webhook puts an IPv6 host in brackets in its url", async () => {
	const source = webhook({ path: "/hooks/ci", hostname: "::1" });
	run(source);
	let url: string;
	try {
		url = await source.listening();
	} catch (error) {
		// A host without an IPv6 loopback must still fail as a typed listen error.
		assert.ok(error instanceof EventSourceError);
		assert.equal(error.phase, "listen");
		assert.ok(error.detail === "EADDRNOTAVAIL" || error.detail === "EAFNOSUPPORT", `unexpected ${error.detail}`);
		return;
	}
	assert.match(url, /^http:\/\/\[::1\]:\d+\/hooks\/ci$/);
	assert.equal((await fetch(url, { method: "POST", body: "x" })).status, 202);
});

interface RecordingRunner {
	readonly gh: GitHubCommandRunner;
	readonly calls: (readonly string[])[];
}

function fakeGh(responses: Readonly<Record<string, string>>): RecordingRunner {
	const calls: (readonly string[])[] = [];
	const gh: GitHubCommandRunner = async (args) => {
		calls.push(args);
		const response = responses[args.join(" ")];
		if (response === undefined) throw new Error(`unexpected gh call: ${args.join(" ")}`);
		return response;
	};
	return { gh, calls };
}

test("githubChecks emits one check_run event per check run of the head commit", async () => {
	const { gh, calls } = fakeGh({
		"api repos/acme/widgets/pulls/7": JSON.stringify({ head: { sha: "abc123" } }),
		"api repos/acme/widgets/commits/abc123/check-runs?per_page=100": JSON.stringify({
			check_runs: [
				{
					id: 11,
					name: "build",
					status: "completed",
					conclusion: "success",
					html_url: "https://github.com/acme/widgets/runs/11",
					started_at: "2026-01-01T00:00:00Z",
					completed_at: "2026-01-01T00:05:00Z",
				},
				{ id: 12, name: "lint", status: "in_progress", conclusion: null, html_url: null },
			],
		}),
	});
	const clock = manualDispatcher();
	const source = githubChecks({ repo: "acme/widgets", pr: 7, intervalMs: POLL_MS, gh, dispatcher: clock.dispatcher });
	assert.equal(source.id, "github-checks:acme/widgets#7");
	const handle = run(source);
	await clock.step(POLL_MS);
	await handle.stop();
	assertNoLeakedWakes(clock);
	assert.equal(handle.events.length, 4);

	assert.deepEqual(handle.events.slice(0, 2), [
		{
			id: "check-run:11:completed:success",
			type: "check_run",
			payload: {
				name: "build",
				status: "completed",
				conclusion: "success",
				url: "https://github.com/acme/widgets/runs/11",
				headSha: "abc123",
				startedAt: "2026-01-01T00:00:00Z",
				completedAt: "2026-01-01T00:05:00Z",
			},
		},
		{
			id: "check-run:12:in_progress:none",
			type: "check_run",
			payload: {
				name: "lint",
				status: "in_progress",
				conclusion: null,
				url: null,
				headSha: "abc123",
				startedAt: null,
				completedAt: null,
			},
		},
	]);
	assert.deepEqual(handle.events.slice(2, 4), handle.events.slice(0, 2));
	assert.deepEqual(calls.slice(0, 2), [
		["api", "repos/acme/widgets/pulls/7"],
		["api", "repos/acme/widgets/commits/abc123/check-runs?per_page=100"],
	]);
});

test("githubReviews emits one pull_request_review event per review", async () => {
	const { gh, calls } = fakeGh({
		"api repos/acme/widgets/pulls/7/reviews?per_page=100": JSON.stringify([
			{
				id: 901,
				user: { login: "octocat" },
				state: "APPROVED",
				body: "ship it",
				submitted_at: "2026-01-02T00:00:00Z",
				html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-901",
			},
			{ id: 902, user: null, state: "COMMENTED", body: null },
		]),
	});
	const clock = manualDispatcher();
	const source = githubReviews({ repo: "acme/widgets", pr: 7, intervalMs: POLL_MS, gh, dispatcher: clock.dispatcher });
	assert.equal(source.id, "github-reviews:acme/widgets#7");
	const handle = run(source);
	await waitFor(() => clock.dispatcher.pending === 1, "the first poll to finish");
	assert.equal(handle.events.length, 2);
	await handle.stop();
	assertNoLeakedWakes(clock);

	assert.deepEqual(handle.events.slice(0, 2), [
		{
			id: "review:901",
			type: "pull_request_review",
			payload: {
				reviewer: "octocat",
				state: "APPROVED",
				body: "ship it",
				submittedAt: "2026-01-02T00:00:00Z",
				url: "https://github.com/acme/widgets/pull/7#pullrequestreview-901",
			},
		},
		{
			id: "review:902",
			type: "pull_request_review",
			payload: { reviewer: null, state: "COMMENTED", body: "", submittedAt: null, url: null },
		},
	]);
	assert.deepEqual(calls[0], ["api", "repos/acme/widgets/pulls/7/reviews?per_page=100"]);
});

test("github sources reject with a poll failure that keeps the runner error as the cause", async () => {
	const runnerFailure = new Error("gh exited with code 1");
	const gh: GitHubCommandRunner = async () => {
		throw runnerFailure;
	};
	for (const factory of [githubChecks, githubReviews]) {
		const source = factory({ repo: "acme/widgets", pr: 7, intervalMs: POLL_MS, gh });
		const error = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
		assert.ok(isEventSourceError(error));
		assert.ok(error instanceof EventSourceError);
		assert.equal(error.code, "source-failed");
		assert.equal(error.phase, "poll");
		assert.equal(error.sourceId, source.id);
		assert.equal(error.retryable, true);
		assert.equal(error.cause, runnerFailure);
	}
});

test("github sources treat a malformed response as a non-retryable poll failure", async () => {
	const source = githubReviews({ repo: "acme/widgets", pr: 7, gh: async () => "not json" });
	const error = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.phase, "poll");
	assert.equal(error.retryable, false);
	assert.equal(error.detail, "unexpected gh response");
});

test("a failed poll renders one credential-free message that names the phase and source", async () => {
	const source = githubChecks({
		repo: "acme/widgets",
		pr: 7,
		gh: async () => {
			throw new Error("token ghp_secret rejected");
		},
	});
	const error = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
	assert.ok(error instanceof EventSourceError);
	assert.equal(
		error.message,
		"Event source failed during poll (gh failed): github-checks:acme/widgets#7 (source-failed). " +
			"Check the source's configuration and access (for GitHub sources, `gh auth status`), then subscribe again.",
	);
});

test("aborting while a poll is in flight resolves instead of failing", async () => {
	let started: () => void = () => undefined;
	const polling = new Promise<void>((resolve) => {
		started = resolve;
	});
	const gh: GitHubCommandRunner = (_args, signal) =>
		new Promise((_resolve, reject) => {
			started();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	const clock = manualDispatcher();
	const handle = run(githubReviews({ repo: "acme/widgets", pr: 7, gh, dispatcher: clock.dispatcher }));
	await polling;
	await handle.stop();
	assertNoLeakedWakes(clock);
	assert.deepEqual(handle.events, []);
});

test("aborting between polls resolves without leaving a timer or emitting again", async () => {
	const { gh, calls } = fakeGh({ "api repos/acme/widgets/pulls/7/reviews?per_page=100": "[]" });
	const clock = manualDispatcher();
	const handle = run(
		githubReviews({ repo: "acme/widgets", pr: 7, intervalMs: 1_000_000, gh, dispatcher: clock.dispatcher }),
	);
	await waitFor(() => clock.dispatcher.pending === 1, "the first poll to finish");
	await handle.stop();
	assertNoLeakedWakes(clock);
	clock.advance(2_000_000);
	await sleep(SETTLE_MS);
	assert.equal(calls.length, 1);
});

const PULL = "api repos/acme/widgets/pulls/7";
const RUNS = "api repos/acme/widgets/commits/abc123/check-runs?per_page=100";
const REVIEWS = "api repos/acme/widgets/pulls/7/reviews?per_page=100";
const PULL_WITH_HEAD = JSON.stringify({ head: { sha: "abc123" } });

type GitHubSourceFactory = typeof githubChecks;

/** The events of the first poll of a source that is fed `responses`, then stopped. */
async function firstPoll(
	factory: GitHubSourceFactory,
	responses: Record<string, string>,
): Promise<SubscriptionEvent[]> {
	const clock = manualDispatcher();
	const gh = fakeGh(responses).gh;
	const handle = run(factory({ repo: "acme/widgets", pr: 7, gh, dispatcher: clock.dispatcher }));
	await waitFor(() => clock.dispatcher.pending === 1, "the first poll to finish");
	await handle.stop();
	return handle.events;
}

async function pollFailure(
	gh: GitHubCommandRunner,
	factory: GitHubSourceFactory = githubReviews,
): Promise<EventSourceError> {
	const source = factory({ repo: "acme/widgets", pr: 7, gh });
	const error = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.phase, "poll");
	return error;
}

test("githubChecks skips check runs without a numeric id and a status, and fills in what is missing", async () => {
	const events = await firstPoll(githubChecks, {
		[PULL]: PULL_WITH_HEAD,
		[RUNS]:
			'{"check_runs":[null,7,"text",[],{"id":"11","status":"completed"},{"id":12},{"id":13,"status":5},' +
			'{"id":1e999,"status":"queued"},{"id":14,"status":"queued","conclusion":5,"html_url":5,"name":5,' +
			'"started_at":5,"completed_at":5}]}',
	});
	assert.deepEqual(events, [
		{
			id: "check-run:14:queued:none",
			type: "check_run",
			payload: {
				name: "",
				status: "queued",
				conclusion: null,
				url: null,
				headSha: "abc123",
				startedAt: null,
				completedAt: null,
			},
		},
	]);
});

test("githubReviews skips reviews without a numeric id, and fills in what is missing", async () => {
	const events = await firstPoll(githubReviews, {
		[REVIEWS]:
			'[null,3,"text",[],{"id":"1"},{"state":"APPROVED"},{"id":1e999},' +
			'{"id":5,"user":"octocat","state":7,"body":8,"submitted_at":9,"html_url":10}]',
	});
	assert.deepEqual(events, [
		{
			id: "review:5",
			type: "pull_request_review",
			payload: { reviewer: null, state: "", body: "", submittedAt: null, url: null },
		},
	]);
});

test("github sources fail a poll with the reason the response was unusable", async () => {
	const cases: readonly {
		readonly factory: GitHubSourceFactory;
		readonly responses: Record<string, string>;
		readonly reason: string;
	}[] = [
		{ factory: githubReviews, responses: { [REVIEWS]: "not json" }, reason: "not-json" },
		{ factory: githubReviews, responses: { [REVIEWS]: "{}" }, reason: "not-array" },
		{ factory: githubReviews, responses: { [REVIEWS]: "null" }, reason: "not-array" },
		{ factory: githubChecks, responses: { [PULL]: "nope" }, reason: "not-json" },
		{ factory: githubChecks, responses: { [PULL]: "[]" }, reason: "not-object" },
		{ factory: githubChecks, responses: { [PULL]: "{}" }, reason: "no-head-sha" },
		{ factory: githubChecks, responses: { [PULL]: '{"head":"abc"}' }, reason: "no-head-sha" },
		{ factory: githubChecks, responses: { [PULL]: '{"head":null}' }, reason: "no-head-sha" },
		{ factory: githubChecks, responses: { [PULL]: '{"head":{"sha":7}}' }, reason: "no-head-sha" },
		{ factory: githubChecks, responses: { [PULL]: PULL_WITH_HEAD, [RUNS]: "oops" }, reason: "not-json" },
		{ factory: githubChecks, responses: { [PULL]: PULL_WITH_HEAD, [RUNS]: "7" }, reason: "not-object" },
		{ factory: githubChecks, responses: { [PULL]: PULL_WITH_HEAD, [RUNS]: "{}" }, reason: "not-array" },
		{
			factory: githubChecks,
			responses: { [PULL]: PULL_WITH_HEAD, [RUNS]: '{"check_runs":{}}' },
			reason: "not-array",
		},
	];
	for (const { factory, responses, reason } of cases) {
		const error = await pollFailure(fakeGh(responses).gh, factory);
		assert.equal(error.retryable, false, reason);
		assert.equal(error.detail, "unexpected gh response", reason);
		const cause = error.cause;
		assert.ok(cause instanceof Error && cause.name === "GitHubResponseError" && "reason" in cause, reason);
		assert.equal(cause.reason, reason);
		if (reason === "not-json") assert.ok(cause.cause instanceof SyntaxError, reason);
		else assert.equal(Object.hasOwn(cause, "cause"), false, reason);
	}
});

test("a failed poll names the errno code of the runner's failure, and nothing else", async () => {
	const cases: readonly [unknown, string][] = [
		["boom", "gh failed"],
		[null, "gh failed"],
		[undefined, "gh failed"],
		[{}, "gh failed"],
		[Object.assign(new Error("x"), { code: 42 }), "gh failed"],
		[errnoError("ECONNRESET"), "gh failed (ECONNRESET)"],
		[{ code: "EPIPE" }, "gh failed (EPIPE)"],
	];
	for (const [failure, detail] of cases) {
		const error = await pollFailure(() => Promise.reject(failure));
		assert.equal(error.detail, detail);
		assert.equal(error.retryable, true);
		assert.equal(error.cause, failure);
	}
});

test("github sources stop delivering a batch of events once their signal aborts", async () => {
	const { gh } = fakeGh({ [REVIEWS]: JSON.stringify([{ id: 1 }, { id: 2 }]) });
	const clock = manualDispatcher();
	const handle = run(
		githubReviews({ repo: "acme/widgets", pr: 7, gh, dispatcher: clock.dispatcher }),
		[],
		(controller) => controller.abort(),
	);
	await bounded(handle.finished, "the source to stop");
	assert.deepEqual(eventIds(handle), ["review:1"]);
});

function installFakeGh(script: string): string {
	const dir = tempDir();
	const gh = join(dir, "gh");
	writeTextSync(gh, `#!/bin/sh\n${script}\n`);
	chmodSync(gh, 0o755);
	process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
	return dir;
}

function commandFailure(error: EventSourceError) {
	const cause = error.cause;
	assert.ok(cause instanceof Error && cause.name === "GitHubCommandError");
	assert.ok("exitCode" in cause && "spawnCode" in cause && "stderr" in cause);
	return { exitCode: cause.exitCode, spawnCode: cause.spawnCode, stderr: cause.stderr, cause: cause.cause };
}

test.runIf(process.platform !== "win32")(
	"the default runner passes its arguments to gh and returns its output",
	async () => {
		const dir = installFakeGh(
			[`printf '%s\\n' "$@" > "$(dirname "$0")/args"`, `printf '[{"id":5,"state":"APPROVED"}]'`].join("\n"),
		);
		const clock = manualDispatcher();
		const handle = run(githubReviews({ repo: "acme/widgets", pr: 7, dispatcher: clock.dispatcher }));
		await waitFor(() => handle.events.length === 1, "the review");
		assert.equal(handle.events[0]?.id, "review:5");
		assert.equal(await readText(join(dir, "args")), "api\nrepos/acme/widgets/pulls/7/reviews?per_page=100\n");
	},
);

test.runIf(process.platform !== "win32")(
	"the default runner reports a failing gh with its exit code and a bounded stderr",
	async () => {
		installFakeGh("head -c 1500 /dev/zero | tr '\\0' x >&2\nexit 3");
		const source = githubReviews({ repo: "acme/widgets", pr: 7 });
		const failure = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
		assert.ok(failure instanceof EventSourceError);
		assert.equal(failure.phase, "poll");
		assert.equal(failure.detail, "gh exited with code 3");
		assert.equal(failure.retryable, true);
		const cause = commandFailure(failure);
		assert.equal(cause.exitCode, 3);
		assert.equal(cause.spawnCode, undefined);
		assert.equal(cause.stderr, "x".repeat(1_000));
		assert.ok(cause.cause instanceof Error);
	},
);

test.runIf(process.platform !== "win32")("the default runner reports a gh that is not installed", async () => {
	process.env.PATH = tempDir();
	const source = githubChecks({ repo: "acme/widgets", pr: 7 });
	const failure = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
	assert.ok(failure instanceof EventSourceError);
	assert.equal(failure.detail, "gh could not be run (ENOENT)");
	assert.equal(failure.retryable, true);
	const cause = commandFailure(failure);
	assert.equal(cause.exitCode, undefined);
	assert.equal(cause.spawnCode, "ENOENT");
});

test.runIf(process.platform !== "win32")("the default runner reports a gh that was killed by a signal", async () => {
	installFakeGh("kill -9 $$");
	const source = githubReviews({ repo: "acme/widgets", pr: 7 });
	const failure = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
	assert.ok(failure instanceof EventSourceError);
	assert.equal(failure.detail, "gh could not be run");
	const cause = commandFailure(failure);
	assert.equal(cause.exitCode, undefined);
	assert.equal(cause.spawnCode, undefined);
});

test.runIf(process.platform !== "win32")("the default runner stops gh when the source is stopped", async () => {
	const dir = installFakeGh(`touch "$(dirname "$0")/started"\nexec sleep 30`);
	const handle = run(githubReviews({ repo: "acme/widgets", pr: 7, dispatcher: manualDispatcher().dispatcher }));
	await waitFor(() => fileExistsSync(join(dir, "started")), "gh to start");
	await bounded(handle.stop(), "gh to be stopped");
	assert.deepEqual(handle.events, []);
});

test("github sources validate repo, pr and interval before any command runs", () => {
	let ran = false;
	const gh: GitHubCommandRunner = async () => {
		ran = true;
		return "[]";
	};
	for (const [name, factory] of [
		["githubChecks", githubChecks],
		["githubReviews", githubReviews],
	] as const) {
		for (const repo of ["", "widgets", "acme/", "/widgets", "acme/../x", "acme/widgets/extra", "a b/c"]) {
			const error = configError(() => factory({ repo, pr: 1, gh }));
			assert.equal(error.field, `${name}.repo`);
			assert.equal(error.reason, "not-string");
		}
		for (const repo of [undefined, 42, ["acme/widgets"], { toString: () => "acme/widgets" }]) {
			const error = configError(() => factory({ repo: repo as never, pr: 1, gh }));
			assert.equal(error.field, `${name}.repo`);
			assert.equal(error.reason, "not-string");
		}
		const notFunction = configError(() => factory({ repo: "acme/widgets", pr: 1, gh: "gh" as never }));
		assert.equal(notFunction.field, `${name}.gh`);
		assert.equal(notFunction.reason, "not-function");
		assert.ok(factory({ repo: "acme/widgets", pr: 1, intervalMs: LONGEST_TIMER_MS, gh }));
		for (const pr of [0, -1, 1.5, Number.NaN]) {
			const error = configError(() => factory({ repo: "acme/widgets", pr, gh }));
			assert.equal(error.field, `${name}.pr`);
			assert.equal(error.reason, "not-positive-integer");
		}
		const interval = configError(() => factory({ repo: "acme/widgets", pr: 1, intervalMs: 0, gh }));
		assert.equal(interval.field, `${name}.intervalMs`);
		assert.equal(interval.reason, "not-positive-integer");
	}
	assert.equal(ran, false);
});

test("sources reject a dispatcher that cannot sleep before any wake is scheduled", () => {
	const broken = {
		now: () => 0,
		elapsed: () => 0,
		schedule: () => ({ cancel: () => undefined }),
		sleep: "no" as never,
	};
	assert.equal(configError(() => interval(TICK_MS, { dispatcher: broken })).field, "interval.dispatcher");
	assert.equal(configError(() => logTail("/tmp/x.log", { dispatcher: broken })).field, "logTail.dispatcher");
	const repoOptions = { repo: "acme/widgets", pr: 1, dispatcher: broken };
	assert.equal(configError(() => githubChecks(repoOptions)).field, "githubChecks.dispatcher");
	assert.equal(configError(() => githubReviews(repoOptions)).reason, "not-function");
});
