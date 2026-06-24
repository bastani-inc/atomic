import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyNotebookEditableText,
	cellSourceToString,
	emptyNotebook,
	notebookToEditableText,
	readEditableNotebookText,
	serializeEditedNotebookText,
	splitNotebookSource,
} from "../src/core/tools/notebook.ts";

const tempDirs: string[] = [];
async function tempDir() { const d = await mkdtemp(join(tmpdir(), "atomic-nb-")); tempDirs.push(d); return d; }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("notebook editable projection", () => {
	it("projects cells to # %% [type] cell:N with 0-based ids", () => {
		const text = notebookToEditableText({ cells: [{ cell_type: "markdown", source: "# Title\n" }, { cell_type: "code", source: ["print('hi')\n"], execution_count: 1, outputs: [], metadata: {} }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
		expect(text).toBe("# %% [markdown] cell:0\n# Title\n\n# %% [code] cell:1\nprint('hi')\n");
	});

	it("escapes marker-like source lines", () => {
		const text = notebookToEditableText({ cells: [{ cell_type: "code", source: "# %% [markdown] cell:3\nx\n" }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
		expect(text).toBe("# %% [code] cell:0\n# %%% [markdown] cell:3\nx\n");
	});

	it("round-trips edits back to notebook json preserving metadata", () => {
		const original = { cells: [{ cell_type: "code", source: "old\n", metadata: { tags: ["keep"] }, execution_count: 2, outputs: [{ text: "x" }] }, { cell_type: "markdown", source: "doc\n" }], metadata: { kernelspec: { name: "py" } }, nbformat: 4, nbformat_minor: 5 };
		const editable = notebookToEditableText(original);
		const edited = editable.replace("old", "NEW");
		const next = applyNotebookEditableText(original, edited, "nb.ipynb");
		expect(cellSourceToString(next.cells[0]!.source)).toBe("NEW\n");
		expect(next.cells[0]!.metadata).toEqual({ tags: ["keep"] });
		expect(next.cells[0]!.execution_count).toBe(2);
		expect(next.cells[0]!.outputs).toEqual([{ text: "x" }]);
		expect(next.cells[1]!.cell_type).toBe("markdown");
		expect(next.metadata).toEqual({ kernelspec: { name: "py" } });
	});

	it("deletes execution_count and outputs on non-code cells", () => {
		const original = { cells: [{ cell_type: "code", source: "a\n", execution_count: 1, outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
		const editable = "# %% [markdown] cell:0\n# hi\n";
		const next = applyNotebookEditableText(original, editable, "nb.ipynb");
		expect(next.cells[0]!.cell_type).toBe("markdown");
		expect(next.cells[0]!.execution_count).toBeUndefined();
		expect(next.cells[0]!.outputs).toBeUndefined();
	});

	it("serializes edited text to JSON and round-trips via disk", async () => {
		const dir = await tempDir(); const file = join(dir, "nb.ipynb");
		await writeFile(file, JSON.stringify({ cells: [{ cell_type: "code", source: "print(1)\n" }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
		const editable = readEditableNotebookText(file, "nb.ipynb");
		const edited = editable.replace("print(1)", "print(2)");
		const json = serializeEditedNotebookText(file, "nb.ipynb", edited);
		expect(json).toContain("print(2)");
		const parsed = JSON.parse(json);
		expect(parsed.cells[0].source).toEqual(["print(2)\n"]);
	});

	it("splitNotebookSource preserves newline chunks", () => {
		expect(splitNotebookSource("a\nb\nc")).toEqual(["a\n", "b\n", "c"]);
		expect(splitNotebookSource("")).toEqual([]);
	});

	it("readEditableNotebookText yields empty notebook for missing file", async () => {
		const dir = await tempDir();
		const text = readEditableNotebookText(join(dir, "missing.ipynb"), "missing.ipynb");
		expect(text).toBe(notebookToEditableText(emptyNotebook()));
	});

	it("throws on non-marker first line", () => {
		expect(() => applyNotebookEditableText(emptyNotebook(), "not a marker\n# %% [code] cell:0\nx", "nb.ipynb")).toThrow(/expected first line/);
	});

	it("reads projected text from disk matches written json", async () => {
		const dir = await tempDir(); const file = join(dir, "nb.ipynb");
		const original = { cells: [{ cell_type: "code", source: "z\n", execution_count: null, outputs: [], metadata: {} }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
		await writeFile(file, JSON.stringify(original));
		await readFile(file, "utf8");
		expect(readEditableNotebookText(file, "nb.ipynb")).toBe("# %% [code] cell:0\nz\n");
	});
});
