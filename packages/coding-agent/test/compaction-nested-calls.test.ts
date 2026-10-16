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

for (const nested of [false, true]) {
	test(`compaction tracks ${nested ? "nested" : "direct"} multi-file hashline edits (#3656)`, () => {
		const operations = createFileOps();
		const calls = [
			{ id: "read-source", name: "read", arguments: { path: "source.ts" } },
			{ id: "read-notes", name: "read", arguments: { path: "notes.md" } },
			{ id: "write", name: "write", arguments: { path: "written.ts", content: "created" } },
			{
				id: "edit",
				name: "edit",
				arguments: {
					input: "[source.ts#A1B2]\nreplace 1..1:\n+changed\n[another file.ts#c3d4]\ninsert tail:\n+[payload.ts#ABCD]",
				},
			},
			{ id: "edit-again", name: "edit", arguments: { input: "[source.ts#E5F6]\ndelete 2" } },
		];
		extractFileOpsFromMessage(
			nested
				? {
						role: "toolResult",
						toolCallId: "script",
						toolName: "codemode",
						content: [],
						isError: false,
						timestamp: 1,
						nestedCalls: { complete: true, calls: calls.map((call) => ({ ...call, status: "ok" })) },
					}
				: {
						role: "assistant",
						content: calls.map((call) => ({ ...call, type: "toolCall" })),
						api: "anthropic-messages",
						provider: "anthropic",
						model: "test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 1,
					},
			operations,
		);
		assert.deepEqual(computeFileLists(operations), {
			readFiles: ["notes.md"],
			modifiedFiles: ["another file.ts", "source.ts", "written.ts"],
		});
	});
}
