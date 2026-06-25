import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];
const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((item) => item.text ?? "").join("\n");
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "atomic-markit-doc-")); tempDirs.push(dir); return dir; }

async function writeDocx(path: string): Promise<void> {
	const zip = new JSZip();
	zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
	zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
	zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>`);
	await writeFile(path, Buffer.from(await zip.generateAsync({ type: "uint8array" })));
}

afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("read markit document parity", () => {
	it("routes modern Office documents through markit", async () => {
		const dir = await tempDir();
		await writeDocx(join(dir, "sample.docx"));
		const output = text(await createReadToolDefinition(dir).execute("read-docx", { path: "sample.docx" }, undefined, undefined, {} as never));
		expect(output).toContain("Hello DOCX");
		expect(output).not.toContain("word/document.xml");
	});
});
