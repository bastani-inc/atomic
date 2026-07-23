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

	test("local operations accept omitted timeout and the 3600 second maximum", async () => {
		const operations = createLocalBashOperations();
		await expect(operations.exec("true", process.cwd(), { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
		await expect(operations.exec("true", process.cwd(), { timeout: 3600, onData: () => {} })).resolves.toEqual({ exitCode: 0 });
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

			await expect(bash.execute("invalid", { command: "true", timeout }, undefined, undefined, context)).rejects.toThrow(
				/timeout/i,
			);
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
});
