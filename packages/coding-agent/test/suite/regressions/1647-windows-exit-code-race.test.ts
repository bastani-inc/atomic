import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BlueprintStepFailedError,
	rehydrateBlueprintError,
	serializeBlueprintError,
} from "../../../src/core/resume/blueprint/errors.ts";
import {
	ChildProcessExitStatusUnknownError,
	isChildProcessExitStatusUnknownError,
	spawnProcess,
	type WindowsProcessExitHandle,
	type WindowsProcessExitStatus,
	waitForChildProcess,
} from "../../../src/utils/child-process.ts";

function createSyntheticChildProcess(pid: number): { child: ChildProcess; stdout: PassThrough; stderr: PassThrough } {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const events = new EventEmitter();
	const child = Object.assign(events, {
		stdout,
		stderr,
		stdin: null,
		stdio: [null, stdout, stderr, null, null],
		pid,
		connected: false,
		killed: false,
		exitCode: null,
		signalCode: null,
		spawnargs: [],
		spawnfile: "synthetic-child",
		kill: () => true,
		ref: () => events as ChildProcess,
		unref: () => events as ChildProcess,
		send: () => false,
		disconnect: () => undefined,
	}) as ChildProcess;

	return { child, stdout, stderr };
}

function createFakeWindowsExitHandle(
	poll: () => WindowsProcessExitStatus,
): WindowsProcessExitHandle & { readonly closed: boolean; readonly pollCount: number } {
	let closed = false;
	let pollCount = 0;
	return {
		creationTime: "133800000000000000",
		get closed() {
			return closed;
		},
		get pollCount() {
			return pollCount;
		},
		pollExit() {
			pollCount += 1;
			if (closed) return { exited: false, unknown: true };
			return poll();
		},
		close() {
			closed = true;
		},
	};
}

