import type { ImageContent, TextContent } from "../types.ts";

/** The image media types every image-capable provider accepts inline: Anthropic, Bedrock, OpenAI and Gemini. */
export type InlineImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * The inline media type a provider accepts for `mimeType`, or undefined when no provider accepts it
 * (for example `image/svg+xml` or `image/bmp`). Parameters and case are ignored, and `image/jpg` is
 * read as `image/jpeg`.
 */
export function inlineImageMimeType(mimeType: string): InlineImageMimeType | undefined {
	switch (mimeType.split(";")[0].trim().toLowerCase()) {
		case "image/jpeg":
		case "image/jpg":
			return "image/jpeg";
		case "image/png":
			return "image/png";
		case "image/gif":
			return "image/gif";
		case "image/webp":
			return "image/webp";
		default:
			return undefined;
	}
}

/** The text that replaces an image whose `mimeType` no provider accepts inline. */
export function unsupportedImagePlaceholder(mimeType: string): string {
	return `[Image omitted: could not be converted to a supported inline image format (${mimeType}).]`;
}

function isImage<TBlock extends { type: string }>(block: TBlock): block is TBlock & ImageContent {
	return block.type === "image";
}

/**
 * Make an image block safe to send: an accepted type passes through (with its media type
 * normalized), any other type becomes the placeholder text. Returns `block` itself when unchanged.
 */
export function toInlineImage(block: ImageContent): ImageContent | TextContent {
	const mimeType = inlineImageMimeType(block.mimeType);
	if (!mimeType) return { type: "text", text: unsupportedImagePlaceholder(block.mimeType) };
	return mimeType === block.mimeType ? block : { ...block, mimeType };
}

/**
 * Apply {@link toInlineImage} to every image in `content`. Returns `content` itself when every
 * image is already sendable, so callers can skip rewriting the message.
 */
export function toInlineImages<TBlock extends { type: string }>(
	content: TBlock[],
): (TBlock | ImageContent | TextContent)[] {
	let result: (TBlock | ImageContent | TextContent)[] | undefined;
	content.forEach((block, index) => {
		if (!isImage(block)) return;
		const inline = toInlineImage(block);
		if (inline === block) return;
		result ??= content.slice();
		result[index] = inline;
	});
	return result ?? content;
}
