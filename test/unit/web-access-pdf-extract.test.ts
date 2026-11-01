import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDocumentProxy } from "unpdf";
import { afterEach, beforeEach, test, vi } from "vitest";
import { extractPDFToMarkdown } from "../../packages/web-access/pdf-extract.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * A one-glyph TrueType font whose `fpgm` defines function 0 while its `prep`
 * program calls function 32. pdf.js rejects the hinting and prints
 * `Warning: TT: undefined function: 32`; the glyph and its text are fine.
 */
function bytes(...parts: (number | number[])[]): number[] {
	return parts.flat();
}
const u16 = (n: number) => bytes((n >> 8) & 255, n & 255);
const u32 = (n: number) => bytes((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const zeros = (n: number) => new Array<number>(n).fill(0);
const pad4 = (data: number[]) => [...data, ...zeros((4 - (data.length % 4)) % 4)];

function buildTrueTypeFontWithUndefinedHintFunction(): Uint8Array {
	const glyph = pad4(
		bytes(
			u16(1),
			u16(0),
			u16(0),
			u16(600),
			u16(700),
			u16(2),
			u16(0),
			[1, 1, 1],
			u16(0),
			u16(300),
			u16(300),
			u16(0),
			u16(700),
			u16(0xfd44),
		),
	);
	const tables: Record<string, number[]> = {
		fpgm: [0xb0, 0x00, 0x2c, 0x2d], // PUSHB 0; FDEF; ENDF
		glyf: glyph,
		head: bytes(
			u32(0x00010000),
			u32(0x00010000),
			u32(0),
			u32(0x5f0f3cf5),
			u16(0),
			u16(1000),
			zeros(16),
			zeros(4),
			u16(600),
			u16(700),
			u16(0),
			u16(8),
			u16(2),
			u16(0),
			u16(0),
		),
		hhea: bytes(
			u32(0x00010000),
			u16(800),
			u16(0xff38),
			u16(0),
			u16(600),
			zeros(10),
			u16(1),
			zeros(8),
			zeros(2),
			u16(2),
		),
		hmtx: bytes(u16(600), u16(0), u16(600), u16(0)),
		loca: bytes(u16(0), u16(0), u16(glyph.length / 2)),
		maxp: bytes(u32(0x00010000), u16(2), u16(3), u16(1), u16(0), u16(0), u16(1), u16(0), u16(0), u16(64), zeros(10)),
		prep: [0xb0, 0x20, 0x2b], // PUSHB 32; CALL
	};
	const tags = Object.keys(tables).sort();
	let offset = 12 + 16 * tags.length;
	const directory: number[] = [];
	const body: number[] = [];
	for (const tag of tags) {
		const table = tables[tag];
		directory.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(0), ...u32(offset), ...u32(table.length));
		const padded = pad4(table);
		body.push(...padded);
		offset += padded.length;
	}
	return Uint8Array.from(
		bytes(u32(0x00010000), u16(tags.length), u16(128), u16(3), u16(tags.length * 16 - 128), directory, body),
	);
}

function buildPdfShowingA(font: Uint8Array): ArrayBuffer {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const offsets: number[] = [];
	let length = 0;
	const add = (data: string | Uint8Array) => {
		const chunk = typeof data === "string" ? encoder.encode(data) : data;
		chunks.push(chunk);
		length += chunk.length;
	};
	const object = (id: number, body: string | Uint8Array, prefix = "", suffix = "") => {
		offsets[id] = length;
		add(`${id} 0 obj\n${prefix}`);
		add(body);
		add(`${suffix}\nendobj\n`);
	};
	const content = "BT /F1 24 Tf 10 10 Td (A) Tj ET";
	add("%PDF-1.4\n");
	object(1, "<< /Type /Catalog /Pages 2 0 R >>");
	object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
	object(
		3,
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 50] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
	);
	object(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	object(
		5,
		"<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Test /FirstChar 65 /LastChar 65 /Widths [600] /FontDescriptor 6 0 R /Encoding /WinAnsiEncoding >>",
	);
	object(
		6,
		"<< /Type /FontDescriptor /FontName /AAAAAA+Test /Flags 32 /FontBBox [0 0 600 700] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>",
	);
	object(7, font, `<< /Length ${font.length} /Length1 ${font.length} >>\nstream\n`, "\nendstream");
	const xref = length;
	add(
		`xref\n0 8\n0000000000 65535 f \n${offsets
			.slice(1)
			.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
			.join("")}`,
	);
	add(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
	const out = new Uint8Array(length);
	let position = 0;
	for (const chunk of chunks) {
		out.set(chunk, position);
		position += chunk.length;
	}
	return out.buffer;
}

let outputDir: string;
let written: string[];

beforeEach(() => {
	outputDir = makeTempDirectory("atomic-pdf-extract-");
	written = [];
	const record = (...args: unknown[]) => void written.push(args.map(String).join(" "));
	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		vi.spyOn(console, method).mockImplementation(record);
	}
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		written.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		written.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	removeTempDirectory(outputDir);
});

// The control must run before the extraction: pdf.js keeps its verbosity level
// process-wide once a document is opened with an explicit one.
test("PDF extraction prints no pdf.js font warnings to the console", async () => {
	const pdf = buildPdfShowingA(buildTrueTypeFontWithUndefinedHintFunction());

	// Control: the fixture really triggers pdf.js's warning when verbosity is left at its default.
	const control = await getDocumentProxy(new Uint8Array(pdf.slice(0)));
	await (await control.getPage(1)).getTextContent();
	await control.loadingTask.destroy();
	assert.match(written.join("\n"), /TT: undefined function: 32/);
	written.length = 0;

	const result = await extractPDFToMarkdown(pdf, "https://example.com/paper.pdf", { outputDir, filename: "paper.md" });

	assert.deepEqual(written, []);
	assert.match(readFileSync(join(outputDir, "paper.md"), "utf-8"), /^A$/m);
	assert.equal(result.pages, 1);
});

test("PDF extraction still rejects input that is not a PDF", async () => {
	await assert.rejects(
		extractPDFToMarkdown(new TextEncoder().encode("not a pdf").buffer, "https://example.com/bad.pdf", { outputDir }),
	);
});
