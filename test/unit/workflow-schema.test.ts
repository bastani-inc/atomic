import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";

describe("WorkflowParametersSchema", () => {
  test("accepts named workflow execution, discovery, inspection, messaging, control, and reload", () => {
    const calls = [
      { action: "run", workflow: "goal", inputs: { objective: "ship it" } },
      { action: "list" },
      { action: "get", workflow: "goal" },
      { action: "inputs", workflow: "goal" },
      { action: "status", runId: "abc123" },
      { action: "stages", runId: "abc123", statusFilter: "running" },
      { action: "stage", runId: "abc123", stageId: "review" },
      { action: "transcript", runId: "abc123", stageId: "review", tail: 20 },
      { action: "send", runId: "abc123", stageId: "review", text: "continue" },
      { action: "pause", runId: "abc123" },
      { action: "resume", runId: "abc123" },
      { action: "interrupt", runId: "abc123" },
      { action: "quit", runId: "abc123" },
      { action: "reload", reason: "new workflow" },
    ];
    for (const call of calls) assert.equal(Value.Check(WorkflowParametersSchema, call), true, JSON.stringify(call));
  });

  test("rejects every removed one-off execution argument", () => {
    const removed = {
      task: { name: "worker", prompt: "work" },
      tasks: [{ name: "worker", prompt: "work" }],
      chain: [{ name: "worker", prompt: "work" }],
      chainName: "one-off",
      chainDir: ".atomic/workflows/run",
      concurrency: 2,
      failFast: false,
      async: true,
      intercom: { enabled: true },
      context: "fresh",
      forkFromSessionFile: "/tmp/session.jsonl",
      output: "result.md",
      outputMode: "file-only",
      reads: ["input.md"],
      maxOutput: { lines: 20 },
      artifacts: true,
      worktree: true,
      gitWorktreeDir: "/tmp/worktree",
      baseBranch: "main",
      model: "openai/gpt-5",
      fallbackModels: ["anthropic/claude-sonnet"],
      tools: ["read"],
      group: true,
    } as const;
    for (const [field, value] of Object.entries(removed)) {
      assert.equal(
        Value.Check(WorkflowParametersSchema, { action: "run", workflow: "goal", [field]: value }),
        false,
        `expected removed field ${field} to be rejected`,
      );
    }
  });

  test("rejects invalid action values and transcript counts", () => {
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "kill", runId: "abc123" }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "transcript", limit: -1 }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "transcript", tail: 1.5 }), false);
  });

  test("keeps agent-facing action field descriptions", () => {
    const properties = (WorkflowParametersSchema as { properties: Record<string, { description?: string }> }).properties;
    for (const field of ["action", "statusFilter", "format", "limit", "tail", "includeToolOutput", "text", "response", "delivery", "promptId", "reason"]) {
      assert.ok((properties[field]?.description ?? "").length > 0, `${field} description`);
    }
  });
});
