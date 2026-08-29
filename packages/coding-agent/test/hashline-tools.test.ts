import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { containsRecognizableHashlineOperations, parsePatch } from "../src/core/tools/hashline-engine/index.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { splitReadLineSelector } from "../src/core/tools/read-selectors.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];
const hashlineStore = createHashlineSnapshotStore();
const hashlineEngineDir = join(dirname(fileURLToPath(import.meta.url)), "../src/core/tools/hashline-engine");

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "atomic-hashline-tools-"));
	tempDirs.push(dir);
	return dir;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("hashline file tool parity", () => {
	it("read bounded line selectors include reference context and do not treat URL ports as lines", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "lines.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const output = text(
			await read.execute("read-line", { path: "lines.txt:5-5" }, undefined, undefined, {} as ExtensionContext),
		);
		expect(output).toContain("5:five");
		expect(output).toContain("4:four");
		expect(output).toContain("6:six");
		expect(splitReadLineSelector("http://localhost:3000")).toMatchObject({ path: "http://localhost:3000" });
	});

	it("reads colon-delimited START:END selectors as a line range instead of a broken path", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "lines.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const output = text(
			await read.execute(
				"read-colon-range",
				{ path: "lines.txt:2:4" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("2:two");
		expect(output).toContain("4:four");
		expect(output).not.toContain("no such file or directory");
		expect(splitReadLineSelector("/abs/Sat.Solver.fst:395:470")).toMatchObject({
			path: "/abs/Sat.Solver.fst",
			ranges: [{ start: 395, end: 470 }],
		});
		expect(splitReadLineSelector("/abs/Sat.Solver.fst:395")).toMatchObject({
			path: "/abs/Sat.Solver.fst",
			offset: 395,
		});
		expect(splitReadLineSelector("/abs/file.ts:40:8")).toMatchObject({ path: "/abs/file.ts", offset: 40 });
	});

	it("raw bounded reads do not include reference context", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "lines.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-raw-range",
				{ path: "lines.txt:3-3:raw" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toBe("three");
	});

	it("does not hashline-tag single-line byte-limit warnings", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "emoji.txt"), "😀".repeat(20_000), "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-emoji",
				{ path: "emoji.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("exceeds");
		expect(output).not.toContain("[emoji.txt#");
	});

	it("conflict-only reads preserve original hashline line numbers", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "conflict.txt"), "pre\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\npost\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const output = text(
			await read.execute(
				"read-conflicts",
				{ path: "conflict.txt:conflicts" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("2:<<<<<<< ours");
		expect(output).toContain("6:>>>>>>> theirs");
		expect(output).not.toContain("1:<<<<<<< ours");
	});

	it("conflict-only reads without markers are not hashline-tagged", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "plain.txt"), "alpha\nbeta\n", "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-no-conflicts",
				{ path: "plain.txt:conflicts" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toBe("No conflict markers found");
		expect(output).not.toContain("[plain.txt#");
	});

	it("custom read operations do not require local fsStat", async () => {
		const read = createReadToolDefinition("/tmp/nonexistent-atomic-cwd", {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from("remote\ncontent\n"),
				resolvePath: (path, cwd) => posix.resolve(cwd, path),
			},
			hashlineStore,
		});
		const output = text(
			await read.execute("read-custom-ops", { path: "remote.txt" }, undefined, undefined, {} as ExtensionContext),
		);
		expect(output).toContain("remote");
		expect(output).toContain("content");
	});

	it("custom read operations handle non-SQLite .db line selectors", async () => {
		const read = createReadToolDefinition("/tmp/nonexistent-atomic-cwd", {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from("one\ntwo\nthree\n"),
				resolvePath: (path, cwd) => posix.resolve(cwd, path),
			},
			hashlineStore,
		});
		const output = text(
			await read.execute("read-custom-db", { path: "notes.db:2-2" }, undefined, undefined, {} as ExtensionContext),
		);
		expect(output).toContain("two");
	});

	it("conflict-only reads preserve original line numbers after line-range selection", async () => {
		const dir = await createTempDir();
		await writeFile(
			join(dir, "conflict-range.txt"),
			"pre\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\npost\n",
			"utf8",
		);
		const read = createReadToolDefinition(dir, { hashlineStore });
		const output = text(
			await read.execute(
				"read-conflict-range",
				{ path: "conflict-range.txt:conflicts:3+1" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("3:left");
		expect(output).toContain("4:=======");
		expect(output).toContain("5:right");
		expect(output).toContain("6:>>>>>>> theirs");
		expect(output).not.toContain("2:left");
	});

	it("conflict-only offset reads preserve original line numbers", async () => {
		const dir = await createTempDir();
		await writeFile(
			join(dir, "conflict-offset.txt"),
			"pre\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\npost\n",
			"utf8",
		);
		const read = createReadToolDefinition(dir, { hashlineStore });
		const output = text(
			await read.execute(
				"read-conflict-offset",
				{ path: "conflict-offset.txt:conflicts:3" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("4:=======");
		expect(output).toContain("5:right");
		expect(output).toContain("6:>>>>>>> theirs");
		expect(output).not.toContain("2:=======");
	});

	it("read emits a hashline tag and edit applies line operations against that snapshot", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "greet.py"), "def greet(name):\n    print(name)\ngreet('world')\n", "utf8");

		const read = createReadToolDefinition(dir, { hashlineStore });
		const readOutput = text(
			await read.execute("read-1", { path: "greet.py" }, undefined, undefined, {} as ExtensionContext),
		);
		expect(readOutput).toMatch(/^\[greet\.py#[0-9A-F]{4}\]\n1:def greet/m);
		const tag = readOutput.match(/\[greet\.py#([0-9A-F]{4})\]/)?.[1];
		expect(tag).toBeTruthy();

		const edit = createEditToolDefinition(dir, { hashlineStore });
		const editOutput = text(
			await edit.execute(
				"edit-1",
				{ input: `[greet.py#${tag}]\nreplace 2..2:\n+    print(f"Hello, {name}")\ninsert tail:\n+# done` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);

		expect(await readFile(join(dir, "greet.py"), "utf8")).toBe(
			"def greet(name):\n    print(f\"Hello, {name}\")\ngreet('world')\n# done\n",
		);
		expect(editOutput).toMatch(/^\[greet\.py#[0-9A-F]{4}\]/);
		expect(editOutput).toContain("+2     print");
	});

	it("insert tail appends before a trailing newline sentinel", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "tail.txt"), "a\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const tag = text(
			await read.execute("read-tail", { path: "tail.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		expect(tag).toBeTruthy();
		await createEditToolDefinition(dir, { hashlineStore }).execute(
			"edit-tail",
			{ input: `[tail.txt#${tag}]\ninsert tail:\n+b` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "tail.txt"), "utf8")).toBe("a\nb\n");
	});

	it("insert tail appends once for files without trailing newline and empty files", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "no-newline.txt"), "a", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const firstTag = text(
			await read.execute(
				"read-tail-no-newline",
				{ path: "no-newline.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).match(/#([0-9A-F]{4})/)?.[1];
		expect(firstTag).toBeTruthy();
		await createEditToolDefinition(dir, { hashlineStore }).execute(
			"edit-tail-no-newline",
			{ input: `[no-newline.txt#${firstTag}]\ninsert tail:\n+b` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "no-newline.txt"), "utf8")).toBe("a\nb");

		await writeFile(join(dir, "empty.txt"), "", "utf8");
		const emptyTag = text(
			await read.execute("read-tail-empty", { path: "empty.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		expect(emptyTag).toBeTruthy();
		await createEditToolDefinition(dir, { hashlineStore }).execute(
			"edit-tail-empty",
			{ input: `[empty.txt#${emptyTag}]\ninsert tail:\n+b` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "empty.txt"), "utf8")).toBe("b");
	});

	it("rejects stale hashline tags without modifying the file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "stale.txt");
		await writeFile(file, "one\ntwo\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const tag = text(
			await read.execute("read-1", { path: "stale.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		expect(tag).toBeTruthy();
		await writeFile(file, "changed\ntwo\n", "utf8");

		const edit = createEditToolDefinition(dir, { hashlineStore });
		await expect(
			edit.execute(
				"edit-1",
				{ input: `[stale.txt#${tag}]\nreplace 1..1:\n+ONE` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/file changed between read and edit/);
		expect(await readFile(file, "utf8")).toBe("changed\ntwo\n");
	});

	it("lowers empty replace to delete and rejects minus/empty-insert hunks", async () => {
		const dir = await createTempDir();
		const file = join(dir, "empty.py");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const edit = createEditToolDefinition(dir, { hashlineStore });
		const freshTag = async (): Promise<string | undefined> => {
			await writeFile(file, "a\nb\nc", "utf8");
			return text(await read.execute("r", { path: "empty.py" }, undefined, undefined, {} as ExtensionContext)).match(
				/#([0-9A-F]{4})/,
			)?.[1];
		};
		// Empty `replace N..M:` lowers to a delete (engine behavior; the EMPTY_REPLACE message is never thrown).
		let tag = await freshTag();
		await edit.execute(
			"edit-empty",
			{ input: `[empty.py#${tag}]\nreplace 2..2:` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(file, "utf8")).toBe("a\nc");
		// Minus body rows are rejected.
		tag = await freshTag();
		await expect(
			edit.execute(
				"edit-minus",
				{ input: `[empty.py#${tag}]\nreplace 1..1:\n-a\n+A` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/`-` rows are not valid/);
		// Empty insert is rejected.
		tag = await freshTag();
		await expect(
			edit.execute(
				"edit-insert-empty",
				{ input: `[empty.py#${tag}]\ninsert after 1:` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/needs at least one `\+TEXT` body row/);
		// Byte-identical payload is a no-op and escalates to STOP on repeat.
		tag = await freshTag();
		expect(
			text(
				await edit.execute(
					"edit-noop",
					{ input: `[empty.py#${tag}]\nreplace 1..1:\n+a` },
					undefined,
					undefined,
					{} as ExtensionContext,
				),
			),
		).toMatch(/produced no change/);
	});

	it("applies tree-sitter block ops across brace, indent, decorator, and closer cases", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "brace.ts"), "function f() {\n  return 1;\n}\nafter();\n", "utf8");
		await writeFile(join(dir, "indent.py"), "def f():\n    return 1\nafter()\n", "utf8");
		await writeFile(join(dir, "deco.py"), "@dec\ndef one():\n    return 1\nprint(one())\n", "utf8");
		await writeFile(join(dir, "svc.rb"), "def f\n  puts 1\nend\nafter\n", "utf8");
		await writeFile(join(dir, "closer.ts"), "function f() {\n  return 1;\n}\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const edit = createEditToolDefinition(dir, { hashlineStore });
		const braceTag = text(
			await read.execute("rb", { path: "brace.ts" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		await edit.execute(
			"e-brace",
			{ input: `[brace.ts#${braceTag}]\nreplace block 1:\n+function f() { return 2; }` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "brace.ts"), "utf8")).toBe("function f() { return 2; }\nafter();\n");
		const indentTag = text(
			await read.execute("ri", { path: "indent.py" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		await edit.execute(
			"e-indent",
			{ input: `[indent.py#${indentTag}]\nreplace block 1:\n+def f():\n+    return 2` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "indent.py"), "utf8")).toBe("def f():\n    return 2\nafter()\n");
		// Tree-sitter sweeps the decorator + def as one block when anchored on the decorator line.
		const decoTag = text(
			await read.execute("rd", { path: "deco.py" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		await edit.execute(
			"e-deco",
			{ input: `[deco.py#${decoTag}]\nreplace block 1:\n+@dec\n+def one():\n+    return 2` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "deco.py"), "utf8")).toBe("@dec\ndef one():\n    return 2\nprint(one())\n");
		// Ruby def...end has no braces; tree-sitter resolves the whole method.
		const rbTag = text(
			await read.execute("rr", { path: "svc.rb" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		await edit.execute(
			"e-rb",
			{ input: `[svc.rb#${rbTag}]\ndelete block 1` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "svc.rb"), "utf8")).toBe("after\n");
		// A pure closing-delimiter line cannot anchor a block.
		const closerTag = text(
			await read.execute("rc", { path: "closer.ts" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		await expect(
			edit.execute(
				"e-closer",
				{ input: `[closer.ts#${closerTag}]\ndelete block 3` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/could not resolve a syntactic block/);
	});

	it("accepts lenient hashline syntax forms", async () => {
		const dir = await createTempDir();
		const file = join(dir, "lenient.py");
		await writeFile(file, "one\ntwo\nthree", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const tag = text(
			await read.execute("read-1", { path: "lenient.py" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		const edit = createEditToolDefinition(dir, { hashlineStore });
		await edit.execute(
			"edit-1",
			{ input: `*** Begin Patch\n[lenient.py#${tag}]\nreplace 2 3:\nTWO\nTHREE\n*** End Patch` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(file, "utf8")).toBe("one\nTWO\nTHREE");
	});

	it("rejects apply-patch/unified-diff contamination and delete bodies with guidance", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "guided.txt"), "one\ntwo\nthree", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const tag = text(
			await read.execute("read-guided", { path: "guided.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		const edit = createEditToolDefinition(dir, { hashlineStore });
		await expect(
			edit.execute(
				"edit-sentinel",
				{ input: `[guided.txt#${tag}]\n*** Update File: guided.txt` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/apply_patch sentinel/);
		await expect(
			edit.execute(
				"edit-@@",
				{ input: `[guided.txt#${tag}]\n@@ -1,1 +1,1 @@` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/unified-diff hunk header/);
		await expect(
			edit.execute(
				"edit-bare",
				{ input: `[guided.txt#${tag}]\n1 2\n+ONE` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/Hunk headers need a verb/i);
		await expect(
			edit.execute(
				"edit-delete-body",
				{ input: `[guided.txt#${tag}]\ndelete 1..1:\n+ONE` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/Remove the colon and body rows|does not take body rows/);
		expect(await readFile(join(dir, "guided.txt"), "utf8")).toBe("one\ntwo\nthree");
	});

	it("edits BOM files after reading hashline snapshots", async () => {
		const dir = await createTempDir();
		const file = join(dir, "bom.txt");
		await writeFile(file, "\uFEFFone\ntwo", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const tag = text(
			await read.execute("read-1", { path: "bom.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		const edit = createEditToolDefinition(dir, { hashlineStore });
		await edit.execute(
			"edit-1",
			{ input: `[bom.txt#${tag}]\nreplace 2..2:\n+TWO` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(file, "utf8")).toBe("\uFEFFone\nTWO");
	});

	it("preserves CR-only line endings after hashline edits", async () => {
		const dir = await createTempDir();
		const file = join(dir, "classic.txt");
		await writeFile(file, "one\rtwo\rthree", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const tag = text(
			await read.execute("read-cr", { path: "classic.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		const edit = createEditToolDefinition(dir, { hashlineStore });
		await edit.execute(
			"edit-cr",
			{ input: `[classic.txt#${tag}]\nreplace 2..2:\n+TWO` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(file, "utf8")).toBe("one\rTWO\rthree");
	});
	it("keeps colliding hashline tags tied to matching snapshot text", async () => {
		const dir = await createTempDir();
		const store = createHashlineSnapshotStore();
		const file = join(dir, "collision.txt");
		const first = "collision-389\n";
		const second = "collision-445\n";
		const firstTag = store.record(file, dir, first).tag;
		const secondTag = store.record(file, dir, second).tag;
		expect(secondTag).toBe(firstTag);
		expect(store.snapshots.head(file)?.text).toBe(second);
		await writeFile(file, second, "utf8");
		const knownEdit = createEditToolDefinition(dir, { hashlineStore: store });
		await knownEdit.execute(
			"edit-known-collision",
			{ input: `[collision.txt#${firstTag}]\nreplace 1..1:\n+known` },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(file, "utf8")).toBe("known\n");

		const editStore = createHashlineSnapshotStore();
		const staleTag = editStore.record(file, dir, first).tag;
		await writeFile(file, second, "utf8");
		const edit = createEditToolDefinition(dir, { hashlineStore: editStore });
		await expect(
			edit.execute(
				"edit-collision",
				{ input: `[collision.txt#${staleTag}]\nreplace 1..1:\n+changed` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/file changed between read and edit|Stale hashline tag/);
		expect(await readFile(file, "utf8")).toBe(second);
	});

	it("preflights all multi-file edit staleness before writing", async () => {
		const dir = await createTempDir();
		const store = createHashlineSnapshotStore();
		await writeFile(join(dir, "a.txt"), "old a\n", "utf8");
		await writeFile(join(dir, "b.txt"), "old b\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore: store });
		const aTag = text(
			await read.execute("read-a", { path: "a.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		const bTag = text(
			await read.execute("read-b", { path: "b.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		const reads = new Map<string, number>();
		const writes: string[] = [];
		const ops = {
			access: async () => {},
			readFile: async (absolutePath: string) => {
				const name = absolutePath.endsWith("a.txt") ? "a" : "b";
				const count = (reads.get(name) ?? 0) + 1;
				reads.set(name, count);
				return Buffer.from(name === "b" && count >= 2 ? "stale b\n" : `old ${name}\n`);
			},
			writeFile: async (absolutePath: string) => {
				writes.push(absolutePath);
			},
		};
		const edit = createEditToolDefinition(dir, { hashlineStore: store, operations: ops });
		await expect(
			edit.execute(
				"edit-two-stale",
				{ input: `[a.txt#${aTag}]\nreplace 1..1:\n+new a\n\n[b.txt#${bTag}]\nreplace 1..1:\n+new b` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/file changed between read and edit|Stale hashline tag/);
		expect(writes).toEqual([]);
	});

	it("rejects duplicate canonical paths in one edit batch", async () => {
		const dir = await createTempDir();
		const store = createHashlineSnapshotStore();
		await writeFile(join(dir, "a.txt"), "one\ntwo\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore: store });
		const tag = text(
			await read.execute("read-a", { path: "a.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		const edit = createEditToolDefinition(dir, { hashlineStore: store });
		await expect(
			edit.execute(
				"edit-duplicate-canonical",
				{ input: `[a.txt#${tag}]\nreplace 1..1:\n+ONE\n\n[./a.txt#${tag}]\nreplace 2..2:\n+TWO` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/Multiple hashline sections resolve to the same file/);
		await expect(readFile(join(dir, "a.txt"), "utf8")).resolves.toBe("one\ntwo\n");
	});

	it("reports already-written sections when a multi-file edit write fails", async () => {
		const dir = await createTempDir();
		const store = createHashlineSnapshotStore();
		await writeFile(join(dir, "a.txt"), "old a\n", "utf8");
		await writeFile(join(dir, "b.txt"), "old b\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore: store });
		const aTag = text(
			await read.execute("read-a", { path: "a.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		const bTag = text(
			await read.execute("read-b", { path: "b.txt" }, undefined, undefined, {} as ExtensionContext),
		).match(/#([0-9A-F]{4})/)?.[1];
		const writes: string[] = [];
		const ops = {
			access: async () => {},
			readFile: async (absolutePath: string) => Buffer.from(absolutePath.endsWith("a.txt") ? "old a\n" : "old b\n"),
			writeFile: async (absolutePath: string) => {
				writes.push(absolutePath);
				if (absolutePath.endsWith("b.txt")) throw new Error("permission denied");
			},
		};
		const edit = createEditToolDefinition(dir, { hashlineStore: store, operations: ops });
		await expect(
			edit.execute(
				"edit-two-write-fail",
				{ input: `[a.txt#${aTag}]\nreplace 1..1:\n+new a\n\n[b.txt#${bTag}]\nreplace 1..1:\n+new b` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/Sections already written: a\.txt/);
		expect(writes.map((file) => (file.endsWith("a.txt") ? "a" : "b"))).toEqual(["a", "b"]);
	});

	it("write strips copied hashline headers only for known snapshots", async () => {
		const dir = await createTempDir();
		const write = createWriteToolDefinition(dir, { hashlineStore });
		const firstOutput = text(
			await write.execute(
				"write-1",
				{ path: "copy.txt", content: "alpha\nbeta" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		const knownCopy = firstOutput.slice(firstOutput.indexOf("[copy.txt#"));
		await write.execute(
			"write-2",
			{ path: "copy.txt", content: knownCopy },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "copy.txt"), "utf8")).toBe("alpha\nbeta");
		const headerOnly = knownCopy.split("\n")[0]!;
		await write.execute(
			"write-header-only",
			{ path: "copy.txt", content: headerOnly },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "copy.txt"), "utf8")).toBe("alpha\nbeta");

		const searchCopy = firstOutput
			.slice(firstOutput.indexOf("[copy.txt#"))
			.replace("1:alpha", "*1:alpha")
			.replace("2:beta", " 2:beta");
		await write.execute(
			"write-3",
			{ path: "other.txt", content: searchCopy },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "other.txt"), "utf8")).toBe("alpha\nbeta");

		const looseOutput = text(
			await write.execute(
				"write-4",
				{ path: "literal.txt", content: "[literal.txt#ABCD]\n1:should not strip loose" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(await readFile(join(dir, "literal.txt"), "utf8")).toBe("[literal.txt#ABCD]\n1:should not strip loose");
		expect(looseOutput).toMatch(/\[literal\.txt#[0-9A-F]{4}\]/);
	});

	it("strips copied partial hashline read output before write", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "source.txt"), "one\ntwo\nthree\nfour\nfive\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const copied = text(
			await read.execute(
				"read-partial-copy",
				{ path: "source.txt:3-3" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		const write = createWriteToolDefinition(dir, { hashlineStore });
		await write.execute(
			"write-partial-copy",
			{ path: "dest.txt", content: copied },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "dest.txt"), "utf8")).toBe("two\nthree\nfour\nfive\n");
	});

	it("strips copied bounded read output with continuation footer before write", async () => {
		const dir = await createTempDir();
		await writeFile(
			join(dir, "long.txt"),
			`${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
			"utf8",
		);
		const read = createReadToolDefinition(dir, { hashlineStore });
		const copied = text(
			await read.execute("read-long-copy", { path: "long.txt:3-3" }, undefined, undefined, {} as ExtensionContext),
		);
		expect(copied).toContain("more lines in file");
		await createWriteToolDefinition(dir, { hashlineStore }).execute(
			"write-long-copy",
			{ path: "copy.txt", content: copied },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "copy.txt"), "utf8")).toBe("line 2\nline 3\nline 4\nline 5\nline 6");
	});

	it("strips copied truncated read output with showing-lines footer before write", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "big.txt"), Array.from({ length: 3001 }, (_, i) => `line ${i + 1}`).join("\n"), "utf8");
		const copied = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-truncated-copy",
				{ path: "big.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(copied).toContain("[Showing lines ");
		await createWriteToolDefinition(dir, { hashlineStore }).execute(
			"write-truncated-copy",
			{ path: "copy.txt", content: copied },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const written = await readFile(join(dir, "copy.txt"), "utf8");
		expect(written).toContain("line 1");
		expect(written).not.toContain("[big.txt#");
		expect(written).not.toContain("[Showing lines ");
	});

	it("strips copied nested search output before write", async () => {
		const dir = await createTempDir();
		await mkdir(join(dir, "sub"), { recursive: true });
		await writeFile(join(dir, "sub", "source.txt"), "one\nneedle\nthree\n", "utf8");
		const search = createSearchToolDefinition(dir, { hashlineStore });
		const copied = text(
			await search.execute(
				"search-nested-copy",
				{ pattern: "needle", paths: "." },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		const write = createWriteToolDefinition(dir, { hashlineStore });
		await write.execute(
			"write-search-copy",
			{ path: "copy.txt", content: copied },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const written = await readFile(join(dir, "copy.txt"), "utf8");
		expect(written).toContain("needle");
		expect(written).not.toContain("[sub/source.txt#");
		expect(written).not.toContain("# sub/");
	});

	it("rejects hashline tags from another snapshot store even when the live hash matches", async () => {
		const dir = await createTempDir();
		const file = join(dir, "scoped.txt");
		await writeFile(file, "one\ntwo", "utf8");
		const storeA = createHashlineSnapshotStore();
		const storeB = createHashlineSnapshotStore();
		const readA = createReadToolDefinition(dir, { hashlineStore: storeA });
		const editB = createEditToolDefinition(dir, { hashlineStore: storeB });
		const output = text(
			await readA.execute("read-a", { path: "scoped.txt" }, undefined, undefined, {} as ExtensionContext),
		);
		const tag = output.match(/#([0-9A-F]{4})/)?.[1];
		expect(tag).toBeTruthy();
		await expect(
			editB.execute(
				"edit-b",
				{ input: `[scoped.txt#${tag}]\nreplace 1..1:\n+ONE` },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/not from this session/);
		expect(await readFile(file, "utf8")).toBe("one\ntwo");
	});
	it("rejects unsafe integer hashline anchors", () => {
		expect(() => parsePatch("replace 9007199254740992..9007199254740992:\n+value")).toThrow(/safe integer/);
	});
	it("rejects expanded numeric ranges above 100,000 lines", () => {
		expect(() => parsePatch("delete 1..100001")).toThrow(/100,000/);
	});
	it("accepts expanded numeric ranges at the 100,000-line limit", () => {
		expect(parsePatch("delete 1..100000").edits).toHaveLength(100000);
	});
	it("preserves hunk-looking explicit payloads and warns", () => {
		const parsed = parsePatch("replace 1..1:\n+replace 5..9:");
		expect(parsed.edits.some((edit) => edit.kind === "insert" && edit.text === "replace 5..9:")).toBe(true);
		expect(parsed.warnings).toContain(
			"Literal +TEXT row resembles a valid hunk header; it was kept as literal payload text.",
		);
	});
	it("keeps explicit payload text literal when its hunk-looking number is unsafe", () => {
		const payload = "replace 9007199254740992..9007199254740992:";
		const parsed = parsePatch(`replace 1..1:\n+${payload}`);
		expect(parsed.edits.some((edit) => edit.kind === "insert" && edit.text === payload)).toBe(true);
	});
	it("does not warn for a normal explicit payload", () => {
		const parsed = parsePatch("replace 1..1:\n+ordinary content");
		expect(parsed.edits.some((edit) => edit.kind === "insert" && edit.text === "ordinary content")).toBe(true);
		expect(parsed.warnings).not.toContain(
			"Literal +TEXT row resembles a valid hunk header; it was kept as literal payload text.",
		);
	});
	it("omits the synthetic numbered row after a terminal newline", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "terminal.txt"), "a\n", "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-terminal-newline",
				{ path: "terminal.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("\n1:a");
		expect(output).not.toContain("\n2:");
	});
	it("keeps a genuine blank row before the terminal newline", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "blank-before-terminal.txt"), "a\n\n", "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-genuine-blank",
				{ path: "blank-before-terminal.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("\n1:a\n2:");
		expect(output).not.toContain("\n3:");
	});
	it("keeps numbered output unchanged without a terminal newline", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "no-terminal.txt"), "a\nb", "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-no-terminal-newline",
				{ path: "no-terminal.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("\n1:a\n2:b");
		expect(output).not.toContain("\n3:");
	});
	it("preserves terminal-newline bytes for raw reads", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "raw-terminal.txt"), "a\n", "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-raw-terminal-newline",
				{ path: "raw-terminal.txt:raw" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toBe("a\n");
	});
	it("keeps a genuine blank row at the line truncation boundary", async () => {
		const dir = await createTempDir();
		const lines = Array.from({ length: 3001 }, (_, index) => (index === 2999 ? "" : `line-${index + 1}`));
		await writeFile(join(dir, "line-truncated.txt"), `${lines.join("\n")}\n`, "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-line-truncated-blank",
				{ path: "line-truncated.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("\n3000:");
		expect(output).toContain("[Showing lines 1-3000 of 3001. Continue with path selector :3001.]");
	});
	it("keeps a genuine blank row at the byte truncation boundary", async () => {
		const dir = await createTempDir();
		const lines = Array.from({ length: 800 }, (_, index) => (index === 423 ? "" : "é".repeat(60)));
		await writeFile(join(dir, "byte-truncated.txt"), `${lines.join("\n")}\n`, "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-byte-truncated-blank",
				{ path: "byte-truncated.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("\n424:");
		expect(output).toContain("[Showing lines 1-424 of 800 (50.0KB limit). Continue with path selector :425.]");
	});
	it("selector reads agree with whole-file output without a terminal sentinel", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "selector-terminal.txt"), "a\nb\nc\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const wholeFile = text(
			await read.execute(
				"read-selector-whole",
				{ path: "selector-terminal.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		for (const selector of ["selector-terminal.txt:1-3", "selector-terminal.txt:1+3", "selector-terminal.txt:2-3"]) {
			const selected = text(
				await read.execute(`read-${selector}`, { path: selector }, undefined, undefined, {} as ExtensionContext),
			);
			expect(selected).toBe(wholeFile);
			expect(selected).not.toContain("\n4:");
		}
	});
	it("classifies unsafe hashline anchors without throwing", () => {
		expect(() => containsRecognizableHashlineOperations("replace 999999999999999999999..2:")).not.toThrow();
		expect(containsRecognizableHashlineOperations("replace 999999999999999999999..2:")).toBe(false);
	});
	it("renders CRLF whole-file reads without a synthetic row", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "crlf.txt"), "a\r\nb\r\nc\r\n", "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-crlf-whole",
				{ path: "crlf.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("[crlf.txt#D988]\n1:a\n2:b\n3:c");
		expect(output).not.toContain("\n4:");
		expect(output).not.toContain("\r");
	});
	it("keeps CRLF selector reads aligned with the whole-file read", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "crlf-selector.txt"), "a\r\nb\r\nc\r\n", "utf8");
		const read = createReadToolDefinition(dir, { hashlineStore });
		const whole = text(
			await read.execute(
				"read-crlf-selector-whole",
				{ path: "crlf-selector.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		for (const [path, expected] of [
			["crlf-selector.txt:1-3", whole],
			["crlf-selector.txt:2", "[crlf-selector.txt#D988]\n2:b\n3:c"],
		] as const) {
			const selected = text(
				await read.execute(`read-${path}`, { path }, undefined, undefined, {} as ExtensionContext),
			);
			expect(selected).toBe(expected);
			expect(selected).not.toContain("\r");
			expect(selected).not.toContain("\n4:");
		}
	});
	it("reports CRLF beyond-EOF selectors using real line counts", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "crlf-eof.txt"), "a\r\nb\r\nc\r\n", "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-crlf-eof",
				{ path: "crlf-eof.txt:4" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("Requested line 4 is beyond end of file (3 lines total)");
	});
	it("keeps a genuine blank final CRLF row visible", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "crlf-blank.txt"), "a\r\n\r\n", "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-crlf-blank",
				{ path: "crlf-blank.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("[crlf-blank.txt#4F66]\n1:a\n2:");
		expect(output).not.toContain("\n3:");
	});
	it("keeps raw CRLF bytes unchanged", async () => {
		const dir = await createTempDir();
		const source = "a\r\nb\r\nc\r\n";
		await writeFile(join(dir, "crlf-raw.txt"), source, "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-crlf-raw",
				{ path: "crlf-raw.txt:raw" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toBe(source);
	});
	it("keeps a genuine blank row at the CRLF truncation boundary", async () => {
		const dir = await createTempDir();
		const lines = Array.from({ length: 3001 }, (_, index) => (index === 2999 ? "" : `line-${index + 1}`));
		await writeFile(join(dir, "crlf-truncated.txt"), `${lines.join("\r\n")}\r\n`, "utf8");
		const output = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-crlf-truncated",
				{ path: "crlf-truncated.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		expect(output).toContain("\n3000:");
		expect(output).toContain("[Showing lines 1-3000 of 3001. Continue with path selector :3001.]");
	});
	it("reports the full unsafe anchor with its parser line number", () => {
		const anchor = "99999999999999999999";
		expect(() => parsePatch(`delete ${anchor}`)).toThrow(
			new RegExp(`line 1: line anchor ${JSON.stringify(anchor)} is not a safe integer`),
		);
	});
	it("round-trips copied numbered output with a terminal newline", async () => {
		const dir = await createTempDir();
		const content = "a\n";
		await writeFile(join(dir, "source.txt"), content, "utf8");
		const copied = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-copy-terminal-newline",
				{ path: "source.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		await createWriteToolDefinition(dir, { hashlineStore }).execute(
			"write-copy-terminal-newline",
			{ path: "destination.txt", content: copied },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "destination.txt"), "utf8")).toBe(content);
	});
	it("round-trips copied numbered output without adding a terminal newline", async () => {
		const dir = await createTempDir();
		const content = "hello";
		await writeFile(join(dir, "source.txt"), content, "utf8");
		const copied = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-copy-no-terminal-newline",
				{ path: "source.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		await createWriteToolDefinition(dir, { hashlineStore }).execute(
			"write-copy-no-terminal-newline",
			{ path: "destination.txt", content: copied },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "destination.txt"), "utf8")).toBe(content);
	});
	it("round-trips a genuine final blank line before the terminal newline", async () => {
		const dir = await createTempDir();
		const content = "a\n\n";
		await writeFile(join(dir, "source.txt"), content, "utf8");
		const copied = text(
			await createReadToolDefinition(dir, { hashlineStore }).execute(
				"read-copy-final-blank",
				{ path: "source.txt" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		);
		await createWriteToolDefinition(dir, { hashlineStore }).execute(
			"write-copy-final-blank",
			{ path: "destination.txt", content: copied },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "destination.txt"), "utf8")).toBe(content);
	});
	it("keeps maintained hashline provenance aligned with source headers", async () => {
		const provenance = await readFile(join(hashlineEngineDir, "PROVENANCE.md"), "utf8");
		const license = await readFile(join(hashlineEngineDir, "LICENSE.upstream"), "utf8");
		expect(license).toContain("Copyright (c) 2025 Mario Zechner");
		expect(license).toContain("Copyright (c) 2025-2026 Can Bölük");
		const locallyModifiedFiles = Array.from(provenance.matchAll(/^- `([^`]+)`:/gm), (match) => match[1]).filter(
			(fileName): fileName is string => fileName !== undefined,
		);
		const modifiedEngineFiles = ["format.ts", "messages.ts", "parser.ts", "tokenizer.ts"];
		expect(locallyModifiedFiles).toEqual(expect.arrayContaining([...modifiedEngineFiles, "normalize.ts"]));
		const headers = await Promise.all(
			modifiedEngineFiles.map(async (fileName) => {
				const source = await readFile(join(hashlineEngineDir, fileName), "utf8");
				return source.split("\n", 1)[0] ?? "";
			}),
		);
		expect(new Set(headers).size).toBe(1);
		for (const fileName of (await readdir(hashlineEngineDir)).filter((name) => locallyModifiedFiles.includes(name))) {
			const source = await readFile(join(hashlineEngineDir, fileName), "utf8");
			const header = source.split("\n", 1)[0] ?? "";
			expect(header).not.toMatch(/vendored verbatim.*DO NOT EDIT/);
		}
	});
});
