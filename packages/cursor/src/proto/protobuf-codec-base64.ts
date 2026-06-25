export interface CursorImageBase64Context {
	readonly kind: string;
	readonly mimeType: string;
	readonly index?: number;
}

// Cursor image protobuf serialization accepts canonical standard base64 only; whitespace is rejected.
const STANDARD_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function decodeStrictBase64ImageData(data: string, context: CursorImageBase64Context): Uint8Array {
	if (data.length % 4 !== 0 || !STANDARD_BASE64_PATTERN.test(data)) {
		throwInvalidBase64ImageData(context);
	}
	const decoded = new Uint8Array(Buffer.from(data, "base64"));
	if (Buffer.from(decoded).toString("base64") !== data) {
		throwInvalidBase64ImageData(context);
	}
	return decoded;
}

function throwInvalidBase64ImageData(context: CursorImageBase64Context): never {
	const index = context.index === undefined ? "" : ` at index ${context.index}`;
	throw new Error(`Invalid ${context.kind} base64 image data${index} for MIME type ${context.mimeType}`);
}
