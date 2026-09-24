import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
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
	schema: TSchemaDef;
	capture?: StructuredOutputCapture<Static<TSchemaDef>>;
	output?: StructuredOutputFileCapture;
	name?: string;
}

export const StructuredOutputParameters = Type.Object(
	{
		instructions: Type.String({ minLength: 1, description: "Complete judgment instructions for the result." }),
		state: Type.Object(
			{},
			{
				additionalProperties: true,
				minProperties: 1,
				description:
					"Named finite JSON values holding the task, relevant context, constraints and reference text. Never include secrets.",
			},
		),
		model: Type.Optional(
			Type.String({
				description:
					"Exact provider/model ID of a chat or classifier model, such as typesafe/jev-latest. Omit to use the current chat model.",
			}),
		),
		fallbackModels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Ordered exact fallback model IDs. The current chat model is always tried last.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type StructuredOutputParams = Static<typeof StructuredOutputParameters>;

function stringifyParams<TSchemaDef extends TSchema>(params: Static<TSchemaDef>): string {
	try {
		return JSON.stringify(params, null, 2);
	} catch (error) {
		throw new Error(
			`Structured output must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
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
		throw new Error(
			`Failed to write structured output capture: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function createStructuredOutputCapture<TValue = unknown>(): StructuredOutputCapture<TValue> {
	return { value: undefined, called: false };
}

export function createStructuredOutputTool<TSchemaDef extends TSchema>(
	options: StructuredOutputToolOptions<TSchemaDef>,
): ToolDefinition<typeof StructuredOutputParameters, Static<TSchemaDef>> {
	const name = options.name ?? STRUCTURED_OUTPUT_TOOL_NAME;

	return defineTool({
		name,
		label: "Structured Output",
		description:
			"Infer the final machine-readable result from instructions and named state using the selected model, then any fallbacks, then the current chat model.",
		promptSnippet: "Return final machine-readable output",
		promptGuidelines: [
			`${name} is the final machine-readable result channel; call ${name} exactly once when done.`,
			"Pass complete instructions and named state; omit model to use the current chat model.",
			`Do not write a prose final answer after calling ${name}.`,
		],
		parameters: StructuredOutputParameters,
		maxResultSizeChars: Infinity,
		structuredOutput: true,
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<Static<TSchemaDef>>> {
			const { inferStructuredOutput } = await import("../structured-output/index.js");
			const result = await inferStructuredOutput({
				schema: options.schema,
				instructions: params.instructions,
				state: params.state as JsonObject,
				...(params.model !== undefined ? { model: params.model } : {}),
				...(params.fallbackModels !== undefined ? { fallbackModels: params.fallbackModels } : {}),
				currentModel: ctx.model,
				modelRegistry: ctx.modelRegistry,
				...(signal ? { signal } : {}),
			});
			const value = result.value;
			const serializedValue = stringifyParams(value);
			if (options.output) {
				await writeCapturedOutput(options.output, serializedValue);
			}
			if (options.capture) {
				options.capture.value = value;
				options.capture.called = true;
			}

			return {
				content: [{ type: "text", text: serializedValue }],
				details: value,
				terminate: true,
			};
		},
	});
}
