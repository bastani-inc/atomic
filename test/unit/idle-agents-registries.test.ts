import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import {
	childCommandRouteCount,
	createChildCommandTaskOwner,
} from "../../packages/coding-agent/src/core/tasks/child-command-owner.js";
import { subagentWakeNamespace } from "../../packages/subagents/src/runs/foreground/released-children.ts";
import { subagentChildRecordOf } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.ts";
import {
	readSubagentChildRecords,
	SUBAGENT_CHILD_RELEASED_STATUS,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.ts";
import { subagentRegistrySizes } from "../../packages/subagents/src/runs/foreground/subagent-registry-sizes.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveAsyncResources, trackAsyncResources } from "../../scripts/perf/idle-agents/async-resources.js";
import { settle } from "../../scripts/perf/idle-agents/scripted-model.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { launchReleasedShellWait, SHELL_TOOL } from "../helpers/released-shell-launch.js";
import { launchReleasedTask } from "../helpers/released-task-launch.js";

const CHILD_LOAD_TIMEOUT_MS = 120_000;
const OWNER_SESSION_ID = "registry-owner";
const COUNTING_OWNER_SESSION_ID = "counting-owner";
const SHELL_REGISTRY_OWNER_SESSION_ID = "shell-registry-owner";
const SHELL_COUNTING_OWNER_SESSION_ID = "shell-counting-owner";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
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

function assertPlainData(value: unknown): void {
	assert.notEqual(typeof value, "function", "the index must not retain a function");
	if (value === null || typeof value !== "object") return;
	assert.ok(
		Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype,
		"only plain objects and arrays",
	);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		assert.ok(descriptor);
		assert.equal(descriptor.get, undefined, "the index must not retain a getter");
		assert.equal(descriptor.set, undefined, "the index must not retain a setter");
		assertPlainData(descriptor.value);
	}
}

test(
	"a released child keeps exactly one plain-data entry in its owner's registries, its latest record, and adds none to the rest (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const dispatcher = new AgentWakeDispatcher();
		dispatcher.handle(subagentWakeNamespace(OWNER_SESSION_ID), async () => {});
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: OWNER_SESSION_ID },
			authorizeLaunch() {},
		});
		cleanups.push(async () => {
			await host.close("session-close");
		});
		await launchReleasedTask(0, env, host, owner, dispatcher);
		const before = subagentRegistrySizes();
		const routes = childCommandRouteCount(host);

		const children = 6;
		for (let index = 1; index <= children; index++) await launchReleasedTask(index, env, host, owner, dispatcher);

		assert.deepEqual(growth(before, subagentRegistrySizes(), children), { records: 1 });
		const childId = `gct-${children}:0`;
		const entry = subagentChildRecordOf(owner.getSessionId(), childId);
		assert.equal(entry?.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS);
		assert.deepEqual(entry, readSubagentChildRecords(owner.getEntries()).get(childId), "it is the saved record");
		assert.deepEqual(structuredClone(entry), entry, "the latest record is structured-cloneable");
		assertPlainData(entry);
		assert.equal(childCommandRouteCount(host), routes, "no completion route is left in the parent's command owner");
	},
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"released children hold no timer, socket or process between them, however many there are, even an unref'd one (#4326)",
	async () => {
		cleanups.push(trackAsyncResources());
		const env = await liveChildEnvironment(cleanups);
		const dispatcher = new AgentWakeDispatcher();
		dispatcher.handle(subagentWakeNamespace(COUNTING_OWNER_SESSION_ID), async () => {});
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: COUNTING_OWNER_SESSION_ID },
			authorizeLaunch() {},
		});
		cleanups.push(async () => {
			await host.close("session-close");
		});
		await launchReleasedTask(0, env, host, owner, dispatcher);
		await settle();
		const afterFirst = liveAsyncResources();

		for (let index = 1; index <= 6; index++) await launchReleasedTask(index, env, host, owner, dispatcher);
		await settle();

		assert.deepEqual(liveAsyncResources(), afterFirst);
	},
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"a child released on a shell wait keeps one record and one completion route while its shell runs, and nothing else (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const dispatcher = new AgentWakeDispatcher();
		dispatcher.handle(subagentWakeNamespace(SHELL_REGISTRY_OWNER_SESSION_ID), async () => {});
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: SHELL_REGISTRY_OWNER_SESSION_ID },
			authorizeLaunch() {},
		});
		cleanups.push(async () => {
			await host.close("session-close");
		});
		const parentCommandTaskOwner = createChildCommandTaskOwner(() => host);
		await launchReleasedShellWait(0, env, host, owner, dispatcher, parentCommandTaskOwner);
		const before = subagentRegistrySizes();
		const routes = childCommandRouteCount(host);

		const children = 4;
		for (let index = 1; index <= children; index++)
			await launchReleasedShellWait(index, env, host, owner, dispatcher, parentCommandTaskOwner);

		assert.deepEqual(growth(before, subagentRegistrySizes(), children), { records: 1 });
		assert.equal(
			childCommandRouteCount(host) - routes,
			children,
			"the route that lets the running shell's completion wake its child is the one more entry, in the parent's owner",
		);
		const childId = `gsw-${children}:0`;
		const entry = subagentChildRecordOf(owner.getSessionId(), childId);
		assert.equal(entry?.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS);
		assert.deepEqual(
			entry?.waitingOn?.map((call) => call.toolName),
			[SHELL_TOOL],
			"it waits on the shell's wait",
		);
		assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry, "it is plain data");
	},
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"children released on a shell wait hold no timer, socket or process of this thread between them (#4326)",
	async () => {
		cleanups.push(trackAsyncResources());
		const env = await liveChildEnvironment(cleanups);
		const dispatcher = new AgentWakeDispatcher();
		dispatcher.handle(subagentWakeNamespace(SHELL_COUNTING_OWNER_SESSION_ID), async () => {});
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: SHELL_COUNTING_OWNER_SESSION_ID },
			authorizeLaunch() {},
		});
		cleanups.push(async () => {
			await host.close("session-close");
		});
		const parentCommandTaskOwner = createChildCommandTaskOwner(() => host);
		await launchReleasedShellWait(0, env, host, owner, dispatcher, parentCommandTaskOwner);
		await settle();
		const afterFirst = liveAsyncResources();

		for (let index = 1; index <= 4; index++)
			await launchReleasedShellWait(index, env, host, owner, dispatcher, parentCommandTaskOwner);
		await settle();

		assert.deepEqual(liveAsyncResources(), afterFirst);
	},
	CHILD_LOAD_TIMEOUT_MS,
);
