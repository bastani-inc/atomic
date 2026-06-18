import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  shouldSuppressIntermediateRetryableFailureUpdate,
  shouldSuppressIntermediateStructuredOutputFailureUpdate,
} from "../../packages/subagents/src/runs/foreground/execution.js";
import type { AgentProgress, Details, SingleResult, Usage } from "../../packages/subagents/src/shared/types.js";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

function progress(status: AgentProgress["status"], error?: string): AgentProgress {
  return {
    index: 0,
    agent: "debugger",
    status,
    task: "inspect",
    recentTools: [],
    recentOutput: [],
    toolCount: 0,
    tokens: 0,
    durationMs: 1,
    error,
  };
}

function result(status: AgentProgress["status"], error?: string): SingleResult {
  const currentProgress = progress(status, error);
  return {
    agent: "debugger",
    task: "inspect",
    exitCode: status === "failed" ? 1 : 0,
    messages: [],
    usage,
    error,
    progress: currentProgress,
    finalOutput: error ?? "ok",
  };
}

function update(input: {
  status: AgentProgress["status"];
  error?: string;
  contentText?: string;
}): AgentToolResult<Details> {
  return {
    content: [{ type: "text", text: input.contentText ?? input.error ?? "ok" }],
    details: {
      mode: "single",
      results: [result(input.status, input.error)],
      progress: [progress(input.status, input.error)],
    },
  };
}

describe("foreground subagent model fallback update suppression", () => {
  test("suppresses terminal retryable API-key failures from intermediate attempts", () => {
    assert.equal(
      shouldSuppressIntermediateRetryableFailureUpdate(
        update({ status: "failed", error: "API key missing for openai/gpt-5" }),
      ),
      true,
    );
  });

  test("does not suppress running retryable output before an attempt is terminal", () => {
    assert.equal(
      shouldSuppressIntermediateRetryableFailureUpdate(
        update({ status: "running", error: "API key missing for openai/gpt-5" }),
      ),
      false,
    );
  });

  test("does not suppress non-retryable terminal failures", () => {
    assert.equal(
      shouldSuppressIntermediateRetryableFailureUpdate(
        update({ status: "failed", error: "command failed: bun test" }),
      ),
      false,
    );
  });

  test("suppresses intermediate structured_output contract failures", () => {
    assert.equal(
      shouldSuppressIntermediateStructuredOutputFailureUpdate(
        update({ status: "failed", error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output." }),
      ),
      true,
    );
    assert.equal(
      shouldSuppressIntermediateStructuredOutputFailureUpdate(
        update({ status: "failed", error: "Structured output validation failed: answer: Expected string" }),
      ),
      true,
    );
    assert.equal(
      shouldSuppressIntermediateStructuredOutputFailureUpdate(
        update({ status: "running", error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output." }),
      ),
      false,
    );
  });

  test("detects retryable failures from terminal update text when error is absent", () => {
    assert.equal(
      shouldSuppressIntermediateRetryableFailureUpdate(
        update({ status: "failed", contentText: "No API key found" }),
      ),
      true,
    );
  });
});
