import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.js";
import { bashExecutionToText } from "../src/core/messages.js";

describe("user bash output truncation (pi #10164)", () => {
	const tempFiles: string[] = [];

	afterEach(async () => {
		await Promise.all(tempFiles.splice(0).map((path) => rm(path, { force: true })));
	});

	// The retained tail can fit even though earlier output was discarded.
	it.each([false, true])("reports discarded chunks when cancelled=%s", async (cancelled) => {
		const first = "error: missing build dependency\n".padEnd(64 * 1024, "x");
		const last = "remaining build output\n".padEnd(44 * 1024, "y");
		const controller = new AbortController();
		const result = await executeBashWithOperations(
			"cat build.log",
			process.cwd(),
			{
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(first));
					onData(Buffer.from(last));
					if (cancelled) {
						controller.abort();
						throw new Error("aborted");
					}
					return { exitCode: 0 };
				},
			},
			{ signal: controller.signal },
		);
		assert.ok(result.fullOutputPath);
		tempFiles.push(result.fullOutputPath);
		await vi.waitFor(async () => {
			assert.equal(await readFile(result.fullOutputPath!, "utf-8"), first + last);
		});

		assert.equal(result.cancelled, cancelled);
		assert.equal(result.output, last);
		assert.equal(result.truncated, true);
		assert.ok(
			bashExecutionToText({ role: "bashExecution", command: "cat build.log", timestamp: 0, ...result }).includes(
				`[Output truncated. Full output: ${result.fullOutputPath}]`,
			),
		);
	});

	it("does not mark short output as truncated", async () => {
		const result = await executeBashWithOperations("echo done", process.cwd(), {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("done\n"));
				return { exitCode: 0 };
			},
		});
		assert.equal(result.output, "done\n");
		assert.equal(result.truncated, false);
		assert.equal(result.fullOutputPath, undefined);
	});

	it("does not mark short output as truncated when the command was cancelled", async () => {
		const controller = new AbortController();
		const result = await executeBashWithOperations(
			"sleep 30",
			process.cwd(),
			{
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("partial\n"));
					controller.abort();
					throw new Error("aborted");
				},
			},
			{ signal: controller.signal },
		);
		assert.equal(result.cancelled, true);
		assert.equal(result.output, "partial\n");
		assert.equal(result.truncated, false);
		assert.equal(result.fullOutputPath, undefined);
	});
});
