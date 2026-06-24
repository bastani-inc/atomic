import { applyPatch } from "diff";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? "";
}

function tagFrom(output: string): string {
	const tag = output.match(/#([0-9A-F]{4})/)?.[1];
	if (!tag) throw new Error(`missing hashline tag in output: ${output}`);
	return tag;
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("edit tool", () => {
		it("applies hashline replace edits and returns an applicable patch", async () => {
			const store = createHashlineSnapshotStore();
			const read = createReadToolDefinition(testDir, { hashlineStore: store });
			const edit = createEditToolDefinition(testDir, { hashlineStore: store });
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!\n";
			writeFileSync(testFile, originalContent);

			const tag = tagFrom(getTextOutput(await read.execute("read", { path: "edit-test.txt" })));
			const result = await edit.execute("edit", { input: `[edit-test.txt#${tag}]\nreplace 1..1:\n+Hello, testing!` });

			expect(getTextOutput(result)).toContain("[edit-test.txt#");
			expect(readFileSync(testFile, "utf-8")).toBe("Hello, testing!\n");
			expect(result.details?.diff).toContain("testing");
			expect(result.details?.patch).toContain("--- ");
			expect(result.details?.patch).toContain("+++ ");
			expect(applyPatch(originalContent, result.details!.patch)).toBe("Hello, testing!\n");
		});

		it("rejects path plus edits input", async () => {
			const edit = createEditToolDefinition(testDir);
			await expect(edit.execute("path-edits", { path: "x.txt", edits: [] } as never)).rejects.toThrow(/hashline script/);
		});

		it("rejects stale tags without modifying the file", async () => {
			const store = createHashlineSnapshotStore();
			const read = createReadToolDefinition(testDir, { hashlineStore: store });
			const edit = createEditToolDefinition(testDir, { hashlineStore: store });
			const testFile = join(testDir, "stale.txt");
			writeFileSync(testFile, "one\n");
			const tag = tagFrom(getTextOutput(await read.execute("read", { path: "stale.txt" })));
			writeFileSync(testFile, "changed outside\n");

			await expect(edit.execute("edit", { input: `[stale.txt#${tag}]\nreplace 1..1:\n+two` })).rejects.toThrow(/file changed between read and edit/);
			expect(readFileSync(testFile, "utf-8")).toBe("changed outside\n");
		});

		it("surfaces access errors for hashline edits", async () => {
			const store = createHashlineSnapshotStore();
			const edit = createEditToolDefinition(testDir, { hashlineStore: store });
			const missingPath = join(testDir, "missing.txt");
			const tag = store.record(missingPath, testDir, "hello\n").tag;

			await expect(edit.execute("missing", { input: `[missing.txt#${tag}]\nreplace 1..1:\n+world` })).rejects.toThrow("Could not edit file: missing.txt. Error code: ENOENT.");
		});

		it("surfaces EACCES for unreadable hashline targets", async () => {
			const store = createHashlineSnapshotStore();
			const read = createReadToolDefinition(testDir, { hashlineStore: store });
			const edit = createEditToolDefinition(testDir, { hashlineStore: store });
			const testFile = join(testDir, "readonly.txt");
			writeFileSync(testFile, "hello\n");
			const tag = tagFrom(getTextOutput(await read.execute("read", { path: "readonly.txt" })));
			chmodSync(testFile, 0o444);

			await expect(edit.execute("readonly", { input: `[readonly.txt#${tag}]\nreplace 1..1:\n+world` })).rejects.toThrow(/Could not edit file: readonly.txt|EACCES|permission/i);
		});
	});
});
