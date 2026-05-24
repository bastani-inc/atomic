import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildPiArgs,
  FANOUT_CHILD_EXTENSION_PATH,
  PROMPT_RUNTIME_EXTENSION_PATH,
  SUBAGENT_FANOUT_CHILD_ENV,
  SUBAGENT_PARENT_DEPTH_ENV,
  SUBAGENT_PARENT_MAX_DEPTH,
} from "../../packages/subagents/src/runs/shared/pi-args.js";

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
});
