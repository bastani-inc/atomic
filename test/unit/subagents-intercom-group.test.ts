import assert from "node:assert/strict";
import { runtimeIntercomGroupEnvKey } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { resolveHomeGroup } from "../../packages/intercom/group.js";
import { inheritedIntercomGroup } from "../../packages/subagents/src/runs/shared/intercom-group.js";

const sessionId = "user chat/session";
const runtimeKey = runtimeIntercomGroupEnvKey(sessionId);
const previousRuntimeGroup = process.env[runtimeKey];

afterEach(() => {
	if (previousRuntimeGroup === undefined) delete process.env[runtimeKey];
	else process.env[runtimeKey] = previousRuntimeGroup;
});

test("runtime group inheritance uses the shared key and outranks static policy", () => {
	process.env[runtimeKey] = "joined-group";
	const context = {
		sessionManager: { getSessionId: () => sessionId },
		subagentPolicy: { intercomGroup: "policy-group" },
	};
	assert.equal(inheritedIntercomGroup(context), "joined-group");
	assert.equal(resolveHomeGroup({ group: "config-group" }, context), "policy-group");
});

test("inheritedIntercomGroup keeps the admitted group without a live join", () => {
	delete process.env[runtimeKey];
	const context = {
		sessionManager: { getSessionId: () => sessionId },
		subagentPolicy: { intercomGroup: "policy-group" },
	};
	assert.equal(inheritedIntercomGroup(context), "policy-group");
	assert.equal(resolveHomeGroup({ group: "config-group" }, context), "policy-group");
});
