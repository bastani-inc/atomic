import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { resolveReadPathAsync } from "./tools/path-utils.ts";

export interface PromptFileReferenceOptions {
	/** Current working directory used to resolve relative @file references. */
	cwd: string;
	/** Whether to auto-resize images to 2000x2000 max. Default: true. */
	autoResizeImages?: boolean;
}

export interface PromptFileReferenceResult {
	text: string;
	images: ImageContent[];
}

interface ImageReference {
	image?: ImageContent;
	replacementText: string;
}

interface CandidatePath {
	path: string;
	suffix: string;
}

interface PromptImageReplacement {
	start: number;
	end: number;
	text: string;
	image?: ImageContent;
}

interface ProtectedRange {
	start: number;
	end: number;
}

interface FileTagRange extends ProtectedRange {
	attrs: string;
	text: string;
	depth: number;
}

const INLINE_FILE_REFERENCE_PATTERN = /(^|[\s([{<])@(?:"([^"]+)"|'([^']+)'|((?:\\.|[^ \t\r\n\f\v])+))/gu;
const FILE_TAG_TOKEN_PATTERN = /<file(?=[\s>/])([^>]*)>|<\/file>/giu;
const FILE_TAG_NAME_ATTRIBUTE_PATTERN = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/iu;
const CLIPBOARD_FILE_NAME_PATTERN = new RegExp(
	String.raw`${APP_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-clipboard-[^\s/\\]*\.(?:png|jpe?g|gif|webp)(?=$|[\s),;:!?\]}>"]|'|\.(?=$|\s))`,
	"giu",
);
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">"]);

function escapeFileNameAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeFileNameAttribute(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, body: string) => {
		const key = body.toLowerCase();
		if (key.startsWith("#x")) {
			const codePoint = Number.parseInt(key.slice(2), 16);
			return Number.isInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
		}
		if (key.startsWith("#")) {
			const codePoint = Number.parseInt(key.slice(1), 10);
			return Number.isInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
		}
		const namedEntities: Record<string, string> = {
			amp: "&",
			quot: '"',
			apos: "'",
			lt: "<",
			gt: ">",
		};
		return namedEntities[key] ?? entity;
	});
}

function splitUnquotedCandidate(rawPath: string): CandidatePath[] {
	let end = rawPath.length;
	while (end > 0 && TRAILING_PUNCTUATION.has(rawPath[end - 1]!)) {
		end--;
	}

	if (end === rawPath.length) {
		return [{ path: rawPath, suffix: "" }];
	}

	return [
		{ path: rawPath, suffix: "" },
		{ path: rawPath.slice(0, end), suffix: rawPath.slice(end) },
	];
}

function stripMatchingQuotes(value: string): string {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value[value.length - 1];
	return (first === last && (first === "\"" || first === "'")) ? value.slice(1, -1) : value;
}

function wholeMessagePathCandidates(text: string): CandidatePath[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const unquoted = stripMatchingQuotes(trimmed);
	return [{ path: unquoted, suffix: "" }];
}

function appendFileTagBodyText(fileTagText: string, bodyText: string): string {
	return fileTagText.replace(/<\/file>$/iu, `${bodyText}</file>`);
}

function imageOmissionBodyText(replacementText: string): string {
	const match = /^<file\b[^>]*>([\s\S]*)<\/file>$/iu.exec(replacementText);
	return match?.[1] ?? "[Image omitted: could not be attached.]";
}

function clipboardPathStartCandidates(text: string, filenameStart: number): number[] {
	const starts = new Set<number>();
	for (let index = 0; index <= filenameStart; index++) {
		const remainder = text.slice(index, filenameStart);
		if (
			(remainder.startsWith("file://") && /[\\/]$/u.test(remainder)) ||
			(/^(?:\/|\\|~[\\/]|[A-Za-z]:[\\/])/u.test(remainder) && /[\\/]$/u.test(remainder))
		) {
			starts.add(index);
		}
	}
	return [...starts].sort((left, right) => left - right);
}

function findFileTagRanges(text: string): FileTagRange[] {
	const stack: Array<{ start: number; attrs: string; depth: number }> = [];
	const ranges: FileTagRange[] = [];
	for (const match of text.matchAll(FILE_TAG_TOKEN_PATTERN)) {
		const token = match[0];
		const start = match.index ?? 0;
		if (/^<file\b/iu.test(token)) {
			stack.push({ start, attrs: match[1] ?? "", depth: stack.length });
			continue;
		}
		const open = stack.pop();
		if (!open) continue;
		const end = start + token.length;
		ranges.push({ start: open.start, end, attrs: open.attrs, text: text.slice(open.start, end), depth: open.depth });
	}
	for (const open of stack) {
		ranges.push({ start: open.start, end: text.length, attrs: open.attrs, text: text.slice(open.start), depth: open.depth });
	}
	return ranges.sort((left, right) => left.start - right.start || right.end - left.end);
}

function overlapsRange(
	ranges: readonly ProtectedRange[],
	start: number,
	end: number,
): boolean {
	return ranges.some((range) => start < range.end && end > range.start);
}

function overlapsExistingReplacement(
	replacements: readonly PromptImageReplacement[],
	start: number,
	end: number,
): boolean {
	return overlapsRange(replacements, start, end);
}

