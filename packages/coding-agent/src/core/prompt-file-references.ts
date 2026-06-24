import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
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

const INLINE_FILE_REFERENCE_PATTERN = /(^|[\s([{<])@(?:"([^"]+)"|'([^']+)'|((?:\\.|[^ \t\r\n\f\v])+))/gu;
// Bare absolute references intentionally probe the filesystem so clipboard and
// terminal drag/drop image paths can become current-turn attachments without an
// explicit `@` prefix. Callers should gate this resolver to image-capable paths.
const BARE_ABSOLUTE_FILE_REFERENCE_PATTERN = /(^|[\s([{<])(?:"((?:\/|~\/|file:\/\/)[^"]+)"|'((?:\/|~\/|file:\/\/)[^']+)'|((?:\/|~\/|file:\/\/)(?:\\.|[^ \t\r\n\f\v])+))/giu;
const FILE_TAG_PATTERN = /<file\b[^>]*\bname=(?:"([^"]*)"|'([^']*)')[^>]*>[\s\S]*?<\/file>/giu;
const UNQUOTED_REFERENCE_START_PATTERN = /(^|[\s([{<])(@?(?:file:\/\/|~\/|\/)|@(?=[^\s"'<>]))/giu;
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp)(?=$|[\s),;:!?.\]}>'"])/giu;
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

function lineRemainder(text: string, start: number): string {
	const newlineIndex = text.indexOf("\n", start);
	return text.slice(start, newlineIndex === -1 ? undefined : newlineIndex);
}

function addUniqueCandidate(candidates: CandidatePath[], candidate: CandidatePath): void {
	if (candidate.path && !candidates.some((existing) => existing.path === candidate.path)) {
		candidates.push(candidate);
	}
}

function imageExtensionCandidates(rawPathAndSuffix: string): CandidatePath[] {
	const candidates: CandidatePath[] = [];
	for (const match of rawPathAndSuffix.matchAll(IMAGE_EXTENSION_PATTERN)) {
		const end = (match.index ?? 0) + match[0].length;
		addUniqueCandidate(candidates, {
			path: rawPathAndSuffix.slice(0, end),
			suffix: rawPathAndSuffix.slice(end),
		});
	}
	return candidates.sort((left, right) => right.path.length - left.path.length);
}

function unquotedPathCandidates(rawPathAndSuffix: string): CandidatePath[] {
	const candidates = imageExtensionCandidates(rawPathAndSuffix);
	for (const candidate of splitUnquotedCandidate(rawPathAndSuffix)) {
		addUniqueCandidate(candidates, candidate);
	}
	return candidates;
}

function overlapsExistingReplacement(
	replacements: readonly PromptImageReplacement[],
	start: number,
	end: number,
): boolean {
	return replacements.some((replacement) => start < replacement.end && end > replacement.start);
}

async function addImageReplacementForCandidates(
	replacements: PromptImageReplacement[],
	start: number,
	consumedLength: number,
	pathCandidates: readonly CandidatePath[],
	options: Required<PromptFileReferenceOptions>,
): Promise<void> {
	for (const candidate of pathCandidates) {
		if (!candidate.path) continue;
		const end = start + consumedLength - candidate.suffix.length;
		if (overlapsExistingReplacement(replacements, start, end)) continue;
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

	for (const match of text.matchAll(FILE_TAG_PATTERN)) {
		const fullMatch = match[0];
		const path = decodeFileNameAttribute(match[1] ?? match[2] ?? "");
		await addImageReplacementForCandidates(
			replacements,
			match.index ?? 0,
			fullMatch.length,
			[{ path, suffix: "" }],
			resolvedOptions,
		);
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
		);
	}

	for (const match of text.matchAll(BARE_ABSOLUTE_FILE_REFERENCE_PATTERN)) {
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
		);
	}

	for (const match of text.matchAll(UNQUOTED_REFERENCE_START_PATTERN)) {
		const prefix = match[1] ?? "";
		const marker = match[2] ?? "";
		const start = (match.index ?? 0) + prefix.length;
		const pathStart = start + (marker === "@" ? marker.length : 0);
		const rawPathAndSuffix = lineRemainder(text, pathStart);
		await addImageReplacementForCandidates(
			replacements,
			start,
			pathStart - start + rawPathAndSuffix.length,
			unquotedPathCandidates(rawPathAndSuffix),
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
