import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  DbosDurableBackend,
  type ConfiguredDbosDurability,
  type DbosSdkHandle,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import {
  DbosDurabilityError,
  dbosLifecycleState,
  getReadyDbosBackend,
  resetDbosLifecycleForTests,
  shutdownDbos,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";

function sdk(events: string[]): DbosSdkHandle {
  return {
    launch: async () => {},
    shutdown: async () => {},
    startWorkflow: async () => { events.push("start"); },
    retrieveWorkflow: async () => undefined,
    cancelWorkflow: async () => {},
    resumeWorkflow: async () => {},
    listAllWorkflows: async () => [],
    listStepRecords: async () => [],
    recordStepOutput: async () => { events.push("record"); },
    deleteWorkflowData: async () => {},
  };
}

function configured(
  events: string[],
  launch: () => Promise<void> = async () => { events.push("launch"); },
): ConfiguredDbosDurability {
  return {
    backend: new DbosDurableBackend(sdk(events)),
    launch,
    shutdown: async () => { events.push("shutdown"); },
  };
}

afterEach(() => resetDbosLifecycleForTests());

describe("mandatory DBOS lifecycle", () => {
  test.serial("configures and launches exactly once for concurrent callers", async () => {
    const events: string[] = [];
    let configurationCalls = 0;
    const durability = configured(events);
    resetDbosLifecycleForTests(async () => {
      configurationCalls += 1;
      return durability;
    });

    const backends = await Promise.all([
      getReadyDbosBackend(),
      getReadyDbosBackend(),
      getReadyDbosBackend(),
    ]);

    assert.equal(configurationCalls, 1);
    assert.deepEqual(events, ["launch"]);
    assert.ok(backends.every((backend) => backend === durability.backend));
    assert.equal(dbosLifecycleState(), "ready");
  });

  test.serial("starts local DBOS Postgres once after a default connection refusal", async () => {
    const originalUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    let launchCalls = 0;
    let provisionCalls = 0;
    resetDbosLifecycleForTests(
      async () => configured([], async () => {
        launchCalls += 1;
        if (launchCalls === 1) throw new Error("connect failed with ECONNREFUSED");
      }),
      async () => { provisionCalls += 1; },
    );
    try {
      await getReadyDbosBackend();
      assert.equal(launchCalls, 2);
      assert.equal(provisionCalls, 1);
      assert.equal(dbosLifecycleState(), "ready");
    } finally {
      if (originalUrl === undefined) delete process.env.DBOS_SYSTEM_DATABASE_URL;
      else process.env.DBOS_SYSTEM_DATABASE_URL = originalUrl;
    }
  });

  test.serial("memoizes launch failure without selecting another backend", async () => {
    let launchCalls = 0;
    resetDbosLifecycleForTests(async () => configured([], async () => {
      launchCalls += 1;
      throw new Error("postgres unavailable");
    }));

    await assert.rejects(getReadyDbosBackend(), DbosDurabilityError);
    await assert.rejects(getReadyDbosBackend(), /postgres unavailable/);
    assert.equal(launchCalls, 1);
    assert.equal(dbosLifecycleState(), "failed");
  });

  test.serial("flushes queued writes before shutting DBOS down once", async () => {
    const events: string[] = [];
    resetDbosLifecycleForTests(async () => configured(events));
    const backend = await getReadyDbosBackend();
    backend.registerWorkflow({
      workflowId: "shutdown-order",
      name: "shutdown-order",
      inputs: {},
      createdAt: 1,
      status: "running",
    });

    await Promise.all([shutdownDbos(), shutdownDbos()]);

    assert.equal(events[0], "launch");
    assert.ok(events.includes("start"));
    assert.ok(events.includes("record"));
    assert.equal(events.at(-1), "shutdown");
    assert.equal(events.filter((event) => event === "shutdown").length, 1);
  });
});
