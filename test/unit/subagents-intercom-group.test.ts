import assert from "node:assert/strict";
import { runtimeIntercomGroupEnvKey } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { resolveHomeGroup } from "../../packages/intercom/group.js";
import { inheritedIntercomGroup } from "../../packages/subagents/src/runs/shared/intercom-group.js";

const sessionId = "workflow stage/session";
const runtimeKey = runtimeIntercomGroupEnvKey(sessionId);
const previousRuntimeGroup = process.env[runtimeKey];

afterEach(() => {
	if (previousRuntimeGroup === undefined) delete process.env[runtimeKey];
	else process.env[runtimeKey] = previousRuntimeGroup;
});

test("runtime group inheritance uses the shared key and outranks static policy/context", () => {
	process.env[runtimeKey] = "joined-group";
	const context = {
		sessionManager: { getSessionId: () => sessionId },
		subagentPolicy: { intercomGroup: "policy-group" },
		orchestrationContext: { intercomGroup: "workflow-group" },
	};
	assert.equal(inheritedIntercomGroup(context), "joined-group");
	assert.equal(resolveHomeGroup({ group: "config-group" }, context), "policy-group");
});

test("inheritedIntercomGroup keeps the static context group without a live join", () => {
	delete process.env[runtimeKey];
	const context = {
		sessionManager: { getSessionId: () => sessionId },
		orchestrationContext: { intercomGroup: "workflow-group" },
	};
	assert.equal(inheritedIntercomGroup(context), "workflow-group");
	assert.equal(resolveHomeGroup({ group: "config-group" }, context), "workflow-group");
});
