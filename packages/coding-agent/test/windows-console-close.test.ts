import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.ts";
import { ENGINE_SHUTDOWN_GRACE_MS } from "../src/modes/rpc/rpc-client-process.js";

// Windows reports the closing of the console window as SIGHUP, and ends the process about five seconds later. The
// session then shuts down as it does when its terminal is gone, within a bound that ends first, and Atomic exits with
// the status Windows gives a process its console's close ended.

/** STATUS_CONTROL_C_EXIT: the status Windows gives a process it ends when its console is closed. */
const CONSOLE_CLOSED_EXIT_CODE = 0xc000013a;
/** How long Windows lets a process run after its console was closed. */
const WINDOWS_CONSOLE_CLOSE_TIMEOUT_MS = 5_000;
/** What Atomic leaves of that timeout for its own exit. */
const OWN_EXIT_MS = 1_000;
/** The longest a session whose terminal is gone may take to shut down (#6104): past it, Atomic ends anyway. */
const TERMINAL_LOST_SHUTDOWN_MS = ENGINE_SHUTDOWN_GRACE_MS + 1_000;
/** The lost terminal's exit status (#6104). */
const TERMINAL_LOST_EXIT_CODE = 129;
/**
 * The turns of the event loop Atomic gives a console-close notice it already received but has not read yet, before it
 * exits at the lost terminal's bound: Windows' own is read in the first, the engine's line is parsed in the second.
 * Fake timers run each turn a millisecond apart.
 */
const PENDING_NOTICE_TURNS_MS = 2;

