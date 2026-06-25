import { existsSync } from "node:fs";
import { convertBufferWithMarkit, convertFileWithMarkit } from "../../utils/markit.ts";
import { selectExactReadRanges, selectReadRanges, type ReadLineRange } from "./read-selectors.ts";

const DOCUMENT_EXTENSIONS = /\.(?:pdf|doc|docx|ppt|pptx|xls|xlsx|rtf|epub|ipynb)(?:$|[?#])/i;
const MARKIT_EXTENSIONS = /\.(?:pdf|doc|docx|ppt|pptx|xls|xlsx|rtf|epub)(?:$|[?#])/i;

export function isDocumentPath(pathValue: string): boolean { return DOCUMENT_EXTENSIONS.test(pathValue); }

function documentExtensionFromContentType(contentType: string): string | undefined {
	if (/ipynb|jupyter/i.test(contentType)) return ".ipynb";
	if (/pdf/i.test(contentType)) return ".pdf";
	if (/msword/i.test(contentType)) return ".doc";
	if (/wordprocessingml|officedocument\.word/i.test(contentType)) return ".docx";
	if (/presentationml|officedocument\.presentation/i.test(contentType)) return ".pptx";
	if (/ms-powerpoint|vnd\.ms-powerpoint/i.test(contentType)) return ".ppt";
	if (/spreadsheetml|officedocument\.spreadsheet/i.test(contentType)) return ".xlsx";
	if (/epub/i.test(contentType)) return ".epub";
	if (/ms-excel|vnd\.ms-excel/i.test(contentType)) return ".xls";
	if (/rtf/i.test(contentType)) return ".rtf";
	return undefined;
}

function isHtmlWhitespace(char: string | undefined): boolean { return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f"; }

function findElementStart(lowerHtml: string, tagName: string, fromIndex: number): number {
	const needle = `<${tagName}`;
	let index = fromIndex;
	for (;;) {
		const found = lowerHtml.indexOf(needle, index);
		if (found < 0) return -1;
		const next = lowerHtml[found + needle.length];
		if (next === undefined || next === ">" || next === "/" || isHtmlWhitespace(next)) return found;
		index = found + needle.length;
	}
}

function findClosingTag(lowerHtml: string, tagName: string, fromIndex: number): number {
	const needle = `</${tagName}`;
	let index = fromIndex;
	for (;;) {
		const found = lowerHtml.indexOf(needle, index);
		if (found < 0) return -1;
		let cursor = found + needle.length;
		while (isHtmlWhitespace(lowerHtml[cursor])) cursor++;
		if (lowerHtml[cursor] === ">") return found;
		index = found + needle.length;
	}
}

function stripElementBlocks(html: string, tagName: string): string {
	const lowerHtml = html.toLowerCase();
	const chunks: string[] = [];
	let index = 0;
	for (;;) {
		const start = findElementStart(lowerHtml, tagName, index);
		if (start < 0) break;
		chunks.push(html.slice(index, start));
		const startEnd = html.indexOf(">", start);
		if (startEnd < 0) { index = html.length; break; }
		const closeStart = findClosingTag(lowerHtml, tagName, startEnd + 1);
		if (closeStart < 0) { index = html.length; break; }
		const closeEnd = html.indexOf(">", closeStart);
		if (closeEnd < 0) { index = html.length; break; }
		index = closeEnd + 1;
	}
	chunks.push(html.slice(index));
	return chunks.join("");
}

function extractElementText(html: string, tagName: string): string | undefined {
	const lowerHtml = html.toLowerCase();
	const start = findElementStart(lowerHtml, tagName, 0);
	if (start < 0) return undefined;
	const startEnd = html.indexOf(">", start);
	if (startEnd < 0) return undefined;
	const closeStart = findClosingTag(lowerHtml, tagName, startEnd + 1);
	return closeStart < 0 ? undefined : html.slice(startEnd + 1, closeStart);
}

function readTagName(tagContent: string): { closing: boolean; name: string } {
	let index = 0;
	while (isHtmlWhitespace(tagContent[index])) index++;
	const closing = tagContent[index] === "/";
	if (closing) index++;
	while (isHtmlWhitespace(tagContent[index])) index++;
	const start = index;
	while (index < tagContent.length) {
		const char = tagContent[index];
		if (!char || !(char >= "a" && char <= "z") && !(char >= "A" && char <= "Z") && !(char >= "0" && char <= "9")) break;
		index++;
	}
	return { closing, name: tagContent.slice(start, index).toLowerCase() };
}

function htmlMarkupToPlainText(html: string): string {
	let output = "";
	let index = 0;
	while (index < html.length) {
		const open = html.indexOf("<", index);
		if (open < 0) { output += html.slice(index); break; }
		output += html.slice(index, open);
		const close = html.indexOf(">", open + 1);
		if (close < 0) break;
		const tag = readTagName(html.slice(open + 1, close));
		if (tag.name === "br" || tag.closing && ["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "li", "tr", "blockquote", "pre"].includes(tag.name)) output += "\n";
		else if (!tag.closing && tag.name === "li") output += "- ";
		index = close + 1;
	}
	return normalizeDecodedText(output);
}

function normalizeDecodedText(value: string): string {
	return decodeEntities(value).split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

function htmlToReadableText(html: string): string {
	const stripped = stripElementBlocks(stripElementBlocks(html, "script"), "style");
	const title = extractElementText(stripped, "title");
	const titleText = title ? htmlMarkupToPlainText(title).split("\n").join(" ").trim() : undefined;
	const text = htmlMarkupToPlainText(stripped);
	return titleText && !text.startsWith(titleText) ? `# ${titleText}\n\n${text}` : text;
}

function decodeEntities(value: string): string {
	const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
	let output = "";
	let index = 0;
	while (index < value.length) {
		const ampersand = value.indexOf("&", index);
		if (ampersand < 0) { output += value.slice(index); break; }
		output += value.slice(index, ampersand);
		const semicolon = value.indexOf(";", ampersand + 1);
		if (semicolon < 0 || semicolon - ampersand > 12) { output += "&"; index = ampersand + 1; continue; }
		const entity = value.slice(ampersand + 1, semicolon).toLowerCase();
		const decoded = entities[entity];
		output += decoded ?? value.slice(ampersand, semicolon + 1);
		index = semicolon + 1;
	}
	return output;
}

function notebookMarkdown(buffer: Buffer, source: string): string {
	const nb = JSON.parse(buffer.toString("utf8")) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
	const cells = nb.cells ?? [];
	return cells.map((cell, index) => {
		const sourceText = Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "";
		return `# %% [${cell.cell_type ?? "raw"}] cell:${index}\n${sourceText.trimEnd()}`;
	}).join("\n\n") || `# ${source}\n\n(empty notebook)`;
}

function documentExtension(source: string): string { return `.${source.match(/\.(pdf|docx?|pptx?|xlsx?|rtf|epub)(?:$|[?#])/i)?.[1]?.toLowerCase() ?? "bin"}`; }

async function extractMarkitDocument(buffer: Buffer, source: string): Promise<string> {
	const ext = documentExtension(source);
	const result = existsSync(source) ? await convertFileWithMarkit(source) : await convertBufferWithMarkit(buffer, ext);
	return result.ok ? result.content : `[Cannot read ${ext} file: ${result.error || "conversion failed"}]`;
}

export async function extractDocumentMarkdown(buffer: Buffer, source: string): Promise<string> {
	if (/\.ipynb(?:$|[?#])/i.test(source)) return notebookMarkdown(buffer, source);
	if (MARKIT_EXTENSIONS.test(source)) return extractMarkitDocument(buffer, source);
	return buffer.toString("utf8");
}

export async function decodeReadableUrl(response: Response, url: string): Promise<string> {
	const contentType = response.headers.get("content-type") ?? "";
	const buffer = Buffer.from(await response.arrayBuffer());
	const contentTypeExtension = documentExtensionFromContentType(contentType);
	if (contentTypeExtension || isDocumentPath(url)) return extractDocumentMarkdown(buffer, contentTypeExtension && !isDocumentPath(url) ? `${url}${contentTypeExtension}` : url);
	const text = buffer.toString("utf8");
	if (/html/i.test(contentType) || /<html[\s>]/i.test(text)) return htmlToReadableText(text);
	return text;
}

export function applyReadLineSelection(allLines: string[], ranges: ReadLineRange[] | undefined, offset?: number, limit?: number, exact = false): { lines: string[]; firstLine: number } {
	const rangeSelection = (exact ? selectExactReadRanges : selectReadRanges)(allLines, ranges);
	const rangeStart = ranges?.[0]?.start;
	const startLine = rangeSelection ? (rangeSelection.selectedLines.length === 0 ? rangeStart ?? rangeSelection.firstLine : rangeSelection.firstLine) - 1 : offset ? Math.max(0, offset - 1) : 0;
	const endLine = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length;
	return { lines: rangeSelection?.selectedLines ?? allLines.slice(startLine, endLine), firstLine: startLine + 1 };
}
