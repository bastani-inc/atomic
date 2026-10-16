import assert from "node:assert/strict";
import { resolve } from "node:path";
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
	for (const cwd of [undefined, resolve("/repo")]) {
		test(`compaction tracks ${nested ? "nested" : "direct"} multi-file hashline edits${cwd ? " with cwd-normalized paths" : ""} (#3656)`, () => {
			const operations = createFileOps();
			const calls = [
				{ id: "read-source", name: "read", arguments: { path: cwd ? resolve(cwd, "source.ts") : "source.ts" } },
				{ id: "read-notes", name: "read", arguments: { path: "notes.md" } },
				{ id: "read-web", name: "read", arguments: { path: "https://example.com/guide" } },
				{ id: "read-skill", name: "read", arguments: { path: "skill://tdd/SKILL.md" } },
				{ id: "read-written", name: "read", arguments: { path: cwd ? resolve(cwd, "written.ts") : "written.ts" } },
				{ id: "write", name: "write", arguments: { path: "written.ts", content: "created" } },
				{
					id: "edit",
					name: "edit",
					arguments: {
						input: "[source.ts#A1B2]\nreplace 1..1:\n+changed\n[another file.ts#c3d4]\ninsert tail:\n+[payload.ts#ABCD]",
					},
				},
				{ id: "edit-again", name: "edit", arguments: { input: "[./source.ts#E5F6]\ndelete 2" } },
			];
			if (cwd)
				calls.push(
					{ id: "read-outside", name: "read", arguments: { path: resolve(cwd, "../repo-other/source.ts") } },
					{ id: "edit-outside", name: "edit", arguments: { input: "[../repo-other/source.ts#A1B2]\ndelete 1" } },
				);
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
				cwd,
			);
			assert.deepEqual(computeFileLists(operations), {
				readFiles: ["https://example.com/guide", "notes.md", "skill://tdd/SKILL.md"],
				modifiedFiles: [
					...(cwd ? [resolve(cwd, "../repo-other/source.ts")] : ["./source.ts"]),
					"another file.ts",
					"source.ts",
					"written.ts",
				].sort(),
			});
		});
	}
}