describe("issue #1647 Windows exit-code verification", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits for the real exit code when a held Windows handle sees termination before the exit event", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess(1647);
		let resolved = false;
		const handle = createFakeWindowsExitHandle(() => ({ exited: true, exitCode: 1, unknown: false }));

		const wait = waitForChildProcess(synthetic.child, {
			platform: "win32",
			holdWindowsProcessExit: () => handle,
			windowsExitPollIntervalMs: 1,
			windowsExitCodeGraceMs: 1_000,
		}).then((code) => {
			resolved = true;
			return code;
		});

		synthetic.stdout.emit("end");
		synthetic.stderr.emit("end");
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);
		expect(handle.pollCount).toBe(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(resolved).toBe(false);
		expect(handle.pollCount).toBe(1);

		synthetic.child.emit("exit", 1, null);

		await expect(wait).resolves.toBe(1);
		expect(resolved).toBe(true);
		expect(handle.closed).toBe(true);
	});

	it.each([0, 1, 2, 259] as const)(
		"reads the proved exit code %i from a creation-time-verified handle when libuv's exit event never arrives",
		async (expectedCode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
			const synthetic = createSyntheticChildProcess(1649);
			let resolved = false;
			const handle = createFakeWindowsExitHandle(() => ({
				exited: true,
				exitCode: expectedCode,
				unknown: false,
			}));

			const wait = waitForChildProcess(synthetic.child, {
				platform: "win32",
				holdWindowsProcessExit: () => handle,
				windowsExitPollIntervalMs: 1,
				windowsExitCodeGraceMs: 1_000,
			}).then((code) => {
				resolved = true;
				return code;
			});

			synthetic.stdout.emit("end");
			synthetic.stderr.emit("end");
			await vi.advanceTimersByTimeAsync(1);
			await vi.advanceTimersByTimeAsync(999);
			expect(resolved).toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			await expect(wait).resolves.toBe(expectedCode);
			expect(resolved).toBe(true);
			expect(handle.closed).toBe(true);
		},
	);

	it.each([0, 2] as const)(
		"resolves with proved exit code %i when a detached descendant holds stdio open and libuv's exit event is lost",
		async (expectedCode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
			const synthetic = createSyntheticChildProcess(1651);
			const handle = createFakeWindowsExitHandle(() => ({
				exited: true,
				exitCode: expectedCode,
				unknown: false,
			}));

			const wait = waitForChildProcess(synthetic.child, {
				platform: "win32",
				holdWindowsProcessExit: () => handle,
				windowsExitPollIntervalMs: 1,
				windowsExitCodeGraceMs: 100,
			});

			// Neither stdout nor stderr ends (simulating an inherited pipe held open by a detached descendant).
			await vi.advanceTimersByTimeAsync(1);
			await vi.advanceTimersByTimeAsync(100);
			// Let the real setImmediate run, then advance past EXIT_STDIO_IDLE_GRACE_MS (100 ms).
			await new Promise<void>((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(100);

			await expect(wait).resolves.toBe(expectedCode);
			expect(handle.closed).toBe(true);
		},
	);

	it("does not fabricate exit code 0 when a Windows child's exit event is delayed past 1 s under load without natives", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess(1650);
		let resolved = false;

		const wait = waitForChildProcess(synthetic.child, {
			platform: "win32",
			isWindowsProcessAlive: () => false,
			windowsExitPollIntervalMs: 1,
			windowsExitCodeGraceMs: 1_000,
		}).then((code) => {
			resolved = true;
			return code;
		});

		synthetic.stdout.emit("end");
		synthetic.stderr.emit("end");
		// Process exits non-zero in the OS, alive check sees ESRCH, and libuv's exit event is delayed 2,500 ms.
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(2_500);
		expect(resolved).toBe(false);

		synthetic.child.emit("exit", 2, null);
		await expect(wait).resolves.toBe(2);
		expect(resolved).toBe(true);
	});

	it("keeps waiting for libuv without natives until the caller's signal aborts, then rejects with exit status unknown instead of 0", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess(1652);
		const controller = new AbortController();
		let settled = false;

		const wait = waitForChildProcess(synthetic.child, {
			platform: "win32",
			signal: controller.signal,
			isWindowsProcessAlive: () => false,
			windowsExitPollIntervalMs: 1,
			windowsExitCodeGraceMs: 1_000,
		});
		const observed = wait.then(
			(code) => {
				settled = true;
				return { ok: true as const, code };
			},
			(error: unknown) => {
				settled = true;
				return { ok: false as const, error };
			},
		);

		synthetic.stdout.emit("end");
		synthetic.stderr.emit("end");
		// Even after 10 seconds with no exit event and process gone, it never fabricates 0.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(settled).toBe(false);

		// Once the caller's own timeout or abort fires, the wait settles with an explicit unknown-exit-status failure.
		controller.abort();
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		const outcome = await observed;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(isChildProcessExitStatusUnknownError(outcome.error)).toBe(true);
			expect((outcome.error as Error).message).toMatch(/exit status unknown/i);
		}
	});

	it("waits for a still-running child after abort without natives before failing with exit status unknown", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess(1653);
		const controller = new AbortController();
		let alive = true;
		let settled = false;

		const wait = waitForChildProcess(synthetic.child, {
			platform: "win32",
			signal: controller.signal,
			isWindowsProcessAlive: () => alive,
			windowsExitPollIntervalMs: 10,
			windowsExitCodeGraceMs: 100,
		});
		const observed = wait.then(
			(code) => {
				settled = true;
				return { ok: true as const, code };
			},
			(error: unknown) => {
				settled = true;
				return { ok: false as const, error };
			},
		);

		synthetic.stdout.emit("end");
		synthetic.stderr.emit("end");
		controller.abort();

		// While the child is still alive during caller stop/kill grace, do not fail prematurely.
		await vi.advanceTimersByTimeAsync(500);
		expect(settled).toBe(false);

		// Once the process actually dies without libuv delivering exit, grace elapses and rejects as unknown.
		alive = false;
		await vi.advanceTimersByTimeAsync(10);
		await vi.advanceTimersByTimeAsync(100);
		const outcome = await observed;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(isChildProcessExitStatusUnknownError(outcome.error)).toBe(true);
		}
	});

	it("drops an unreadable handle and keeps waiting for a delayed libuv exit rather than failing at 1 s", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess(1654);
		const handle = createFakeWindowsExitHandle(() => ({ exited: true, unknown: true }));
		let resolved = false;

		const wait = waitForChildProcess(synthetic.child, {
			platform: "win32",
			holdWindowsProcessExit: () => handle,
			isWindowsProcessAlive: () => false,
			windowsExitPollIntervalMs: 1,
			windowsExitCodeGraceMs: 100,
		}).then((code) => {
			resolved = true;
			return code;
		});

		synthetic.stdout.emit("end");
		synthetic.stderr.emit("end");
		await vi.advanceTimersByTimeAsync(1);
		expect(handle.closed).toBe(true);

		// Even past the 100 ms grace, because the caller did not abort, it keeps waiting for libuv's real exit.
		await vi.advanceTimersByTimeAsync(2_000);
		expect(resolved).toBe(false);

		synthetic.child.emit("exit", 3, null);
		await expect(wait).resolves.toBe(3);
	});

	it("rejects with exit status unknown (never 0) when an unreadable handle combines with caller abort and lost exit", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess(1655);
		const controller = new AbortController();
		const handle = createFakeWindowsExitHandle(() => ({ exited: true, unknown: true }));

		const wait = waitForChildProcess(synthetic.child, {
			platform: "win32",
			signal: controller.signal,
			holdWindowsProcessExit: () => handle,
			isWindowsProcessAlive: () => false,
			windowsExitPollIntervalMs: 1,
			windowsExitCodeGraceMs: 100,
		});
		const observed = wait.then(
			(code) => ({ ok: true as const, code }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		synthetic.stdout.emit("end");
		synthetic.stderr.emit("end");
		controller.abort();
		await vi.advanceTimersByTimeAsync(101);

		const outcome = await observed;
		expect(handle.closed).toBe(true);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(isChildProcessExitStatusUnknownError(outcome.error)).toBe(true);
		}
	});

	it("closes the held handle on spawn error", async () => {
		const synthetic = createSyntheticChildProcess(1656);
		const handle = createFakeWindowsExitHandle(() => ({ exited: false, unknown: false }));

		const wait = waitForChildProcess(synthetic.child, {
			platform: "win32",
			holdWindowsProcessExit: () => handle,
			windowsExitPollIntervalMs: 50,
		});

		const boom = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
		synthetic.child.emit("error", boom);

		await expect(wait).rejects.toBe(boom);
		expect(handle.closed).toBe(true);
	});

	it("resolves immediately when passed a child that already exited", async () => {
		const synthetic = createSyntheticChildProcess(1657);
		Object.defineProperty(synthetic.child, "exitCode", { value: 4, configurable: true });
		synthetic.stdout.end();
		synthetic.stderr.end();
		// Drain PassThrough so readableEnded becomes true.
		synthetic.stdout.resume();
		synthetic.stderr.resume();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const holdSpy = vi.fn(() => createFakeWindowsExitHandle(() => ({ exited: true, exitCode: 0, unknown: false })));
		const code = await waitForChildProcess(synthetic.child, {
			platform: "win32",
			holdWindowsProcessExit: holdSpy,
		});
		expect(code).toBe(4);
		expect(holdSpy).not.toHaveBeenCalled();
	});

	it.each(["before", "after"] as const)(
		"keeps a stopped process's queued exit and signal when a loaded machine holds the loop past the grace (output ended %s it)",
		async (outputEnds) => {
			const synthetic = createSyntheticChildProcess(1648);
			const endOutput = () => {
				synthetic.stdout.emit("end");
				synthetic.stderr.emit("end");
			};
			// The exit arrives as an event of the loop's poll phase, as a real child's does.
			const exitReport = new MessageChannel();
			exitReport.port1.once("message", () => {
				// Simulate a signal-terminated Windows child: libuv reports (null, "SIGTERM"), while GetExitCodeProcess sees 1.
				Object.defineProperty(synthetic.child, "signalCode", { value: "SIGTERM", configurable: true });
				synthetic.child.emit("exit", null, "SIGTERM");
				// Output that ends later does so after anything else that turn has queued.
				if (outputEnds === "after") setImmediate(endOutput);
			});
			let stalled = false;
			const handle = createFakeWindowsExitHandle(() => {
				if (!stalled) {
					stalled = true;
					setImmediate(() => {
						// The exit is reported while the loop is held, for longer than the grace: when the loop goes on, the
						// grace's timer is due and the exit is queued behind it.
						exitReport.port2.postMessage("exit");
						const end = performance.now() + 150;
						while (performance.now() < end) {
							// A loaded machine holds the loop.
						}
					});
				}
				return { exited: true, exitCode: 1, unknown: false };
			});

			const wait = waitForChildProcess(synthetic.child, {
				platform: "win32",
				holdWindowsProcessExit: () => handle,
				windowsExitPollIntervalMs: 1,
				windowsExitCodeGraceMs: 100,
			});
			if (outputEnds === "before") endOutput();

			try {
				// Queued libuv exit (null, "SIGTERM") wins over the handle's raw exitCode 1.
				await expect(wait).resolves.toBeNull();
				expect(synthetic.child.signalCode).toBe("SIGTERM");
				expect(handle.closed).toBe(true);
			} finally {
				exitReport.port1.close();
			}
		},
	);

	it("reports BlueprintStepFailedError as unknown exit status (not 'could not be started'), including after rehydration", () => {
		const cause = new ChildProcessExitStatusUnknownError(4242);
		const error = new BlueprintStepFailedError(
			{
				blueprint: "/repo/.atomic/blueprint.yaml",
				scope: "repository",
				section: "maintenance",
				index: 0,
				step: "build",
				exitStatus: null,
				signal: null,
				logPath: "/logs/step-1.log",
			},
			cause,
		);
		expect(error.message).toContain("ended with an unknown exit status");
		expect(error.message).not.toContain("could not be started");

		const rehydrated = rehydrateBlueprintError(serializeBlueprintError(error));
		expect(rehydrated.message).toContain("ended with an unknown exit status");
		expect(rehydrated.message).not.toContain("could not be started");
	});

	describe.runIf(process.platform === "win32")("real Windows native process exit verification", () => {
		it.each([0, 1, 2, 259] as const)(
			"holds a creation-time-verified native handle and captures exact exit code %i for a real Windows child",
			async (expectedCode) => {
				const natives = createRequire(import.meta.url)("@bastani/atomic-natives") as {
					holdWindowsProcessExit: (
						pid: number,
						expectedCreated?: string | null,
					) => WindowsProcessExitHandle | null;
				};
				// Non-child PIDs must be rejected.
				expect(natives.holdWindowsProcessExit(0)).toBeNull();
				expect(natives.holdWindowsProcessExit(process.pid)).toBeNull();

				const child = spawnProcess(process.execPath, ["-e", `process.exit(${expectedCode})`], {
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				const pid = child.pid!;
				const held = natives.holdWindowsProcessExit(pid);
				expect(held).not.toBeNull();
				try {
					const created = held!.creationTime;
					expect(BigInt(created) > 0n).toBe(true);
					// Wrong creation time must be rejected.
					expect(natives.holdWindowsProcessExit(pid, (BigInt(created) + 1n).toString())).toBeNull();

					const code = await waitForChildProcess(child);
					expect(code).toBe(expectedCode);

					// The independently held handle must still report the exact kernel exit code.
					const polled = held!.pollExit();
					expect(polled).toEqual({ exited: true, exitCode: expectedCode, unknown: false });
				} finally {
					held?.close();
				}
			},
		);

		it.each([0, 2] as const)(
			"captures exact exit code %i when a real Windows child spawns a quiet descendant keeping stdio open",
			async (expectedCode) => {
				const dir = mkdtempSync(join(tmpdir(), "atomic-1647-descendant-"));
				const gate = join(dir, "hold");
				writeFileSync(gate, "1");
				try {
					// Spawn a short-lived Node child that spawns a detached helper inheriting stdout while `gate` exists,
					// then exits with expectedCode.
					const helperScript = [
						'const fs = require("node:fs");',
						"const gate = process.argv[1];",
						"const end = Date.now() + 10_000;",
						"const tick = setInterval(() => {",
						"  if (!fs.existsSync(gate) || Date.now() >= end) { clearInterval(tick); process.exit(0); }",
						"}, 25);",
					].join(" ");
					const parentScript = [
						'const { spawn } = require("node:child_process");',
						'const bg = spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], {',
						'  detached: true, stdio: ["ignore", 1, 2], windowsHide: true',
						"});",
						"bg.unref();",
						`process.exit(${expectedCode});`,
					].join(" ");
					const child = spawnProcess(process.execPath, ["-e", parentScript, helperScript, gate], {
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
					});
					const start = Date.now();
					const code = await waitForChildProcess(child);
					const elapsed = Date.now() - start;
					expect(code).toBe(expectedCode);
					expect(elapsed).toBeLessThan(8_000);
				} finally {
					rmSync(gate, { force: true });
					rmSync(dir, { recursive: true, force: true });
				}
			},
		);
	});
});
