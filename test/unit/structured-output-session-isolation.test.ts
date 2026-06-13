import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createStructuredOutputTool } from "../../packages/coding-agent/src/core/tools/index.js";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";

const gateSchema = Type.Object({
  approved: Type.Boolean(),
  findings: Type.Array(Type.String()),
}, { additionalProperties: false });

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

async function createIsolatedSession(options: {
  tools?: string[];
  excludedTools?: string[];
  customTools?: ToolDefinition[];
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "atomic-structured-output-session-"));
  tempDirs.push(tempDir);
  const agentDir = join(tempDir, "agent");
  mkdirSync(agentDir, { recursive: true });

  const settingsManager = SettingsManager.create(tempDir, agentDir);
  const sessionManager = SessionManager.inMemory(tempDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: tempDir,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: tempDir,
    agentDir,
    model: getModel("anthropic", "claude-sonnet-4-5")!,
    settingsManager,
    sessionManager,
    resourceLoader,
    tools: options.tools,
    excludedTools: options.excludedTools,
    customTools: options.customTools,
  });
  return session;
}

describe("structured_output custom-name isolation in AgentSession", () => {
  test("custom-named structured output does not register the standard tool", async () => {
    const finalDecision = createStructuredOutputTool({ name: "final_decision", schema: gateSchema });
    const session = await createIsolatedSession({ customTools: [finalDecision] });
    try {
      const activeNames = session.getActiveToolNames();
      const allNames = session.getAllTools().map((tool) => tool.name);

      assert.equal(activeNames.includes("structured_output"), false);
      assert.ok(activeNames.includes("final_decision"));
      assert.equal(allNames.includes("structured_output"), false);
      assert.ok(allNames.includes("final_decision"));
      assert.equal(session.getToolDefinition("final_decision")?.parameters, gateSchema);
      assert.equal(session.getToolDefinition("structured_output"), undefined);
    } finally {
      session.dispose();
    }
  });

  test("tools allowlist isolates a custom-named structured output contract", async () => {
    const finalDecision = createStructuredOutputTool({ name: "final_decision", schema: gateSchema });
    const session = await createIsolatedSession({
      customTools: [finalDecision],
      tools: ["final_decision"],
    });
    try {
      assert.deepEqual(session.getActiveToolNames(), ["final_decision"]);
      assert.deepEqual(session.getAllTools().map((tool) => tool.name), ["final_decision"]);
      assert.equal(session.getToolDefinition("final_decision")?.parameters, gateSchema);
      assert.equal(session.getToolDefinition("structured_output"), undefined);
    } finally {
      session.dispose();
    }
  });

  test("excludedTools can remove an opt-in standard structured_output tool", async () => {
    const strictStructuredOutput = createStructuredOutputTool({ schema: gateSchema });
    const session = await createIsolatedSession({
      customTools: [strictStructuredOutput],
      excludedTools: ["structured_output"],
    });
    try {
      const activeNames = session.getActiveToolNames();
      const allNames = session.getAllTools().map((tool) => tool.name);

      assert.equal(activeNames.includes("structured_output"), false);
      assert.equal(allNames.includes("structured_output"), false);
      assert.equal(session.getToolDefinition("structured_output"), undefined);
    } finally {
      session.dispose();
    }
  });

  test("standard-name structured_output custom tool registers a schema-specific tool", async () => {
    const strictStructuredOutput = createStructuredOutputTool({ schema: gateSchema });
    const session = await createIsolatedSession({ customTools: [strictStructuredOutput] });
    try {
      const activeStructuredOutputNames = session
        .getActiveToolNames()
        .filter((name) => name === "structured_output");

      assert.deepEqual(activeStructuredOutputNames, ["structured_output"]);
      assert.equal(session.getToolDefinition("structured_output")?.parameters, gateSchema);
      assert.equal(session.getAllTools().filter((tool) => tool.name === "structured_output").length, 1);
    } finally {
      session.dispose();
    }
  });
});
