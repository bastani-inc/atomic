import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { ENGINE_SHUTDOWN_GRACE_MS } from "../../../src/modes/rpc/rpc-client-process.ts";

// A closing terminal sends SIGHUP and fails the next write to it with EIO, in either order. Neither ends the session
// before its shutdown has run: the session shuts down as on SIGHUP, restores nothing, and Atomic exits with 129.

/** The longest a session whose terminal is gone may take to shut down: past it, Atomic ends anyway. */
const TERMINAL_LOST_SHUTDOWN_MS = ENGINE_SHUTDOWN_GRACE_MS + 1_000;

interface Context {
	isShuttingDown: boolean;
	hostSignals: number;
	terminalLost: boolean;
	terminalLoss: PromiseWithResolvers<void>;
	signalCleanupHandlers: Array<() => void>;
	chatContainer: undefined;
	writeExitOutputInSlices: boolean;
	exitOutputWritten: Promise<void> | undefined;
	sessionManager: { isPersisted(): boolean; getSessionFile(): string | undefined };
	runtimeHost: { dispose: (options?: { fromSignal?: boolean }) => Promise<void> };
	ui: { terminal: { drainInput: () => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
	shutdown: (options?: { fromSignal?: boolean }) => Promise<void>;
	handleTerminalLost: () => void;
	emergencyTerminalExit: () => never;
	uncaughtCrash: (error: Error) => never;
	unregisterSignalHandlers: () => void;
	getCrashExtensionHint: () => string | undefined;
}

interface Prototype {
	registerSignalHandlers(this: Context): void;
	unregisterSignalHandlers(this: Context): void;
	shutdown(this: Context, options?: { fromSignal?: boolean }): Promise<void>;
	handleTerminalLost(this: Context): void;
	emergencyTerminalExit(this: Context): never;
	uncaughtCrash(this: Context, error: Error): never;
}

const prototype = InteractiveMode.prototype as unknown as Prototype;

class ProcessExit extends Error {
	constructor(readonly code: number | string | null | undefined) {
		super(`exit ${code}`);
	}
}

const exits: Array<number | string | null | undefined> = [];
let contexts: Context[] = [];

function createContext(dispose: () => Promise<void>): Context {
	const context: Context = {
		isShuttingDown: false,
		hostSignals: 0,
		terminalLost: false,
		terminalLoss: Promise.withResolvers<void>(),
		signalCleanupHandlers: [],
		chatContainer: undefined,
		writeExitOutputInSlices: false,
		exitOutputWritten: undefined,
		sessionManager: { isPersisted: () => false, getSessionFile: () => undefined },
		runtimeHost: { dispose: vi.fn(dispose) },
		ui: { terminal: { drainInput: vi.fn(async () => {}) } },
		themeController: { disableAutoSync: vi.fn() },
		stop: vi.fn(),
		// The shutdown ends in process.exit, which these tests turn into a rejection.
		shutdown: (options) =>
			prototype.shutdown.call(context, options).catch((error: unknown) => {
				if (!(error instanceof ProcessExit)) throw error;
			}),
		handleTerminalLost: () => prototype.handleTerminalLost.call(context),
		emergencyTerminalExit: () => prototype.emergencyTerminalExit.call(context),
		uncaughtCrash: (error) => prototype.uncaughtCrash.call(context, error),
		unregisterSignalHandlers: () => prototype.unregisterSignalHandlers.call(context),
		getCrashExtensionHint: () => undefined,
	};
	contexts.push(context);
	prototype.registerSignalHandlers.call(context);
	return context;
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
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	for (const context of contexts) context.unregisterSignalHandlers();
	contexts = [];
	exits.length = 0;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a terminal that is gone (#6104)", () => {
	test("shuts the session down as a signal does, restores nothing, and exits with 129", async () => {
		const disposed = Promise.withResolvers<void>();
		const context = createContext(() => disposed.promise);

		process.stdout.emit("error", deadTerminal());
		await settle();

		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[{ fromSignal: true }]]);
		assert.deepEqual(exits, [], "Atomic does not exit before the session has shut down");

		disposed.resolve();
		await settle();

		assert.deepEqual(exits, [129]);
		assert.equal(vi.mocked(context.stop).mock.calls.length, 0, "the terminal is not restored");
		assert.equal(vi.mocked(context.ui.terminal.drainInput).mock.calls.length, 0);
	});

	test("after SIGHUP, a failed write does not cut the shutdown short", async () => {
		const disposed = Promise.withResolvers<void>();
		const context = createContext(() => disposed.promise);
		const sighup = process.listeners("SIGHUP")[0] as (() => void) | undefined;
		if (!sighup) return; // Windows: no SIGHUP handler.

		sighup();
		process.stdout.emit("error", deadTerminal());
		await settle();

		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[{ fromSignal: true }]]);
		assert.deepEqual(exits, []);
		disposed.resolve();
		await settle();
		assert.deepEqual(exits, [129]);
	});

	test("a shutdown that does not end within the bound is cut short, with every child ended", async () => {
		const context = createContext(() => new Promise<void>(() => {}));

		process.stdout.emit("error", deadTerminal());
		await settle();
		await vi.advanceTimersByTimeAsync(TERMINAL_LOST_SHUTDOWN_MS - 1);
		assert.deepEqual(exits, []);

		await assert.rejects(vi.advanceTimersByTimeAsync(1), ProcessExit);
		assert.deepEqual(exits, [129]);
		assert.equal(context.isShuttingDown, true);
	});

	test("a later dead-terminal error during the shutdown is ignored", async () => {
		const disposed = Promise.withResolvers<void>();
		const context = createContext(() => disposed.promise);

		process.stdout.emit("error", deadTerminal());
		process.stderr.emit("error", deadTerminal());
		process.stdin.emit("error", Object.assign(new Error("read EIO"), { code: "EIO", syscall: "read" }));
		await settle();

		assert.equal(vi.mocked(context.runtimeHost.dispose).mock.calls.length, 1);
		assert.deepEqual(exits, []);
	});

	test("other errors on the terminal's streams still crash", () => {
		createContext(async () => {});
		const error = Object.assign(new Error("read ECONNREFUSED"), { code: "ECONNREFUSED" });

		assert.throws(
			() => process.stdin.emit("error", error),
			(actual) => actual === error,
		);
	});

	test("a quit whose terminal turns out to be gone when it stops the screen still shuts the session down", async () => {
		const context = createContext(async () => {});
		vi.mocked(context.stop).mockImplementation(() => {
			throw Object.assign(new Error("setRawMode EIO"), { code: "EIO", syscall: "setRawMode" });
		});

		await context.shutdown();

		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[]], "the quit's own disposal ran");
		assert.deepEqual(exits, [129]);
	});
});