async function addImageReplacementForCandidates(
	replacements: PromptImageReplacement[],
	start: number,
	consumedLength: number,
	pathCandidates: readonly CandidatePath[],
	options: Required<PromptFileReferenceOptions>,
	protectedRanges: readonly ProtectedRange[] = [],
): Promise<void> {
	for (const candidate of pathCandidates) {
		if (!candidate.path) continue;
		const end = start + consumedLength - candidate.suffix.length;
		if (overlapsExistingReplacement(replacements, start, end) || overlapsRange(protectedRanges, start, end)) continue;
		const resolved = await resolveImageReference(candidate.path, options);
		if (!resolved) continue;

		replacements.push({
			start,
			end,
			text: resolved.replacementText,
			...(resolved.image ? { image: resolved.image } : {}),
		});
		return;
	}
}

async function resolveImageReference(
	filePath: string,
	options: Required<PromptFileReferenceOptions>,
): Promise<ImageReference | undefined> {
	let absolutePath: string;
	let mimeType: string | null | undefined;
	try {
		absolutePath = await resolveReadPathAsync(filePath, options.cwd);
		mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
	} catch {
		return undefined;
	}

	if (!mimeType) return undefined;

	let buffer: Buffer;
	try {
		buffer = await readFile(absolutePath);
	} catch {
		return undefined;
	}

	const escapedPath = escapeFileNameAttribute(absolutePath);
	if (options.autoResizeImages) {
		const resized = await resizeImage(buffer, mimeType);
		if (!resized) {
			return {
				replacementText: `<file name="${escapedPath}">[Image omitted: could not be resized below the inline image size limit.]</file>`,
			};
		}

		const dimensionNote = formatDimensionNote(resized);
		return {
			image: { type: "image", mimeType: resized.mimeType, data: resized.data },
			replacementText: `<file name="${escapedPath}">${dimensionNote ?? ""}</file>`,
		};
	}

	return {
		image: { type: "image", mimeType, data: buffer.toString("base64") },
		replacementText: `<file name="${escapedPath}"></file>`,
	};
}

/**
 * Resolve inline prompt image references such as `@diagram.png explain this` into
 * model-visible file markers plus image attachments. Non-image or missing paths
 * are left untouched so normal mentions and prose continue to work.
 */
export async function resolvePromptImageReferences(
	text: string,
	options: PromptFileReferenceOptions,
): Promise<PromptFileReferenceResult> {
	const resolvedOptions: Required<PromptFileReferenceOptions> = {
		cwd: options.cwd,
		autoResizeImages: options.autoResizeImages ?? true,
	};
	const replacements: PromptImageReplacement[] = [];
	const fileTagRanges = findFileTagRanges(text);
	const protectedFileTagRanges: ProtectedRange[] = fileTagRanges;

	for (const fileTagRange of fileTagRanges) {
		if (fileTagRange.depth > 0) continue;
		const nameMatch = FILE_TAG_NAME_ATTRIBUTE_PATTERN.exec(fileTagRange.attrs);
		if (!nameMatch) continue;
		const path = decodeFileNameAttribute(nameMatch[1] ?? nameMatch[2] ?? "");
		const resolved = await resolveImageReference(path, resolvedOptions);
		if (!resolved) continue;
		replacements.push({
			start: fileTagRange.start,
			end: fileTagRange.end,
			text: resolved.image ? fileTagRange.text : appendFileTagBodyText(fileTagRange.text, imageOmissionBodyText(resolved.replacementText)),
			...(resolved.image ? { image: resolved.image } : {}),
		});
	}

	for (const match of text.matchAll(INLINE_FILE_REFERENCE_PATTERN)) {
		const fullMatch = match[0];
		const prefix = match[1] ?? "";
		const quotedPath = match[2] ?? match[3];
		const unquotedPath = match[4];
		const pathCandidates = quotedPath !== undefined ? [{ path: quotedPath, suffix: "" }] : splitUnquotedCandidate(unquotedPath ?? "");
		await addImageReplacementForCandidates(
			replacements,
			(match.index ?? 0) + prefix.length,
			fullMatch.length - prefix.length,
			pathCandidates,
			resolvedOptions,
			protectedFileTagRanges,
		);
	}

	for (const match of text.matchAll(CLIPBOARD_FILE_NAME_PATTERN)) {
		const filenameStart = match.index ?? 0;
		const filenameEnd = filenameStart + match[0].length;
		for (const start of clipboardPathStartCandidates(text, filenameStart)) {
			const replacementCount = replacements.length;
			await addImageReplacementForCandidates(
				replacements,
				start,
				filenameEnd - start,
				[{ path: text.slice(start, filenameEnd), suffix: "" }],
				resolvedOptions,
				protectedFileTagRanges,
			);
			if (replacements.length > replacementCount) break;
		}
	}

	if (replacements.length === 0) {
		const trimmed = text.trim();
		const trimmedStart = trimmed ? text.indexOf(trimmed) : 0;
		await addImageReplacementForCandidates(
			replacements,
			trimmedStart,
			trimmed.length,
			wholeMessagePathCandidates(text),
			resolvedOptions,
		);
	}

	if (replacements.length === 0) {
		return { text, images: [] };
	}
	replacements.sort((left, right) => left.start - right.start);

	let output = "";
	let cursor = 0;
	const images: ImageContent[] = [];
	for (const replacement of replacements) {
		output += text.slice(cursor, replacement.start);
		output += replacement.text;
		cursor = replacement.end;
		if (replacement.image) images.push(replacement.image);
	}
	output += text.slice(cursor);

	return { text: output, images };
}
