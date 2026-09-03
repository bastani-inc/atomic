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
				protectedPaths: ["tracked.txt", "user-notes.txt", "dirty-submodule"],
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
			mkdirSync(join(harness.tempDir, "dirty-submodule"));
			writeFileSync(join(harness.tempDir, "dirty-submodule/nested.txt"), "nested user bytes\n");
			const originalNested = readFileSync(join(harness.tempDir, "dirty-submodule/nested.txt"));
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

			const nestedOverwrite = (await beforeToolCall({
				toolCall: { id: "write-protected-descendant", name: "write" },
				args: { path: "dirty-submodule/nested.txt", content: "debugger overwrite\n" },
			})) as ToolCallEventResult | undefined;
			assert.deepEqual(nestedOverwrite, { block: true, reason: SUBAGENT_PROTECTED_PATHS_REFUSAL });

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
			assert.deepEqual(readFileSync(join(harness.tempDir, "dirty-submodule/nested.txt")), originalNested);
		} finally {
			harness.cleanup();
		}
	});

	test("blocks LF and CRLF shell command separators before a mutation", async () => {
		// #2799: shells treat newlines as command separators, not argument whitespace.
		const harness = await createHarness({
			subagentPolicy: {
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: true,
				inheritSkills: true,
				protectedPaths: ["dirty.txt"],
			},
		});
		try {
			writeFileSync(join(harness.tempDir, "dirty.txt"), "user bytes\n");
			const beforeToolCall = harness.session.agent.beforeToolCall;
			assert.ok(beforeToolCall);

			for (const [toolName, command] of [
				["bash", "cat dirty.txt\nrm -f dirty.txt"],
				["powershell", "Get-Content dirty.txt\r\nRemove-Item dirty.txt"],
			] as const) {
				const result = (await beforeToolCall({
					toolCall: { id: `newline-${toolName}`, name: toolName },
					args: { command },
				})) as ToolCallEventResult | undefined;
				assert.deepEqual(result, { block: true, reason: SUBAGENT_PROTECTED_BASH_REFUSAL }, toolName);
			}
			assert.equal(readFileSync(join(harness.tempDir, "dirty.txt"), "utf8"), "user bytes\n");
		} finally {
			harness.cleanup();
		}
	});

	test("allows proven read-only diagnostics and safe artifacts while blocking direct and indirect shell mutation", async () => {
		// #2799: keep ordinary debugger diagnostics without risking pre-existing work.
		const harness = await createHarness({
			subagentPolicy: {
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: true,
				inheritSkills: true,
				protectedPaths: ["tracked.txt", "user-notes.txt", "dirty-submodule"],
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
			mkdirSync(join(harness.tempDir, "dirty-submodule"));
			writeFileSync(join(harness.tempDir, "dirty-submodule/nested.txt"), "nested user bytes\n");
			writeFileSync(join(harness.tempDir, "repro.js"), "console.log('safe repro');\n");
			const originalTracked = readFileSync(join(harness.tempDir, "tracked.txt"));
			const originalNotes = readFileSync(join(harness.tempDir, "user-notes.txt"));
			const originalNested = readFileSync(join(harness.tempDir, "dirty-submodule/nested.txt"));
			const beforeToolCall = harness.session.agent.beforeToolCall;
			assert.ok(beforeToolCall);

			const allowed = [
				"git status --short",
				"git diff -- tracked.txt",
				"git log -1 --oneline",
				"git rev-parse --show-toplevel",
				"git diff --check",
				"test -f tracked.txt",
				"node --check repro.js",
				"printf safe-reproduction",
				"mkdir -p diagnostics && touch diagnostics/repro.log && rm diagnostics/repro.log",
			];
			for (const command of allowed) {
				assert.equal(
					await beforeToolCall({ toolCall: { id: `allowed-${command}`, name: "bash" }, args: { command } }),
					undefined,
					command,
				);
			}

			const blocked = [
				"rm -f tracked.txt",
				"rm -f dirty-submodule/nested.txt",
				"printf overwrite > tracked.txt",
				"touch user-notes.txt",
				"git checkout -- tracked.txt",
				"git reset --hard",
				"find . -delete",
				"find . -fls diagnostics/find.log",
				"node -e \"require('node:fs').writeFileSync('tracked.txt','overwrite')\"",
				"npm test",
				"sh ./indirect.sh",
				"rm -rf .",
			];
			for (const command of blocked) {
				const result = (await beforeToolCall({
					toolCall: { id: `blocked-${command}`, name: "bash" },
					args: { command },
				})) as ToolCallEventResult | undefined;
				assert.deepEqual(result, { block: true, reason: SUBAGENT_PROTECTED_BASH_REFUSAL }, command);
			}
			for (const command of ["git status --short", "Get-Content tracked.txt"]) {
				assert.equal(
					await beforeToolCall({
						toolCall: { id: `allowed-ps-${command}`, name: "powershell" },
						args: { command },
					}),
					undefined,
					command,
				);
			}
			for (const command of [
				"Set-Content tracked.txt overwrite",
				"& ./indirect.ps1",
				"git checkout -- tracked.txt",
			]) {
				const result = (await beforeToolCall({
					toolCall: { id: `blocked-ps-${command}`, name: "powershell" },
					args: { command },
				})) as ToolCallEventResult | undefined;
				assert.deepEqual(result, { block: true, reason: SUBAGENT_PROTECTED_BASH_REFUSAL }, command);
			}

			const bash = harness.session.getToolDefinition("bash");
			assert.ok(bash);
			await bash.execute(
				"real-readonly-diagnostics",
				{
					command:
						"git status --short && node --check repro.js && mkdir -p diagnostics && touch diagnostics/repro.log",
				},
				undefined,
				undefined,
				undefined as never,
			);
			assert.deepEqual(readFileSync(join(harness.tempDir, "tracked.txt")), originalTracked);
			assert.deepEqual(readFileSync(join(harness.tempDir, "user-notes.txt")), originalNotes);
			assert.deepEqual(readFileSync(join(harness.tempDir, "dirty-submodule/nested.txt")), originalNested);
			assert.equal(readFileSync(join(harness.tempDir, "diagnostics/repro.log"), "utf8"), "");
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

	test("blocks protected POSIX colon paths and every writable selector alias", async () => {
		// #2799: selector resolution must happen before protected-path matching.
		const protectedPaths = ["dirty:report.txt", ".agents/skills/demo/SKILL.md", "state.db", "bundle.zip"];
		const harness = await createHarness({
			subagentPolicy: {
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: true,
				inheritSkills: true,
				protectedPaths,
			},
		});
		try {
			mkdirSync(join(harness.tempDir, ".agents/skills/demo"), { recursive: true });
			for (const [path, bytes] of [
				["dirty:report.txt", "colon bytes\n"],
				[".agents/skills/demo/SKILL.md", "skill bytes\n"],
				["state.db", "database bytes\n"],
				["bundle.zip", "archive bytes\n"],
			] as const) {
				writeFileSync(join(harness.tempDir, path), bytes);
			}
			const originals = new Map(protectedPaths.map((path) => [path, readFileSync(join(harness.tempDir, path))]));
			const beforeToolCall = harness.session.agent.beforeToolCall;
			assert.ok(beforeToolCall);

			for (const path of [
				"dirty:report.txt",
				"local://dirty:report.txt",
				"skill://demo/SKILL.md",
				"state.db:records:1",
				"bundle.zip:member.txt",
				"artifact://unknown/output.txt",
				"conflict://1",
			]) {
				const blocked = (await beforeToolCall({
					toolCall: { id: `selector-${path}`, name: "write" },
					args: { path, content: "debugger overwrite\n" },
				})) as ToolCallEventResult | undefined;
				assert.deepEqual(blocked, { block: true, reason: SUBAGENT_PROTECTED_PATHS_REFUSAL }, path);
			}

			for (const path of ["dirty:report.txt", "skill://demo/SKILL.md"]) {
				const blocked = (await beforeToolCall({
					toolCall: { id: `edit-selector-${path}`, name: "edit" },
					args: { input: `[${path}#ABCD]\ndelete 1` },
				})) as ToolCallEventResult | undefined;
				assert.deepEqual(blocked, { block: true, reason: SUBAGENT_PROTECTED_PATHS_REFUSAL }, path);
			}

			for (const [path, bytes] of originals) assert.deepEqual(readFileSync(join(harness.tempDir, path)), bytes);
		} finally {
			harness.cleanup();
		}
	});
});
