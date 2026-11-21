import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../../../../../test/helpers/recorded-process.js";
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

test.runIf(process.platform !== "win32").each<FatalExit>(["uncaughtCrash", "emergencyTerminalExit"])(
	"%s ends a running background shell's whole process tree before exiting (#5057)",
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
		// #6125: recorded while it runs, so neither the assertion nor the cleanup takes a later process for it.
		let descendant: RecordedProcess | undefined;
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
			descendant = await recordProcess(Number(readFileSync(pidFile, "utf8").trim()));
			assert.equal(await stillRuns(descendant), true);

			const exit = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new ProcessExitError();
			}) as typeof process.exit);
			vi.spyOn(console, "error").mockImplementation(() => {});
			const context: FatalThis = {
				isShuttingDown: false,
				unregisterSignalHandlers: vi.fn(),
				ui: { stop: vi.fn() },
				getCrashExtensionHint: () => undefined,
				emergencyTerminalExit: () => prototype.emergencyTerminalExit.call(context),
			};
			assert.throws(() => prototype[path].call(context, new Error("crash")), ProcessExitError);
			assert.equal(exit.mock.calls.length, 1);
			// SIGKILL went out before exit: well inside the default TERM grace an owner close would wait for.
			assert.ok(await waitUntilGone(descendant, 1000), "the descendant outlived the fatal exit");
		} finally {
			vi.restoreAllMocks();
			if (descendant !== undefined) await signalRecordedProcess(descendant);
			await supervisor.closeTaskOwner(owner, "session-close");
		}
	},
	30_000,
);
