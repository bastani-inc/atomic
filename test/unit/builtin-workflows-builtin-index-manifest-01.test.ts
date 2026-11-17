import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { isBrandedWorkflowDefinition } from "../../packages/workflows/src/authoring/workflow.js";
import {
	deriveInputFields,
	schemaDescription,
	schemaFieldKind,
} from "../../packages/workflows/src/shared/schema-introspection.js";
import { moduleDir } from "../helpers/runtime.js";

const expectedBuiltinNames = [
	"adversarial-verification",
	"classify-and-act",
	"fan-out-and-synthesize",
	"generate-and-filter",
	"goal",
	"loop-until-done",
	"open-claude-design",
	"ralph",
	"tournament",
] as const;

const expectedExports = [
	"adversarialVerification",
	"classifyAndAct",
	"fanOutAndSynthesize",
	"generateAndFilter",
	"goal",
	"loopUntilDone",
	"openClaudeDesign",
	"ralph",
	"tournament",
] as const;

describe("builtin workflow manifest", () => {
	test("exports exactly the supported builtin workflows", async () => {
		const mod = await import("../../packages/workflows/builtin/index.js");
		assert.deepEqual(Object.keys(mod).sort(), [...expectedExports].sort());

		const definitions = expectedExports.map((name) => mod[name]);
		assert.deepEqual(
			definitions.map((definition) => definition.normalizedName).sort(),
			[...expectedBuiltinNames].sort(),
		);
		for (const definition of definitions) {
			assert.equal(isBrandedWorkflowDefinition(definition), true, definition.normalizedName);
		}
	});

	test("contains no files for the retired deep-research-codebase workflow", () => {
		const builtinRoot = join(moduleDir(import.meta.url), "../../packages/workflows/builtin");
		const stem = ["deep", "research", "codebase"].join("-");
		const suffixes = [".ts", ".d.ts", "-runner.ts", "-utils.ts", "-models.ts"];

		for (const suffix of suffixes) {
			assert.equal(existsSync(join(builtinRoot, `${stem}${suffix}`)), false, `${stem}${suffix}`);
		}
	});

	test("input schema introspection mirrors every builtin workflow input contract", async () => {
		const mod = await import("../../packages/workflows/builtin/index.js");
		const definitions = expectedExports.map((name) => mod[name]);

		for (const definition of definitions) {
			const derived = deriveInputFields(definition.inputs);
			const expectedInputs = Object.entries(definition.inputs).map(([name, schema]) => ({
				name,
				type: schemaFieldKind(schema),
				description: schemaDescription(schema),
			}));
			assert.deepEqual(
				derived.map(({ name, type, description }) => ({ name, type, description })),
				expectedInputs,
				definition.normalizedName,
			);
		}
	});
});
