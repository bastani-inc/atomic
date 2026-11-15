import { type ImageContent, type ModelImageResizeOptions, type TextContent, toInlineImage } from "@bastani/atomic-ai";
import { processImage } from "./image-process.ts";

export type ToolResultContent = TextContent | ImageContent;

export interface NormalizeToolResultImagesOptions {
	/** Whether oversized images are resized to inline provider limits. Default: true */
	autoResizeImages?: boolean;
	/** Model-specific resize profile. Uses the conservative built-in defaults when omitted. */
	resizeOptions?: ModelImageResizeOptions;
}

/**
 * Normalize image blocks returned by tool results.
 *
 * The `read` tool and `@file` CLI attachments run their images through `processImage`, but tools
 * that produce images themselves hand back arbitrary base64 payloads that go straight into session
 * history and every subsequent provider request. Normalize them once as they enter history.
 *
 * Returns the original array when nothing changed so callers can skip rewriting the result.
 */
export async function normalizeToolResultImages(
	content: ToolResultContent[],
	options?: NormalizeToolResultImagesOptions,
): Promise<ToolResultContent[]> {
	if (!content.some((block) => block.type === "image")) {
		return content;
	}

	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized: ToolResultContent[] = [];
	let changed = false;

	for (const block of content) {
		if (block.type !== "image") {
			normalized.push(block);
			continue;
		}

		const processed = await processImage(Buffer.from(block.data, "base64"), block.mimeType, {
			autoResizeImages,
			resizeOptions: options?.resizeOptions,
		});
		if (!processed.ok) {
			// Keep an image the backend could not process only if providers accept its format; replace
			// any other (an SVG, say) with a placeholder so it cannot fail later requests (#4908).
			const inline = toInlineImage(block);
			normalized.push(inline);
			changed ||= inline !== block;
			continue;
		}

		if (processed.data === block.data && processed.mimeType === block.mimeType && processed.hints.length === 0) {
			normalized.push(block);
			continue;
		}

		normalized.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		if (processed.hints.length > 0) {
			normalized.push({ type: "text", text: processed.hints.join("\n") });
		}
		changed = true;
	}

	return changed ? normalized : content;
}
