import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { inheritedIntercomGroup } from "../../packages/subagents/src/runs/shared/intercom-group.ts";

const RUNTIME_GROUP_ENV = "ATOMIC_INTERCOM_RUNTIME_GROUP";
const runtimeKey = (sessionId: string): string => `${RUNTIME_GROUP_ENV}_${encodeURIComponent(sessionId)}`;
const previousRuntimeGroup = process.env[runtimeKey("workflow-stage-session")];

afterEach(() => {
	if (previousRuntimeGroup === undefined) delete process.env[runtimeKey("workflow-stage-session")];
	else process.env[runtimeKey("workflow-stage-session")] = previousRuntimeGroup;
});

test("inheritedIntercomGroup prefers a live joined group over the static context group", () => {
	process.env[runtimeKey("workflow-stage-session")] = "joined-group";
	assert.equal(
		inheritedIntercomGroup({
			sessionManager: { getSessionId: () => "workflow-stage-session" },
			orchestrationContext: { intercomGroup: "workflow-group" },
		}),
		"joined-group",
	);
});

test("inheritedIntercomGroup keeps the static context group without a live join", () => {
	delete process.env[runtimeKey("workflow-stage-session")];
	assert.equal(
		inheritedIntercomGroup({
			sessionManager: { getSessionId: () => "workflow-stage-session" },
			orchestrationContext: { intercomGroup: "workflow-group" },
		}),
		"workflow-group",
	);
});
