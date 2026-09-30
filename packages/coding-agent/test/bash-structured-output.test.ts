import assert from "node:assert/strict";
import { test } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { DEFAULT_MAX_LINES } from "../src/core/tools/truncate.js";

test("completed bash gives scripts full output beyond the model-facing cap", async () => {
	const output = "line\n".repeat(DEFAULT_MAX_LINES + 100);
	const tool = createBashToolDefinition(process.cwd(), {
		operations: {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(output));
				return { exitCode: 0 };
			},
		},
	});
	const result = await tool.execute("structured", { command: "fixture" });
	assert.ok(
		result.structuredContent &&
			typeof result.structuredContent === "object" &&
			!Array.isArray(result.structuredContent),
	);
	assert.equal(result.structuredContent.output, output);
	assert.equal(result.structuredContent.truncated, false);
	assert.equal(result.structuredContent.exit_code, 0);
	assert.equal(typeof result.structuredContent.wall_time_seconds, "number");
	assert.ok(result.content[0].type === "text" && result.content[0].text.includes("Showing"));
});

test("structured bash caps oversized output with head, tail and full output path", async () => {
	const output = `HEAD${"x".repeat(2 * 1024 * 1024)}TAIL`;
	const tool = createBashToolDefinition(process.cwd(), {
		operations: {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(output));
				return { exitCode: 7 };
			},
		},
	});
	const result = await tool.execute("oversized", { command: "fixture" });
	const structured = result.structuredContent;
	assert.ok(structured && typeof structured === "object" && !Array.isArray(structured));
	assert.equal(structured.truncated, true);
	assert.equal(structured.exit_code, 7);
	assert.equal(result.isError, true);
	assert.equal(typeof structured.full_output_path, "string");
	assert.ok(
		typeof structured.output === "string" &&
			structured.output.startsWith("HEAD") &&
			structured.output.endsWith("TAIL"),
	);
	assert.ok(typeof structured.output === "string" && structured.output.includes("bytes omitted"));
});
