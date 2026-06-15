type WireField = { readonly fieldNumber: number; readonly wireType: number; readonly value: bigint | Uint8Array | number };

export type TestJsonValue = string | number | boolean | null | { readonly [key: string]: TestJsonValue } | readonly TestJsonValue[];

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function readVarint(data: Uint8Array, startOffset: number): { readonly value: bigint; readonly offset: number } {
	let result = 0n;
	let shift = 0n;
	let offset = startOffset;
	while (offset < data.length) {
		const byte = data[offset++] ?? 0;
		result |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value: result, offset };
		shift += 7n;
		if (shift > 63n) throw new Error("varint too long");
	}
	throw new Error("truncated varint");
}

function encodeVarint(value: bigint): Uint8Array {
	const bytes: number[] = [];
	let current = value;
	do {
		let byte = Number(current & 0x7fn);
		current >>= 7n;
		if (current !== 0n) byte |= 0x80;
		bytes.push(byte);
	} while (current !== 0n);
	return new Uint8Array(bytes);
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

function encodeLengthDelimitedField(fieldNumber: number, value: Uint8Array): Uint8Array {
	return concatBytes(encodeVarint(BigInt((fieldNumber << 3) | WIRE_LENGTH_DELIMITED)), encodeVarint(BigInt(value.length)), value);
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
	return encodeLengthDelimitedField(fieldNumber, textEncoder.encode(value));
}

function encodeMessageField(fieldNumber: number, value: Uint8Array): Uint8Array {
	return encodeLengthDelimitedField(fieldNumber, value);
}

function encodeVarintField(fieldNumber: number, value: bigint): Uint8Array {
	return concatBytes(encodeVarint(BigInt((fieldNumber << 3) | WIRE_VARINT)), encodeVarint(value));
}

function encodeDoubleField(fieldNumber: number, value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value, true);
	return concatBytes(encodeVarint(BigInt((fieldNumber << 3) | WIRE_FIXED64)), bytes);
}

function encodeFixed32Field(fieldNumber: number, value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, true);
	return concatBytes(encodeVarint(BigInt((fieldNumber << 3) | WIRE_FIXED32)), bytes);
}

function readFields(data: Uint8Array): readonly WireField[] {
	const fields: WireField[] = [];
	let offset = 0;
	while (offset < data.length) {
		const tag = readVarint(data, offset);
		offset = tag.offset;
		const fieldNumber = Number(tag.value >> 3n);
		const wireType = Number(tag.value & 0x7n);
		if (fieldNumber <= 0) throw new Error("invalid field number");
		if (wireType === WIRE_VARINT) {
			const value = readVarint(data, offset);
			offset = value.offset;
			fields.push({ fieldNumber, wireType, value: value.value });
		} else if (wireType === WIRE_FIXED64) {
			const end = offset + 8;
			if (end > data.length) throw new Error("truncated fixed64 field");
			const view = new DataView(data.buffer, data.byteOffset + offset, 8);
			fields.push({ fieldNumber, wireType, value: view.getFloat64(0, true) });
			offset = end;
		} else if (wireType === WIRE_LENGTH_DELIMITED) {
			const length = readVarint(data, offset);
			offset = length.offset;
			const end = offset + Number(length.value);
			if (end > data.length) throw new Error("truncated length-delimited field");
			fields.push({ fieldNumber, wireType, value: data.slice(offset, end) });
			offset = end;
		} else {
			throw new Error(`unsupported wire type ${wireType}`);
		}
	}
	return fields;
}

function decodeString(data: Uint8Array): string {
	return textDecoder.decode(data);
}

function decodeValue(data: Uint8Array): TestJsonValue {
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && typeof field.value === "bigint") return null;
		if (field.fieldNumber === 2 && typeof field.value === "number") return field.value;
		if (field.fieldNumber === 3 && field.value instanceof Uint8Array) return decodeString(field.value);
		if (field.fieldNumber === 4 && typeof field.value === "bigint") return field.value !== 0n;
		if (field.fieldNumber === 5 && field.value instanceof Uint8Array) return decodeStruct(field.value);
		if (field.fieldNumber === 6 && field.value instanceof Uint8Array) return decodeList(field.value);
	}
	throw new Error("missing protobuf Value field");
}

function decodeStruct(data: Uint8Array): { readonly [key: string]: TestJsonValue } {
	const output: Record<string, TestJsonValue> = {};
	for (const field of readFields(data)) {
		if (field.fieldNumber !== 1 || !(field.value instanceof Uint8Array)) continue;
		let key: string | undefined;
		let value: TestJsonValue | undefined;
		for (const entryField of readFields(field.value)) {
			if (entryField.fieldNumber === 1 && entryField.value instanceof Uint8Array) key = decodeString(entryField.value);
			else if (entryField.fieldNumber === 2 && entryField.value instanceof Uint8Array) value = decodeValue(entryField.value);
		}
		if (key !== undefined && value !== undefined) output[key] = value;
	}
	return output;
}

function decodeList(data: Uint8Array): readonly TestJsonValue[] {
	const output: TestJsonValue[] = [];
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) output.push(decodeValue(field.value));
	}
	return output;
}

export const cursorProtoTest = { encodeStringField, encodeMessageField, encodeVarintField, encodeDoubleField, encodeFixed32Field, concatBytes, readFields, decodeString, decodeValue };
