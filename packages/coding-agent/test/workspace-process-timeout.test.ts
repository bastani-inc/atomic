import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { WorkspaceTimeoutError } from "../src/core/workspace/errors.ts";
import { runWorkspaceProcess } from "../src/core/workspace/process.ts";
import { spawnHostProcess } from "../src/utils/host-spawn.ts";
import { killChildProcessTree, killProcessTree } from "../src/utils/shell.ts";

const mocks = vi.hoisted(() => ({
	spawnHostProcess: vi.fn(),
	killChildProcessTree: vi.fn(),
	killProcessTree: vi.fn(),
	jobAttached: false,
	holdResult: "unavailable" as "unavailable" | "held" | "absent",
	containCalls: [] as number[],
	holdCalls: [] as number[],
	treeActive: 0,
	keepTreeActiveOnTerminate: false,
	treeTerminateCalls: 0,
	treeReleaseCalls: 0,
	treeCloseCalls: 0,
	holdEndAllCalls: 0,
	holdReleaseCalls: 0,
	resetContainment() {
		this.jobAttached = false;
		this.holdResult = "unavailable";
		this.containCalls = [];
		this.holdCalls = [];
		this.treeActive = 0;
		this.keepTreeActiveOnTerminate = false;
		this.treeTerminateCalls = 0;
		this.treeReleaseCalls = 0;
		this.treeCloseCalls = 0;
		this.holdEndAllCalls = 0;
		this.holdReleaseCalls = 0;
	},
}));

vi.mock("../src/utils/host-spawn.ts", () => ({ spawnHostProcess: mocks.spawnHostProcess }));
vi.mock("../src/utils/shell.ts", () => ({
	killChildProcessTree: mocks.killChildProcessTree,
	killProcessTree: mocks.killProcessTree,
}));
vi.mock("../src/core/process-tree-containment.ts", () => ({
	containProcessTree: vi.fn(() => undefined),
	containProcessTreeAllowingBreakaway: vi.fn((pid: number) => {
		mocks.containCalls.push(pid);
		if (!mocks.jobAttached) return undefined;
		return {
			terminate: () => {
				mocks.treeTerminateCalls++;
				if (!mocks.keepTreeActiveOnTerminate) mocks.treeActive = 0;
				return true;
			},
			activeProcesses: () => mocks.treeActive,
			release: () => {
				mocks.treeReleaseCalls++;
				return true;
			},
			close: () => {
				mocks.treeCloseCalls++;
			},
		};
	}),
	holdProcessDescendantsResult: vi.fn((pid: number) => {
		mocks.holdCalls.push(pid);
		if (mocks.holdResult === "held") {
			return {
				kind: "held" as const,
				held: {
					count: 0,
					endAll: () => {
						mocks.holdEndAllCalls++;
						return true;
					},
					release: () => {
						mocks.holdReleaseCalls++;
					},
				},
			};
		}
		if (mocks.holdResult === "absent") return { kind: "absent" as const };
		return { kind: "unavailable" as const };
	}),
	holdProcessDescendants: vi.fn(() => undefined),
	hasNativeProcessHold: vi.fn(() => mocks.holdResult !== "unavailable"),
}));

function fixtureProcess() {
	return Object.assign(new EventEmitter(), {
		pid: 12345,
		stdin: null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		killed: false,
		kill: vi.fn(() => true),
		ref() {},
		unref() {},
	});
}

let child: ReturnType<typeof fixtureProcess>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
	vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
	child = fixtureProcess();
	mocks.resetContainment();
	vi.mocked(spawnHostProcess).mockReturnValue(child);
	vi.mocked(killChildProcessTree).mockReset();
	vi.mocked(killProcessTree).mockReset();
	vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
		if (signal === 0) throw Object.assign(new Error("process group exited"), { code: "ESRCH" });
		return true;
	});
});

afterEach(() => {
	vi.clearAllTimers();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function firstTimerFiresEarly(): void {
	const schedule = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementationOnce((callback) => schedule(callback, 99));
}

function terminationCount(): number {
	return (
		vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0).length +
		vi.mocked(killChildProcessTree).mock.calls.length +
		vi.mocked(killProcessTree).mock.calls.length +
		child.kill.mock.calls.length
	);
}

function finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
	child.exitCode = code;
	child.signalCode = signal;
	child.emit("exit", code, signal);
	child.emit("close", code, signal);
}

