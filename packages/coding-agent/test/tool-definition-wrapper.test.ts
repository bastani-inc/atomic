import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const parameters = Type.Object({ value: Type.Number() });
const result = (value: number) => ({ content: [{ type: "text" as const, text: String(value) }], details: { value } });

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
		const output = await tool.execute("call-1", { value: 4 }, undefined, (update) => updates.push(update.details.value));
		expect(output.details.value).toBe(8);
		expect(updates).toEqual([4]);
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
