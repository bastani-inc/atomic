import { test, expect, describe, afterEach } from "bun:test";
import type { WorkflowRunOptions } from "../../../src/sdk/runtime/executor.ts";
import { runOrchestrator } from "../../../src/sdk/runtime/executor.ts";
// Import validateOrchestratorEnv from the un-mocked sub-module so env-var
// tests are not affected by mock.module("executor.ts") in worker/command tests.
import { validateOrchestratorEnv } from "../../../src/sdk/runtime/executor-env.ts";
import type { WorkflowDefinition } from "../../../src/sdk/types.ts";
import { defineWorkflow } from "../../../src/sdk/define-workflow.ts";

// ---------------------------------------------------------------------------
// WorkflowRunOptions shape
// ---------------------------------------------------------------------------

describe("WorkflowRunOptions shape", () => {
  test("only carries definition + agent + inputs + projectRoot + detach", () => {
    // The post-refactor WorkflowRunOptions drops `entrypointFile` and
    // `workflowKey`. The orchestrator imports the workflow by its `source`
    // field instead, so the executor never needs to know the dev's argv.
    const opts = {
      definition: defineWorkflow({
        name: "hello-world",
        source: import.meta.path,
      })
        .for("claude")
        .run(async () => {})
        .compile(),
      agent: "claude" as const,
      inputs: { prompt: "hi" },
    } satisfies WorkflowRunOptions;

    expect(opts.definition.source).toBe(import.meta.path);
    // The deprecated fields must not survive on the typed shape.
    expect("entrypointFile" in opts).toBe(false);
    expect("workflowKey" in opts).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateOrchestratorEnv — env var validation
//
// Uses validateOrchestratorEnv directly (imported from executor-env.ts, NOT
// from executor.ts) so that mock.module("executor.ts") in worker.test.ts and
// workflow-command.test.ts does not interfere with these tests.
// ---------------------------------------------------------------------------

describe("runOrchestrator env var validation", () => {
  const REQUIRED_VARS = ["ATOMIC_WF_ID", "ATOMIC_WF_TMUX", "ATOMIC_WF_AGENT", "ATOMIC_WF_CWD"] as const;

  // Save and restore process.env around each test.
  const savedEnv: Partial<Record<string, string>> = {};

  function saveEnv(): void {
    for (const key of [...REQUIRED_VARS, "ATOMIC_ORCHESTRATOR_MODE", "ATOMIC_WF_KEY", "ATOMIC_WF_INPUTS"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  function restoreEnv(): void {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  afterEach(restoreEnv);

  test("throws when ATOMIC_WF_ID is missing", () => {
    saveEnv();
    // Set all required vars except ATOMIC_WF_ID
    process.env.ATOMIC_WF_TMUX = "atomic-wf-claude-hello-world-abc";
    process.env.ATOMIC_WF_AGENT = "claude";
    process.env.ATOMIC_WF_CWD = "/tmp";

    expect(() => validateOrchestratorEnv()).toThrow("ATOMIC_WF_ID");
  });

  test("throws when ATOMIC_WF_TMUX is missing", () => {
    saveEnv();
    process.env.ATOMIC_WF_ID = "wf-run-123";
    process.env.ATOMIC_WF_AGENT = "claude";
    process.env.ATOMIC_WF_CWD = "/tmp";

    expect(() => validateOrchestratorEnv()).toThrow("ATOMIC_WF_TMUX");
  });

  test("throws when ATOMIC_WF_AGENT is missing", () => {
    saveEnv();
    process.env.ATOMIC_WF_ID = "wf-run-123";
    process.env.ATOMIC_WF_TMUX = "atomic-wf-claude-hello-world-abc";
    process.env.ATOMIC_WF_CWD = "/tmp";

    expect(() => validateOrchestratorEnv()).toThrow("ATOMIC_WF_AGENT");
  });

  test("throws when ATOMIC_WF_CWD is missing", () => {
    saveEnv();
    process.env.ATOMIC_WF_ID = "wf-run-123";
    process.env.ATOMIC_WF_TMUX = "atomic-wf-claude-hello-world-abc";
    process.env.ATOMIC_WF_AGENT = "claude";

    expect(() => validateOrchestratorEnv()).toThrow("ATOMIC_WF_CWD");
  });

  test("throws for invalid ATOMIC_WF_AGENT value", () => {
    saveEnv();
    process.env.ATOMIC_WF_ID = "wf-run-123";
    process.env.ATOMIC_WF_TMUX = "atomic-wf-bad-hello-world-abc";
    process.env.ATOMIC_WF_AGENT = "not-an-agent";
    process.env.ATOMIC_WF_CWD = "/tmp";

    expect(() => validateOrchestratorEnv()).toThrow(/Invalid ATOMIC_WF_AGENT/);
  });

  test("error message for invalid agent includes the bad value", () => {
    saveEnv();
    process.env.ATOMIC_WF_ID = "wf-run-123";
    process.env.ATOMIC_WF_TMUX = "atomic-wf-bad-hello-world-abc";
    process.env.ATOMIC_WF_AGENT = "gpt";
    process.env.ATOMIC_WF_CWD = "/tmp";

    let message = "";
    try {
      validateOrchestratorEnv();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("gpt");
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — accepts WorkflowDefinition (not a string path)
// ---------------------------------------------------------------------------

describe("runOrchestrator accepts WorkflowDefinition + inputs", () => {
  test("signature accepts a compiled WorkflowDefinition and an inputs map", () => {
    const definition = defineWorkflow({
      name: "test-wf",
      source: import.meta.path,
    })
      .for("copilot")
      .run(async () => {})
      .compile();

    const _check: (
      d: WorkflowDefinition,
      inputs?: Record<string, string>,
    ) => Promise<void> = runOrchestrator;
    expect(typeof _check).toBe("function");
    expect(definition.__brand).toBe("WorkflowDefinition");
    expect(definition.source).toBe(import.meta.path);
  });
});

// ---------------------------------------------------------------------------
// Launcher script — orchestrator entry script with positional argv
// ---------------------------------------------------------------------------

describe("launcher script invokes the SDK orchestrator entry", () => {
  test("executor sources orchestrator-entry.ts and drops the old env-var contract", async () => {
    const src = await Bun.file("src/sdk/runtime/executor.ts").text();

    // The dev's CLI is no longer re-execed; the SDK ships its own entry.
    expect(src).toContain("orchestrator-entry.ts");

    // The old ATOMIC_ORCHESTRATOR_MODE / ATOMIC_WF_KEY / ATOMIC_WF_INPUTS
    // re-entry signals must be gone from the launcher.
    expect(src).not.toContain("ATOMIC_ORCHESTRATOR_MODE");
    expect(src).not.toContain("ATOMIC_WF_KEY");
    expect(src).not.toContain("ATOMIC_WF_INPUTS");
    expect(src).not.toContain("ATOMIC_WF_FILE");
  });
});
