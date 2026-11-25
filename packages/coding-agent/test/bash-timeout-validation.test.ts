import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createBashToolDefinition, createLocalBashOperations } from "../src/core/tools/bash.ts";

/** Node's longest timer delay, in milliseconds: a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DAY_MS = 86_400_000;

/**
 * A command that keeps writing `alive` while it runs, until `release` exists: a test can move fake time while the real
 * command is known to be running, check that it still runs, then let it finish.
 */
function heldCommand() {
	const dir = mkdtempSync(join(tmpdir(), "atomic-shell-deadline-"));
	const alive = join(dir, "alive");
	const release = join(dir, "release");
	return {
		// It also ends once the directory is gone, so a test that fails never leaves it running.
		command: `while [ ! -e '${release}' ] && [ -d '${dir}' ]; do : > '${alive}'; sleep 0.05; done; echo finished`,
		/** Resolves `true` once the command shows it runs, or `false` if `outcome` settles first. */
		async runs(outcome: Promise<unknown>) {
			rmSync(alive, { force: true });
			let settled = false;
			void outcome.finally(() => {
				settled = true;
			});
			// Real I/O, polled without timers: setTimeout is fake here.
			while (!existsSync(alive) && !settled) await new Promise((resolve) => setImmediate(resolve));
			return existsSync(alive);
		},
		release: () => writeFileSync(release, ""),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("bash timeout validation", () => {
	const context = {} as never;

	test("sets no deadline when timeout is omitted and accepts a timeout of any length", async () => {
		const observed: number[] = [];
		const bash = createBashToolDefinition(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, options) => {
					observed.push(options.timeout ?? -1);
					return { exitCode: 0 };
				},
			},
		});

		await bash.execute("default", { command: "true" }, undefined, undefined, context);
		for (const timeout of [3600, 3600.5, 86400, 10_000_000])
			await bash.execute("long", { command: "true", timeout }, undefined, undefined, context);

		expect(observed).toEqual([-1, 3600, 3600.5, 86400, 10_000_000]);
	});

	test("honours a fractional timeout instead of flooring it to whole seconds", async () => {
		const observed: number[] = [];
		const bash = createBashToolDefinition(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, options) => {
					observed.push(options.timeout ?? -1);
					return { exitCode: 0 };
				},
			},
		});

		for (const timeout of [1.9, 0.29, 0.0001]) {
			await bash.execute("fraction", { command: "true", timeout }, undefined, undefined, context);
		}

		// The nearest whole millisecond, and at least one.
		expect(observed).toEqual([1.9, 0.29, 0.001]);
	});

	test("stops a command at a fractional timeout, not at the whole second it floors to", async () => {
		const bash = createBashToolDefinition(process.cwd());

		await expect(
			bash.execute("fraction", { command: "sleep 30", timeout: 0.5 }, undefined, undefined, context),
		).rejects.toThrow(/Command timed out after 0\.5 seconds/);
	});

	test("local operations accept an omitted timeout and one of a day", async () => {
		const operations = createLocalBashOperations();
		await expect(operations.exec("true", process.cwd(), { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
		await expect(operations.exec("true", process.cwd(), { timeout: 86400, onData: () => {} })).resolves.toEqual({
			exitCode: 0,
		});
	});

	test.runIf(process.platform !== "win32")(
		"a command without a timeout keeps running past the 300 seconds that used to stop it",
		async () => {
			const held = heldCommand();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const running = createBashToolDefinition(process.cwd()).execute(
					"no-deadline",
					{ command: held.command },
					undefined,
					undefined,
					context,
				);
				expect(await held.runs(running)).toBe(true);
				await vi.advanceTimersByTimeAsync(3_600_000);
				expect(await held.runs(running)).toBe(true);
				vi.useRealTimers();
				held.release();
				const result = await running;
				expect(result.content[0]).toEqual({ type: "text", text: "finished\n" });
				expect(result.details?.timeoutSeconds).toBeUndefined();
			} finally {
				vi.useRealTimers();
				held.cleanup();
			}
		},
	);

	test.runIf(process.platform !== "win32")(
		"a timeout longer than Node's longest timer stops the command at its deadline, not at once",
		async () => {
			const held = heldCommand();
			const timeoutSeconds = 30 * 86_400;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const running = createBashToolDefinition(process.cwd()).execute(
					"month",
					{ command: held.command, timeout: timeoutSeconds },
					undefined,
					undefined,
					context,
				);
				const outcome = running.then(
					() => "finished",
					(error: Error) => error.message,
				);
				expect(await held.runs(outcome)).toBe(true);
				// Past Node's longest timer, which a deadline set as one timer would have fired at once.
				await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS + DAY_MS);
				expect(await held.runs(outcome)).toBe(true);
				await vi.advanceTimersByTimeAsync(timeoutSeconds * 1000);
				vi.useRealTimers();
				expect(await outcome).toMatch(/Command timed out after 2592000 seconds$/);
			} finally {
				vi.useRealTimers();
				held.cleanup();
			}
		},
	);

	test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects an invalid explicit tool timeout: %s",
		async (timeout) => {
			let executed = false;
			const bash = createBashToolDefinition(process.cwd(), {
				operations: {
					exec: async () => {
						executed = true;
						return { exitCode: 0 };
					},
				},
			});

			await expect(
				bash.execute("invalid", { command: "true", timeout }, undefined, undefined, context),
			).rejects.toThrow(/timeout/i);
			expect(executed).toBe(false);
		},
	);

	test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects an invalid local-operation timeout before spawning: %s",
		async (timeout) => {
			await expect(
				createLocalBashOperations().exec("true", process.cwd(), { timeout, onData: () => {} }),
			).rejects.toThrow(/timeout/i);
		},
	);

	test("reports a custom backend's timeout:<seconds> error as a timed-out command with the error as cause", async () => {
		const thrown = new Error("timeout:5");
		const bash = createBashToolDefinition(process.cwd(), {
			operations: {
				exec: async () => {
					throw thrown;
				},
			},
		});

		const error = await bash.execute("custom", { command: "true" }, undefined, undefined, context).then(
			() => undefined,
			(failure: unknown) => failure,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Command timed out after 5 seconds");
		expect((error as Error).cause).toBe(thrown);
	});

	test("rethrows a custom backend's unrelated failure unchanged", async () => {
		const thrown = new Error("spawn failed");
		const bash = createBashToolDefinition(process.cwd(), {
			operations: {
				exec: async () => {
					throw thrown;
				},
			},
		});

		const error = await bash.execute("custom", { command: "true" }, undefined, undefined, context).then(
			() => undefined,
			(failure: unknown) => failure,
		);

		expect(error).toBe(thrown);
	});
});
