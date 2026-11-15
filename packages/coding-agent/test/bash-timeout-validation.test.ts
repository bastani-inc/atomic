import { describe, expect, test } from "vitest";
import { createBashToolDefinition, createLocalBashOperations } from "../src/core/tools/bash.ts";

describe("bash timeout validation", () => {
	const context = {} as never;

	test("uses the Atomic default when timeout is omitted and accepts the 3600 second maximum", async () => {
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
		await bash.execute("maximum", { command: "true", timeout: 3600 }, undefined, undefined, context);

		expect(observed).toEqual([300, 3600]);
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

	test("lets a command finish within a fractional timeout longer than its whole seconds", async () => {
		const bash = createBashToolDefinition(process.cwd());

		const result = await bash.execute(
			"fraction",
			{ command: "sleep 1.2; echo done", timeout: 1.9 },
			undefined,
			undefined,
			context,
		);

		expect(result.content).toEqual([{ type: "text", text: "done\n" }]);
		expect(result.details?.timeoutSeconds).toBe(1.9);
	});

	test("local operations accept omitted timeout and the 3600 second maximum", async () => {
		const operations = createLocalBashOperations();
		await expect(operations.exec("true", process.cwd(), { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
		await expect(operations.exec("true", process.cwd(), { timeout: 3600, onData: () => {} })).resolves.toEqual({
			exitCode: 0,
		});
	});

	test.each([0, -1, 3600.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
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

	test.each([0, -1, 3600.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
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
