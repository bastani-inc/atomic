import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolDefinition } from "../src/core/tools/index.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];
async function tempDir() {
	const d = await mkdtemp(join(tmpdir(), "atomic-nb-tool-"));
	tempDirs.push(d);
	return d;
}
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
	r.content.map((i) => i.text ?? "").join("\n");

describe("notebook read+edit parity", () => {
	it("read projects notebook to editable cell text", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "nb.ipynb"),
			JSON.stringify({
				cells: [{ cell_type: "code", source: "print('old')\n" }],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5,
			}),
		);
		const out = text(
			await createReadToolDefinition(dir).execute("r", { path: "nb.ipynb" }, undefined, undefined, {} as never),
		);
		expect(out).toBe("# %% [code] cell:0\nprint('old')");
	});

	it("read :raw returns raw notebook JSON", async () => {
		const dir = await tempDir();
		const json = JSON.stringify({
			cells: [{ cell_type: "code", source: "x\n" }],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		});
		await writeFile(join(dir, "nb.ipynb"), json);
		const out = text(
			await createReadToolDefinition(dir).execute("r", { path: "nb.ipynb:raw" }, undefined, undefined, {} as never),
		);
		expect(out).toContain('"nbformat"');
	});

	it("built-in edit replaces projected cell text and writes notebook json back", async () => {
		const dir = await tempDir();
		const file = join(dir, "nb.ipynb");
		await writeFile(
			file,
			JSON.stringify({
				cells: [
					{
						cell_type: "code",
						source: "print('old')\n",
						execution_count: 1,
						outputs: [],
						metadata: { tags: ["keep"] },
					},
				],
				metadata: { kernelspec: { name: "py" } },
				nbformat: 4,
				nbformat_minor: 5,
			}),
		);
		const readOut = text(
			await createReadToolDefinition(dir).execute("r", { path: "nb.ipynb" }, undefined, undefined, {} as never),
		);
		expect(readOut).toContain("print('old')");
		const editOut = text(
			await createToolDefinition("edit", dir).execute(
				"e",
				{ path: "nb.ipynb", edits: [{ oldText: "print('old')", newText: "print('NEW')" }] },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(editOut).toBe("Successfully replaced 1 block(s) in nb.ipynb.");
		const saved = JSON.parse(await readFile(file, "utf8"));
		expect(saved.cells[0].source).toEqual(["print('NEW')\n"]);
		expect(saved.cells[0].metadata).toEqual({ tags: ["keep"] });
		expect(saved.cells[0].execution_count).toBe(1);
		expect(saved.metadata).toEqual({ kernelspec: { name: "py" } });
	});
});
