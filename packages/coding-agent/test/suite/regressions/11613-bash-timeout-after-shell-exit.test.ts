import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it, vi } from "vitest";
import { createBashTool, createLocalBashOperations } from "../../../src/core/tools/bash.js";
import {
	isShellTimeoutError,
	isShellToolError,
	rehydrateShellToolError,
	ShellTimeoutError,
	ShellToolError,
} from "../../../src/core/tools/shell-errors.js";

/**
 * The bash tool waits for stdout/stderr to close, not only for the shell to exit (#5303). A background
 * process that inherited those pipes and keeps writing keeps the tool waiting after the shell exited.
 * When the timeout then hit, the tool reported only "Command timed out", so the shell's real exit code
 * and the fact that it had already finished were lost. The tool now reports both (pi #11613).
 *
 * Unix only: on Windows the deadline cannot kill background processes once the shell pid is gone, so the
 * tool keeps waiting until their output pauses; this test would hang there.
 */
/** libuv keeps loop time in whole milliseconds, so a 1000 ms timer can fire a fraction of a millisecond early. */
const TIMER_EARLY_FIRE_TOLERANCE_MS = 2;
/** The timeout path kills the process group and drains its pipes; well above that under load, far below a hang. */
const TIMEOUT_UPPER_BOUND_MS = 20_000;

describe.skipIf(process.platform === "win32")("pi #11613 bash timeout after the shell exited", () => {
	const bashTool = createBashTool(tmpdir());

	async function runExpectingTimeout(command: string, timeout: number): Promise<Error> {
		const error = await bashTool.execute("test-11613", { command, timeout }).then(
			() => undefined,
			(err: unknown) => err,
		);
		assert.ok(error instanceof Error);
		return error;
	}

	it("reports the shell's exit code when background processes kept writing until the timeout", async () => {
		const error = await runExpectingTimeout(
			"(while true; do echo tick; sleep 0.02; done) & sleep 0.2; echo boom >&2; exit 3",
			1,
		);
		assert.ok(error.message.includes("boom"));
		assert.match(
			error.message,
			/Command timed out after 1 seconds\. The shell exited with code 3 after \d+(?:\.\d)? seconds, but background processes it started kept writing output until the timeout\.$/,
		);
		const timeout = error.cause;
		assert.ok(timeout instanceof ShellTimeoutError);
		assert.equal(timeout.code, "shell-timeout");
		assert.equal(timeout.phase, "draining-output");
		assert.equal(timeout.timeoutMs, 1000);
		assert.equal(timeout.shellExit?.exitCode, 3);
		const afterSeconds = timeout.shellExit?.afterSeconds ?? Number.NaN;
		assert.ok(afterSeconds > 0 && afterSeconds <= timeout.timeoutMs / 1000, `shell exited after ${afterSeconds} s`);
		assert.ok(
			timeout.elapsedMs >= timeout.timeoutMs - TIMER_EARLY_FIRE_TOLERANCE_MS,
			`elapsed ${timeout.elapsedMs} ms`,
		);
		assert.ok(timeout.elapsedMs < TIMEOUT_UPPER_BOUND_MS, `elapsed ${timeout.elapsedMs} ms`);
		assert.equal(timeout.retryable, false);
		assert.ok(timeout.hint?.includes("Redirect its output"));
	});

	it("keeps the plain timeout message when the shell was still running at the deadline", async () => {
		// Atomic's bash tool rounds a timeout down to whole seconds, at least 1.
		const error = await runExpectingTimeout("echo started; sleep 30", 1);
		assert.match(error.message, /started\s+Command timed out after 1 seconds$/);
		const timeout = error.cause;
		assert.ok(timeout instanceof ShellTimeoutError);
		assert.equal(timeout.phase, "running");
		assert.equal(timeout.shellExit, undefined);
		assert.ok(timeout.hint?.includes("Raise `timeout`"));
	});

	it("throws a typed timeout from the local backend that keeps the timeout:<seconds> message", async () => {
		const error = await createLocalBashOperations()
			.exec("sleep 30", tmpdir(), { onData: () => {}, timeout: 0.2 })
			.then(
				() => undefined,
				(err: unknown) => err,
			);
		assert.ok(isShellTimeoutError(error));
		assert.ok(isShellToolError(error));
		assert.equal(error.message, "timeout:0.2");
		assert.equal(error.timeoutSeconds, 0.2);
		assert.ok(error.hint);
	});

	it("measures the elapsed time of a timeout from the start of the command", async () => {
		const realNow = performance.now.bind(performance);
		const clockOffsetMs = 3_600_000;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + clockOffsetMs);
		let error: unknown;
		try {
			error = await createLocalBashOperations()
				.exec("sleep 30", tmpdir(), { onData: () => {}, timeout: 0.2 })
				.then(
					() => undefined,
					(err: unknown) => err,
				);
		} finally {
			clock.mockRestore();
		}
		assert.ok(isShellTimeoutError(error));
		assert.ok(error.elapsedMs > 0);
		assert.ok(error.elapsedMs < clockOffsetMs);
	});
});

