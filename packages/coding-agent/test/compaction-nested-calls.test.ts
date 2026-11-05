import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
		test(`compaction tracks ${nested ? "nested" : "direct"} edits across files${cwd ? " with cwd-normalized paths" : ""} (#3656)`, () => {
			const operations = createFileOps();
			const replace = [{ oldText: "a", newText: "b" }];
			const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [
				{ id: "read-source", name: "read", arguments: { path: cwd ? resolve(cwd, "source.ts") : "source.ts" } },
				{ id: "read-notes", name: "read", arguments: { path: "notes.md" } },
				{ id: "read-web", name: "read", arguments: { path: "https://example.com/guide" } },
				{ id: "read-skill", name: "read", arguments: { path: "skill://tdd/SKILL.md" } },
				{ id: "read-written", name: "read", arguments: { path: cwd ? resolve(cwd, "written.ts") : "written.ts" } },
				{ id: "write", name: "write", arguments: { path: "written.ts", content: "created" } },
				{ id: "edit", name: "edit", arguments: { path: "source.ts", edits: replace } },
				{ id: "edit-other", name: "edit", arguments: { path: "another file.ts", edits: replace } },
				{ id: "edit-again", name: "edit", arguments: { path: "./source.ts", edits: replace } },
				{ id: "edit-old-session", name: "edit", arguments: { input: "[old.ts#A1B2]\ndelete 1" } },
			];
			if (cwd)
				calls.push(
					{ id: "read-outside", name: "read", arguments: { path: resolve(cwd, "../repo-other/source.ts") } },
					{ id: "edit-outside", name: "edit", arguments: { path: "../repo-other/source.ts", edits: replace } },
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

test("compaction resolves file-operation paths like the file tools do (#3656)", () => {
	const cwd = resolve("/repo");
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
					{ id: "write-home", name: "write", arguments: { path: "~/../shared/file.ts" }, status: "ok" },
					{ id: "read-at", name: "read", arguments: { path: "@src/app.ts" }, status: "ok" },
				],
			},
		},
		operations,
		cwd,
	);
	assert.deepEqual(computeFileLists(operations), {
		readFiles: [join("src", "app.ts")],
		modifiedFiles: [resolve(homedir(), "../shared/file.ts")],
	});
});
