import { fromBinary, fromJson, toBinary, toJson, type JsonValue as ProtobufJsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { parseJsonValue, type JsonObject, type JsonValue } from "../config.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeProtobufValue(value: JsonValue): Uint8Array {
	return toBinary(ValueSchema, fromJson(ValueSchema, value as ProtobufJsonValue));
}

function encodeMcpArgValue(value: JsonValue): Uint8Array {
	try {
		return encodeProtobufValue(value);
	} catch {
		return textEncoder.encode(String(value));
	}
}

export function encodeMcpArgsMap(args: JsonObject): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = {};
	for (const [key, value] of Object.entries(args)) encoded[key] = encodeMcpArgValue(value);
	return encoded;
}

function decodeMcpArgValue(value: Uint8Array): JsonValue {
	try {
		const decoded = toJson(ValueSchema, fromBinary(ValueSchema, value)) as ProtobufJsonValue;
		return parseJsonValue(JSON.stringify(decoded)) ?? null;
	} catch {
		return textDecoder.decode(value);
	}
}

export function decodeMcpArgsMap(args: Record<string, Uint8Array>): JsonObject {
	const decoded: JsonObject = {};
	for (const [key, value] of Object.entries(args)) decoded[key] = decodeMcpArgValue(value);
	return decoded;
}

export function serializableJsonValue(value: object): JsonValue {
	return parseJsonValue(JSON.stringify(value)) ?? {};
}

