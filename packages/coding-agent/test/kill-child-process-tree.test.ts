import assert from "node:assert/strict";
import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

/** Each taskkill the tree kill starts, and how it ends: it runs and exits, or it cannot start. */
const taskkill = vi.hoisted(() => ({
	runs: [] as string[][],
	ends: "exit" as "exit" | "error",
	onExit: undefined as (() => void) | undefined,
	nativeMode: "unavailable" as "unavailable" | "held" | "absent",
	nativeHoldCalls: [] as number[],
	nativeEnded: 0,
}));

vi.mock("../src/core/process-tree-containment.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/process-tree-containment.ts")>();
	return {
		...actual,
		holdProcessDescendantsResult: (pid: number) => {
			taskkill.nativeHoldCalls.push(pid);
			if (taskkill.nativeMode === "held") {
				return {
					kind: "held" as const,
					held: {
						count: 1,
						endAll: () => {
							taskkill.nativeEnded++;
							return true;
						},
						release: () => {},
					},
				};
			}
			if (taskkill.nativeMode === "absent") return { kind: "absent" as const };
			return { kind: "unavailable" as const };
		},
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	const spawn = ((command: string, args: readonly string[], options: object) => {
		if (!String(command).toLowerCase().endsWith("taskkill.exe")) return actual.spawn(command, [...args], options);
		taskkill.runs.push([...args]);
		const run = new EventEmitter();
		queueMicrotask(() => {
			if (taskkill.ends === "error") run.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
			else {
				taskkill.onExit?.();
				run.emit("exit", 0, null);
			}
		});
		return run;
	}) as typeof actual.spawn;
	return { ...actual, spawn };
});

const { killChildProcessTree } = await import("../src/utils/shell.js");

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const ROOT_PID = 424_242;

interface FakeChild {
	readonly pid: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	readonly kill: ReturnType<typeof vi.fn>;
}

function child(exitCode: number | null): FakeChild {
	return { pid: ROOT_PID, exitCode, signalCode: null, kill: vi.fn(() => true) };
}

function onPlatform(name: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { configurable: true, value: name });
}

/** The signals sent by pid, without delivering any: the pids are made up. */
function recordSignals(): Array<[number, string | number | undefined]> {
	const sent: Array<[number, string | number | undefined]> = [];
	vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
		sent.push([pid, signal]);
		throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
	});
	return sent;
}

beforeEach(() => {
	taskkill.runs.length = 0;
	taskkill.ends = "exit";
	taskkill.onExit = undefined;
	taskkill.nativeMode = "unavailable";
	taskkill.nativeHoldCalls.length = 0;
	taskkill.nativeEnded = 0;
});

afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	vi.restoreAllMocks();
});

describe("stopping a child's process tree without a Job object (#5377)", () => {
	test("on POSIX, a root whose exit was reported is never signalled by its pid alone, only its process group", () => {
		onPlatform("linux");
		const sent = recordSignals();
		const exited = child(0);

		killChildProcessTree(exited as unknown as ChildProcess, true);

		assert.deepEqual(sent, [[-ROOT_PID, "SIGKILL"]], "a reaped pid may already name another process");
		assert.equal(exited.kill.mock.calls.length, 0);
	});

	test("on POSIX, a running root's process group and the root itself are killed", () => {
		onPlatform("linux");
		const sent = recordSignals();
		const running = child(null);

		killChildProcessTree(running as unknown as ChildProcess, false);

		assert.deepEqual(sent[0], [-ROOT_PID, "SIGKILL"]);
		assert.deepEqual(running.kill.mock.calls, [["SIGKILL"]]);
	});

	test("on Windows, a running root is stopped through its handle when taskkill cannot run", async () => {
		onPlatform("win32");
		taskkill.ends = "error";
		const running = child(null);

		killChildProcessTree(running as unknown as ChildProcess, false);

		assert.deepEqual(taskkill.runs, [["/F", "/T", "/PID", String(ROOT_PID)]]);
		await vi.waitFor(() => assert.equal(running.kill.mock.calls.length, 1, "the root is ended through its handle"));
	});

	test("on Windows, a root taskkill ended is not killed again", async () => {
		onPlatform("win32");
		const running = child(null);
		taskkill.onExit = () => {
			running.exitCode = 1;
		};

		killChildProcessTree(running as unknown as ChildProcess, false);

		await vi.waitFor(() => assert.equal(taskkill.runs.length, 1));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(running.kill.mock.calls.length, 0);
	});

	test("on Windows, nothing is killed by pid once the root's exit was reported", async () => {
		onPlatform("win32");
		const exited = child(0);

		killChildProcessTree(exited as unknown as ChildProcess, true);
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(taskkill.runs, [], "the pid may already name another process");
		assert.equal(exited.kill.mock.calls.length, 0);
	});

	test("on Windows, with the native module available, a running root is ended via holdProcessDescendants without taskkill", async () => {
		onPlatform("win32");
		taskkill.nativeMode = "held";
		const running = child(null);

		killChildProcessTree(running as unknown as ChildProcess, false);
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(taskkill.nativeHoldCalls, [ROOT_PID]);
		assert.equal(taskkill.nativeEnded, 1);
		assert.deepEqual(taskkill.runs, []);
		assert.equal(running.kill.mock.calls.length, 0);
	});

	test.each(["linux", "win32"] as const)(
		"on %s, a child that never started has nothing to kill, and stopping it does not throw (#5601)",
		async (name) => {
			onPlatform(name);
			const sent = recordSignals();
			// Node gives a child whose spawn failed no pid; on Windows its kill() then throws EINVAL.
			const neverStarted = {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				kill: vi.fn(() => {
					throw Object.assign(new Error("kill EINVAL"), { code: "EINVAL", syscall: "kill" });
				}),
			};

			assert.doesNotThrow(() => killChildProcessTree(neverStarted as unknown as ChildProcess, false));
			await new Promise((resolve) => setImmediate(resolve));

			assert.deepEqual(sent, []);
			assert.deepEqual(taskkill.runs, []);
			assert.equal(neverStarted.kill.mock.calls.length, 0);
		},
	);
});
