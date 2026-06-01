import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";

describe("WorkflowParametersSchema stage options", () => {
  test("accepts createAgentSession options on direct tasks and top-level defaults", () => {
    const payload = {
      task: {
        name: "planner",
        prompt: "plan",
        cwd: "/repo",
        agentDir: "/agent",
        model: "anthropic/primary",
        fallbackModels: ["openai/fallback"],
        tools: ["read", "todo"],
        customTools: [],
        noTools: "builtin",
        thinkingLevel: "high",
        context: "fork",
        forkFromSessionFile: "/tmp/session.jsonl",
      },
      tasks: [
        { name: "reviewer", task: "review", fallbackModels: ["openai/fallback"] },
      ],
      chain: [
        { name: "first", task: "one", fallbackModels: ["openai/fallback"] },
        {
          parallel: [
            { name: "second", task: "two", fallbackModels: ["openai/fallback"] },
          ],
        },
      ],
      concurrency: 2,
      failFast: false,
      output: "reports/out.md",
      outputMode: "inline",
      reads: ["notes.md"],
      worktree: false,
      maxOutput: { lines: 100 },
      artifacts: true,
      chainDir: ".atomic/workflows/run",
      fallbackModels: ["github-copilot/fallback"],
      tools: ["read", "bash"],
      customTools: [],
      noTools: "all",
      thinkingLevel: "medium",
    };

    assert.equal(Value.Check(WorkflowParametersSchema, payload), true);
  });

  test("accepts stage introspection and control actions", () => {
    for (const statusFilter of ["pending", "running", "awaiting_input", "paused", "blocked", "completed", "failed", "skipped", "all"] as const) {
      assert.equal(Value.Check(WorkflowParametersSchema, {
        action: "stages",
        runId: "abc123",
        statusFilter,
      }), true);
    }
    assert.equal(Value.Check(WorkflowParametersSchema, {
      action: "transcript",
      runId: "abc123",
      stageId: "review",
      format: "text",
      tail: 20,
      includeToolOutput: true,
    }), true);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      action: "send",
      runId: "abc123",
      stageId: "review",
      text: "continue",
      delivery: "followUp",
      promptId: "prompt-1",
    }), true);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      action: "pause",
      runId: "abc123",
      stageId: "review",
    }), true);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      action: "reload",
      reason: "created a workflow file",
    }), true);
  });

  test("exposes descriptions for agent-facing action fields", () => {
    const properties = (WorkflowParametersSchema as unknown as {
      properties: Record<string, { description?: string }>;
    }).properties;

    for (const field of [
      "statusFilter",
      "format",
      "limit",
      "tail",
      "includeToolOutput",
      "text",
      "response",
      "delivery",
      "promptId",
      "reason",
    ]) {
      assert.equal(typeof properties[field]?.description, "string", `${field} description`);
      assert.ok((properties[field]?.description ?? "").length > 0, `${field} description`);
    }

    const actionDescription = properties.action?.description ?? "";
    assert.match(actionDescription, /status\/stages\/stage first/);
    assert.match(actionDescription, /sessionFile\/transcriptPath/);
    assert.match(actionDescription, /Windows backslashes/);
    assert.match(actionDescription, /rg\/grep/);

    const limitDescription = properties.limit?.description ?? "";
    assert.match(limitDescription, /metadata\/path only/);
    assert.match(limitDescription, /sessionFile\/transcriptPath/);
    assert.match(limitDescription, /platform path separators/);

    const tailDescription = properties.tail?.description ?? "";
    assert.match(tailDescription, /quick recent-context checks/);
  });

  test("rejects invalid stage-control enum values and transcript counts", () => {
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "stages", statusFilter: "cancelled" }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "transcript", format: "markdown" }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "transcript", limit: -1 }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "transcript", limit: 1.5 }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "transcript", tail: -1 }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "transcript", tail: 1.5 }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, { action: "send", delivery: "chat" }), false);
  });

  test("rejects non-array and non-string fallbackModels", () => {
    assert.equal(Value.Check(WorkflowParametersSchema, {
      task: { name: "planner", prompt: "plan", fallbackModels: "openai/fallback" },
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      tasks: [{ name: "planner", task: "plan", fallbackModels: [42] }],
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      task: { name: "planner", prompt: "plan" },
      fallbackModels: [false],
    }), false);
  });
});
