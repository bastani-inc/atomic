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
      fallbackModels: ["github-copilot/fallback"],
      tools: ["read", "bash"],
      customTools: [],
      noTools: "all",
      thinkingLevel: "medium",
    };

    assert.equal(Value.Check(WorkflowParametersSchema, payload), true);
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
