import assert from "node:assert/strict";
import { test } from "vitest";
import type { IntercomClient } from "../../packages/intercom/broker/client.js";
import { SupervisorAuthorizationRegistry } from "../../packages/intercom/supervisor-authorization-registry.js";

test("parent registry restores the same child capability against a new broker supervisor id", async () => {
	const registry = new SupervisorAuthorizationRegistry();
	const calls: Array<{ childName: string; capability?: string }> = [];
	const client = (supervisorSessionId: string) =>
		({
			async authorizeSupervisorChild(childName: string, capability?: string) {
				calls.push({ childName, capability });
				return { childName, capability: capability ?? "stable-capability", supervisorSessionId };
			},
		}) as IntercomClient;

	const first = await registry.authorize("child-1", async () => client("supervisor-old"));
	assert.equal(first.capability, "stable-capability");
	await registry.restore(client("supervisor-new"));

	assert.deepEqual(calls, [
		{ childName: "child-1", capability: undefined },
		{ childName: "child-1", capability: "stable-capability" },
	]);
});

test("parent registry restores every bounded dynamic slot independently", async () => {
	const registry = new SupervisorAuthorizationRegistry();
	let issued = 0;
	const restored: string[] = [];
	const issuingClient = {
		async authorizeSupervisorChild(childName: string) {
			issued += 1;
			return { childName, capability: `dynamic-${issued}`, supervisorSessionId: "old" };
		},
	} as IntercomClient;
	const reconnectClient = {
		async authorizeSupervisorChild(childName: string, capability?: string) {
			restored.push(capability ?? "missing");
			return { childName, capability: capability!, supervisorSessionId: "new" };
		},
	} as IntercomClient;

	await registry.authorize("*", async () => issuingClient);
	await registry.authorize("*", async () => issuingClient);
	await registry.restore(reconnectClient);

	assert.deepEqual(restored.sort(), ["dynamic-1", "dynamic-2"]);
});

function issuingClient(calls: Array<{ childName: string; capability?: string }> = []): IntercomClient {
	let issued = 0;
	return {
		async authorizeSupervisorChild(childName: string, capability?: string) {
			calls.push(capability === undefined ? { childName } : { childName, capability });
			issued += 1;
			return {
				childName,
				capability: capability ?? `${childName}.capability-${issued}`,
				supervisorSessionId: "owner",
			};
		},
	} as IntercomClient;
}

const RELEASED_CHILDREN = 50;

test("releasing N children returns the registry to its size before their launch, and waking them again does not grow it (#4326)", async () => {
	const registry = new SupervisorAuthorizationRegistry();
	const client = issuingClient();
	await registry.authorize("live-child", async () => client);
	const baseline = registry.size;
	const names = Array.from({ length: RELEASED_CHILDREN }, (_, index) => `subagent-released-${index}`);
	for (const name of names) await registry.authorize(name, async () => client);
	assert.equal(registry.size, baseline + RELEASED_CHILDREN);
	registry.forget(names);
	assert.equal(registry.size, baseline);
	for (let wake = 0; wake < 3; wake++) {
		for (const name of names) await registry.authorize(name, async () => client);
		assert.equal(registry.size, baseline + RELEASED_CHILDREN, "a woken child replaces its own entry");
		registry.forget(names.map((name) => ` ${name.toUpperCase()} `));
		assert.equal(registry.size, baseline);
	}
	const restored: Array<{ childName: string; capability?: string }> = [];
	await registry.restore(issuingClient(restored));
	assert.deepEqual(restored, [{ childName: "live-child", capability: "live-child.capability-1" }]);
});

test("a gone child's capability and a dynamic slot are forgotten by capability, and an unknown one changes nothing (#4326)", async () => {
	const registry = new SupervisorAuthorizationRegistry();
	const client = issuingClient();
	const gone = await registry.authorize("subagent-gone", async () => client);
	const kept = await registry.authorize("subagent-kept", async () => client);
	const slot = await registry.authorize("*", async () => client);
	assert.equal(registry.size, 3);
	registry.forgetCapability("unknown.capability");
	assert.equal(registry.size, 3);
	registry.forgetCapability(gone.capability);
	registry.forgetCapability(slot.capability);
	assert.equal(registry.size, 1);
	const restored: Array<{ childName: string; capability?: string }> = [];
	await registry.restore(issuingClient(restored));
	assert.deepEqual(restored, [{ childName: "subagent-kept", capability: kept.capability }]);
});

test("a child released while a reconnect is re-authorizing it is not brought back (#4326)", async () => {
	const registry = new SupervisorAuthorizationRegistry();
	await registry.authorize("subagent-racing", async () => issuingClient());
	const racing = {
		async authorizeSupervisorChild(childName: string, capability?: string) {
			registry.forget([childName]);
			return { childName, capability: capability ?? "fresh", supervisorSessionId: "new-owner" };
		},
	} as IntercomClient;
	await registry.restore(racing);
	assert.equal(registry.size, 0);
});
