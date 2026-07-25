import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isBrandedWorkflowDefinition } from "../../packages/workflows/src/authoring/workflow.js";

const expectedBuiltinNames = [
  "adversarial-verification",
  "classify-and-act",
  "fan-out-and-synthesize",
  "generate-and-filter",
  "loop-until-done",
  "open-claude-design",
  "tournament",
] as const;

const expectedExports = [
  "adversarialVerification",
  "classifyAndAct",
  "fanOutAndSynthesize",
  "generateAndFilter",
  "loopUntilDone",
  "openClaudeDesign",
  "tournament",
] as const;

describe("builtin workflow manifest", () => {
  test("exports exactly the supported builtin workflows", async () => {
    const mod = await import("../../packages/workflows/builtin/index.js");
    assert.deepEqual(Object.keys(mod).sort(), [...expectedExports].sort());

    const definitions = expectedExports.map((name) => mod[name]);
    assert.deepEqual(
      definitions.map((definition) => definition.normalizedName).sort(),
      [...expectedBuiltinNames].sort(),
    );
    for (const definition of definitions) {
      assert.equal(isBrandedWorkflowDefinition(definition), true, definition.normalizedName);
    }
  });

  test("contains no files for retired builtin workflows", () => {
    const builtinRoot = join(import.meta.dir, "../../packages/workflows/builtin");
    const retiredStems = [
      ["deep", "research", "codebase"].join("-"),
      ["go", "al"].join(""),
      ["ral", "ph"].join(""),
    ];
    const suffixes = [".ts", ".d.ts", "-runner.ts", "-utils.ts", "-models.ts"];

    for (const stem of retiredStems) {
      for (const suffix of suffixes) {
        assert.equal(existsSync(join(builtinRoot, `${stem}${suffix}`)), false, `${stem}${suffix}`);
      }
    }
  });
});
