import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { childCommandRouteCount } from "../../packages/coding-agent/src/core/tasks/child-command-owner.js";
import { subagentWakeNamespace } from "../../packages/subagents/src/runs/foreground/released-children.ts";
import { subagentRegistrySizes } from "../../packages/subagents/src/runs/foreground/subagent-registry-sizes.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { launchReleasedTask } from "../helpers/released-task-launch.js";

const CHILD_LOAD_TIMEOUT_MS = 120_000;
const OWNER_SESSION_ID = "registry-owner";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

function growth(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>, children: number) {
	const grown: Record<string, number> = {};
	for (const name of Object.keys(after)) {
		const added = (after[name] ?? 0) - (before[name] ?? 0);
		if (added !== 0) grown[name] = added / children;
	}
	return grown;
}

test(
	"a released child adds exactly seven small entries to its owner's registries (its record, task id, retained output and its run's control), and none to the rest (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const dispatcher = new AgentWakeDispatcher();
		dispatcher.handle(subagentWakeNamespace(OWNER_SESSION_ID), async () => {});
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: OWNER_SESSION_ID },
			authorizeLaunch() {},
		});
		cleanups.push(() => void host.close("session-close"));
		await launchReleasedTask(0, env, host, owner, dispatcher);
		const before = subagentRegistrySizes();
		const routes = childCommandRouteCount(host);

		const children = 6;
		for (let index = 1; index <= children; index++) await launchReleasedTask(index, env, host, owner, dispatcher);

		assert.deepEqual(growth(before, subagentRegistrySizes(), children), {
			controlChildIds: 1,
			controlDelivered: 1,
			controlEnvelopes: 1,
			controls: 1,
			records: 1,
			retainedTaskOutputs: 1,
			taskIds: 1,
		});
		assert.equal(childCommandRouteCount(host), routes, "no completion route is left in the parent's command owner");
	},
	CHILD_LOAD_TIMEOUT_MS,
);