interface Context {
	isShuttingDown: boolean;
	signalCleanupHandlers: Array<() => void>;
	chatContainer: undefined;
	writeExitOutputInSlices: boolean;
	exitOutputWritten: Promise<void> | undefined;
	sessionManager: {
		isPersisted(): boolean;
		getSessionFile(): string | undefined;
		getSessionStore?(): { descriptor: { adapter: string } };
		getSessionDir?(): string;
		getSessionId?(): string;
	};
	runtimeHost: { dispose: (options?: { fromSignal?: boolean }) => Promise<void> };
	ui: { terminal: { drainInput: () => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
	shutdown: (options?: { fromSignal?: boolean }) => Promise<void>;
	handleTerminalLost: () => void;
	emergencyTerminalExit: () => never;
	unregisterSignalHandlers: () => void;
}

interface Prototype {
	registerSignalHandlers(this: Context): void;
	unregisterSignalHandlers(this: Context): void;
	shutdown(this: Context, options?: { fromSignal?: boolean }): Promise<void>;
	handleTerminalLost(this: Context): void;
	emergencyTerminalExit(this: Context): never;
}

const prototype = InteractiveMode.prototype as unknown as Prototype;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

class ProcessExit extends Error {
	constructor(readonly code: number | string | null | undefined) {
		super(`exit ${code}`);
	}
}

const exits: Array<number | string | null | undefined> = [];
let contexts: Context[] = [];

/** An interactive host on Windows whose session's shutdown settles when `dispose` does. */
function createWindowsHost(
	dispose: () => Promise<void>,
	runtime?: IsolatedInteractiveRuntime,
): { context: Context; closeConsole: () => void } {
	const context: Context = {
		isShuttingDown: false,
		signalCleanupHandlers: [],
		chatContainer: undefined,
		writeExitOutputInSlices: false,
		exitOutputWritten: undefined,
		sessionManager: { isPersisted: () => false, getSessionFile: () => undefined },
		runtimeHost: runtime ? Object.assign(runtime, { dispose: vi.fn(dispose) }) : { dispose: vi.fn(dispose) },
		ui: { terminal: { drainInput: vi.fn(async () => {}) } },
		themeController: { disableAutoSync: vi.fn() },
		// As the interactive mode's stop does.
		stop: vi.fn(() => context.unregisterSignalHandlers()),
		// The shutdown ends in process.exit, which these tests turn into a rejection.
		shutdown: (options) =>
			prototype.shutdown.call(context, options).catch((error: unknown) => {
				if (!(error instanceof ProcessExit)) throw error;
			}),
		handleTerminalLost: () => prototype.handleTerminalLost.call(context),
		emergencyTerminalExit: () => prototype.emergencyTerminalExit.call(context),
		unregisterSignalHandlers: () => prototype.unregisterSignalHandlers.call(context),
	};
	contexts.push(context);
	const others = process.listeners("SIGHUP");
	// Windows for the rest of the test; afterEach restores the platform.
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	prototype.registerSignalHandlers.call(context);
	/** Atomic's console-close listener as it is registered now. */
	const listener = (): NodeJS.SignalsListener => {
		const own = process.listeners("SIGHUP").filter((candidate) => !others.includes(candidate));
		assert.equal(own.length, 1, "Atomic listens for the console's close on Windows");
		return own[0]!;
	};
	listener();
	return { context, closeConsole: () => listener()("SIGHUP") };
}

function deadTerminal(): NodeJS.ErrnoException {
	return Object.assign(new Error("write EIO"), { code: "EIO", syscall: "write" });
}

/** Let the shutdown's promise reactions run. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(process, "exit").mockImplementation(((code) => {
		exits.push(code);
		throw new ProcessExit(code);
	}) as typeof process.exit);
});

afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	for (const context of contexts) context.unregisterSignalHandlers();
	contexts = [];
	exits.length = 0;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("closing the Windows console", () => {
	test("shuts the session down as a signal does, restores nothing, and exits with STATUS_CONTROL_C_EXIT", async () => {
		const disposed = Promise.withResolvers<void>();
		const { context, closeConsole } = createWindowsHost(() => disposed.promise);

		closeConsole();
		await settle();

		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[{ fromSignal: true }]]);
		assert.deepEqual(exits, [], "Atomic does not exit before the session has shut down");

		disposed.resolve();
		await settle();

		assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
		assert.equal(vi.mocked(context.stop).mock.calls.length, 0, "the console is not restored");
		assert.equal(vi.mocked(context.ui.terminal.drainInput).mock.calls.length, 0);
	});

	test("a shutdown still running before Windows would end the process is cut short", async () => {
		const { context, closeConsole } = createWindowsHost(() => new Promise<void>(() => {}));
		const bound = WINDOWS_CONSOLE_CLOSE_TIMEOUT_MS - OWN_EXIT_MS;

		closeConsole();
		await settle();
		await vi.advanceTimersByTimeAsync(bound - 1);
		assert.deepEqual(exits, []);

		await assert.rejects(vi.advanceTimersByTimeAsync(1), ProcessExit);
		assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
		assert.equal(context.isShuttingDown, true);
	});

	test("an engine that says the console was closed shuts the session down as the close does", async () => {
		// The engine shares the console and hears of its close first; the host hears of it only once the engine is gone.
		const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
		const runtime = Object.assign(Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime, {
			getReadyEngineChildPid: () => undefined,
			onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
				engineListeners.push(listener);
				return () => engineListeners.splice(engineListeners.indexOf(listener), 1);
			},
		});
		const disposed = Promise.withResolvers<void>();
		const { context, closeConsole } = createWindowsHost(() => disposed.promise, runtime);

		for (const listener of [...engineListeners]) listener({ type: "engine_console_closed" });
		await settle();
		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[{ fromSignal: true }]]);
		assert.deepEqual(exits, [], "Atomic does not exit before the session has shut down");

		// Windows then tells the host itself, once the engine is gone.
		closeConsole();
		disposed.resolve();
		await settle();
		assert.equal(vi.mocked(context.runtimeHost.dispose).mock.calls.length, 1);
		assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
		assert.equal(vi.mocked(context.stop).mock.calls.length, 0, "the console is not restored");
	});

	test("a close after a failed write shortens the bound and sets the status", async () => {
		const { closeConsole } = createWindowsHost(() => new Promise<void>(() => {}));
		const bound = WINDOWS_CONSOLE_CLOSE_TIMEOUT_MS - OWN_EXIT_MS;

		process.stdout.emit("error", deadTerminal());
		await settle();
		await vi.advanceTimersByTimeAsync(500);
		closeConsole();
		await vi.advanceTimersByTimeAsync(bound - 1);
		assert.deepEqual(exits, []);

		await assert.rejects(vi.advanceTimersByTimeAsync(1), ProcessExit);
		assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
	});

	test("a failed write after the close shuts the session down once", async () => {
		const disposed = Promise.withResolvers<void>();
		const { context, closeConsole } = createWindowsHost(() => disposed.promise);

		closeConsole();
		process.stdout.emit("error", deadTerminal());
		closeConsole();
		await settle();
		assert.equal(vi.mocked(context.runtimeHost.dispose).mock.calls.length, 1);

		disposed.resolve();
		await settle();
		assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
	});

	test("a close during a quit lets the quit finish and exits with STATUS_CONTROL_C_EXIT", async () => {
		const disposed = Promise.withResolvers<void>();
		const { context, closeConsole } = createWindowsHost(() => disposed.promise);

		const quitting = context.shutdown();
		await settle();
		closeConsole();
		await settle();
		assert.deepEqual(exits, []);

		disposed.resolve();
		await quitting;
		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[]], "the quit's own disposal ran, once");
		assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
	});

	test("a close while a quit drains the keyboard's input leaves the console unrestored", async () => {
		const { context, closeConsole } = createWindowsHost(async () => {});
		vi.mocked(context.ui.terminal.drainInput).mockImplementation(async () => closeConsole());

		await context.shutdown();

		assert.equal(vi.mocked(context.stop).mock.calls.length, 0, "the closed console is not restored");
		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[]], "the quit's own disposal ran, once");
		assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
	});

	test("a close while a signalled shutdown drains the keyboard's input leaves the console unrestored", async () => {
		const { context, closeConsole } = createWindowsHost(async () => {});
		vi.mocked(context.ui.terminal.drainInput).mockImplementation(async () => closeConsole());

		await context.shutdown({ fromSignal: true });

		assert.equal(vi.mocked(context.stop).mock.calls.length, 0, "the closed console is not restored");
		assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
	});

	test("a close while the quit looks up its resume hint writes no hint and exits with STATUS_CONTROL_C_EXIT", async () => {
		const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const { context, closeConsole } = createWindowsHost(async () => {});
			context.sessionManager = {
				isPersisted: () => true,
				getSessionFile: () => {
					closeConsole();
					return tmpdir();
				},
				getSessionStore: () => ({ descriptor: { adapter: "jsonl" } }),
				getSessionDir: () => tmpdir(),
				getSessionId: () => "session",
			};

			await context.shutdown();

			assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
			assert.deepEqual(write.mock.calls, [], "nothing is written to the closed console");
		} finally {
			if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});
});

describe("a console Atomic finds gone before Windows says it closed", () => {
	// Windows tells the console's processes one at a time, newest first: the engine, then the host once the engine is
	// gone. The host can find its console gone first, from its input's end or a failed write. That alone does not prove
	// the console was closed: only Windows' notice, to the host or to its engine, does.
	const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
	});
	afterEach(() => {
		if (stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
		else Reflect.deleteProperty(process.stdin, "isTTY");
	});

	for (const [loss, lose] of [
		["its input ends", () => process.stdin.emit("end")],
		["a write finds it gone", () => process.stdout.emit("error", deadTerminal())],
	] as const) {
		test(`when ${loss} and no close notice comes, Atomic exits as a lost terminal does, with 129`, async () => {
			const disposed = Promise.withResolvers<void>();
			const { context } = createWindowsHost(() => disposed.promise);

			lose();
			await settle();
			assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[{ fromSignal: true }]]);
			assert.deepEqual(exits, [], "Atomic does not exit before the session has shut down");

			disposed.resolve();
			await settle();
			assert.deepEqual(exits, [TERMINAL_LOST_EXIT_CODE]);
			assert.equal(vi.mocked(context.stop).mock.calls.length, 0, "the terminal is not restored");
		});

		test(`when ${loss} and no close notice comes, a shutdown that does not end is cut short at the lost terminal's bound`, async () => {
			createWindowsHost(() => new Promise<void>(() => {}));

			lose();
			await settle();
			await vi.advanceTimersByTimeAsync(TERMINAL_LOST_SHUTDOWN_MS - 1);
			assert.deepEqual(exits, []);
			await assert.rejects(vi.advanceTimersByTimeAsync(1 + PENDING_NOTICE_TURNS_MS), ProcessExit);
			assert.deepEqual(exits, [TERMINAL_LOST_EXIT_CODE]);
		});

		test(`when ${loss} and then Windows says the console closed, Atomic exits with STATUS_CONTROL_C_EXIT within the close's bound`, async () => {
			const { closeConsole } = createWindowsHost(() => new Promise<void>(() => {}));
			const bound = WINDOWS_CONSOLE_CLOSE_TIMEOUT_MS - OWN_EXIT_MS;
			const noticeAfterMs = 500;

			lose();
			await settle();
			await vi.advanceTimersByTimeAsync(noticeAfterMs);
			closeConsole();
			await vi.advanceTimersByTimeAsync(bound - 1);
			assert.deepEqual(exits, []);
			await assert.rejects(vi.advanceTimersByTimeAsync(1), ProcessExit);
			assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
		});

		test(`when ${loss} and Windows says the console closed only late, Atomic still exits at the lost terminal's bound, with STATUS_CONTROL_C_EXIT`, async () => {
			const { closeConsole } = createWindowsHost(() => new Promise<void>(() => {}));

			lose();
			await settle();
			await vi.advanceTimersByTimeAsync(TERMINAL_LOST_SHUTDOWN_MS - 1_000);
			closeConsole();
			await vi.advanceTimersByTimeAsync(1_000 - 1);
			assert.deepEqual(exits, []);
			await assert.rejects(vi.advanceTimersByTimeAsync(1), ProcessExit);
			assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
		});

		// A host too busy to run its timers on time can find the lost terminal's bound run out with a close notice already
		// received but not yet read: it is read in the same turn, after the bound's timer.
		test(`when ${loss}, Windows' notice received but not yet read when the lost terminal's bound runs out still decides the status`, async () => {
			const { closeConsole } = createWindowsHost(() => new Promise<void>(() => {}));

			lose();
			await settle();
			await vi.advanceTimersByTimeAsync(TERMINAL_LOST_SHUTDOWN_MS - 1);
			assert.deepEqual(exits, []);
			// Scheduled after the bound's timer, for the same moment: it runs in the same turn, after that timer.
			setTimeout(closeConsole, 1);
			await assert.rejects(vi.advanceTimersByTimeAsync(1 + PENDING_NOTICE_TURNS_MS), ProcessExit);
			assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
		});

		test(`when ${loss}, the engine's notice received but not yet read when the lost terminal's bound runs out still decides the status`, async () => {
			const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
			const runtime = Object.assign(
				Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime,
				{
					getReadyEngineChildPid: () => undefined,
					onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
						engineListeners.push(listener);
						return () => engineListeners.splice(engineListeners.indexOf(listener), 1);
					},
				},
			);
			createWindowsHost(() => new Promise<void>(() => {}), runtime);

			lose();
			await settle();
			await vi.advanceTimersByTimeAsync(TERMINAL_LOST_SHUTDOWN_MS - 1);
			assert.deepEqual(exits, []);
			// The engine's line is read in the same turn as the bound's timer, after it, and its reader parses the lines it
			// read in a turn of their own.
			setTimeout(
				() =>
					setImmediate(() => {
						for (const listener of [...engineListeners]) listener({ type: "engine_console_closed" });
					}),
				1,
			);
			await assert.rejects(vi.advanceTimersByTimeAsync(1 + PENDING_NOTICE_TURNS_MS), ProcessExit);
			assert.deepEqual(exits, [CONSOLE_CLOSED_EXIT_CODE]);
		});
	}
});

describe("on Linux and macOS", () => {
	test.skipIf(process.platform === "win32")("a lost terminal still exits with 129", async () => {
		const disposed = Promise.withResolvers<void>();
		const context: Context = {
			isShuttingDown: false,
			signalCleanupHandlers: [],
			chatContainer: undefined,
			writeExitOutputInSlices: false,
			exitOutputWritten: undefined,
			sessionManager: { isPersisted: () => false, getSessionFile: () => undefined },
			runtimeHost: { dispose: vi.fn(() => disposed.promise) },
			ui: { terminal: { drainInput: vi.fn(async () => {}) } },
			themeController: { disableAutoSync: vi.fn() },
			stop: vi.fn(),
			shutdown: (options) =>
				prototype.shutdown.call(context, options).catch((error: unknown) => {
					if (!(error instanceof ProcessExit)) throw error;
				}),
			handleTerminalLost: () => prototype.handleTerminalLost.call(context),
			emergencyTerminalExit: () => prototype.emergencyTerminalExit.call(context),
			unregisterSignalHandlers: () => prototype.unregisterSignalHandlers.call(context),
		};
		contexts.push(context);
		prototype.registerSignalHandlers.call(context);

		process.stdout.emit("error", deadTerminal());
		disposed.resolve();
		await settle();
		assert.deepEqual(exits, [129]);
	});
});
