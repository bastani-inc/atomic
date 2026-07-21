import { afterEach, describe, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { resetDbosLifecycleForTests } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import {
  getDurableBackend,
  initializeDurableBackend,
  setDurableBackend,
} from "../../packages/workflows/src/durable/factory.js";

afterEach(() => {
  setDurableBackend(undefined);
  resetDbosLifecycleForTests();
});

describe("durable factory non-durable degradation", () => {
  test.serial("falls back to one in-memory backend with a loud warning when DBOS cannot be provisioned", async () => {
    setDurableBackend(undefined); // clear the preload-injected test backend
    resetDbosLifecycleForTests(async () => {
      throw new Error("initdb: error: cannot be run as root");
    });
    const warnings: string[] = [];
    const consoleSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const [first, second] = await Promise.all([
        initializeDurableBackend(),
        initializeDurableBackend(),
      ]);

      assert.ok(first instanceof InMemoryDurableBackend);
      assert.equal(first.persistent, false);
      // Concurrent initialization must converge on a single fallback backend.
      assert.equal(second, first);
      assert.equal(await initializeDurableBackend(), first);
      // The sync accessor serves the degraded backend after initialization.
      assert.equal(getDurableBackend(), first);

      const degradationWarnings = warnings.filter((message) => message.includes("NON-DURABLY"));
      assert.equal(degradationWarnings.length, 1);
      assert.match(degradationWarnings[0]!, /cannot be run as root/);
      assert.match(degradationWarnings[0]!, /\/workflow resume/);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test.serial("a provisionable DBOS backend is preferred and produces no degradation warning", async () => {
    const warnings: string[] = [];
    setDurableBackend(undefined); // clear the preload-injected test backend
    const consoleSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const backend = await initializeDurableBackendWithFakeDbos();
      assert.equal(backend.persistent, true);
      assert.equal(warnings.filter((message) => message.includes("NON-DURABLY")).length, 0);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

async function initializeDurableBackendWithFakeDbos() {
  const { DbosDurableBackend } = await import("../../packages/workflows/src/durable/dbos-backend.js");
  const sdk = {
    launch: async () => {},
    shutdown: async () => {},
    startWorkflow: async () => {},
    retrieveWorkflow: async () => undefined,
    cancelWorkflow: async () => {},
    resumeWorkflow: async () => {},
    listAllWorkflows: async () => [],
    listStepRecords: async () => [],
    recordStepOutput: async () => {},
    deleteWorkflowData: async () => {},
  };
  resetDbosLifecycleForTests(async () => ({
    backend: new DbosDurableBackend(sdk),
    launch: async () => {},
    shutdown: async () => {},
  }));
  return await initializeDurableBackend();
}
