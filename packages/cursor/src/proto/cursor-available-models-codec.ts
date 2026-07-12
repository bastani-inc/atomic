import type { CursorUsableModel } from "../model-mapper.js";

/** Reverse-engineered metadata from Cursor's private AiService/AvailableModels RPC. */
export interface CursorModelParameter {
	readonly id: string;
	readonly value: string;
}

export interface CursorParameterizedVariant {
	readonly parameters: readonly CursorModelParameter[];
	readonly isMaxMode: boolean;
	readonly isDefaultMaxConfig?: boolean;
	readonly isDefaultNonMaxConfig?: boolean;
	readonly displayName?: string;
	readonly displayNameOutsidePicker?: string;
	readonly variantStringRepresentation?: string;
}

export interface CursorAvailableModel extends CursorUsableModel {
	readonly serverModelName?: string;
	readonly supportsImages?: boolean;
	readonly supportsMaxMode?: boolean;
	readonly supportsNonMaxMode?: boolean;
	readonly maxModeContextWindow?: number;
	readonly variants: readonly CursorParameterizedVariant[];
	readonly metadataProvenance: "available-models-reverse-engineered";
}

interface WireReader {
	readonly bytes: Uint8Array;
	offset: number;
}

export function encodeAvailableModelsRequest(): Uint8Array {
	// aiserver.v1.AvailableModelsRequest: use_model_parameters=true (5),
	// do_not_use_markdown=true (7). These field numbers are reverse-engineered.
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
	let id = "";
	let displayName: string | undefined;
	let serverModelName: string | undefined;
	let supportsImages: boolean | undefined;
	let supportsMaxMode: boolean | undefined;
	let supportsNonMaxMode: boolean | undefined;
	let contextWindow: number | undefined;
	let maxModeContextWindow: number | undefined;
	const variants: CursorParameterizedVariant[] = [];
	while (reader.offset < bytes.length) {
		const tag = readVarint(reader);
		const fieldNumber = Math.floor(tag / 8);
		const wireType = tag % 8;
		if (fieldNumber === 1 && wireType === 2) id = decodeString(readLengthDelimited(reader)).trim();
		else if (fieldNumber === 10 && wireType === 0) supportsImages = readVarint(reader) !== 0;
		else if (fieldNumber === 14 && wireType === 0) supportsMaxMode = readVarint(reader) !== 0;
		else if (fieldNumber === 15 && wireType === 0) contextWindow = positiveSafeInteger(readVarint(reader));
		else if (fieldNumber === 16 && wireType === 0) maxModeContextWindow = positiveSafeInteger(readVarint(reader));
		else if (fieldNumber === 17 && wireType === 2) displayName = nonEmpty(decodeString(readLengthDelimited(reader)));
		else if (fieldNumber === 18 && wireType === 2) serverModelName = nonEmpty(decodeString(readLengthDelimited(reader)));
		else if (fieldNumber === 19 && wireType === 0) supportsNonMaxMode = readVarint(reader) !== 0;
		else if (fieldNumber === 30 && wireType === 2) variants.push(decodeVariant(readLengthDelimited(reader)));
		else skipWireField(reader, wireType);
	}
	if (!id) return undefined;
	return {
		id,
		...(displayName ? { displayName } : {}),
		...(serverModelName ? { serverModelName } : {}),
		...(supportsImages !== undefined ? { supportsImages } : {}),
		...(supportsMaxMode !== undefined ? { supportsMaxMode } : {}),
		...(supportsNonMaxMode !== undefined ? { supportsNonMaxMode } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxModeContextWindow !== undefined ? { maxModeContextWindow } : {}),
		variants,
		metadataProvenance: "available-models-reverse-engineered",
	};
}

function decodeVariant(bytes: Uint8Array): CursorParameterizedVariant {
	const reader: WireReader = { bytes, offset: 0 };
	const parameters: CursorModelParameter[] = [];
	let isMaxMode = false;
	let isDefaultMaxConfig: boolean | undefined;
	let isDefaultNonMaxConfig: boolean | undefined;
	let displayName: string | undefined;
	let displayNameOutsidePicker: string | undefined;
	let variantStringRepresentation: string | undefined;
	while (reader.offset < bytes.length) {
		const tag = readVarint(reader);
		const fieldNumber = Math.floor(tag / 8);
		const wireType = tag % 8;
		if (fieldNumber === 1 && wireType === 2) parameters.push(decodeParameter(readLengthDelimited(reader)));
		else if (fieldNumber === 2 && wireType === 2) displayName = nonEmpty(decodeString(readLengthDelimited(reader)));
		else if (fieldNumber === 3 && wireType === 0) isMaxMode = readVarint(reader) !== 0;
		else if (fieldNumber === 4 && wireType === 0) isDefaultMaxConfig = readVarint(reader) !== 0;
		else if (fieldNumber === 5 && wireType === 0) isDefaultNonMaxConfig = readVarint(reader) !== 0;
		else if (fieldNumber === 8 && wireType === 2) displayNameOutsidePicker = nonEmpty(decodeString(readLengthDelimited(reader)));
		else if (fieldNumber === 9 && wireType === 2) variantStringRepresentation = nonEmpty(decodeString(readLengthDelimited(reader)));
		else skipWireField(reader, wireType);
	}
	return {
		parameters,
		isMaxMode,
		...(isDefaultMaxConfig !== undefined ? { isDefaultMaxConfig } : {}),
		...(isDefaultNonMaxConfig !== undefined ? { isDefaultNonMaxConfig } : {}),
		...(displayName ? { displayName } : {}),
		...(displayNameOutsidePicker ? { displayNameOutsidePicker } : {}),
		...(variantStringRepresentation ? { variantStringRepresentation } : {}),
	};
}

function decodeParameter(bytes: Uint8Array): CursorModelParameter {
	const reader: WireReader = { bytes, offset: 0 };
	let id = "";
	let value = "";
	while (reader.offset < bytes.length) {
		const tag = readVarint(reader);
		const fieldNumber = Math.floor(tag / 8);
		const wireType = tag % 8;
		if (fieldNumber === 1 && wireType === 2) id = decodeString(readLengthDelimited(reader));
		else if (fieldNumber === 2 && wireType === 2) value = decodeString(readLengthDelimited(reader));
		else skipWireField(reader, wireType);
	}
	return { id, value };
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
	if (wireType === 0) {
		readVarint(reader);
		return;
	}
	if (wireType === 1) return skipBytes(reader, 8);
	if (wireType === 2) {
		readLengthDelimited(reader);
		return;
	}
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

function positiveSafeInteger(value: number): number | undefined {
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonEmpty(value: string): string | undefined {
	return value.length > 0 ? value : undefined;
}