function run(timeoutMs = 100, signal?: AbortSignal) {
	return Promise.allSettled([
		runWorkspaceProcess({
			path: "fixture-git",
			args: [],
			cwd: process.cwd(),
			env: {},
			timeoutMs,
			signal,
			timeoutError: (elapsedMs) =>
				new WorkspaceTimeoutError({ phase: "clone", timeoutMs, elapsedMs, command: "git clone" }),
		}),
	]);
}

test("a workspace command keeps its whole timeout budget when its timer fires early (#5332)", async () => {
	firstTimerFiresEarly();
	const outcome = run();
	await vi.advanceTimersByTimeAsync(99);
	assert.equal(terminationCount(), 0, "an early timer must not stop the command");
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(terminationCount(), 1);
	finish(null, "SIGTERM");
	const [settled] = await outcome;
	assert.equal(settled.status, "rejected");
	assert.ok(settled.reason instanceof WorkspaceTimeoutError);
	assert.equal(settled.reason.elapsedMs, 100);
});

test("a late workspace timeout reports its actual monotonic duration rounded up to milliseconds (#5332)", async () => {
	const outcome = run();
	vi.spyOn(performance, "now").mockReturnValue(150.25);
	await vi.advanceTimersByTimeAsync(100);
	assert.equal(terminationCount(), 1);
	finish(null, "SIGTERM");
	const [settled] = await outcome;
	assert.equal(settled.status, "rejected");
	assert.ok(settled.reason instanceof WorkspaceTimeoutError);
	assert.equal(settled.reason.elapsedMs, 151);
	assert.match(settled.reason.message, /ran 151ms/u);
});

test("workspace timeouts larger than a native timer delay keep their full budget (#5332)", async () => {
	const nativeTimerLimitMs = 2_147_483_647;
	const timeoutMs = nativeTimerLimitMs + 100;
	const outcome = run(timeoutMs);
	await vi.advanceTimersByTimeAsync(100);
	assert.equal(terminationCount(), 0, "an overflowing timer delay must not stop the command");
	await vi.advanceTimersByTimeAsync(nativeTimerLimitMs - 100);
	assert.equal(terminationCount(), 0);
	await vi.advanceTimersByTimeAsync(99);
	assert.equal(terminationCount(), 0);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(terminationCount(), 1);
	finish(null, "SIGTERM");
	const [settled] = await outcome;
	assert.equal(settled.status, "rejected");
	assert.ok(settled.reason instanceof WorkspaceTimeoutError);
	assert.equal(settled.reason.elapsedMs, timeoutMs);
});

test("workspace timeouts beyond twice the native timer delay do not busy-loop (#5332)", async () => {
	const nativeTimerLimitMs = 2_147_483_647;
	const timeoutMs = 2 * nativeTimerLimitMs + 100;
	const maximumCallbacks = Math.ceil(timeoutMs / nativeTimerLimitMs);
	const schedule = globalThis.setTimeout;
	let callbacks = 0;
	vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay) =>
		schedule(() => {
			assert.ok(++callbacks <= maximumCallbacks, "a long timeout must not repeatedly overflow into 1 ms timers");
			callback();
		}, delay),
	);
	const outcome = run(timeoutMs);
	await vi.advanceTimersByTimeAsync(timeoutMs - 1);
	assert.equal(terminationCount(), 0);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(terminationCount(), 1);
	finish(null, "SIGTERM");
	const [settled] = await outcome;
	assert.equal(settled.status, "rejected");
	assert.ok(settled.reason instanceof WorkspaceTimeoutError);
	assert.equal(settled.reason.elapsedMs, timeoutMs);
	assert.equal(vi.getTimerCount(), 0);
});

for (const wallClockJumpMs of [-60_000, 60_000]) {
	test(`workspace timeout elapsed time ignores a wall clock jump of ${wallClockJumpMs} ms (#5332)`, async () => {
		const outcome = run();
		vi.setSystemTime(Date.now() + wallClockJumpMs);
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(terminationCount(), 1);
		finish(null, "SIGTERM");
		const [settled] = await outcome;
		assert.equal(settled.status, "rejected");
		assert.ok(settled.reason instanceof WorkspaceTimeoutError);
		assert.equal(settled.reason.elapsedMs, 100);
	});
}