describe("ShellToolError serialization", () => {
	it("serializes a base error with only the facts it has", () => {
		const bare = new ShellToolError("boom", { code: "shell-timeout", retryable: true });
		assert.equal(bare.name, "ShellToolError");
		assert.equal(Object.hasOwn(bare, "cause"), false);
		assert.deepEqual(bare.fields, {});
		assert.deepEqual(bare.toJSON(), {
			name: "ShellToolError",
			code: "shell-timeout",
			message: "boom",
			retryable: true,
			fields: {},
		});

		const full = new ShellToolError("boom", {
			code: "shell-timeout",
			hint: "try again",
			retryable: false,
			cause: new Error("root"),
		});
		assert.deepEqual(full.toJSON(), {
			name: "ShellToolError",
			code: "shell-timeout",
			message: "boom",
			hint: "try again",
			retryable: false,
			fields: {},
			cause: { name: "Error", message: "root" },
		});
	});

	it("serializes a timeout with its phase hint and structured fields", () => {
		const draining = new ShellTimeoutError({
			timeoutSeconds: 3,
			elapsedMs: 3004,
			shellExit: { exitCode: 1, afterSeconds: 1.1 },
		});
		assert.ok(draining.hint?.includes("Redirect its output"));
		assert.deepEqual(draining.toJSON(), {
			name: "ShellTimeoutError",
			code: "shell-timeout",
			message: "timeout:3",
			hint: draining.hint,
			retryable: false,
			fields: {
				timeoutMs: 3000,
				elapsedMs: 3004,
				phase: "draining-output",
				shellExitCode: 1,
				shellExitAfterSeconds: 1.1,
			},
		});

		const running = new ShellTimeoutError({ timeoutSeconds: 2, elapsedMs: 2001 });
		assert.ok(running.hint?.includes("Raise `timeout`"));
		assert.deepEqual(running.fields, {
			timeoutMs: 2000,
			elapsedMs: 2001,
			phase: "running",
			shellExitCode: null,
			shellExitAfterSeconds: null,
		});
	});

	it("rehydrates a timeout whose name or timeout field is missing into the base class", () => {
		const unnamed = rehydrateShellToolError({
			name: "ShellTimeoutError",
			code: "shell-timeout",
			message: "timeout:3",
			retryable: false,
			fields: {},
		});
		assert.ok(unnamed instanceof ShellToolError);
		assert.equal(unnamed instanceof ShellTimeoutError, false);
		assert.equal(unnamed.name, "ShellTimeoutError");
		assert.equal(unnamed.message, "timeout:3");

		const foreign = rehydrateShellToolError({
			name: "ShellFutureError",
			code: "shell-timeout",
			message: "future",
			retryable: false,
			fields: { timeoutMs: 3000 },
		});
		assert.equal(foreign instanceof ShellTimeoutError, false);
		assert.equal(foreign.name, "ShellFutureError");
		assert.equal(foreign.message, "future");
	});

	it("rehydrates a shell exit only when both of its facts are present", () => {
		const rehydrate = (fields: Record<string, number | null>) =>
			rehydrateShellToolError({
				name: "ShellTimeoutError",
				code: "shell-timeout",
				message: "timeout:3",
				retryable: false,
				fields: { timeoutMs: 3000, ...fields },
			}) as ShellTimeoutError;

		assert.deepEqual(rehydrate({ shellExitCode: 1, shellExitAfterSeconds: 2.5 }).shellExit, {
			exitCode: 1,
			afterSeconds: 2.5,
		});
		assert.equal(rehydrate({ shellExitCode: 1, shellExitAfterSeconds: null }).shellExit, undefined);
		assert.equal(rehydrate({ shellExitCode: null, shellExitAfterSeconds: 2.5 }).shellExit, undefined);
		assert.equal(rehydrate({ shellExitCode: 1 }).shellExit, undefined);
		assert.equal(rehydrate({ shellExitAfterSeconds: 2.5 }).shellExit, undefined);
	});

	it("falls back to the timeout for the elapsed time when it was not relayed", () => {
		const rehydrate = (fields: Record<string, number | null>) =>
			rehydrateShellToolError({
				name: "ShellTimeoutError",
				code: "shell-timeout",
				message: "timeout:3",
				retryable: false,
				fields: { timeoutMs: 3000, ...fields },
			}) as ShellTimeoutError;

		assert.equal(rehydrate({}).elapsedMs, 3000);
		assert.equal(rehydrate({ elapsedMs: null }).elapsedMs, 3000);
		assert.equal(rehydrate({ elapsedMs: 3012 }).elapsedMs, 3012);
	});

	it("round-trips a timeout across a process boundary", () => {
		const original = new ShellTimeoutError({
			timeoutSeconds: 3,
			elapsedMs: 3004,
			shellExit: { exitCode: 1, afterSeconds: 1.1 },
		});
		const rehydrated = rehydrateShellToolError(JSON.parse(JSON.stringify(original)));
		assert.ok(rehydrated instanceof ShellTimeoutError);
		assert.ok(isShellTimeoutError(rehydrated));
		assert.equal(rehydrated.code, "shell-timeout");
		assert.equal(rehydrated.message, "timeout:3");
		assert.deepEqual(rehydrated.fields, original.fields);
		assert.equal(rehydrated.describe(), original.describe());
		assert.equal(rehydrated.hint, original.hint);
	});

	it("round-trips a timeout without a shell exit", () => {
		const original = new ShellTimeoutError({ timeoutSeconds: 2, elapsedMs: 2001 });
		const rehydrated = rehydrateShellToolError(JSON.parse(JSON.stringify(original)));
		assert.ok(rehydrated instanceof ShellTimeoutError);
		assert.equal(rehydrated.phase, "running");
		assert.equal(rehydrated.shellExit, undefined);
		assert.equal(rehydrated.elapsedMs, 2001);
	});

	it("rehydrates an unknown family member into the base with its name and code", () => {
		const rehydrated = rehydrateShellToolError({
			name: "ShellFutureError",
			code: "shell-timeout",
			message: "future",
			hint: "later",
			retryable: true,
			fields: {},
			cause: { name: "Error", message: "root", code: "EIO" },
		});
		assert.ok(rehydrated instanceof ShellToolError);
		assert.equal(rehydrated.name, "ShellFutureError");
		assert.equal(rehydrated.code, "shell-timeout");
		assert.equal(rehydrated.retryable, true);
		assert.equal((rehydrated.cause as Error & { code?: string }).code, "EIO");
	});

	it("matches structurally and never by message", () => {
		assert.ok(isShellTimeoutError({ name: "ShellTimeoutError", code: "shell-timeout" }));
		assert.equal(isShellTimeoutError({ name: "ShellToolError", code: "shell-timeout" }), false);
		assert.ok(isShellToolError({ name: "ShellToolError", code: "shell-timeout" }));
		assert.ok(isShellToolError({ name: "ShellTimeoutError", code: "shell-timeout" }));
		assert.equal(isShellToolError(new Error("timeout:3")), false);
		assert.equal(isShellTimeoutError(undefined), false);
	});
});
