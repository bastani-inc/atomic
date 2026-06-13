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
        schema: {
          type: "object",
          required: ["approved"],
          properties: { approved: { type: "boolean" } },
          additionalProperties: false,
        },
        tools: ["read", "todo"],
        customTools: [],
        bashPolicy: {
          default: "deny",
          allow: ["pwd", { prefix: "browse " }, { glob: "bun test *" }, { regex: "^rg\\b" }],
          deny: [{ regex: "\\brm\\b" }],
          match: "segments",
        },
        noTools: "builtin",
        thinkingLevel: "high",
        context: "fork",
        forkFromSessionFile: "/tmp/session.jsonl",
      },
      tasks: [
        { name: "reviewer", task: "review", fallbackModels: ["openai/fallback"], schema: { type: "object", properties: { ok: { type: "boolean" } } } },
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
      bashPolicy: { default: "allow", deny: [{ prefix: "sudo " }] },
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
    assert.match(actionDescription, /path-only by default/);
    assert.match(actionDescription, /explicit tail\/limit returns bounded previews/);
    assert.match(actionDescription, /missing transcript paths fall back/);

    const limitDescription = properties.limit?.description ?? "";
    assert.match(limitDescription, /explicitly inline/);
    assert.match(limitDescription, /path-only default/);
    assert.match(limitDescription, /sessionFile\/transcriptPath/);
    assert.match(limitDescription, /platform path separators/);

    const tailDescription = properties.tail?.description ?? "";
    assert.match(tailDescription, /quick recent-context checks/);

    const includeToolOutputDescription = properties.includeToolOutput?.description ?? "";
    assert.match(includeToolOutputDescription, /inlined snapshot previews/);
    assert.match(includeToolOutputDescription, /does not bypass the path-only default/);
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

  test("validates schema options as top-level object tool-argument contracts", () => {
    assert.equal(Value.Check(WorkflowParametersSchema, {
      task: { name: "planner", prompt: "plan", schema: { type: "array", items: { type: "string" } } },
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      tasks: [{ name: "reviewer", task: "review", schema: { type: "string" } }],
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      chain: [
        { name: "first", task: "one", schema: { properties: { ok: { type: "boolean" } } } },
      ],
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      chain: [
        { parallel: [{ name: "second", task: "two", schema: { type: "object", properties: { ok: { type: "boolean" } } } }] },
      ],
    }), true);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      task: { name: "tuple-object", prompt: "plan", schema: { type: ["object"], properties: { ok: { type: "boolean" } } } },
    }), true);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      task: {
        name: "all-of-object",
        prompt: "plan",
        schema: {
          allOf: [
            { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
            { type: ["object"], properties: { note: { type: "string" } } },
          ],
        },
      },
    }), true);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      task: {
        name: "bad-all-of",
        prompt: "plan",
        schema: { allOf: [{ type: "object" }, { type: "array", items: { type: "string" } }] },
      },
    }), false);
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

  test("accepts and validates bashPolicy schema", () => {
    assert.equal(Value.Check(WorkflowParametersSchema, {
      task: {
        name: "safe-shell",
        prompt: "run safe command",
        tools: ["bash"],
        bashPolicy: {
          default: "deny",
          allow: ["pwd", { prefix: "echo " }, { glob: "bun test *" }, { regex: "^rg\\b", flags: "i" }],
          deny: [{ regex: "\\brm\\b" }],
          match: "segments",
        },
      },
    }), true);

    assert.equal(Value.Check(WorkflowParametersSchema, {
      task: { name: "bad-policy", prompt: "x", bashPolicy: { default: "block" } },
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      task: { name: "bad-rule", prompt: "x", bashPolicy: { allow: [{ prefix: "echo ", regex: "echo" }] } },
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      bashPolicy: { allow: "echo" },
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      bashPolicy: { deny: "rm" },
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      bashPolicy: { default: "deny", allow: ["echo ok"], extra: true },
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      bashPolicy: { allow: [{ regex: "echo", flags: 1 }] },
    }), false);
    assert.equal(Value.Check(WorkflowParametersSchema, {
      bashPolicy: { match: "raw" },
    }), false);
  });
});