for (const cancel of [false, true]) {
	test(`${cancel ? "cancelling" : "exiting"} a workspace command clears a timeout rescheduled after an early callback (#5332)`, async () => {
		firstTimerFiresEarly();
		const controller = new AbortController();
		const reason = new Error("cancelled before the deadline");
		const outcome = run(100, controller.signal);
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(terminationCount(), 0);
		if (cancel) {
			controller.abort(reason);
			assert.equal(terminationCount(), 1);
			finish(null, "SIGTERM");
		} else {
			finish();
		}
		const [settled] = await outcome;
		if (cancel) {
			assert.equal(settled.status, "rejected");
			assert.equal(settled.reason, reason);
		} else {
			assert.equal(settled.status, "fulfilled");
			assert.deepEqual(settled.value, { kind: "exited", stdout: "", stderr: "", status: 0 });
		}
		assert.equal(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(10_000);
		assert.equal(terminationCount(), cancel ? 1 : 0, "a settled command must never be terminated later");
	});
}

describe("Windows process-tree containment timeouts (#5332)", () => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	let runWindowsWorkspaceProcess: typeof runWorkspaceProcess;

	beforeAll(async () => {
		vi.resetModules();
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		try {
			({ runWorkspaceProcess: runWindowsWorkspaceProcess } = await import("../src/core/workspace/process.ts"));
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	afterAll(() => {
		Object.defineProperty(process, "platform", platformDescriptor);
	});

	function runWindows(timeoutMs = 100, signal?: AbortSignal) {
		return Promise.allSettled([
			runWindowsWorkspaceProcess({
				path: "fixture-git",
				args: [],
				cwd: process.cwd(),
				env: {},
				timeoutMs,
				signal,
				timeoutError: (elapsedMs) =>
					new WorkspaceTimeoutError({ phase: "clone", timeoutMs, elapsedMs, command: "git clone" }),
			}),
		]);
	}

	test("a Windows workspace command without native containment falls back to killChildProcessTree at the deadline (#5332)", async () => {
		mocks.jobAttached = false;
		mocks.holdResult = "unavailable";
		firstTimerFiresEarly();
		const outcome = runWindows();
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(terminationCount(), 0, "an early timer must not stop the command");
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(vi.mocked(killChildProcessTree).mock.calls.length, 1);
		assert.deepEqual(vi.mocked(killChildProcessTree).mock.calls[0], [child, false]);
		assert.equal(terminationCount(), 1);
		finish(null, "SIGTERM");
		const [settled] = await outcome;
		assert.equal(settled.status, "rejected");
		assert.ok(settled.reason instanceof WorkspaceTimeoutError);
		assert.equal(settled.reason.elapsedMs, 100);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a Windows workspace command with Job-object containment keeps its full timeout budget when its timer fires early (#5332)", async () => {
		mocks.jobAttached = true;
		mocks.holdResult = "held";
		mocks.treeActive = 1;
		firstTimerFiresEarly();
		const outcome = runWindows();
		assert.deepEqual(mocks.containCalls, [child.pid]);
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(mocks.holdEndAllCalls, 0, "an early timer must not end held descendants");
		assert.equal(mocks.treeTerminateCalls, 0, "an early timer must not terminate the Job object");
		assert.equal(terminationCount(), 0);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(mocks.holdEndAllCalls, 1);
		assert.equal(mocks.treeTerminateCalls, 1);
		assert.equal(terminationCount(), 0, "native containment handles termination without fallback kills");
		finish(null, "SIGTERM");
		const [settled] = await outcome;
		assert.equal(settled.status, "rejected");
		assert.ok(settled.reason instanceof WorkspaceTimeoutError);
		assert.equal(settled.reason.elapsedMs, 100);
		assert.equal(mocks.treeReleaseCalls, 0);
		assert.equal(mocks.treeCloseCalls, 1);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("exiting a Windows workspace command after an early timer releases its Job object without terminating it (#5332)", async () => {
		mocks.jobAttached = true;
		mocks.holdResult = "held";
		firstTimerFiresEarly();
		const outcome = runWindows();
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(mocks.holdEndAllCalls, 0);
		assert.equal(mocks.treeTerminateCalls, 0);
		finish();
		const [settled] = await outcome;
		assert.equal(settled.status, "fulfilled");
		assert.deepEqual(settled.value, { kind: "exited", stdout: "", stderr: "", status: 0 });
		assert.equal(mocks.treeReleaseCalls, 1);
		assert.equal(mocks.treeCloseCalls, 1);
		assert.equal(mocks.treeTerminateCalls, 0);
		assert.equal(mocks.holdEndAllCalls, 0);
		assert.equal(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(10_000);
		assert.equal(mocks.treeTerminateCalls, 0);
		assert.equal(mocks.holdEndAllCalls, 0);
	});

	test("cancelling a Windows workspace command after an early timer terminates its Job object once and clears timers (#5332)", async () => {
		mocks.jobAttached = true;
		mocks.holdResult = "held";
		firstTimerFiresEarly();
		const controller = new AbortController();
		const reason = new Error("cancelled before the deadline");
		const outcome = runWindows(100, controller.signal);
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(mocks.holdEndAllCalls, 0);
		assert.equal(mocks.treeTerminateCalls, 0);
		controller.abort(reason);
		assert.equal(mocks.holdEndAllCalls, 1);
		assert.equal(mocks.treeTerminateCalls, 1);
		finish(null, "SIGTERM");
		const [settled] = await outcome;
		assert.equal(settled.status, "rejected");
		assert.equal(settled.reason, reason);
		assert.equal(mocks.treeReleaseCalls, 0);
		assert.equal(mocks.treeCloseCalls, 1);
		assert.equal(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(10_000);
		assert.equal(mocks.holdEndAllCalls, 1);
		assert.equal(mocks.treeTerminateCalls, 1);
	});

	test("a Windows workspace command without a Job object stops via native hold without fallback kills (#5332)", async () => {
		mocks.jobAttached = false;
		mocks.holdResult = "held";
		firstTimerFiresEarly();
		const outcome = runWindows();
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(mocks.holdEndAllCalls, 0);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(mocks.holdEndAllCalls, 1);
		assert.equal(terminationCount(), 0);
		finish(null, "SIGTERM");
		const [settled] = await outcome;
		assert.equal(settled.status, "rejected");
		assert.ok(settled.reason instanceof WorkspaceTimeoutError);
		assert.equal(settled.reason.elapsedMs, 100);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a Windows workspace command falls back to child.kill when native hold reports absent without a Job (#5332)", async () => {
		mocks.jobAttached = false;
		mocks.holdResult = "absent";
		firstTimerFiresEarly();
		const outcome = runWindows();
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(terminationCount(), 0);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(child.kill.mock.calls.length, 1);
		assert.deepEqual(child.kill.mock.calls[0], ["SIGKILL"]);
		assert.equal(vi.mocked(killProcessTree).mock.calls.length, 0);
		finish(null, "SIGTERM");
		const [settled] = await outcome;
		assert.equal(settled.status, "rejected");
		assert.ok(settled.reason instanceof WorkspaceTimeoutError);
		assert.equal(settled.reason.elapsedMs, 100);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a Windows workspace command with a Job object stops via Job termination even when native hold reports absent (#5332)", async () => {
		mocks.jobAttached = true;
		mocks.holdResult = "absent";
		mocks.treeActive = 1;
		firstTimerFiresEarly();
		const outcome = runWindows();
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(mocks.treeTerminateCalls, 0);
		assert.equal(terminationCount(), 0);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(mocks.treeTerminateCalls, 1);
		assert.equal(terminationCount(), 0, "Job termination must not fall back to child.kill or killProcessTree");
		finish(null, "SIGTERM");
		const [settled] = await outcome;
		assert.equal(settled.status, "rejected");
		assert.ok(settled.reason instanceof WorkspaceTimeoutError);
		assert.equal(settled.reason.elapsedMs, 100);
		assert.equal(mocks.treeReleaseCalls, 0);
		assert.equal(mocks.treeCloseCalls, 1);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a stopped Windows workspace command polls until its Job object drains before settling (#5332)", async () => {
		mocks.jobAttached = true;
		mocks.holdResult = "held";
		mocks.keepTreeActiveOnTerminate = true;
		mocks.treeActive = 1;
		const outcome = runWindows();
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(mocks.treeTerminateCalls, 1);
		finish(null, "SIGTERM");
		await vi.advanceTimersByTimeAsync(10);
		assert.equal(mocks.treeCloseCalls, 0, "must not settle while Job object still reports active processes");
		mocks.treeActive = 0;
		await vi.advanceTimersByTimeAsync(5);
		const [settled] = await outcome;
		assert.equal(settled.status, "rejected");
		assert.ok(settled.reason instanceof WorkspaceTimeoutError);
		assert.equal(settled.reason.elapsedMs, 100);
		assert.equal(mocks.treeCloseCalls, 1);
		assert.equal(vi.getTimerCount(), 0);
	});
});
