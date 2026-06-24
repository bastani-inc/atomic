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

function htmlToReadableText(html: string): string {
	let text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
	const title = text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
	text = text.replace(/<\/(h[1-6]|p|div|li|tr|blockquote|pre)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<li\b[^>]*>/gi, "- ").replace(/<[^>]+>/g, "");
	text = decodeEntities(text).split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
	return title && !text.startsWith(title) ? `# ${title}\n\n${text}` : text;
}

function decodeEntities(value: string): string {
	return value.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
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
