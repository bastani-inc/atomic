import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_WORKFLOW_DESCRIPTION_TOKENS,
  factory,
  makeMock,
  recordWorkflowRun,
  runTool,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./mock-extension-api-helpers.js";
import type { WorkflowToolArgs } from "./mock-extension-api-helpers.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";

describe("MockExtensionAPI — tool registration", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("registers only the workflow tool", () => {
    // `workflow` is the workflows extension's sole registered tool;
    // `ask_user_question` now ships as a base tool from the coding-agent
    // package and is not registered here.
    assert.equal(mock.tools.length, 1);
    const names = mock.tools.map((t) => t.opts.name).sort();
    assert.deepEqual(names, ["workflow"]);
  });

  test("workflow tool is registered first (stable ordering)", () => {
    // Downstream tests in this suite use `mock.tools[0]!` as a shortcut to
    // the workflow tool — register the workflow tool first so that path
    // stays stable.
    assert.equal(mock.tools[0]!.opts.name, "workflow");
  });

  test("tool description covers current workflow capabilities", () => {
    const description = mock.tools[0]!.opts.description;
    assert.equal(typeof description, "string");
    assert.equal(description, WORKFLOW_TOOL_DESCRIPTION);
    assert.ok(!description.includes("defined multi-stage workflow by name"));
    for (const token of EXPECTED_WORKFLOW_DESCRIPTION_TOKENS) {
      assert.ok(description.includes(token), `description mentions ${token}`);
    }
    assert.match(description, /quit/);
    assert.doesNotMatch(description, /kill/);
  });

  test("README workflow tool description stays in sync", () => {
    const readme = readFileSync(join(process.cwd(), "packages/workflows/README.md"), "utf8");
    assert.ok(
      readme.includes(`"description": "${WORKFLOW_TOOL_DESCRIPTION}",`),
      "README JSON example includes WORKFLOW_TOOL_DESCRIPTION",
    );
  });

  test("tool has parameters schema (TypeBox object)", () => {
    const params = mock.tools[0]!.opts.parameters as Record<string, unknown>;
    assert.notEqual(params, undefined);
    // TypeBox TObject has a 'type' property equal to 'object'
    assert.equal(params["type"], "object");
  });

  test("tool parameters include only named execution, discovery, inspection, messaging, and control properties", () => {
    const params = mock.tools[0]!.opts.parameters as {
      properties: Record<string, unknown>;
    };
    assert.ok("workflow" in params.properties);
    assert.ok(!("name" in params.properties));
    assert.ok("inputs" in params.properties);
    assert.ok("action" in params.properties);
    assert.ok("runId" in params.properties);
    assert.ok("all" in params.properties);
    assert.ok("stageId" in params.properties);
    assert.ok("message" in params.properties);
    assert.ok(!("id" in params.properties));
    for (const removed of [
      "task", "tasks", "chain", "chainName", "chainDir", "concurrency", "failFast",
      "async", "intercom", "context", "cwd", "output", "outputMode", "maxOutput",
      "artifacts", "sessionDir", "worktree", "gitWorktreeDir", "baseBranch",
    ]) {
      assert.ok(!(removed in params.properties), `removed direct field ${removed}`);
    }
  });

  test("tool 'action' schema covers rewritten literals only", () => {
    const params = mock.tools[0]!.opts.parameters as {
      properties: {
        action: { anyOf?: Array<{ const?: string; enum?: string[] }> };
      };
    };
    const actionSchema = params.properties.action;
    // TypeBox Optional(Union([...])) wraps in anyOf
    const raw = JSON.stringify(actionSchema);
    for (const literal of ["run", "list", "get", "status", "interrupt", "quit", "resume", "inputs"]) {
      assert.ok(raw.includes(literal));
    }
    assert.ok(!raw.includes("kill"));
    assert.ok(!raw.includes("doctor"));
  });

  test("tool execute returns run stub for default action", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "my-workflow", inputs: {} });
    assert.equal(result.action, "run");
  });


  test("tool execute returns list stub for action='list'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { inputs: {}, action: "list" });
    assert.equal(result.action, "list");
    assert.equal(
      Array.isArray((result as { action: "list"; items: unknown[] }).items),
      true,
    );
  });

  test("tool execute returns status stub for action='status'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { inputs: {}, action: "status" });
    assert.equal(result.action, "status");
    assert.equal(
      Array.isArray((result as { action: "status"; snapshots: unknown[] }).snapshots),
      true,
    );
  });

  test("tool execute status includes retained terminal snapshots", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const activeId = `status-active-${Date.now()}`;
    const completedId = `status-completed-${Date.now()}`;
    const failedId = `status-failed-${Date.now()}`;
    const killedId = `status-killed-${Date.now()}`;
    recordWorkflowRun(activeId, "active", "running");
    recordWorkflowRun(completedId, "completed", "completed");
    recordWorkflowRun(failedId, "failed", "failed", "boom");
    recordWorkflowRun(killedId, "killed", "killed", "killed");

    const result = await runTool(execute, { inputs: {}, action: "status" });
    const snapshots = (result as { action: "status"; snapshots: Array<{ id: string; status: string }> }).snapshots;

    assert.deepEqual(
      [activeId, completedId, failedId, killedId].map((id) => snapshots.find((s) => s.id === id)?.status),
      ["running", "completed", "failed", "killed"],
    );
  });

  test("tool execute returns inputs stub for action='inputs'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "wf", inputs: {}, action: "inputs" });
    assert.equal(result.action, "inputs");
    const r = result as { action: "inputs"; name: string; inputs: unknown[] };
    assert.equal(r.name, "wf");
    assert.equal(Array.isArray(r.inputs), true);
  });

  test("tool execute accepts canonical workflow field for action='inputs'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "deep-research-codebase", action: "inputs" });
    assert.equal(result.action, "inputs");
    const r = result as { action: "inputs"; name: string; inputs: Array<{ name: string }> };
    assert.equal(r.name, "deep-research-codebase");
    assert.ok(r.inputs.some((input) => input.name === "prompt"));
  });

  test("tool execute returns read-only workflow details for action='get'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "deep-research-codebase", action: "get" });

    assert.equal(result.action, "get");
    const r = result as {
      action: "get";
      details?: {
        mode: string;
        action: string;
        status: string;
        output?: {
          workflow?: string;
          description?: string;
          inputs?: Array<{ name: string; required?: boolean }>;
        };
      };
      error?: string;
    };
    assert.equal(r.error, undefined);
    assert.equal(r.details?.mode, "inspection");
    assert.equal(r.details?.action, "get");
    assert.equal(r.details?.status, "completed");
    assert.equal(r.details?.output?.workflow, "deep-research-codebase");
    assert.equal(
      r.details?.output?.description,
      "Heavy research for tasks requiring comprehensive, whole-repository context.",
    );
    assert.ok(r.details?.output?.inputs?.some((input) => input.name === "prompt" && input.required === true));
  });

  test("tool execute rejects unknown actions", async () => {
    const execute = mock.tools[0]!.opts.execute;
    await assert.rejects(
      () => runTool(execute, { runId: "run-123", action: "archive" } as unknown as WorkflowToolArgs),
      /unknown action "archive"/,
    );
  });

  test("tool execute returns interrupt result for canonical action='interrupt'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { runId: "run-123", action: "interrupt" });
    assert.equal(result.action, "interrupt");
    const r = result as { action: "interrupt"; runId: string; status: string; message: string };
    assert.equal(r.runId, "run-123");
    assert.equal(r.status, "noop");
    assert.ok(r.message.includes("Run not found"));
  });

  test("tool execute returns quit result for canonical action='quit'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { runId: "run-123", action: "quit" });
    assert.equal(result.action, "quit");
    const r = result as { action: "quit"; runId: string; status: string; message: string };
    assert.equal(r.runId, "run-123");
    assert.equal(r.status, "noop");
    assert.ok(r.message.includes("Run not found"));
  });

  test("tool execute returns resume stub for action='resume'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { runId: "run-456", inputs: {}, action: "resume" });
    assert.equal(result.action, "resume");
  });

  test("tool has renderCall slot", () => {
    assert.equal(typeof mock.tools[0]!.opts.renderCall, "function");
  });

  test("tool has renderResult slot", () => {
    assert.equal(typeof mock.tools[0]!.opts.renderResult, "function");
  });

  test("tool renders its own shell", () => {
    assert.equal(mock.tools[0]!.opts.renderShell, "self");
  });

  test("tool renderCall slot delegates correctly", () => {
    const slot = mock.tools[0]!.opts.renderCall!;
    const out = slot({ workflow: "test-wf", inputs: {}, action: "run" }, {} as never, {} as never);
    assert.ok(out.includes("test-wf"));
  });

  test("tool renderResult slot delegates correctly", () => {
    const slot = mock.tools[0]!.opts.renderResult!;
    const details: WorkflowToolResult = {
      action: "run",
      runId: "abc",
      status: "pending",
      message: "not yet implemented",
    };
    const out = slot({ content: [{ type: "text", text: "" }], details }, {}, {} as never, {} as never);
    assert.ok(out.includes("abc"));
  });
});

// ---------------------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------------------

