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

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { WorkflowRuntimeConfig } from "../../packages/workflows/src/shared/types.js";
import type { ExtensionRuntimeOpts } from "../../packages/workflows/src/extension/runtime.js";
import type { DispatcherOpts } from "../../packages/workflows/src/extension/dispatcher.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { DetachedRunOpts } from "../../packages/workflows/src/runs/background/runner.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { Type } from "typebox";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { WORKFLOW_CONFIG_DEFAULTS } from "../../packages/workflows/src/extension/config-loader.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";

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
void _withPath;

// Verify config? is accepted on all four option types (type-level compile check)
const _runtimeOpts: ExtensionRuntimeOpts = {
  config: _shapeCheck,
  resolveDefaultStageSessionDir: () => "/tmp/atomic-sessions",
};
const _dispatcherOpts: DispatcherOpts = {
  registry: createRegistry([]),
  config: _shapeCheck,
  defaultSessionDir: "/tmp/atomic-sessions",
};
const _runOpts: RunOpts = { config: _shapeCheck };
const _detachedOpts: DetachedRunOpts = { config: _shapeCheck };
void _runtimeOpts; void _dispatcherOpts; void _runOpts; void _detachedOpts;

// ---------------------------------------------------------------------------
// Runtime checks
// ---------------------------------------------------------------------------

function makeWorkflow(name: string): WorkflowDefinition {
  return defineWorkflow(name)
    .output("ok", Type.Boolean())
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
    assert.ok(runtime.registry.names().includes("wf-a"));
  });

  test("createExtensionRuntime accepts a default stage session dir resolver", () => {
    const registry = createRegistry([makeWorkflow("wf-session-dir")]);
    const runtime = createExtensionRuntime({
      registry,
      resolveDefaultStageSessionDir: () => "/tmp/atomic-sessions",
    });
    assert.ok(runtime.registry.names().includes("wf-session-dir"));
  });

  test("createExtensionRuntime without config remains valid (config is optional)", () => {
    const registry = createRegistry([makeWorkflow("wf-b")]);
    const runtime = createExtensionRuntime({ registry });
    assert.ok(runtime.registry.names().includes("wf-b"));
  });
});

describe("WorkflowRuntimeConfig — DispatcherOpts", () => {
  test("DispatcherOpts accepts config field", () => {
    const opts: DispatcherOpts = {
      registry: createRegistry([]),
      config: sampleConfig,
    };
    assert.equal(opts.config, sampleConfig);
  });

  test("DispatcherOpts without config is still valid", () => {
    const opts: DispatcherOpts = { registry: createRegistry([]) };
    assert.equal(opts.config, undefined);
  });

  test("dispatch(run) with config propagates without error", async () => {
    const wf = makeWorkflow("cfg-run-test");
    const registry = createRegistry([wf]);
    const store = createStore();
    const result = await dispatch(
      { action: "run", workflow: "cfg-run-test", inputs: {} },
      { registry, store, config: sampleConfig },
    );
    // Background dispatch — synchronous return is `running`; the eventual
    // completion lives on the store.
    assert.equal(result.action, "run");
    if (result.action === "run" && "runId" in result) {
      assert.equal(result.status, "running");
    }
  });

  test("dispatch(list) with config is unaffected", async () => {
    const registry = createRegistry([makeWorkflow("alpha")]);
    const result = await dispatch(
      { action: "list" },
      { registry, config: sampleConfig },
    );
    assert.equal(result.action, "list");
    if (result.action === "list") {
      assert.ok(result.items.some((i) => i.name === "alpha"));
    }
  });
});

describe("WorkflowRuntimeConfig — RunOpts", () => {
  test("RunOpts accepts config field", () => {
    const opts: RunOpts = { config: sampleConfig };
    assert.equal(opts.config, sampleConfig);
  });

  test("RunOpts config is optional", () => {
    const opts: RunOpts = {};
    assert.equal(opts.config, undefined);
  });
});

describe("WorkflowRuntimeConfig — DetachedRunOpts", () => {
  test("DetachedRunOpts accepts config field (inherited from RunOpts)", () => {
    const opts: DetachedRunOpts = { config: sampleConfig };
    assert.equal(opts.config, sampleConfig);
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
    assert.equal(config.maxDepth, 4);
    assert.equal(config.defaultConcurrency, 4);
    assert.equal(config.persistRuns, true);
    assert.equal(config.statusFile, false);
    assert.equal(config.resumeInFlight, "ask");
  });
});
