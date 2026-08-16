import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { createAskUserQuestionToolDefinition } from "../src/core/tools/ask-user-question/index.ts";
import { QuestionParamsSchema } from "../src/core/tools/ask-user-question/tool/types.ts";
import { allToolNames, createToolDefinition, type ToolDef } from "../src/core/tools/index.ts";
import { createStructuredOutputTool } from "../src/core/tools/structured-output.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

function createBuiltInToolDefinitions(): ToolDef[] {
	return [...allToolNames].map((name) => createToolDefinition(name, process.cwd()));
}

/**
 * A questionnaire shaped exactly like a model-authored call: three questions,
 * each with a valid 2-4 option array, one single-select with previews, one
 * multiSelect. `ask_user_question`'s option arrays are the arrays strict-mode
 * sampling has to reproduce, so this is the payload that must keep validating.
 */
const VALID_QUESTIONNAIRE = {
	questions: [
		{
			question: "Which library should we use for date formatting?",
			header: "Library",
			options: [
				{ label: "date-fns", description: "Functional, tree-shakeable." },
				{ label: "Day.js", description: "Small and immutable." },
			],
		},
		{
			question: "Which features do you want to enable?",
			header: "Features",
			multiSelect: true,
			options: [
				{ label: "Search", description: "Transcript search." },
				{ label: "Clipboard", description: "Selection copy." },
				{ label: "Exit output", description: "Configurable exit print." },
				{ label: "Tool status", description: "Managed-tool warnings." },
			],
		},
		{
			question: "Which layout should the selector use?",
			header: "Layout",
			options: [
				{ label: "Vertical list", description: "One option per row.", preview: "one\ntwo" },
				{ label: "Side by side", description: "Options left, preview right.", preview: "left | right" },
			],
		},
	],
};

describe("experimental strict built-in tools", () => {
	const originalAtomicExperimental = process.env.ATOMIC_EXPERIMENTAL;
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;

	afterEach(() => {
		if (originalAtomicExperimental === undefined) delete process.env.ATOMIC_EXPERIMENTAL;
		else process.env.ATOMIC_EXPERIMENTAL = originalAtomicExperimental;
		if (originalPiExperimental === undefined) delete process.env.PI_EXPERIMENTAL;
		else process.env.PI_EXPERIMENTAL = originalPiExperimental;
	});

	it("only enables strict-prefer sampling in experimental mode", () => {
		delete process.env.ATOMIC_EXPERIMENTAL;
		delete process.env.PI_EXPERIMENTAL;
		const normalTools = createBuiltInToolDefinitions();

		process.env.PI_EXPERIMENTAL = "1";
		const experimentalTools = createBuiltInToolDefinitions();

		expect(experimentalTools.map((tool) => tool.name)).toEqual(normalTools.map((tool) => tool.name));
		for (const [index, tool] of experimentalTools.entries()) {
			expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
			// Strict mode is a sampling hint, never a schema rewrite: parameters
			// stay identical to the unconstrained definitions, and the key stays
			// absent rather than owned-with-undefined when the gate is off.
			expect(tool.parameters).toEqual(normalTools[index]?.parameters);
			expect(normalTools[index]?.constrainedSampling).toBeUndefined();
			expect(Object.hasOwn(normalTools[index]!, "constrainedSampling")).toBe(false);
			expect(Object.hasOwn(tool, "constrainedSampling")).toBe(true);
		}
	});

	it("honors ATOMIC_EXPERIMENTAL as well as the legacy PI_EXPERIMENTAL", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ATOMIC_EXPERIMENTAL = "1";
		for (const tool of createBuiltInToolDefinitions()) {
			expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		}
	});

	it("covers every built-in tool name", () => {
		process.env.ATOMIC_EXPERIMENTAL = "1";
		const names = createBuiltInToolDefinitions()
			.map((tool) => tool.name)
			.sort();
		expect(names).toEqual([...allToolNames].sort());
	});

	it("ask_user_question option arrays still validate under strict mode", () => {
		process.env.PI_EXPERIMENTAL = "1";
		const tool = createAskUserQuestionToolDefinition();

		expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		// The schema itself is unchanged, so valid option arrays (2-4 options,
		// previews, multiSelect) keep passing validation with strict mode on.
		expect(tool.parameters).toBe(QuestionParamsSchema);
		expect(Value.Check(QuestionParamsSchema, VALID_QUESTIONNAIRE)).toBe(true);
		expect(Value.Check(QuestionParamsSchema, { questions: [] })).toBe(false);
		expect(
			Value.Check(QuestionParamsSchema, {
				questions: [
					{
						question: "Too few options?",
						header: "Options",
						options: [{ label: "Only", description: "A single option." }],
					},
				],
			}),
		).toBe(false);
	});

	it("composes structured-output's own schema constraint with strict mode rather than double-wrapping", () => {
		delete process.env.ATOMIC_EXPERIMENTAL;
		const schema = Type.Object({ verdict: Type.String() });
		const normalTool = createStructuredOutputTool({ schema });

		process.env.PI_EXPERIMENTAL = "1";
		const experimentalTool = createStructuredOutputTool({ schema });

		// Layer 1 — structured-output constrains its output with the caller's
		// schema itself. That constraint is shared, never re-wrapped: the same
		// schema object, with strict mode on or off.
		expect(experimentalTool.parameters).toBe(schema);
		expect(normalTool.parameters).toBe(schema);

		// Layer 2 — experimental strict sampling applies to the built-in tools
		// only; it does not bolt a second constraint onto a tool whose
		// constraint already lives in its parameters.
		expect(experimentalTool.constrainedSampling).toBeUndefined();
		expect(normalTool.constrainedSampling).toBeUndefined();

		// Crossing into the agent runtime preserves both facts: one schema,
		// zero added wrappers, even with the experimental flag set.
		const wrapped = wrapToolDefinition(experimentalTool);
		expect(wrapped.parameters).toBe(schema);
		expect(wrapped.constrainedSampling).toBeUndefined();
		expect(Object.hasOwn(wrapped, "constrainedSampling")).toBe(false);
	});
});
