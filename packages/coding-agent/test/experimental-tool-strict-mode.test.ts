import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, it } from "vitest";
import { createAskUserQuestionToolDefinition } from "../src/core/tools/ask-user-question/index.js";
import { QuestionParamsSchema } from "../src/core/tools/ask-user-question/tool/types.js";
import { allToolNames, createToolDefinition, type ToolDef } from "../src/core/tools/index.js";
import { createStructuredOutputTool, StructuredOutputParameters } from "../src/core/tools/structured-output.js";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";

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

		assert.deepEqual(
			experimentalTools.map((tool) => tool.name),
			normalTools.map((tool) => tool.name),
		);
		for (const [index, tool] of experimentalTools.entries()) {
			assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
			// Sampling hints never rewrite the schema.
			assert.deepEqual(tool.parameters, normalTools[index]?.parameters);
			if (["bash", "powershell", "read", "edit", "write"].includes(tool.name)) {
				assert.deepEqual(normalTools[index]?.constrainedSampling, { type: "json_schema", strict: "prefer" });
			} else {
				assert.equal(normalTools[index]?.constrainedSampling, undefined);
				assert.equal(Object.hasOwn(normalTools[index]!, "constrainedSampling"), false);
			}
			assert.equal(Object.hasOwn(tool, "constrainedSampling"), true);
		}
	});

	it("honors ATOMIC_EXPERIMENTAL as well as the legacy PI_EXPERIMENTAL", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ATOMIC_EXPERIMENTAL = "1";
		for (const tool of createBuiltInToolDefinitions()) {
			assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
		}
	});

	it("covers every built-in tool name", () => {
		process.env.ATOMIC_EXPERIMENTAL = "1";
		const names = createBuiltInToolDefinitions()
			.map((tool) => tool.name)
			.sort();
		assert.deepEqual(names, [...allToolNames].sort());
	});

	it("ask_user_question option arrays still validate under strict mode", () => {
		process.env.PI_EXPERIMENTAL = "1";
		const tool = createAskUserQuestionToolDefinition();

		assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
		// The schema itself is unchanged, so valid option arrays (2-4 options,
		// previews, multiSelect) keep passing validation with strict mode on.
		assert.equal(tool.parameters, QuestionParamsSchema);
		assert.equal(Value.Check(QuestionParamsSchema, VALID_QUESTIONNAIRE), true);
		assert.equal(Value.Check(QuestionParamsSchema, { questions: [] }), false);
		assert.equal(
			Value.Check(QuestionParamsSchema, {
				questions: [
					{
						question: "Too few options?",
						header: "Options",
						options: [{ label: "Only", description: "A single option." }],
					},
				],
			}),
			false,
		);
	});

	it("keeps structured-output's inference arguments outside strict sampling rather than double-wrapping", () => {
		delete process.env.ATOMIC_EXPERIMENTAL;
		const schema = Type.Object({ verdict: Type.String() });
		const normalTool = createStructuredOutputTool({ schema });

		process.env.PI_EXPERIMENTAL = "1";
		const experimentalTool = createStructuredOutputTool({ schema });

		// Layer 1 — the model-visible arguments are the shared inference request
		// (instructions, state, optional model and fallbacks), never the caller's
		// result schema, with strict mode on or off. The result schema constrains
		// the inferred value instead.
		assert.equal(experimentalTool.parameters, StructuredOutputParameters);
		assert.equal(normalTool.parameters, StructuredOutputParameters);
		assert.notEqual(experimentalTool.parameters, schema);
		assert.equal(
			Value.Check(StructuredOutputParameters, {
				instructions: "Judge the patch.",
				state: { task: "Review" },
				model: "typesafe/jev-latest",
				fallbackModels: ["openai/gpt-5-mini"],
			}),
			true,
		);
		assert.equal(Value.Check(StructuredOutputParameters, { verdict: "approve" }), false);

		// Layer 2 — experimental strict sampling applies to the built-in tools
		// only; it does not bolt a constraint onto structured_output.
		assert.equal(experimentalTool.constrainedSampling, undefined);
		assert.equal(normalTool.constrainedSampling, undefined);

		// Crossing into the agent runtime preserves both facts, even with the
		// experimental flag set.
		const wrapped = wrapToolDefinition(experimentalTool);
		assert.equal(wrapped.parameters, StructuredOutputParameters);
		assert.equal(wrapped.constrainedSampling, undefined);
		assert.equal(Object.hasOwn(wrapped, "constrainedSampling"), false);
	});
});
