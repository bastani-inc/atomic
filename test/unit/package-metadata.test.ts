import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import packageJson from "../../package.json" with { type: "json" };

describe("package metadata", () => {
  test("ships workflow skill and prompt assets through npm and pi metadata", () => {
    assert.ok(packageJson.files.includes("skills/**/*"));
    assert.ok(packageJson.files.includes("prompts/**/*"));
    assert.deepEqual(packageJson.pi.skills, ["./skills"]);
    assert.deepEqual(packageJson.pi.prompts, ["./prompts"]);
    assert.deepEqual(packageJson.pi.workflows, ["./workflows"]);
  });
});
