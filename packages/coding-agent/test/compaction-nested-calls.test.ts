import assert from "node:assert/strict";
import { test } from "vitest";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.js";

test("compaction retains file operations performed by nested tools", () => {
	const operations = createFileOps();
	extractFileOpsFromMessage(
		{
			role: "toolResult",
			toolCallId: "script",
			toolName: "codemode",
			content: [],
			isError: false,
			timestamp: 1,
			nestedCalls: {
				complete: true,
				calls: [
					{ id: "script/1", name: "read", arguments: { path: "source.ts" }, status: "ok" },
					{ id: "script/2", name: "edit", arguments: { path: "source.ts" }, status: "ok" },
					{ id: "script/3", name: "read", arguments: { path: "notes.md" }, status: "ok" },
				],
			},
		},
		operations,
	);
	assert.deepEqual(computeFileLists(operations), { readFiles: ["notes.md"], modifiedFiles: ["source.ts"] });
});
