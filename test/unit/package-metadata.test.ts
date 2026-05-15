import { describe, test } from "bun:test";
import { readdirSync } from "node:fs";
import assert from "node:assert/strict";
import atomicPackageJson from "../../packages/coding-agent/package.json" with { type: "json" };
import workflowsPackageJson from "../../packages/workflows/package.json" with { type: "json" };

function markdownFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

describe("package metadata", () => {
  test("all workspace packages share the same release version", () => {
    assert.equal(atomicPackageJson.version, "0.8.0");
    assert.equal(workflowsPackageJson.version, atomicPackageJson.version);
  });

  test("only @bastani/atomic is publishable", () => {
    assert.equal(atomicPackageJson.name, "@bastani/atomic");
    assert.equal(Object.prototype.hasOwnProperty.call(atomicPackageJson, "private"), false);
    assert.equal(workflowsPackageJson.name, "@bastani/workflows");
    assert.equal(workflowsPackageJson.private, true);
  });

  test("ships workflow, skill, and bundled agent assets through package metadata", () => {
    assert.ok(workflowsPackageJson.files.includes("builtin/**/*.ts"));
    assert.ok(workflowsPackageJson.files.includes("skills/**/*"));
    assert.deepEqual(workflowsPackageJson.pi.skills, ["./skills"]);
    assert.deepEqual(workflowsPackageJson.pi.builtin, ["./builtin"]);
  });

  test("subagents package ships bundled agent markdown files", () => {
    const bundledAgents = markdownFiles("packages/subagents/agents");
    assert.ok(bundledAgents.length > 0, "expected at least one bundled agent markdown file");
  });
});
