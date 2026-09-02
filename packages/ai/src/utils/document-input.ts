import type { DocumentContent } from "../types.ts";

/**
 * The only document media type either serializer implements.
 *
 * `DocumentContent.mimeType` is typed as this literal, so a TypeScript caller cannot pass anything
 * else. This runtime check exists for the JavaScript callers `@bastani/pi-ai` also ships to, who
 * get no compile-time narrowing: without it, a block labelled `text/plain` would be sent to
 * Anthropic as `media_type: "application/pdf"` and to Bedrock as `format: "pdf"`, because both
 * paths hardcode PDF rather than reading the field.
 * https://platform.claude.com/docs/en/build-with-claude/pdf-support
 */
export const SUPPORTED_DOCUMENT_MIME_TYPE = "application/pdf";

/**
 * Reject a document whose media type neither provider path can honor.
 *
 * This runs during request construction, after `transformMessages` has already replaced documents
 * bound for a model without the `pdf` modality with a visible placeholder — so a model that cannot
 * receive documents at all still degrades rather than throwing.
 */
export function assertSupportedDocumentMimeType(block: DocumentContent): void {
	// Widened deliberately: the declared type is the single supported literal, so comparing it
	// directly would be a no-overlap error, and the value this guards against arrives untyped.
	const mimeType: string = block.mimeType;
	if (mimeType === SUPPORTED_DOCUMENT_MIME_TYPE) return;
	throw new Error(
		`Unsupported document mimeType ${JSON.stringify(mimeType)}: ` +
			`only ${JSON.stringify(SUPPORTED_DOCUMENT_MIME_TYPE)} is supported.`,
	);
}
