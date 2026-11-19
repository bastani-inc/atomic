import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	getCurrentSubagentDepth,
	isSubagentChildSession,
	SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE,
} from "../../packages/subagents/src/shared/types.js";

const childPolicy = {
	managementActions: "full" as const,
	fanoutAuthorized: true,
	inheritProjectContext: false,
	inheritSkills: false,
};

function contextAtDepth(depth: number) {
	return { subagentPolicy: { ...childPolicy, depth } };
}

describe("subagent delegation boundary", () => {
	test("a top-level session is not a subagent child", () => {
		assert.equal(getCurrentSubagentDepth({}), 0);
		assert.equal(isSubagentChildSession({}), false);
		assert.equal(isSubagentChildSession(contextAtDepth(0)), false);
	});

	test("an admitted child is a subagent child at every depth it can hold", () => {
		assert.equal(isSubagentChildSession(contextAtDepth(1)), true);
		assert.equal(isSubagentChildSession(contextAtDepth(2)), true);
		assert.equal(isSubagentChildSession(contextAtDepth(3)), true);
	});

	test("a fanout-authorized child is still a subagent child", () => {
		const fanoutChild = {
			subagentPolicy: { ...childPolicy, fanoutAuthorized: true, depth: 1 },
		};
		assert.equal(isSubagentChildSession(fanoutChild), true);
	});

	test("a malformed depth is treated as top level rather than silently blocking", () => {
		const negative = { subagentPolicy: { ...childPolicy, depth: -1 } };
		const fractional = { subagentPolicy: { ...childPolicy, depth: 1.5 } };
		assert.equal(getCurrentSubagentDepth(negative), 0);
		assert.equal(getCurrentSubagentDepth(fractional), 0);
		assert.equal(isSubagentChildSession(negative), false);
		assert.equal(isSubagentChildSession(fractional), false);
	});

	test("the refusal message names no configurable ceiling", () => {
		assert.match(SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE, /not available inside a subagent/);
		assert.doesNotMatch(SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE, /max|depth=|\bdepth\b/i);
	});
});
