import assert from "node:assert/strict";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";

// Signing out of Windows, or restarting or shutting it down, reaches Atomic through the native module's hidden window,
// which calls back with how long ago Windows said the session ends and keeps Windows waiting while the answer is true.
// The session then shuts down as when its console is closed.

const natives = vi.hoisted(() => ({
	watchSessionEnd: vi.fn((_onEnd: (endedMsAgo: number) => boolean) => {}),
}));
vi.mock("../src/utils/module-require.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/module-require.js")>();
	// Loaded now, on this platform: the binding's loader picks its file by process.platform, which tests change.
	const binding = { ...(actual.createModuleRequire(import.meta.url)("@bastani/atomic-natives") as object) };
	return {
		...actual,
		createModuleRequire: (url: string) => {
			const require = actual.createModuleRequire(url);
			return (specifier: string) =>
				specifier === "@bastani/atomic-natives"
					? { ...binding, watchSessionEnd: natives.watchSessionEnd }
					: require(specifier);
		},
	};
});

const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.ts");
const { watchWindowsSessionEnd } = await import("../src/modes/interactive/windows-session-end.ts");

/** STATUS_CONTROL_C_EXIT: the status Windows gives a console program it ends at the end of the session. */
const SESSION_ENDED_EXIT_CODE = 0xc000013a;
/** How long Windows waits for a program at the end of the session before it says the program keeps it waiting. */
const WINDOWS_SESSION_END_WAIT_MS = 5_000;
/** What Atomic leaves of that wait for its own exit. */
const OWN_EXIT_MS = 1_000;

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

function onWindows(): void {
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
}

/** What the native window calls when Windows says the session ends; true keeps Windows waiting. */
let onEnd: ((endedMsAgo: number) => boolean) | undefined;

function sessionEnds(endedMsAgo = 0): boolean {
	assert.ok(onEnd, "Atomic watches for the end of the Windows session");
	return onEnd(endedMsAgo);
}

/** An interactive host on Windows whose session's shutdown settles when `dispose` does. */
function createWindowsHost(dispose: () => Promise<void>): Context {
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
	onWindows();
	prototype.registerSignalHandlers.call(context);
	return context;
}

/** Let the shutdown's promise reactions run. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

beforeAll(() => {
	onWindows();
	try {
		watchWindowsSessionEnd();
		onEnd = natives.watchSessionEnd.mock.calls[0]?.[0];
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

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

describe("the end of the Windows session", () => {
	test("shuts the session down as a closed console does, and exits with STATUS_CONTROL_C_EXIT", async () => {
		const disposed = Promise.withResolvers<void>();
		const context = createWindowsHost(() => disposed.promise);

		assert.equal(sessionEnds(), true, "Windows is kept waiting while the session shuts down");
		await settle();

		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[{ fromSignal: true }]]);
		assert.deepEqual(exits, [], "Atomic does not exit before the session has shut down");

		disposed.resolve();
		await settle();

		assert.deepEqual(exits, [SESSION_ENDED_EXIT_CODE]);
		assert.equal(vi.mocked(context.stop).mock.calls.length, 0, "the console is not restored");
	});

	test("cuts the shutdown short within Windows's wait counted from when Windows said so, not from when Atomic heard it", async () => {
		createWindowsHost(() => new Promise<void>(() => {}));
		const bound = WINDOWS_SESSION_END_WAIT_MS - OWN_EXIT_MS;
		const heardLate = 3_000;

		sessionEnds(heardLate);
		await settle();
		await vi.advanceTimersByTimeAsync(bound - heardLate - 1);
		assert.deepEqual(exits, []);

		await assert.rejects(vi.advanceTimersByTimeAsync(1), ProcessExit);
		assert.deepEqual(exits, [SESSION_ENDED_EXIT_CODE]);
	});

	test("a session end during a quit lets the quit finish and exits with STATUS_CONTROL_C_EXIT", async () => {
		const disposed = Promise.withResolvers<void>();
		const context = createWindowsHost(() => disposed.promise);

		const quitting = context.shutdown();
		await settle();
		assert.equal(sessionEnds(), true, "the quit, which stopped the screen, still hears the session end");
		await settle();
		assert.deepEqual(exits, []);

		disposed.resolve();
		await quitting;
		assert.deepEqual(vi.mocked(context.runtimeHost.dispose).mock.calls, [[]], "the quit's own disposal ran, once");
		assert.deepEqual(exits, [SESSION_ENDED_EXIT_CODE]);
	});

	test("with nothing shutting down for it, Windows is not kept waiting", async () => {
		const context = createWindowsHost(async () => {});
		context.unregisterSignalHandlers();

		assert.equal(sessionEnds(), false);
		await settle();
		assert.equal(vi.mocked(context.runtimeHost.dispose).mock.calls.length, 0);
		assert.deepEqual(exits, []);
	});
});

describe("watching for the end of the Windows session", () => {
	test("starts once per process on Windows", async () => {
		vi.resetModules();
		const fresh = await import("../src/modes/interactive/windows-session-end.ts");
		onWindows();

		fresh.watchWindowsSessionEnd();
		fresh.watchWindowsSessionEnd();

		assert.equal(natives.watchSessionEnd.mock.calls.length, 1);
	});

	test.each(["linux", "darwin"] as const)("never starts on %s", async (other) => {
		vi.resetModules();
		const fresh = await import("../src/modes/interactive/windows-session-end.ts");
		Object.defineProperty(process, "platform", { ...platform, value: other });

		fresh.watchWindowsSessionEnd();

		assert.equal(natives.watchSessionEnd.mock.calls.length, 0);
	});
});
