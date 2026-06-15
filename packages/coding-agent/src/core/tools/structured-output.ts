import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";

export const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface StructuredOutputCapture<TValue = unknown> {
	value: TValue | undefined;
	called: boolean;
}

export interface StructuredOutputFileCapture {
	outputPath: string;
}

export interface StructuredOutputToolOptions<TSchemaDef extends TSchema> {
	/** Tool parameter schema. */
	schema: TSchemaDef;
	/** In-process result sink for SDK and workflow callers. */
	capture?: StructuredOutputCapture<Static<TSchemaDef>>;
	/** Cross-process result sink for subagent child runtimes. */
	output?: StructuredOutputFileCapture;
	/** Tool name. Defaults to `structured_output`. */
	name?: string;
}

function stringifyParams<TSchemaDef extends TSchema>(params: Static<TSchemaDef>): string {
	try {
		return JSON.stringify(params, null, 2);
	} catch (error) {
		throw new Error(`Structured output must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function writePrivateJsonFile(filePath: string, serializedJson: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, serializedJson, { mode: 0o600 });
	// Re-apply the private mode after writing so pre-existing looser files are tightened too.
	await fs.chmod(filePath, 0o600);
}

async function writeCapturedOutput(output: StructuredOutputFileCapture, serializedParams: string): Promise<void> {
	try {
		await writePrivateJsonFile(output.outputPath, serializedParams);
	} catch (error) {
		throw new Error(`Failed to write structured output capture: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function createStructuredOutputCapture<TValue = unknown>(): StructuredOutputCapture<TValue> {
	return { value: undefined, called: false };
}

export function createStructuredOutputTool<TSchemaDef extends TSchema>(
	options: StructuredOutputToolOptions<TSchemaDef>,
): ToolDefinition<TSchemaDef, Static<TSchemaDef>> {
	const name = options.name ?? STRUCTURED_OUTPUT_TOOL_NAME;

	return defineTool({
		name,
		label: "Structured Output",
		description: "Return the final machine-readable result for this subagent task.",
		promptSnippet: "Return final machine-readable output",
		promptGuidelines: [
			`${name} is the final answer channel for this task; call ${name} exactly once when done.`,
			`Do not write a prose final answer after calling ${name}.`,
		],
		parameters: options.schema,
		maxResultSizeChars: Infinity,
		structuredOutput: true,
		async execute(_toolCallId, params): Promise<AgentToolResult<Static<TSchemaDef>>> {
			const serializedParams = stringifyParams(params);
			if (options.output) {
				await writeCapturedOutput(options.output, serializedParams);
			}
			if (options.capture) {
				options.capture.value = params;
				options.capture.called = true;
			}

			return {
				content: [{ type: "text", text: serializedParams }],
				details: params,
				terminate: true,
			};
		},
	});
}
