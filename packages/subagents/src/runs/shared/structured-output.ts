import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME } from "@bastani/atomic";
import { Compile } from "typebox/compile";
import type { Message } from "@earendil-works/pi-ai/compat";
import type { JsonSchemaObject } from "../../shared/types.ts";

const ENV_PREFIX = APP_NAME.toUpperCase();
export const STRUCTURED_OUTPUT_SCHEMA_ENV = `${ENV_PREFIX}_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA`;
export const STRUCTURED_OUTPUT_CAPTURE_ENV = `${ENV_PREFIX}_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE`;
export const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";
export const STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS = 3;
export const STRUCTURED_OUTPUT_MISSING_ERROR = "Missing structured_output call; this step has outputSchema and must finish by calling structured_output.";

export interface StructuredOutputRuntime {
	schema: JsonSchemaObject;
	schemaPath: string;
	outputPath: string;
}

export function assertJsonSchemaDescriptor(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`${label} must be a JSON Schema object descriptor.`);
	}
}

export function createStructuredOutputRuntime(schema: JsonSchemaObject, baseDir?: string): StructuredOutputRuntime {
	const rootDir = baseDir ?? os.tmpdir();
	fs.mkdirSync(rootDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-structured-"));
	const schemaPath = path.join(dir, "schema.json");
	const outputPath = path.join(dir, "output.json");
	fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
	return { schema, schemaPath, outputPath };
}

export function validateStructuredOutputValue(schema: JsonSchemaObject, value: unknown): { status: "valid" } | { status: "invalid"; message: string } {
	try {
		const validator = (Compile as (schema: unknown) => {
			Check(value: unknown): boolean;
			Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }>;
		})(schema);
		if (validator.Check(value)) return { status: "valid" };
		const errors = [...validator.Errors(value)]
			.slice(0, 8)
			.map((error) => {
				const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
				return `${pathText}: ${error.message}`;
			});
		return { status: "invalid", message: errors.join("; ") || "schema validation failed" };
	} catch (error) {
		return { status: "invalid", message: `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function textFromContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const record = block as { readonly type?: unknown; readonly text?: unknown };
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

export function latestStructuredOutputToolErrorFromMessages(messages: readonly Message[] | undefined): string | undefined {
	if (!messages) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;
		if (message.toolName !== STRUCTURED_OUTPUT_TOOL_NAME) continue;
		if (message.isError !== true) continue;
		return textFromContent(message.content) ?? "structured_output tool call failed schema validation.";
	}
	return undefined;
}

export function isStructuredOutputContractError(error: string | undefined): boolean {
	if (error === undefined) return false;
	return error === STRUCTURED_OUTPUT_MISSING_ERROR
		|| error.startsWith("Structured output validation failed:")
		|| error.startsWith("Failed to read structured output:");
}

export function formatStructuredOutputCorrectionPrompt(args: {
	readonly originalTask: string;
	readonly error: string;
	readonly attempt: number;
	readonly maxAttempts?: number;
}): string {
	const maxAttempts = args.maxAttempts ?? STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS;
	return [
		"The previous response failed this subagent's structured-output contract.",
		"",
		`Corrective attempt ${args.attempt}/${maxAttempts}.`,
		"",
		"Error:",
		args.error,
		"",
		"You must finish by calling the `structured_output` tool exactly once with arguments matching the registered schema.",
		"Do not answer with plain JSON text, Markdown, or prose. If you attempted `structured_output` and validation failed, correct the tool arguments and call `structured_output` again.",
		"If the requested work is already complete, do not redo side effects unnecessarily; just report the completed result through `structured_output`.",
		"",
		"Original task:",
		args.originalTask,
	].join("\n");
}

export function readStructuredOutput(runtime: StructuredOutputRuntime): { value?: unknown; error?: string } {
	if (!fs.existsSync(runtime.outputPath)) {
		return { error: STRUCTURED_OUTPUT_MISSING_ERROR };
	}
	try {
		const value = JSON.parse(fs.readFileSync(runtime.outputPath, "utf-8")) as unknown;
		const validation = validateStructuredOutputValue(runtime.schema, value);
		if (validation.status === "invalid") {
			return { error: `Structured output validation failed: ${validation.message}` };
		}
		return { value };
	} catch (error) {
		return { error: `Failed to read structured output: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void {
	if (!runtime) return;
	try {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup.
	}
}
