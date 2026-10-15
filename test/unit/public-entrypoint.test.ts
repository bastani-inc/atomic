import assert from "node:assert/strict";
import type { Static, TSchema } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { describe, test } from "vitest";
import * as workflows from "../../packages/workflows/src/index.js";
import {
	createRegistry,
	GraphFrontierTracker,
	normalizeWorkflowName,
	resolveInputs,
	workflow,
	workflowNamesEqual,
} from "../../packages/workflows/src/index.js";

describe("public entrypoint", () => {
	test("does not export the removed imperative workflow API", () => {
		assert.equal("runWorkflow" in workflows, false);
		assert.equal("WorkflowOptions" in workflows, false);
		assert.equal("WorkflowRunOptions" in workflows, false);
	});

	test("does not export direct one-off executor helpers", () => {
		assert.equal("runTask" in workflows, false);
		assert.equal("runParallel" in workflows, false);
		assert.equal("runChain" in workflows, false);
	});

	test("exports TypeBox schema types through the source entrypoint", () => {
		const schema = Type.Object({ ok: Type.Boolean() });
		const value: Static<typeof schema> = { ok: true };
		const typedSchema: TSchema = schema;
		assert.equal(value.ok, true);
		assert.equal(typedSchema, schema);
	});

	test("supports authoring and registry lookup through exported APIs", async () => {
		const def = workflow({
			name: "Example Task",
			description: "Exercises the package entrypoint",
			inputs: {
				prompt: Type.String(),
			},
			outputs: {
				echoed: Type.String(),
			},
			run: async (ctx) => ({ echoed: ctx.inputs.prompt }),
		});

		const registry = createRegistry().register(def);

		assert.equal(normalizeWorkflowName(" Example_Task! "), "example-task");
		assert.equal(workflowNamesEqual("Example Task", "example_task"), true);
		assert.equal(registry.has("example task"), true);
		assert.equal(registry.get("example-task"), def);
		assert.deepEqual(await def.run({ inputs: { prompt: "hello" } } as Parameters<typeof def.run>[0]), {
			echoed: "hello",
		});
	});

	test("exposes runtime helpers with observable edge-case behavior", () => {
		assert.throws(() => resolveInputs({ prompt: Type.String() }, {}), {
			message: 'atomic-workflows: required input "prompt" not provided',
		});

		const tracker = new GraphFrontierTracker();
		assert.deepEqual(tracker.onSpawn("stage-1", "first"), []);
		tracker.onSettle("stage-1");
		assert.deepEqual(tracker.onSpawn("stage-2", "second"), ["stage-1"]);
	});
});
