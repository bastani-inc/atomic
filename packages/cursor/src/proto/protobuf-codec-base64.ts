export interface CursorImageBase64Context {
	readonly kind: string;
	readonly mimeType: string;
	readonly index?: number;
}

// Cursor image protobuf serialization accepts canonical standard base64 after MIME line wrapping is removed.
const BASE64_WHITESPACE_PATTERN = /[\t\n\f\r ]+/gu;
const STANDARD_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function decodeStrictBase64ImageData(data: string, context: CursorImageBase64Context): Uint8Array {
	const normalized = data.replace(BASE64_WHITESPACE_PATTERN, "");
	if (normalized.length === 0 || normalized.length % 4 !== 0 || !STANDARD_BASE64_PATTERN.test(normalized)) {
		throwInvalidBase64ImageData(context);
	}
	return Buffer.from(normalized, "base64");
}

function throwInvalidBase64ImageData(context: CursorImageBase64Context): never {
	const index = context.index === undefined ? "" : ` at index ${context.index}`;
	throw new Error(`Invalid ${context.kind} base64 image data${index} for MIME type ${context.mimeType}`);
}
