import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../../../src/config.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// Regression for https://github.com/earendil-works/atomic/issues/5080
//
// On SIGTERM/SIGHUP the graceful shutdown must emit `session_shutdown`
// (runtimeHost.dispose) BEFORE touching the terminal. Extension teardown such
// as removing a socket does not write to the tty, so it must not be skipped if
// a later terminal-restore write fails on a dead or stalled terminal. The
// interactive quit path (Ctrl+D, /quit) keeps the opposite order to preserve
// the final TUI frame.

type ShutdownThis = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	runtimeHost: { dispose: () => Promise<void> };
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
	sessionManager: SessionManager;
};

type InteractiveModePrototypeWithShutdown = {
	shutdown(this: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;
const tempDirs: string[] = [];
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

class ProcessExitError extends Error {}

function createSessionManager(options: { sessionFile?: string } = {}): SessionManager {
	return {
		isPersisted: () => options.sessionFile !== undefined,
		getSessionFile: () => options.sessionFile,
		getSessionId: () => "test-session",
		getSessionDir: () => "/tmp/atomic-sessions",
		usesDefaultSessionDir: () => true,
	} as unknown as SessionManager;
}

function createTempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-shutdown-resume-hint-"));
	tempDirs.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "\n");
	return file;
}

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreStdoutIsTTY(): void {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
}

function createContext(order: string[], sessionManager = createSessionManager()): ShutdownThis {
	return {
		isShuttingDown: false,
		unregisterSignalHandlers: vi.fn(),
		runtimeHost: {
			dispose: vi.fn(async () => {
				order.push("dispose");
			}),
		},
		ui: {
			terminal: {
				drainInput: vi.fn(async () => {
					order.push("drainInput");
				}),
			},
		},
		themeController: { disableAutoSync: vi.fn() },
		stop: vi.fn(() => {
			order.push("stop");
		}),
		sessionManager,
	};
}

async function callShutdown(context: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(context, options);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

describe("InteractiveMode.shutdown ordering (#5080)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("signal-triggered shutdown emits session_shutdown before terminal writes", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual(["dispose", "drainInput", "stop"]);
		expect(context.isShuttingDown).toBe(true);
	});

	test("interactive quit stops the TUI before emitting session_shutdown", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
	});

	test("interactive quit prints a resume hint for persisted sessions", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
		expect(stdoutWrite).toHaveBeenCalledWith(
			`${chalk.dim("To resume this session:")} ${APP_NAME} --session test-session\n`,
		);
	});

	test("signal-triggered shutdown does not print a resume hint", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context, { fromSignal: true });

		for (const call of stdoutWrite.mock.calls) {
			expect(call[0]).not.toContain("To resume this session:");
		}
	});

	test("re-entrant shutdown is a no-op", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);
		context.isShuttingDown = true;

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual([]);
		expect(context.runtimeHost.dispose).not.toHaveBeenCalled();
	});
});

type HandlerContext = {
	isShuttingDown: boolean;
	signalCleanupHandlers: Array<() => void>;
	shutdown: () => Promise<void>;
	unregisterSignalHandlers: () => void;
	emergencyTerminalExit: () => never;
	uncaughtCrash: (error: Error) => never;
	getCrashExtensionHint: () => string | undefined;
	ui: { stop: () => void };
};
type HandlerPrototype = {
	registerSignalHandlers(this: HandlerContext): void;
	unregisterSignalHandlers(this: HandlerContext): void;
	emergencyTerminalExit(this: HandlerContext): never;
	uncaughtCrash(this: HandlerContext, error: Error): never;
};
const handlerPrototype = InteractiveMode.prototype as unknown as HandlerPrototype;

test("unrelated uncaught EIO and ENOTTY restore the terminal and report a crash (#3429)", () => {
	const hint = "Error in extension unrelated-extension";
	const stop = vi.fn();
	const context: HandlerContext = {
		isShuttingDown: false,
		signalCleanupHandlers: [],
		shutdown: async () => {},
		unregisterSignalHandlers: () => handlerPrototype.unregisterSignalHandlers.call(context),
		emergencyTerminalExit: () => handlerPrototype.emergencyTerminalExit.call(context),
		uncaughtCrash: (error) => handlerPrototype.uncaughtCrash.call(context, error),
		getCrashExtensionHint: () => hint,
		ui: { stop },
	};
	const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit ${code}`);
	});
	const report = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		for (const code of ["EIO", "ENOTTY", "EPIPE", "ENOTCONN"]) {
			for (const syscall of [undefined, "read", "open"]) {
				context.isShuttingDown = false;
				stop.mockClear();
				report.mockClear();
				handlerPrototype.registerSignalHandlers.call(context);
				const error = Object.assign(new Error(`unrelated extension setRawMode ${code}`), { code, syscall });
				const handler = process.listeners("uncaughtException")[0] as (error: Error) => void;
				assert.throws(() => handler(error), /exit 1$/);
				assert.equal(stop.mock.calls.length, 1);
				assert.ok(report.mock.calls.some(([value]) => value === error));
				assert.ok(report.mock.calls.some(([value]) => String(value).includes(hint)));
			}
		}
	} finally {
		context.unregisterSignalHandlers();
		exit.mockRestore();
		report.mockRestore();
	}
});

test("dead stdin and uncaught terminal errors exit quietly while other errors still crash (#3429)", () => {
	const context: HandlerContext = {
		isShuttingDown: false,
		signalCleanupHandlers: [],
		shutdown: async () => {},
		unregisterSignalHandlers: () => handlerPrototype.unregisterSignalHandlers.call(context),
		emergencyTerminalExit: () => handlerPrototype.emergencyTerminalExit.call(context),
		uncaughtCrash: (error) => handlerPrototype.uncaughtCrash.call(context, error),
		getCrashExtensionHint: () => undefined,
		ui: { stop: vi.fn() },
	};
	const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit ${code}`);
	});
	const report = vi.spyOn(console, "error").mockImplementation(() => {});
	const before = process.stdin.listenerCount("error");
	try {
		for (const code of ["EIO", "ENOTTY"]) {
			context.isShuttingDown = false;
			handlerPrototype.registerSignalHandlers.call(context);
			assert.equal(process.stdin.listenerCount("error"), before + 1);
			assert.throws(
				() => process.stdin.emit("error", Object.assign(new Error(`read ${code}`), { code })),
				/exit 129/,
			);
			assert.equal(report.mock.calls.length, 0);
			assert.equal(process.stdin.listenerCount("error"), before);
			context.isShuttingDown = false;
			assert.throws(
				() =>
					context.uncaughtCrash(Object.assign(new Error(`setRawMode ${code}`), { code, syscall: "setRawMode" })),
				/exit 129/,
			);
			assert.equal(report.mock.calls.length, 0);
		}
		context.isShuttingDown = false;
		handlerPrototype.registerSignalHandlers.call(context);
		const error = Object.assign(new Error("read ECONNREFUSED"), { code: "ECONNREFUSED" });
		assert.throws(
			() => process.stdin.emit("error", error),
			(actual) => actual === error,
		);
		assert.throws(() => context.uncaughtCrash(error), /exit 1/);
		assert.ok(report.mock.calls.length > 0);
	} finally {
		context.unregisterSignalHandlers();
		exit.mockRestore();
		report.mockRestore();
	}
});
