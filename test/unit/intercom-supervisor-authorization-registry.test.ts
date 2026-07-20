import { test } from "bun:test";
import assert from "node:assert/strict";
import type { IntercomClient } from "../../packages/intercom/broker/client.js";
import { SupervisorAuthorizationRegistry } from "../../packages/intercom/supervisor-authorization-registry.js";

test("parent registry restores the same child capability against a new broker supervisor id", async () => {
  const registry = new SupervisorAuthorizationRegistry();
  const calls: Array<{ childName: string; capability?: string }> = [];
  const client = (supervisorSessionId: string) => ({
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
