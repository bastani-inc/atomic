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

const INLINE_FILE_REFERENCE_PATTERN = /(^|[\s([{<])@(?:"([^"]+)"|'([^']+)'|([^\s]+))/gu;
const BARE_ABSOLUTE_FILE_REFERENCE_PATTERN = /(^|[\s([{<])(?:"((?:\/|~\/)[^"]+)"|'((?:\/|~\/)[^']+)'|((?:\/|~\/)[^\s]+))/gu;
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

function escapeFileNameAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
