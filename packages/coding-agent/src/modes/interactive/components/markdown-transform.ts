import type { MarkdownTransformContext, MarkdownTransformer } from "../../../core/extensions/types.ts";

/** Built-in transforms can reconstruct the same row at the same width; extension closures can depend on live state. */
const replayableTransforms = new WeakSet<MarkdownTransformer>();

export function replayableMarkdownTransform(transform: MarkdownTransformer): MarkdownTransformer {
	replayableTransforms.add(transform);
	return transform;
}

export function hasExtensionMarkdownTransform(transforms: readonly MarkdownTransformer[]): boolean {
	return transforms.some((transform) => !replayableTransforms.has(transform));
}

/** Applies extension Markdown transformers. `isStreaming` is read per transform, so a reused component sees a stream end. */
export function createMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	isStreaming: () => boolean,
	transformers: readonly MarkdownTransformer[],
	messageId?: string,
	timestamp?: string,
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(
			markdown,
			{ messageType, isStreaming: isStreaming(), availableWidth, messageId, timestamp },
			transformers,
		);
}

function applyMarkdownTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers) {
		try {
			const transformed = transformer(transformedMarkdown, context);
			if (typeof transformed === "string") {
				transformedMarkdown = transformed;
			}
		} catch {
			// Keep the current Markdown and continue with the next transformer.
		}
	}
	return transformedMarkdown;
}
