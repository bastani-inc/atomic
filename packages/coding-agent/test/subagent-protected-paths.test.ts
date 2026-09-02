import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { ToolCallEventResult } from "../src/core/extensions/index.ts";
import {
	SUBAGENT_PROTECTED_BASH_REFUSAL,
	SUBAGENT_PROTECTED_PATHS_REFUSAL,
} from "../src/core/subagent-protected-paths.ts";
import { createHarness } from "./suite/harness.ts";

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("foreground subagent protected-path policy", () => {
	test("blocks overwrite and delete attempts while preserving dirty files byte-for-byte", async () => {
		const harness = await createHarness({
			subagentPolicy: {
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: true,
				inheritSkills: true,
				protectedPaths: ["tracked.txt", "user-notes.txt"],
			},
		});
		try {
			git(harness.tempDir, ["init", "-q"]);
			git(harness.tempDir, ["config", "user.name", "Feedback Test"]);
			git(harness.tempDir, ["config", "user.email", "feedback@example.invalid"]);
			git(harness.tempDir, ["config", "--local", "commit.gpgsign", "false"]);
			writeFileSync(join(harness.tempDir, "tracked.txt"), "committed\n");
			git(harness.tempDir, ["add", "tracked.txt"]);
			git(harness.tempDir, ["commit", "-qm", "fixture"]);
			writeFileSync(join(harness.tempDir, "tracked.txt"), "user tracked bytes\n");
			writeFileSync(join(harness.tempDir, "user-notes.txt"), "user untracked bytes\n");
			const originalTracked = readFileSync(join(harness.tempDir, "tracked.txt"));
			const originalNotes = readFileSync(join(harness.tempDir, "user-notes.txt"));
			const beforeToolCall = harness.session.agent.beforeToolCall;
			assert.ok(beforeToolCall);

			const overwrite = (await beforeToolCall({
				toolCall: { id: "write-protected", name: "write" },
				args: { path: "tracked.txt", content: "debugger overwrite\n" },
			})) as ToolCallEventResult | undefined;
			assert.deepEqual(overwrite, { block: true, reason: SUBAGENT_PROTECTED_PATHS_REFUSAL });

			const editDelete = (await beforeToolCall({
				toolCall: { id: "edit-protected", name: "edit" },
				args: { input: "[user-notes.txt#ABCD]\ndelete 1" },
			})) as ToolCallEventResult | undefined;
			assert.deepEqual(editDelete, { block: true, reason: SUBAGENT_PROTECTED_PATHS_REFUSAL });

			const shellDelete = (await beforeToolCall({
				toolCall: { id: "bash-protected", name: "bash" },
				args: { command: "rm -f tracked.txt user-notes.txt" },
			})) as ToolCallEventResult | undefined;
			assert.deepEqual(shellDelete, { block: true, reason: SUBAGENT_PROTECTED_BASH_REFUSAL });

			const todoMutation = (await beforeToolCall({
				toolCall: { id: "todo-protected", name: "todo" },
				args: { action: "update", id: "TODO-synthetic", body: "debugger overwrite" },
			})) as ToolCallEventResult | undefined;
			assert.equal(todoMutation?.block, true);

			assert.deepEqual(readFileSync(join(harness.tempDir, "tracked.txt")), originalTracked);
			assert.deepEqual(readFileSync(join(harness.tempDir, "user-notes.txt")), originalNotes);
		} finally {
			harness.cleanup();
		}
	});

	test("keeps read-only tools and new diagnostic artifacts available", async () => {
		const harness = await createHarness({
			subagentPolicy: {
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: true,
				inheritSkills: true,
				protectedPaths: ["user-work.txt"],
			},
		});
		try {
			writeFileSync(join(harness.tempDir, "user-work.txt"), "keep\n");
			const beforeToolCall = harness.session.agent.beforeToolCall;
			assert.ok(beforeToolCall);
			for (const [name, args] of [
				["read", { path: "user-work.txt" }],
				["search", { pattern: "keep", paths: ["user-work.txt"] }],
				["find", { paths: ["*.txt"] }],
				["ls", { path: "." }],
			] as const) {
				assert.equal(await beforeToolCall({ toolCall: { id: `readonly-${name}`, name }, args }), undefined);
			}
			assert.equal(
				await beforeToolCall({ toolCall: { id: "readonly-todo", name: "todo" }, args: { action: "list" } }),
				undefined,
			);

			const artifactArgs = { path: "diagnostics/debug.log", content: "diagnostic\n" };
			assert.equal(
				await beforeToolCall({ toolCall: { id: "write-artifact", name: "write" }, args: artifactArgs }),
				undefined,
			);
			mkdirSync(join(harness.tempDir, "diagnostics"), { recursive: true });
			const write = harness.session.getToolDefinition("write");
			assert.ok(write);
			await write.execute("write-artifact", artifactArgs, undefined, undefined, undefined as never);
			assert.equal(readFileSync(join(harness.tempDir, "diagnostics/debug.log"), "utf8"), "diagnostic\n");
			assert.equal(readFileSync(join(harness.tempDir, "user-work.txt"), "utf8"), "keep\n");
		} finally {
			harness.cleanup();
		}
	});
});
