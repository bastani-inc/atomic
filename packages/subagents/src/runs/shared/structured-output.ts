import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME, STRUCTURED_OUTPUT_TOOL_NAME, getStructuredOutputMetadataPath } from "@bastani/atomic";
import { Compile } from "typebox/compile";
import type { JsonSchemaObject } from "../../shared/types.ts";

const ENV_PREFIX = APP_NAME.toUpperCase();
export const STRUCTURED_OUTPUT_SCHEMA_ENV = `${ENV_PREFIX}_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA`;
export const STRUCTURED_OUTPUT_CAPTURE_ENV = `${ENV_PREFIX}_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE`;

type JsonPrimitive = string | number | boolean | null;
type JsonArray = readonly JsonValue[];
type JsonRecord = { readonly [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonArray | JsonRecord;

export interface StructuredOutputRuntime {
	schema: JsonSchemaObject;
	schemaPath: string;
	outputPath: string;
	metadataPath: string;
}

export interface StructuredOutputCaptureMetadata {
	toolName: string;
	toolCallId: string;
	success: true;
	terminate: true;
	capturedAt?: string;
}

export interface StructuredOutputTranscriptContent {
	readonly type?: string;
	readonly id?: string;
	readonly name?: string;
}

export interface StructuredOutputTranscriptMessage {
	readonly role: string;
	readonly content?: string | readonly StructuredOutputTranscriptContent[];
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
}

export interface ReadStructuredOutputOptions {
	messages?: readonly StructuredOutputTranscriptMessage[];
	toolName?: string;
}

interface CompiledJsonSchema {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }>;
}

type JsonSchemaRootDescriptor = {
	readonly type?: string | readonly string[];
	readonly anyOf?: readonly JsonSchemaObject[];
	readonly oneOf?: readonly JsonSchemaObject[];
	readonly allOf?: readonly JsonSchemaObject[];
};

type ToolCallBlock = {
	readonly type: "toolCall";
	readonly id?: string;
	readonly name?: string;
};

function schemaTypeIsObjectOnly(type: JsonSchemaRootDescriptor["type"]): boolean {
	if (type === "object") return true;
	return Array.isArray(type) && type.length === 1 && type[0] === "object";
}

function isTopLevelObjectOutputSchema(schema: JsonSchemaObject): boolean {
	const descriptor = schema as JsonSchemaRootDescriptor;
	if (schemaTypeIsObjectOnly(descriptor.type)) return true;
	if (descriptor.type !== undefined) return false;
	if (Array.isArray(descriptor.anyOf) || Array.isArray(descriptor.oneOf)) return false;
	if (Array.isArray(descriptor.allOf)) {
		return descriptor.allOf.length > 0 && descriptor.allOf.every((member) => isTopLevelObjectOutputSchema(member));
	}
	return false;
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanField(record: JsonRecord, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function roleOf(message: StructuredOutputTranscriptMessage): string {
	return message.role;
}

function toolCallBlocks(message: StructuredOutputTranscriptMessage): ToolCallBlock[] {
	if (roleOf(message) !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content
		.filter((block): block is ToolCallBlock => block.type === "toolCall")
		.map((block) => ({ type: "toolCall", id: block.id, name: block.name }));
}

function isFinalityRelevantMessage(message: StructuredOutputTranscriptMessage): boolean {
	const role = roleOf(message);
	// `custom` entries are host/runtime annotations (for example display/status
	// messages) rather than additional child model output, so they should not make
	// an otherwise-final structured_output capture look stale.
	return role === "assistant" || role === "toolResult";
}

function finalityInvalid(message: string): { status: "invalid"; message: string } {
	return { status: "invalid", message };
}

function parseCaptureMetadata(value: JsonValue): { metadata?: StructuredOutputCaptureMetadata; error?: string } {
	if (!isJsonRecord(value)) {
		return { error: "Structured output metadata sidecar must contain an object with call metadata." };
	}
	const toolName = stringField(value, "toolName");
	const toolCallId = stringField(value, "toolCallId");
	if (!toolName || !toolCallId) {
		return { error: "Structured output metadata sidecar is missing toolName or toolCallId metadata." };
	}
	if (booleanField(value, "success") !== true) {
		return { error: "Structured output capture was not marked successful." };
	}
	if (booleanField(value, "terminate") !== true) {
		return { error: "Structured output capture was not marked as a terminating action." };
	}
	return {
		metadata: {
			toolName,
			toolCallId,
			success: true,
			terminate: true,
			...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
		},
	};
}

function verifyStructuredOutputFinality(
	messages: readonly StructuredOutputTranscriptMessage[],
	metadata: StructuredOutputCaptureMetadata,
	expectedToolName: string,
): { status: "valid" } | { status: "invalid"; message: string } {
	if (metadata.toolName !== expectedToolName) {
		return finalityInvalid(
			`Captured structured output tool name ${JSON.stringify(metadata.toolName)} did not match expected ${JSON.stringify(expectedToolName)}.`,
		);
	}
	if (messages.length === 0) {
		return finalityInvalid("Structured output finality could not be verified because the child transcript is empty.");
	}

	let structuredOutputCallCount = 0;
	let assistantIndex = -1;
	let matchingAssistantToolCalls: ToolCallBlock[] = [];
	for (let index = 0; index < messages.length; index++) {
		const calls = toolCallBlocks(messages[index]);
		if (calls.length === 0) continue;
		for (const call of calls) {
			if (call.name === metadata.toolName) {
				structuredOutputCallCount += 1;
			}
		}
		const idMatch = calls.find((call) => call.id === metadata.toolCallId);
		if (!idMatch) continue;
		if (idMatch.name !== metadata.toolName) {
			return finalityInvalid(
				`Captured structured output tool call ${JSON.stringify(metadata.toolCallId)} used tool name ${JSON.stringify(idMatch.name)} instead of ${JSON.stringify(metadata.toolName)}.`,
			);
		}
		assistantIndex = index;
		matchingAssistantToolCalls = calls;
	}

	if (structuredOutputCallCount > 1) {
		return finalityInvalid(
			`Captured structured output call ${JSON.stringify(metadata.toolCallId)} was not exactly once; another ${metadata.toolName} tool call appeared in the child transcript.`,
		);
	}
	if (assistantIndex === -1) {
		return finalityInvalid(
			`No assistant tool call matched captured structured output toolCallId ${JSON.stringify(metadata.toolCallId)}.`,
		);
	}
	if (matchingAssistantToolCalls.length !== 1) {
		return finalityInvalid(
			`Captured structured output call ${JSON.stringify(metadata.toolCallId)} was accompanied by sibling tool calls in the same assistant message.`,
		);
	}

	let resultIndex = -1;
	let resultMessage: StructuredOutputTranscriptMessage | undefined;
	for (let index = assistantIndex + 1; index < messages.length; index++) {
		const message = messages[index];
		if (roleOf(message) !== "toolResult") continue;
		if (message.toolCallId !== metadata.toolCallId) continue;
		resultIndex = index;
		resultMessage = message;
		break;
	}

	if (!resultMessage) {
		return finalityInvalid(
			`No tool result matched captured structured output toolCallId ${JSON.stringify(metadata.toolCallId)}.`,
		);
	}
	if (resultMessage.toolName !== metadata.toolName) {
		return finalityInvalid(
			`Structured output tool result for ${JSON.stringify(metadata.toolCallId)} used tool name ${JSON.stringify(resultMessage.toolName)} instead of ${JSON.stringify(metadata.toolName)}.`,
		);
	}
	if (resultMessage.isError !== false) {
		return finalityInvalid(
			`Structured output tool result for ${JSON.stringify(metadata.toolCallId)} was an error or did not prove success.`,
		);
	}

	for (let index = assistantIndex + 1; index < resultIndex; index++) {
		const message = messages[index];
		if (isFinalityRelevantMessage(message)) {
			return finalityInvalid(
				`Structured output call ${JSON.stringify(metadata.toolCallId)} was not final; another ${roleOf(message)} message appeared before its matching tool result.`,
			);
		}
	}
	for (let index = resultIndex + 1; index < messages.length; index++) {
		const message = messages[index];
		if (isFinalityRelevantMessage(message)) {
			return finalityInvalid(
				`Structured output call ${JSON.stringify(metadata.toolCallId)} was not final; a later ${roleOf(message)} message followed the successful tool result.`,
			);
		}
	}

	return { status: "valid" };
}

export function assertJsonSchemaDescriptor(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`${label} must be a JSON Schema object descriptor.`);
	}
}

export function assertStructuredOutputParameterSchema(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	assertJsonSchemaDescriptor(schema, label);
	if (!isTopLevelObjectOutputSchema(schema)) {
		throw new Error(
			`${label} must be a top-level object tool-argument schema. `
			+ "Wrap array or primitive outputs in an object field, for example `{ items: [...] }` or `{ value: ... }`.",
		);
	}
}

export function createStructuredOutputRuntime(schema: JsonSchemaObject, baseDir?: string): StructuredOutputRuntime {
	assertStructuredOutputParameterSchema(schema);
	const rootDir = baseDir ?? os.tmpdir();
	fs.mkdirSync(rootDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-structured-"));
	const schemaPath = path.join(dir, "schema.json");
	const outputPath = path.join(dir, "output.json");
	const metadataPath = path.join(dir, "output.meta.json");
	fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
	return { schema, schemaPath, outputPath, metadataPath };
}

export function validateStructuredOutputValue(schema: JsonSchemaObject, value: unknown): { status: "valid" } | { status: "invalid"; message: string } {
	let validator: CompiledJsonSchema;
	try {
		validator = (Compile as (schema: unknown) => CompiledJsonSchema)(schema);
	} catch (error) {
		return { status: "invalid", message: `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (validator.Check(value)) return { status: "valid" };
	const errors = [...validator.Errors(value)]
		.slice(0, 8)
		.map((error) => {
			const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
			return `${pathText}: ${error.message}`;
		});
	return { status: "invalid", message: errors.join("; ") || "schema validation failed" };
}

export function readStructuredOutput(
	runtime: StructuredOutputRuntime,
	options: ReadStructuredOutputOptions = {},
): { value?: unknown; error?: string } {
	if (!fs.existsSync(runtime.outputPath)) {
		return { error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output." };
	}
	const metadataPath = runtime.metadataPath ?? getStructuredOutputMetadataPath(runtime.outputPath);
	if (!fs.existsSync(metadataPath)) {
		return { error: "Missing structured_output metadata sidecar; this step must finish with a verified structured_output call." };
	}
	let payload: JsonValue;
	try {
		payload = JSON.parse(fs.readFileSync(runtime.outputPath, "utf-8")) as JsonValue;
	} catch (error) {
		return { error: `Failed to read structured output: ${error instanceof Error ? error.message : String(error)}` };
	}
	let rawMetadata: JsonValue;
	try {
		rawMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as JsonValue;
	} catch (error) {
		return { error: `Failed to read structured output metadata: ${error instanceof Error ? error.message : String(error)}` };
	}
	const parsed = parseCaptureMetadata(rawMetadata);
	if (parsed.error || !parsed.metadata) {
		return { error: parsed.error ?? "Structured output metadata sidecar is invalid." };
	}
	const validation = validateStructuredOutputValue(runtime.schema, payload);
	if (validation.status === "invalid") return { error: `Structured output validation failed: ${validation.message}` };
	const expectedToolName = options.toolName ?? STRUCTURED_OUTPUT_TOOL_NAME;
	if (options.messages) {
		const finality = verifyStructuredOutputFinality(options.messages, parsed.metadata, expectedToolName);
		if (finality.status === "invalid") return { error: finality.message };
	} else if (parsed.metadata.toolName !== expectedToolName) {
		return {
			error: `Captured structured output tool name ${JSON.stringify(parsed.metadata.toolName)} did not match expected ${JSON.stringify(expectedToolName)}.`,
		};
	}
	return { value: payload };
}

export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void {
	if (!runtime) return;
	try {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup.
	}
}
