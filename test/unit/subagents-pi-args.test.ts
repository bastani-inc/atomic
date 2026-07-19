import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { ENV_CODEX_FAST_MODE } from "../../packages/coding-agent/src/config.js";
import { WORKFLOW_SESSION_METADATA_ENV } from "../../packages/coding-agent/src/core/session-manager-classification.js";
import {
  buildPiArgs,
  FANOUT_CHILD_EXTENSION_PATH,
  INTERCOM_GROUP_ENV,
  PROMPT_RUNTIME_EXTENSION_PATH,
  SUBAGENT_FANOUT_CHILD_ENV,
  SUBAGENT_PARENT_DEPTH_ENV,
  SUBAGENT_PARENT_MAX_DEPTH,
} from "../../packages/subagents/src/runs/shared/pi-args.js";
import {
  inheritedIntercomGroup,
  resolveChildIntercomGroup,
  sharedAutoGroupForSet,
} from "../../packages/subagents/src/runs/shared/intercom-group.js";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "../../packages/subagents/src/runs/shared/structured-output.js";

function structuredOutputRuntime() {
  return {
    schema: { type: "object" },
    schemaPath: "/tmp/schema.json",
    outputPath: "/tmp/output.json",
  };
}

describe("subagent child CLI args", () => {
  test("adds fanout child extension only when the subagent tool is explicitly authorized", () => {
    const plain = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      tools: ["read"],
    });
    const fanout = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      tools: ["read", "subagent"],
    });

    assert.equal(plain.env[SUBAGENT_FANOUT_CHILD_ENV], "0");
    assert.equal(fanout.env[SUBAGENT_FANOUT_CHILD_ENV], "1");
    assert.equal(plain.args.includes(PROMPT_RUNTIME_EXTENSION_PATH), true);
    assert.equal(plain.args.includes(FANOUT_CHILD_EXTENSION_PATH), false);
    assert.equal(fanout.args.includes(FANOUT_CHILD_EXTENSION_PATH), true);
  });

  test("clamps inherited nested parent depth when fanout is authorized", () => {
    const result = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      tools: ["subagent"],
      parentDepth: SUBAGENT_PARENT_MAX_DEPTH + 10,
    });

    assert.equal(result.env[SUBAGENT_PARENT_DEPTH_ENV], String(SUBAGENT_PARENT_MAX_DEPTH));
  });

  test("clears nested route env when fanout is not authorized", () => {
    const result = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      tools: ["read"],
      parentDepth: 2,
    });

    assert.equal(result.env[SUBAGENT_PARENT_DEPTH_ENV], "");
  });

  test("uses the MCP adapter direct-tool sentinel contract", () => {
    const disabled = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
    });
    const selected = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      mcpDirectTools: ["github/search_code"],
    });

    assert.equal(disabled.env.MCP_DIRECT_TOOLS, "__none__");
    assert.equal(selected.env.MCP_DIRECT_TOOLS, "github/search_code");
  });

  test("auto-allows structured_output for explicit child tool allowlists with outputSchema", () => {
    const result = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      tools: ["read"],
      structuredOutput: structuredOutputRuntime(),
    });

    const toolsIndex = result.args.indexOf("--tools");
    assert.notEqual(toolsIndex, -1);
    assert.equal(result.args[toolsIndex + 1], "read,structured_output");
    assert.equal(result.env[STRUCTURED_OUTPUT_SCHEMA_ENV], "/tmp/schema.json");
    assert.equal(result.env[STRUCTURED_OUTPUT_CAPTURE_ENV], "/tmp/output.json");
  });

  test("keeps explicit empty tool allowlists restrictive while auto-allowing structured_output for outputSchema", () => {
    const result = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      tools: [],
      structuredOutput: structuredOutputRuntime(),
    });

    const toolsIndex = result.args.indexOf("--tools");
    assert.notEqual(toolsIndex, -1);
    assert.equal(result.args[toolsIndex + 1], "structured_output");
    assert.deepEqual(result.args[toolsIndex + 1]?.split(","), ["structured_output"]);
    assert.equal(result.env[STRUCTURED_OUTPUT_SCHEMA_ENV], "/tmp/schema.json");
    assert.equal(result.env[STRUCTURED_OUTPUT_CAPTURE_ENV], "/tmp/output.json");
  });

  test("does not duplicate structured_output when an explicit allowlist already includes it", () => {
    const result = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      tools: ["read", "structured_output"],
      structuredOutput: structuredOutputRuntime(),
    });

    const toolsIndex = result.args.indexOf("--tools");
    assert.notEqual(toolsIndex, -1);
    assert.equal(result.args[toolsIndex + 1], "read,structured_output");
  });

  test("does not convert path-only tool extensions into an explicit allowlist for outputSchema", () => {
    const toolPath = "/tmp/custom-tool.ts";
    const result = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      tools: [toolPath],
      structuredOutput: structuredOutputRuntime(),
    });

    assert.equal(result.args.includes("--tools"), false);
    assert.equal(result.args.includes(toolPath), true);
  });

  test("loads the prompt runtime before user extensions when structured_output is allowlisted", () => {
    const toolPath = "/tmp/custom-tool.ts";
    const userExtensionPath = "/tmp/user-extension.ts";
    const result = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      tools: ["read", toolPath],
      extensions: [userExtensionPath],
      structuredOutput: structuredOutputRuntime(),
    });

    const toolsIndex = result.args.indexOf("--tools");
    assert.notEqual(toolsIndex, -1);
    assert.equal(result.args[toolsIndex + 1], "read,structured_output");

    const extensionPaths = result.args
      .map((arg, index) => (arg === "--extension" ? result.args[index + 1] : undefined))
      .filter((arg): arg is string => typeof arg === "string");
    assert.deepEqual(extensionPaths, [PROMPT_RUNTIME_EXTENSION_PATH, toolPath, userExtensionPath]);
  });

  test("maps scoped fast-mode settings onto child chat env", () => {
    const chatScoped = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      codexFastModeSettings: { chat: true, workflow: false },
      codexFastModeScope: "chat",
    });
    const workflowScoped = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      codexFastModeSettings: { chat: false, workflow: true },
      codexFastModeScope: "workflow",
    });
    const workflowDisabled = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      codexFastModeSettings: { chat: true, workflow: false },
      codexFastModeScope: "workflow",
    });

    assert.equal(chatScoped.env[ENV_CODEX_FAST_MODE], "chat=1;workflow=0");
    assert.equal(workflowScoped.env[ENV_CODEX_FAST_MODE], "chat=1;workflow=1");
    assert.equal(workflowDisabled.env[ENV_CODEX_FAST_MODE], "chat=0;workflow=0");
  });

  test("passes workflow ownership metadata to fresh child sessions", () => {
    const workflow = { runId: "run-1", stageId: "stage-1", stageName: "build" };
    const result = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: true,
      sessionFile: "/tmp/fresh-subagent.jsonl",
      inheritProjectContext: true,
      inheritSkills: true,
      workflowSessionMetadata: workflow,
    });

    assert.equal(result.env[WORKFLOW_SESSION_METADATA_ENV], JSON.stringify(workflow));
  });

  test("writes the intercom group env only when the child has intercom access", () => {
    const withPeer = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      intercomGroup: "reviewers",
      intercomSessionName: "child-1",
    });
    const withSupervisor = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      intercomGroup: "reviewers",
      orchestratorIntercomTarget: "parent",
    });
    const withoutAccess = buildPiArgs({
      baseArgs: [],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      intercomGroup: "reviewers",
    });

    assert.equal(withPeer.env[INTERCOM_GROUP_ENV], "reviewers");
    assert.equal(withSupervisor.env[INTERCOM_GROUP_ENV], "reviewers");
    assert.equal(withoutAccess.env[INTERCOM_GROUP_ENV], undefined);
  });

  test("resolveChildIntercomGroup: explicit > inherited; auto sentinels use the shared group", () => {
    assert.equal(resolveChildIntercomGroup("teamX", "stage", undefined), "teamX");
    assert.equal(resolveChildIntercomGroup(undefined, "stage", undefined), "stage");
    assert.equal(resolveChildIntercomGroup(undefined, undefined, undefined), undefined);
    assert.equal(resolveChildIntercomGroup(true, "stage", "shared-uuid"), "shared-uuid");
    assert.equal(resolveChildIntercomGroup(" TrUe ", "stage", "shared-uuid"), "shared-uuid");
    assert.equal(resolveChildIntercomGroup(" AuTo ", "stage", "shared-uuid"), "shared-uuid");
  });

  test("sharedAutoGroupForSet mints one uuid when a boolean or string sentinel opts in", () => {
    assert.equal(sharedAutoGroupForSet(undefined, [{ group: "a" }, {}]), undefined);
    const set = sharedAutoGroupForSet(true, [{}, {}]);
    assert.match(set ?? "", /^[0-9a-f-]{36}$/);
    const stringSet = sharedAutoGroupForSet(" AUTO ", [{}, {}]);
    assert.match(stringSet ?? "", /^[0-9a-f-]{36}$/);
    const perItem = sharedAutoGroupForSet(undefined, [{ group: " true " }, {}]);
    assert.match(perItem ?? "", /^[0-9a-f-]{36}$/);
  });

  test("inheritedIntercomGroup reads the stage group from orchestrationContext only", () => {
    assert.equal(inheritedIntercomGroup({ orchestrationContext: { intercomGroup: "stage-g" } }), "stage-g");
    assert.equal(inheritedIntercomGroup({ orchestrationContext: {} }), undefined);
    assert.equal(inheritedIntercomGroup(undefined), undefined);
  });
});
