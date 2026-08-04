import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { describe, expect, test, vi } from "vitest";
import { createStructuredOutputTool } from "../src/core/tools/structured-output.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { normalizeToolParameterSchema } from "../src/core/tools/tool-parameter-schema.ts";

/**
 * Reproduces how a provider advertises a tool: pi-ai's `convertTools` builds
 * `input_schema` from the root `properties`/`required` keywords and nothing else.
 */
function advertise(schema: unknown): { properties: Record<string, unknown>; required: readonly string[] } {
	// Unchecked by design: this mirrors the provider, which reads these two keywords off any schema.
	const root = schema as { properties?: Record<string, unknown>; required?: readonly string[] };
	return { properties: root.properties ?? {}, required: root.required ?? [] };
}

const QuestionBranch = Type.Object(
	{
		kind: Type.Literal("question"),
		decisionOwnership: Type.Union([Type.Literal("researcher-intent"), Type.Literal("agent-operational")]),
		discussion: Type.String({ minLength: 1 }),
		options: Type.Array(Type.Object({ label: Type.String({ minLength: 1 }) }, { additionalProperties: false }), {
			minItems: 2,
			maxItems: 3,
		}),
	},
	{ additionalProperties: false },
);

const TerminalBranch = Type.Object(
	{
		kind: Type.Literal("ready_for_review"),
		venue: Type.Object({ venueId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);

const UnionRoot = Type.Union([QuestionBranch, TerminalBranch]);

const VALID_QUESTION = {
	kind: "question",
	decisionOwnership: "researcher-intent",
	discussion: "Which population should the study prioritize?",
	options: [{ label: "Novices" }, { label: "Experts" }],
};
const VALID_TERMINAL = { kind: "ready_for_review", venue: { venueId: "sigplan" } };

describe("normalizeToolParameterSchema", () => {
	test("advertises real properties for a union-rooted schema", () => {
		// The defect: a union root serializes to {anyOf} alone, so the tool ships with no
		// parameters and clients send every argument as a string.
		expect(advertise(UnionRoot).properties).toEqual({});

		const advertised = advertise(normalizeToolParameterSchema(UnionRoot, "structured_output"));
		expect(Object.keys(advertised.properties)).toEqual([
			"kind",
			"decisionOwnership",
			"discussion",
			"options",
			"venue",
		]);
		// Only the property every branch requires may be required on the merged root.
		expect(advertised.required).toEqual(["kind"]);
		expect(advertised.properties.options).toMatchObject({ type: "array" });
	});

	test("accepts exactly the values the union root accepted", () => {
		const normalized = Compile(normalizeToolParameterSchema(UnionRoot, "structured_output"));
		const union = Compile(UnionRoot);
		const cases: ReadonlyArray<readonly [string, unknown]> = [
			["valid question", VALID_QUESTION],
			["valid terminal", VALID_TERMINAL],
			["three options", { ...VALID_QUESTION, options: [...VALID_QUESTION.options, { label: "Mixed" }] }],
			["one option", { ...VALID_QUESTION, options: [VALID_QUESTION.options[0]] }],
			["four options", { ...VALID_QUESTION, options: [...VALID_QUESTION.options, { label: "c" }, { label: "d" }] }],
			["missing discriminator", { discussion: "d" }],
			["unknown discriminator", { ...VALID_TERMINAL, kind: "other" }],
			["undeclared root property", { ...VALID_TERMINAL, privateReasoning: "hidden" }],
			["undeclared option property", { ...VALID_QUESTION, options: [{ label: "a", rank: 1 }, { label: "b" }] }],
			["fields borrowed from another branch", { ...VALID_TERMINAL, discussion: "leaked" }],
			["branch stripped to its discriminator", { kind: "question" }],
			["container sent as a string", { ...VALID_QUESTION, options: JSON.stringify(VALID_QUESTION.options) }],
			["wrong scalar type", { ...VALID_QUESTION, discussion: 7 }],
			["null field", { ...VALID_TERMINAL, venue: null }],
		];

		for (const [name, value] of cases) {
			expect([name, normalized.Check(value)]).toEqual([name, union.Check(value)]);
		}
	});

	test("unions a discriminator that differs across branches", () => {
		// First-wins merging would pin `kind` to one branch's literal and silently reject
		// every other branch.
		const normalized = Compile(normalizeToolParameterSchema(UnionRoot, "structured_output"));
		expect(normalized.Check(VALID_QUESTION)).toBe(true);
		expect(normalized.Check(VALID_TERMINAL)).toBe(true);
	});

	test("coerces arguments in place, which a union root cannot", () => {
		// pi-ai calls Value.Convert(tool.parameters, args) for its effect and discards the
		// return value. That only mutates `args` when the root is an object.
		const stringified = { ...VALID_TERMINAL, venue: { venueId: 42 } };

		const viaUnion = structuredClone(stringified);
		Value.Convert(UnionRoot, viaUnion);
		expect(viaUnion.venue.venueId).toBe(42);

		const viaNormalized = structuredClone(stringified);
		Value.Convert(normalizeToolParameterSchema(UnionRoot, "structured_output"), viaNormalized);
		expect(viaNormalized.venue.venueId).toBe("42");
	});

	test("returns an object-rooted schema unchanged", () => {
		const objectRoot = Type.Object({ path: Type.String() }, { additionalProperties: false });
		expect(normalizeToolParameterSchema(objectRoot, "read")).toBe(objectRoot);
	});

	test("reuses one rewritten schema per authored schema", () => {
		// Identity matters: the provider caches compiled validators by schema identity, so a
		// fresh rewrite on every registry refresh would recompile the validator each time.
		const first = normalizeToolParameterSchema(UnionRoot, "structured_output");
		expect(normalizeToolParameterSchema(UnionRoot, "structured_output")).toBe(first);
	});

	test("warns once and passes through a schema that cannot be object-rooted", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const arrayRoot = Type.Array(Type.String());
			expect(normalizeToolParameterSchema(arrayRoot, "list_files")).toBe(arrayRoot);
			normalizeToolParameterSchema(arrayRoot, "list_files");
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain('tool "list_files"');

			// A union is only mergeable when every branch is itself object-rooted.
			const mixedUnion = Type.Union([QuestionBranch, Type.String()]);
			expect(normalizeToolParameterSchema(mixedUnion, "mixed")).toBe(mixedUnion);
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("wrapToolDefinition", () => {
	test("advertises parameters for a union-rooted structured output tool", () => {
		const wrapped = wrapToolDefinition(createStructuredOutputTool({ schema: UnionRoot }));

		expect(Object.keys(advertise(wrapped.parameters).properties)).toContain("options");
		// The advertised schema and the validated schema must be the same object.
		expect(Compile(wrapped.parameters).Check(VALID_TERMINAL)).toBe(true);
		expect(Compile(wrapped.parameters).Check({ ...VALID_TERMINAL, discussion: "leaked" })).toBe(false);
	});
});
