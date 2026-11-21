import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { IsolatedInteractiveRuntime } from "../../../src/modes/interactive-engine/isolated-runtime.ts";
import { ENGINE_SHUTDOWN_GRACE_MS } from "../../../src/modes/rpc/rpc-client-process.js";
import { trackDetachedChildPid, untrackDetachedChildPid } from "../../../src/utils/shell.ts";

// A closing terminal sends SIGHUP and fails the next write to it with EIO, in either order. Neither ends the session
// before its shutdown has run: the session shuts down as on SIGHUP, restores nothing, and Atomic exits with 129.

/** The longest a session whose terminal is gone may take to shut down: past it, Atomic ends anyway. */
const TERMINAL_LOST_SHUTDOWN_MS = ENGINE_SHUTDOWN_GRACE_MS + 1_000;

interface Context {
	isShuttingDown: boolean;
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

/** The timers these tests do not fake, captured before they are faked. */
const realSetTimeout = globalThis.setTimeout;
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => realSetTimeout(resolve, ms));
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

	// Windows delivers no SIGHUP to Atomic: closing the console ends it at once.
	test.skipIf(process.platform === "win32")(
		"after SIGHUP, a failed write does not cut the shutdown short",
		async () => {
			const disposed = Promise.withResolvers<void>();
			const others = process.listeners("SIGHUP");
			const context = createContext(() => disposed.promise);
			const sighup = process.listeners("SIGHUP").find((listener) => !others.includes(listener));
			assert.ok(sighup, "Atomic handles SIGHUP");

			sighup("SIGHUP");
			process.stdout.emit("error", deadTerminal());
			await settle();

			assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[{ fromSignal: true }]]);
			assert.deepEqual(exits, []);
			disposed.resolve();
			await settle();
			assert.deepEqual(exits, [129]);
		},
	);

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

	test("the end of a terminal's input shuts the session down as a lost terminal does", async () => {
		// A closed terminal ends its input before its signals arrive; with nothing else to do, the process would end there.
		const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		try {
			const disposed = Promise.withResolvers<void>();
			const context = createContext(() => disposed.promise);

			process.stdin.emit("end");
			await settle();

			assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[{ fromSignal: true }]]);
			assert.deepEqual(exits, []);
			disposed.resolve();
			await settle();
			assert.deepEqual(exits, [129]);
		} finally {
			if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
			else Reflect.deleteProperty(process.stdin, "isTTY");
		}
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

// Windows delivers neither SIGHUP nor SIGTERM to Atomic.
describe.skipIf(process.platform === "win32")("the signals of a closing terminal (#6104)", () => {
	/** Longer than a kill takes to be reported, however loaded the machine. */
	const KILL_REPORTED_MS = 5_000;
	/** How long the engine is watched for a kill that must not come. */
	const SPARED_WATCH_MS = 500;
	/** As a shell's forwarded SIGHUP and the kernel's, sent when the shell exits, arrive apart. */
	const SIGHUP_GAP_MS = 10;
	let engine: ChildProcess | undefined;

	afterEach(() => {
		if (engine?.pid !== undefined) {
			untrackDetachedChildPid(engine.pid);
			if (engine.exitCode === null && engine.signalCode === null) engine.kill("SIGKILL");
		}
		engine = undefined;
	});

	/** A session in an interactive engine whose shutdown has not finished, with that engine as a real process. */
	function engineSession(): { context: Context; exited: Promise<void>; hasExited: () => boolean } {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
		engine = child;
		const pid = child.pid;
		assert.ok(pid !== undefined);
		trackDetachedChildPid(pid);
		let done = false;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => {
				done = true;
				resolve();
			});
		});
		const context = createContext(() => new Promise<void>(() => {}));
		const runtime = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
		context.runtimeHost = Object.assign(runtime, {
			dispose: context.runtimeHost.dispose,
			getReadyEngineChildPid: () => pid,
		});
		return { context, exited, hasExited: () => done };
	}

	function listener(signal: "SIGHUP" | "SIGTERM", others: readonly NodeJS.SignalsListener[]): NodeJS.SignalsListener {
		const own = process.listeners(signal).find((candidate) => !others.includes(candidate));
		assert.ok(own, `Atomic handles ${signal}`);
		return own;
	}

	test("two SIGHUPs and a failed write leave the engine to the session's shutdown", async () => {
		const others = process.listeners("SIGHUP");
		const { context, hasExited } = engineSession();
		const sighup = listener("SIGHUP", others);

		sighup("SIGHUP");
		await sleep(SIGHUP_GAP_MS);
		sighup("SIGHUP");
		process.stdout.emit("error", deadTerminal());
		await sleep(SPARED_WATCH_MS);

		assert.equal(hasExited(), false, "a closing terminal's second SIGHUP killed the engine");
		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[{ fromSignal: true }]]);
	});

	test("a SIGTERM after SIGHUP still leaves the engine to the shutdown", async () => {
		const hups = process.listeners("SIGHUP");
		const terms = process.listeners("SIGTERM");
		const { hasExited } = engineSession();

		listener("SIGHUP", hups)("SIGHUP");
		listener("SIGTERM", terms)("SIGTERM");
		await sleep(SPARED_WATCH_MS);

		assert.equal(hasExited(), false);
	});

	test("a second SIGTERM ends the engine at once", async () => {
		const others = process.listeners("SIGTERM");
		const { exited } = engineSession();
		const sigterm = listener("SIGTERM", others);

		sigterm("SIGTERM");
		sigterm("SIGTERM");

		await Promise.race([
			exited,
			sleep(KILL_REPORTED_MS).then(() => assert.fail("the second SIGTERM left the engine running")),
		]);
	});
});
