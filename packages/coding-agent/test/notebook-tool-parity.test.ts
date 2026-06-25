import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];
async function tempDir() { const d = await mkdtemp(join(tmpdir(), "atomic-nb-tool-")); tempDirs.push(d); return d; }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const text = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((i) => i.text ?? "").join("\n");

describe("notebook hashline read+edit parity", () => {
	it("read projects notebook to editable hashline text", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "nb.ipynb"), JSON.stringify({ cells: [{ cell_type: "code", source: "print('old')\n" }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
		const out = text(await createReadToolDefinition(dir).execute("r", { path: "nb.ipynb" }, undefined, undefined, {} as never));
		expect(out).toMatch(/^\[nb\.ipynb#[0-9A-F]{4}\]/);
		expect(out).toContain("# %% [code] cell:0");
		expect(out).toContain("print('old')");
	});

	it("read :raw returns raw notebook JSON", async () => {
		const dir = await tempDir();
		const json = JSON.stringify({ cells: [{ cell_type: "code", source: "x\n" }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
		await writeFile(join(dir, "nb.ipynb"), json);
		const out = text(await createReadToolDefinition(dir).execute("r", { path: "nb.ipynb:raw" }, undefined, undefined, {} as never));
		expect(out).toContain('"nbformat"');
	});

	it("edit on hashline snapshot writes notebook json back", async () => {
		const dir = await tempDir(), store = createHashlineSnapshotStore();
		const file = join(dir, "nb.ipynb");
		await writeFile(file, JSON.stringify({ cells: [{ cell_type: "code", source: "print('old')\n", execution_count: 1, outputs: [], metadata: { tags: ["keep"] } }], metadata: { kernelspec: { name: "py" } }, nbformat: 4, nbformat_minor: 5 }));
		const readOut = text(await createReadToolDefinition(dir, { hashlineStore: store }).execute("r", { path: "nb.ipynb" }, undefined, undefined, {} as never));
		const tag = readOut.match(/#([0-9A-F]{4})/)?.[1];
		expect(tag).toBeTruthy();
		const edit = createEditToolDefinition(dir, { hashlineStore: store });
		const editOut = text(await edit.execute("e", { input: `[nb.ipynb#${tag}]\nreplace 2..2:\n+print('NEW')` }, undefined, undefined, {} as never));
		expect(editOut).toMatch(/^\[nb\.ipynb#[0-9A-F]{4}\]/);
		const saved = JSON.parse(await readFile(file, "utf8"));
		expect(saved.cells[0].source).toEqual(["print('NEW')\n"]);
		expect(saved.cells[0].metadata).toEqual({ tags: ["keep"] });
		expect(saved.cells[0].execution_count).toBe(1);
		expect(saved.metadata).toEqual({ kernelspec: { name: "py" } });
	});
});
