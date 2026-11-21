import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { OperationId, Result } from "../../../src/core/tasks/contracts.ts";
import { TaskSupervisor } from "../../../src/core/tasks/supervisor.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// A crash exits at once, so the async owner close never runs. Fatal exit paths end every supervised shell's whole
// process tree synchronously instead, before process.exit.

class ProcessExitError extends Error {}
type FatalExit = "uncaughtCrash" | "emergencyTerminalExit";
type FatalThis = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	ui: { stop: () => void };
	getCrashExtensionHint: () => string | undefined;
	emergencyTerminalExit: () => never;
};
const prototype = InteractiveMode.prototype as unknown as Record<FatalExit, (this: FatalThis, error?: Error) => never>;
const directories: string[] = [];

function value<T, E>(result: Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? "accepted" : JSON.stringify(result.error));
	return result.value;
}
function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function waitFor(predicate: () => boolean, ms: number) {
	const deadline = Date.now() + ms;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	return predicate();
}

test("a crash before any supervisor exists exits without failing in the crash handler (#5057)", async () => {
	vi.resetModules();
	const fresh = await import("../../../src/core/tasks/supervisor.ts");
	assert.doesNotThrow(() => fresh.killSupervisedProcessTrees());
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type TerminalLossThis = FatalThis & {
	hostSignals: number;
	terminalLost: boolean;
	terminalLoss: PromiseWithResolvers<void>;
	runtimeHost: object;
	signalCleanupHandlers: Array<() => void>;
	shutdown: (options?: { fromSignal?: boolean }) => Promise<void>;
	handleTerminalLost: () => void;
};
const terminalLossPrototype = InteractiveMode.prototype as unknown as {
	registerSignalHandlers(this: TerminalLossThis): void;
	unregisterSignalHandlers(this: TerminalLossThis): void;
	handleTerminalLost(this: TerminalLossThis): void;
};

type Ending = FatalExit | "lostTerminal";

test.runIf(process.platform !== "win32").each<Ending>(["uncaughtCrash", "emergencyTerminalExit", "lostTerminal"])(
	"%s ends a running background shell's whole process tree at once (#5057, #6104)",
	async (path) => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-fatal-exit-5057-"));
		directories.push(directory);
		const pidFile = join(directory, "pid");
		const supervisor = new TaskSupervisor();
		const scope = { kind: "session" as const, sessionId: crypto.randomUUID() };
		const host = supervisor.bindHostSession({
			scope,
			authorizeLaunch() {},
			createRunner() {
				throw new Error("Command must not dispatch an agent");
			},
		});
		const owner = value(supervisor.openTaskOwner(host, scope));
		let descendant = 0;
		try {
			value(
				await supervisor.startCommandTask(
					owner,
					{
						kind: "command",
						command: `timeout 300 sh -c 'echo $$ > "$1"; exec sleep 300' sh '${pidFile}'`,
						terminal: { kind: "pipe" },
					},
					"fatal" as OperationId,
				),
			);
			assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 10_000));
			descendant = Number(readFileSync(pidFile, "utf8").trim());
			assert.ok(alive(descendant));

			const exit = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new ProcessExitError();
			}) as typeof process.exit);
			vi.spyOn(console, "error").mockImplementation(() => {});
			if (path === "lostTerminal") {
				// The terminal's window closed: a write to it fails. The session shuts down first, but the shell ends now.
				const context: TerminalLossThis = {
					isShuttingDown: false,
					hostSignals: 0,
					terminalLost: false,
					terminalLoss: Promise.withResolvers<void>(),
					runtimeHost: {},
					signalCleanupHandlers: [],
					shutdown: vi.fn(() => new Promise<void>(() => {})),
					unregisterSignalHandlers: () => terminalLossPrototype.unregisterSignalHandlers.call(context),
					handleTerminalLost: () => terminalLossPrototype.handleTerminalLost.call(context),
					ui: { stop: vi.fn() },
					getCrashExtensionHint: () => undefined,
					emergencyTerminalExit: () => prototype.emergencyTerminalExit.call(context),
				};
				vi.useFakeTimers({ toFake: ["setTimeout"] });
				terminalLossPrototype.registerSignalHandlers.call(context);
				try {
					process.stdout.emit("error", Object.assign(new Error("write EIO"), { code: "EIO", syscall: "write" }));
				} finally {
					context.unregisterSignalHandlers();
					vi.useRealTimers();
				}
				assert.deepEqual(vi.mocked(context.shutdown).mock.calls, [[{ fromSignal: true }]]);
				assert.equal(exit.mock.calls.length, 0);
			} else {
				const context: FatalThis = {
					isShuttingDown: false,
					unregisterSignalHandlers: vi.fn(),
					ui: { stop: vi.fn() },
					getCrashExtensionHint: () => undefined,
					emergencyTerminalExit: () => prototype.emergencyTerminalExit.call(context),
				};
				assert.throws(() => prototype[path].call(context, new Error("crash")), ProcessExitError);
				assert.equal(exit.mock.calls.length, 1);
			}
			// SIGKILL went out before exit: well inside the default TERM grace an owner close would wait for.
			assert.ok(await waitFor(() => !alive(descendant), 1000), "the descendant outlived the fatal exit");
		} finally {
			vi.restoreAllMocks();
			if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
			await supervisor.closeTaskOwner(owner, "session-close");
		}
	},
	30_000,
);
