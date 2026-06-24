import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { splitReadLineSelector } from "../src/core/tools/read-selectors.ts";

const tempDirs: string[] = [];
const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((item) => item.text ?? "").join("\n");
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "atomic-hashline-recovery-")); tempDirs.push(dir); return dir; }

afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("hashline recovery and read selector parity", () => {
	it("recovers hashline edits across non-overlapping external drift", async () => {
		const dir = await tempDir(), store = createHashlineSnapshotStore(), file = join(dir, "stale.txt");
		await writeFile(file, "one\ntwo\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore: store });
		const tag = text(await read.execute("read", { path: "stale.txt" }, undefined, undefined, {} as ExtensionContext)).match(/#([0-9A-F]{4})/)?.[1];
		expect(tag).toBeTruthy();
		await writeFile(file, "one\ntwo\nthree\n", "utf8");
		const output = text(await createEditToolDefinition(dir, { hashlineStore: store }).execute("edit", { input: `[stale.txt#${tag}]\nreplace 1..1:\n+ONE` }, undefined, undefined, {} as ExtensionContext));
		expect(output).toContain("Recovered from a stale file hash");
		expect(await readFile(file, "utf8")).toBe("ONE\ntwo\nthree\n");
	});

	it("rejects separated hunks against an in-place external modification (re-read required)", async () => {
		const dir = await tempDir(), store = createHashlineSnapshotStore(), file = join(dir, "multi.txt");
		await writeFile(file, "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore: store });
		const tag = text(await read.execute("read", { path: "multi.txt" }, undefined, undefined, {} as ExtensionContext)).match(/#([0-9A-F]{4})/)?.[1];
		// In-place external edit to an unrelated line; oh-my-pi recovery targets in-session edit
		// chains and append drift, so a multi-hunk patch over an externally modified file is rejected.
		await writeFile(file, "one\ntwo\nTHREE\nfour\nfive\nsix\n", "utf8");
		await expect(createEditToolDefinition(dir, { hashlineStore: store }).execute("edit", { input: `[multi.txt#${tag}]\nreplace 1..1:\n+ONE\nreplace 6..6:\n+SIX` }, undefined, undefined, {} as ExtensionContext)).rejects.toThrow(/file changed between read and edit/);
		expect(await readFile(file, "utf8")).toBe("one\ntwo\nTHREE\nfour\nfive\nsix\n");
	});

	it("recovers hashline edits shifted by external insertions above", async () => {
		const dir = await tempDir(), store = createHashlineSnapshotStore(), file = join(dir, "shifted.txt");
		await writeFile(file, "a\nb\nc\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore: store });
		const tag = text(await read.execute("read", { path: "shifted.txt" }, undefined, undefined, {} as ExtensionContext)).match(/#([0-9A-F]{4})/)?.[1];
		await writeFile(file, "x\na\nb\nc\n", "utf8");
		await createEditToolDefinition(dir, { hashlineStore: store }).execute("edit", { input: `[shifted.txt#${tag}]\nreplace 3..3:\n+C` }, undefined, undefined, {} as ExtensionContext);
		expect(await readFile(file, "utf8")).toBe("x\na\nb\nC\n");
	});

	it("sorts raw multi-range reads and rejects open-ended plus selectors", async () => {
		const dir = await tempDir(), store = createHashlineSnapshotStore();
		await writeFile(join(dir, "lines.txt"), "one\ntwo\nthree\nfour\n", "utf8");
		const output = text(await createReadToolDefinition(dir, { hashlineStore: store }).execute("raw", { path: "lines.txt:3-3,1-1:raw" }, undefined, undefined, {} as ExtensionContext));
		expect(output).toBe("one\nthree");
		expect(() => splitReadLineSelector("lines.txt:2+")).toThrow(/\+ requires a line count/);
	});
});
