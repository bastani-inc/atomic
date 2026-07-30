import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { getAllTools } from "../src/core/agent-session-state.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import type { ExtensionContext, ToolDefinition } from "../src/index.ts";

const parameters = Type.Object({ value: Type.Number() });
const result = (value: number) => ({ content: [{ type: "text" as const, text: String(value) }], details: { value } });
const grammarSampling = {
	type: "grammar" as const,
	variants: {
		openai_lark: 'start: "α" | "β"\n',
		openai_regex: "^(a|a)$",
	},
};

describe("tool definition wrappers", () => {
	test("preserves schemas and forwards prepared arguments and extension context", async () => {
		const context = {} as ExtensionContext;
		const updates: number[] = [];
		const definition: ToolDefinition<typeof parameters, { value: number }> = {
			name: "double",
			label: "Double",
			description: "Doubles a number",
			parameters,
			prepareArguments: (args) => ({ value: Number((args as { value: string }).value) }),
			execute: async (_id, args, _signal, onUpdate, receivedContext) => {
				expect(receivedContext).toBe(context);
				onUpdate?.(result(args.value));
				return result(args.value * 2);
			},
		};

		const tool = wrapToolDefinition(definition, () => context);
		expect(tool.parameters).toBe(parameters);
		expect(tool.prepareArguments?.({ value: "4" })).toEqual({ value: 4 });
		const output = await tool.execute("call-1", { value: 4 }, undefined, (update) =>
			updates.push(update.details.value),
		);
		expect(output.details.value).toBe(8);
		expect(updates).toEqual([4]);
	});

	test("preserves constrained sampling by identity in both wrapper directions", () => {
		const definition: ToolDefinition<typeof parameters, { value: number }> = {
			name: "grammar",
			label: "Grammar",
			description: "Uses exact caller grammar",
			parameters,
			constrainedSampling: grammarSampling,
			execute: async (_id, args) => result(args.value),
		};

		const wrapped = wrapToolDefinition(definition);
		expect(wrapped.constrainedSampling).toBe(grammarSampling);
		const synthesized = createToolDefinitionFromAgentTool(wrapped);
		expect(synthesized.constrainedSampling).toBe(grammarSampling);
		expect(synthesized.constrainedSampling).toEqual(grammarSampling);
	});

	test("keeps omitted, false, prefer, and require constraints exact", () => {
		const makeTool = (constrainedSampling?: ToolDefinition<typeof parameters>["constrainedSampling"]) =>
			wrapToolDefinition({
				name: "sampling",
				label: "Sampling",
				description: "Sampling",
				parameters,
				...(constrainedSampling === undefined ? {} : { constrainedSampling }),
				execute: async (_id, args) => result(args.value),
			});

		const omitted = makeTool();
		expect(omitted.constrainedSampling).toBeUndefined();
		expect("constrainedSampling" in omitted).toBe(false);
		expect("constrainedSampling" in createToolDefinitionFromAgentTool(omitted)).toBe(false);
		expect(makeTool(false).constrainedSampling).toBe(false);
		for (const strict of ["prefer", "require"] as const) {
			const constraint = { type: "json_schema" as const, strict };
			expect(makeTool(constraint).constrainedSampling).toBe(constraint);
		}
	});

	test("preserves the exact optional-property truth table in both wrapper directions", () => {
		const base: ToolDefinition<typeof parameters, { value: number }> = {
			name: "sampling",
			label: "Sampling",
			description: "Sampling",
			parameters,
			execute: async (_id, args) => result(args.value),
		};
		const definitions = [
			base,
			{ ...base, constrainedSampling: undefined },
			{ ...base, constrainedSampling: false as const },
			{ ...base, constrainedSampling: grammarSampling },
		];
		const expectedOwn = [false, true, true, true];

		for (const [index, definition] of definitions.entries()) {
			const wrapped = wrapToolDefinition(definition);
			const synthesized = createToolDefinitionFromAgentTool(wrapped);
			expect(Object.hasOwn(wrapped, "constrainedSampling")).toBe(expectedOwn[index]);
			expect(Object.hasOwn(synthesized, "constrainedSampling")).toBe(expectedOwn[index]);
			expect(synthesized.constrainedSampling).toBe(definition.constrainedSampling);
		}
		expect(Object.keys(grammarSampling.variants)).toEqual(["openai_lark", "openai_regex"]);
	});

	test("preserves optional-property state through session inspection and a bundled tool", () => {
		const sourceInfo = {
			path: "<test>",
			source: "test",
			scope: "user" as const,
			origin: "top-level" as const,
			configurationOrigin: "atomic" as const,
		};
		const inspect = (definition: ToolDefinition) =>
			getAllTools.call({
				_toolDefinitions: new Map([[definition.name, { definition, sourceInfo }]]),
			} as never)[0]!;
		const base: ToolDefinition = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect",
			parameters,
			execute: async () => result(1),
		};
		const definitions = [
			base,
			{ ...base, constrainedSampling: undefined },
			{ ...base, constrainedSampling: false as const },
			{ ...base, constrainedSampling: grammarSampling },
		];
		for (const [index, definition] of definitions.entries()) {
			const inspected = inspect(definition);
			expect(Object.hasOwn(inspected, "constrainedSampling")).toBe(index !== 0);
			expect(inspected.constrainedSampling).toBe(definition.constrainedSampling);
		}

		const bundledRead = inspect(createReadToolDefinition(process.cwd()));
		expect(Object.hasOwn(bundledRead, "constrainedSampling")).toBe(false);
	});

	test("converts Pi tools back without inventing an argument preparer", async () => {
		const tool: AgentTool<typeof parameters, { value: number }> = {
			name: "identity",
			label: "Identity",
			description: "Returns a number",
			parameters,
			execute: async (_id, args) => result(args.value),
		};

		const definition = createToolDefinitionFromAgentTool(tool);
		expect(definition.parameters).toBe(parameters);
		expect(definition.prepareArguments).toBeUndefined();
		const output = await definition.execute("call-2", { value: 7 }, undefined, undefined, {} as ExtensionContext);
		expect(output.details.value).toBe(7);
	});

	test("forwards Pi argument preparation through a synthesized definition", () => {
		const tool: AgentTool<typeof parameters, { value: number }> = {
			name: "prepared",
			label: "Prepared",
			description: "Prepares a number",
			parameters,
			prepareArguments: (args) => ({ value: Number((args as { value: string }).value) }),
			execute: async (_id, args) => result(args.value),
		};

		const definition = createToolDefinitionFromAgentTool(tool);
		expect(definition.prepareArguments?.({ value: "9" })).toEqual({ value: 9 });
	});
});
