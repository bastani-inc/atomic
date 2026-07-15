/** Minimal image-enrichment metadata from Cursor's private AvailableModels RPC. */
export interface CursorAvailableModel {
	readonly id?: string;
	readonly serverModelName?: string;
	readonly variantIds: readonly string[];
	readonly supportsImages?: boolean;
}

interface WireReader {
	readonly bytes: Uint8Array;
	offset: number;
}

export function encodeAvailableModelsRequest(): Uint8Array {
	// Variant string representations are returned when model parameters are
	// requested. No parameter tuple is retained or used for execution.
	return new Uint8Array([...encodeBoolField(5, true), ...encodeBoolField(7, true)]);
}

export function decodeAvailableModelsResponse(bytes: Uint8Array): readonly CursorAvailableModel[] {
	const reader: WireReader = { bytes, offset: 0 };
	const models: CursorAvailableModel[] = [];
	while (reader.offset < bytes.length) {
		const tag = readVarint(reader);
		const fieldNumber = Math.floor(tag / 8);
		const wireType = tag % 8;
		if (fieldNumber === 2 && wireType === 2) {
			const model = decodeModel(readLengthDelimited(reader));
			if (model) models.push(model);
		} else {
			skipWireField(reader, wireType);
		}
	}
	return models;
}

function decodeModel(bytes: Uint8Array): CursorAvailableModel | undefined {
	const reader: WireReader = { bytes, offset: 0 };
	let id: string | undefined;
	let serverModelName: string | undefined;
	let supportsImages: boolean | undefined;
	const variantIds: string[] = [];
	while (reader.offset < bytes.length) {
		const tag = readVarint(reader);
		const fieldNumber = Math.floor(tag / 8);
		const wireType = tag % 8;
		if (fieldNumber === 1 && wireType === 2) id = nonEmpty(decodeString(readLengthDelimited(reader)));
		else if (fieldNumber === 10 && wireType === 0) supportsImages = readVarint(reader) !== 0;
		else if (fieldNumber === 18 && wireType === 2) serverModelName = nonEmpty(decodeString(readLengthDelimited(reader)));
		else if (fieldNumber === 30 && wireType === 2) {
			const variantId = decodeVariantId(readLengthDelimited(reader));
			if (variantId) variantIds.push(variantId);
		} else skipWireField(reader, wireType);
	}
	const distinctVariantIds = [...new Set(variantIds)];
	if (!id && !serverModelName && distinctVariantIds.length === 0) return undefined;
	return {
		...(id ? { id } : {}),
		...(serverModelName ? { serverModelName } : {}),
		variantIds: distinctVariantIds,
		...(supportsImages !== undefined ? { supportsImages } : {}),
	};
}

function decodeVariantId(bytes: Uint8Array): string | undefined {
	const reader: WireReader = { bytes, offset: 0 };
	let variantId: string | undefined;
	while (reader.offset < bytes.length) {
		const tag = readVarint(reader);
		const fieldNumber = Math.floor(tag / 8);
		const wireType = tag % 8;
		if (fieldNumber === 9 && wireType === 2) variantId = nonEmpty(decodeString(readLengthDelimited(reader)));
		else skipWireField(reader, wireType);
	}
	return variantId;
}

function encodeVarint(value: number): number[] {
	const output: number[] = [];
	let remaining = value >>> 0;
	while (remaining >= 0x80) {
		output.push((remaining & 0x7f) | 0x80);
		remaining >>>= 7;
	}
	output.push(remaining);
	return output;
}

function encodeBoolField(fieldNumber: number, value: boolean): number[] {
	return [...encodeVarint(fieldNumber * 8), value ? 1 : 0];
}

function readVarint(reader: WireReader): number {
	let result = 0;
	let shift = 0;
	while (reader.offset < reader.bytes.length) {
		const byte = reader.bytes[reader.offset++]!;
		if (shift < 53) result += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) return result;
		shift += 7;
		if (shift >= 70) throw new Error("varint too long");
	}
	throw new Error("unexpected EOF while reading varint");
}

function readLengthDelimited(reader: WireReader): Uint8Array {
	const length = readVarint(reader);
	if (!Number.isSafeInteger(length) || length < 0) throw new Error("length-delimited size is invalid");
	const end = reader.offset + length;
	if (end > reader.bytes.length) throw new Error("length-delimited field exceeds buffer");
	const value = reader.bytes.subarray(reader.offset, end);
	reader.offset = end;
	return value;
}

function skipWireField(reader: WireReader, wireType: number): void {
	if (wireType === 0) return void readVarint(reader);
	if (wireType === 1) return skipBytes(reader, 8);
	if (wireType === 2) return void readLengthDelimited(reader);
	if (wireType === 5) return skipBytes(reader, 4);
	throw new Error(`unsupported wire type ${wireType}`);
}

function skipBytes(reader: WireReader, length: number): void {
	const end = reader.offset + length;
	if (end > reader.bytes.length) throw new Error("fixed-width field exceeds buffer");
	reader.offset = end;
}

function decodeString(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function nonEmpty(value: string): string | undefined {
	return value.trim().length > 0 ? value : undefined;
}
