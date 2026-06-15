import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME } from "@bastani/atomic";
import { Compile } from "typebox/compile";
import type { JsonSchemaObject } from "../../shared/types.ts";

const ENV_PREFIX = APP_NAME.toUpperCase();
export const STRUCTURED_OUTPUT_SCHEMA_ENV = `${ENV_PREFIX}_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA`;
export const STRUCTURED_OUTPUT_CAPTURE_ENV = `${ENV_PREFIX}_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE`;

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

export function assertStructuredOutputParameterSchema(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	assertJsonSchemaDescriptor(schema, label);
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

export function readStructuredOutput(runtime: StructuredOutputRuntime): { value?: unknown; error?: string } {
	if (!fs.existsSync(runtime.outputPath)) {
		return { error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output." };
	}
	try {
		return { value: JSON.parse(fs.readFileSync(runtime.outputPath, "utf-8")) as unknown };
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
