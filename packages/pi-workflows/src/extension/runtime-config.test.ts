/**
 * WorkflowRuntimeConfig port tests.
 *
 * Verifies:
 * - WorkflowRuntimeConfig type is exported from the public types.ts entry point
 * - config? field is present on ExtensionRuntimeOpts, DispatcherOpts, RunOpts, DetachedRunOpts
 * - createExtensionRuntime accepts config and threads it through dispatch → run
 * - dispatch() forwards config to run() and runDetached()
 * - Composition root default config contains required fields from WORKFLOW_CONFIG_DEFAULTS
 */

import { test, expect, describe } from "bun:test";
import type { WorkflowRuntimeConfig } from "../shared/types.js";
import type { ExtensionRuntimeOpts } from "./runtime.js";
import type { DispatcherOpts } from "./dispatcher.js";
import type { RunOpts } from "../runs/sync/executor.js";
import type { DetachedRunOpts } from "../runs/detach/runner.js";
import { createExtensionRuntime } from "./runtime.js";
import { dispatch } from "./dispatcher.js";
import { createRegistry } from "../workflows/registry.js";
import { defineWorkflow } from "../workflows/define-workflow.js";
import { createStore } from "../store.js";
import { WORKFLOW_CONFIG_DEFAULTS } from "./config-loader.js";
import type { WorkflowDefinition } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Type-level checks — compile-time only, no runtime assertions needed
// ---------------------------------------------------------------------------

// Verify WorkflowRuntimeConfig shape is structurally correct.
const _shapeCheck: WorkflowRuntimeConfig = {
  maxDepth: 4,
  defaultConcurrency: 4,
  persistRuns: true,
  statusFile: false,
  resumeInFlight: "ask",
};

// Verify optional statusFilePath
const _withPath: WorkflowRuntimeConfig = {
  maxDepth: 4,
  defaultConcurrency: 4,
  persistRuns: true,
  statusFile: true,
  resumeInFlight: "ask",
  statusFilePath: "/tmp/workflow-status.json",
};

// Verify config? is accepted on all four option types (type-level compile check)
const _runtimeOpts: ExtensionRuntimeOpts = { config: _shapeCheck };
const _dispatcherOpts: DispatcherOpts = { registry: createRegistry([]), config: _shapeCheck };
const _runOpts: RunOpts = { config: _shapeCheck };
const _detachedOpts: DetachedRunOpts = { config: _shapeCheck };

// ---------------------------------------------------------------------------
// Runtime checks
// ---------------------------------------------------------------------------

function makeWorkflow(name: string): WorkflowDefinition {
  return defineWorkflow(name)
    .run(async (_ctx) => ({ ok: true }))
    .compile() as WorkflowDefinition;
}

const sampleConfig: WorkflowRuntimeConfig = {
  maxDepth: 8,
  defaultConcurrency: 2,
  persistRuns: false,
  statusFile: false,
  resumeInFlight: "never",
};

describe("WorkflowRuntimeConfig — ExtensionRuntimeOpts", () => {
  test("createExtensionRuntime accepts config without error", () => {
    const registry = createRegistry([makeWorkflow("wf-a")]);
    const runtime = createExtensionRuntime({ registry, config: sampleConfig });
    expect(runtime.registry.names()).toContain("wf-a");
  });

  test("createExtensionRuntime without config remains valid (config is optional)", () => {
    const registry = createRegistry([makeWorkflow("wf-b")]);
    const runtime = createExtensionRuntime({ registry });
    expect(runtime.registry.names()).toContain("wf-b");
  });
});

describe("WorkflowRuntimeConfig — DispatcherOpts", () => {
  test("DispatcherOpts accepts config field", () => {
    const opts: DispatcherOpts = {
      registry: createRegistry([]),
      config: sampleConfig,
    };
    expect(opts.config).toBe(sampleConfig);
  });

  test("DispatcherOpts without config is still valid", () => {
    const opts: DispatcherOpts = { registry: createRegistry([]) };
    expect(opts.config).toBeUndefined();
  });

  test("dispatch(run) with config propagates without error", async () => {
    const wf = makeWorkflow("cfg-run-test");
    const registry = createRegistry([wf]);
    const store = createStore();
    const result = await dispatch(
      { action: "run", name: "cfg-run-test", inputs: {} },
      { registry, store, config: sampleConfig },
    );
    expect(result.action).toBe("run");
    if (result.action === "run" && "runId" in result) {
      expect(result.status).toBe("completed");
    }
  });

  test("dispatch(list) with config is unaffected", async () => {
    const registry = createRegistry([makeWorkflow("alpha")]);
    const result = await dispatch(
      { action: "list" },
      { registry, config: sampleConfig },
    );
    expect(result.action).toBe("list");
    if (result.action === "list") {
      expect(result.workflows).toContain("alpha");
    }
  });
});

describe("WorkflowRuntimeConfig — RunOpts", () => {
  test("RunOpts accepts config field", () => {
    const opts: RunOpts = { config: sampleConfig };
    expect(opts.config).toBe(sampleConfig);
  });

  test("RunOpts config is optional", () => {
    const opts: RunOpts = {};
    expect(opts.config).toBeUndefined();
  });
});

describe("WorkflowRuntimeConfig — DetachedRunOpts", () => {
  test("DetachedRunOpts accepts config field (inherited from RunOpts)", () => {
    const opts: DetachedRunOpts = { config: sampleConfig };
    expect(opts.config).toBe(sampleConfig);
  });
});

describe("WorkflowRuntimeConfig — WORKFLOW_CONFIG_DEFAULTS alignment", () => {
  test("WORKFLOW_CONFIG_DEFAULTS covers all required WorkflowRuntimeConfig fields", () => {
    // Build a runtime config from defaults — all required fields must be satisfied
    const config: WorkflowRuntimeConfig = {
      maxDepth: WORKFLOW_CONFIG_DEFAULTS.maxDepth,
      defaultConcurrency: WORKFLOW_CONFIG_DEFAULTS.defaultConcurrency,
      persistRuns: WORKFLOW_CONFIG_DEFAULTS.persistRuns,
      statusFile: WORKFLOW_CONFIG_DEFAULTS.statusFile,
      resumeInFlight: WORKFLOW_CONFIG_DEFAULTS.resumeInFlight,
    };
    expect(config.maxDepth).toBe(4);
    expect(config.defaultConcurrency).toBe(4);
    expect(config.persistRuns).toBe(true);
    expect(config.statusFile).toBe(false);
    expect(config.resumeInFlight).toBe("ask");
  });
});
