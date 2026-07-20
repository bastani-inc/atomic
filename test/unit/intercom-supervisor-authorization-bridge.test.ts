import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  requestSupervisorAuthorization,
  SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT,
} from "../../packages/subagents/src/intercom/supervisor-authorization.js";

test("subagent bridge receives the broker-issued supervisor authorization", async () => {
  const events = {
    on() { return () => {}; },
    emit(channel: string, data: unknown) {
      assert.equal(channel, SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT);
      const request = data as { childName: string; completion?: Promise<object> };
      assert.equal(request.childName, "child-1");
      request.completion = Promise.resolve({
        capability: "capability-1",
        supervisorSessionId: "supervisor-id",
        childName: request.childName,
      });
    },
  };

  assert.deepEqual(await requestSupervisorAuthorization(events, " child-1 "), {
    capability: "capability-1",
    supervisorSessionId: "supervisor-id",
    childName: "child-1",
  });
});

test("subagent bridge returns no authority when no Intercom listener owns authorization", async () => {
  const events = { on() { return () => {}; }, emit() {} };
  assert.equal(await requestSupervisorAuthorization(events, "child-1"), undefined);
});
