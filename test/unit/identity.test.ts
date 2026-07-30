import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { normalizeWorkflowName, workflowNamesEqual } from "../../packages/workflows/src/workflows/identity.js";

describe("normalizeWorkflowName", () => {
	test("lowercases", () => {
		assert.equal(normalizeWorkflowName("MyWorkflow"), "myworkflow");
	});

	test("trims surrounding whitespace", () => {
		assert.equal(normalizeWorkflowName("  hello  "), "hello");
	});

	test("replaces spaces with hyphens", () => {
		assert.equal(normalizeWorkflowName("fan out and synthesize"), "fan-out-and-synthesize");
	});

	test("replaces underscores with hyphens", () => {
		assert.equal(normalizeWorkflowName("my_workflow"), "my-workflow");
	});

	test("collapses multiple separators", () => {
		assert.equal(normalizeWorkflowName("a   b__c"), "a-b-c");
	});

	test("strips non-alphanumeric non-hyphen characters", () => {
		assert.equal(normalizeWorkflowName("hello!@#world"), "helloworld");
	});

	test("strips leading and trailing hyphens", () => {
		assert.equal(normalizeWorkflowName("-hello-"), "hello");
	});

	test("full example from spec", () => {
		assert.equal(normalizeWorkflowName("Fan Out And Synthesize"), "fan-out-and-synthesize");
	});

	test("throws on empty string", () => {
		assert.throws(() => normalizeWorkflowName(""), { message: /non-empty string/ });
	});

	test("throws on non-string", () => {
		// @ts-expect-error intentional wrong type
		assert.throws(() => normalizeWorkflowName(null), { message: /non-empty string/ });
	});
});

describe("workflowNamesEqual", () => {
	test("equal for same string", () => {
		assert.equal(workflowNamesEqual("my-workflow", "my-workflow"), true);
	});

	test("equal across casing and separators", () => {
		assert.equal(workflowNamesEqual("My Workflow", "my-workflow"), true);
		assert.equal(workflowNamesEqual("my_workflow", "my-workflow"), true);
	});

	test("not equal for different names", () => {
		assert.equal(workflowNamesEqual("foo", "bar"), false);
	});
});
