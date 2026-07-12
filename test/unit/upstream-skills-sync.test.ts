/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { clearSkillCache, resolveSkills } from "../../packages/subagents/src/agents/skills.js";

const root = resolve(import.meta.dir, "../..");
const subagentSkills = join(root, "packages/subagents/skills");
const workflowSkills = join(root, "packages/workflows/skills");

function assertRegularTree(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    assert.equal(lstatSync(child).isSymbolicLink(), false, `unexpected symlink: ${child}`);
    if (entry.isDirectory()) assertRegularTree(child);
  }
}

function treeFiles(base: string, current = base): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const child = join(current, entry.name);
    return entry.isDirectory() ? treeFiles(base, child) : [child.slice(base.length + 1).replaceAll("\\", "/")];
  });
}

function upstreamFiles(base: string): string[] {
  return JSON.parse(readFileSync(join(base, "UPSTREAM_FILES.json"), "utf8")) as string[];
}

function assertCompleteTree(base: string): void {
  const additions = new Set(["LICENSE", "UPSTREAM.md", "UPSTREAM_FILES.json"]);
  assert.deepEqual(treeFiles(base).filter((path) => !additions.has(path)).sort(), upstreamFiles(base).sort());
}

function assertPacked(packageDir: string, skillPaths: readonly string[]): void {
  const result = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], { cwd: packageDir });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const output = result.stdout.toString();
  for (const path of skillPaths) assert.ok(output.includes(` ${path}\n`), `packed archive omitted ${path}`);
}

function assertFiles(base: string, paths: readonly string[]): void {
  for (const path of paths) assert.ok(existsSync(join(base, path)), `missing bundled resource: ${path}`);
}

describe("pinned upstream skill trees", () => {
  test("discovers the renamed subagent skills and removes the old name", () => {
    clearSkillCache();
    const result = resolveSkills(["playwright-cli", "liteparse", "effective-liteparse"], root);
    assert.deepEqual(result.resolved.map((skill) => skill.name).sort(), ["liteparse", "playwright-cli"]);
    assert.deepEqual(result.missing, ["effective-liteparse"]);
    assert.match(readFileSync(join(subagentSkills, "liteparse/SKILL.md"), "utf8"), /^---\nname: liteparse\n/m);
    assert.equal(existsSync(join(subagentSkills, "effective-liteparse")), false);
  });

  test("discovers Impeccable through the coding-agent package loader", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "atomic-impeccable-discovery-"));
    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        builtinPackagePaths: [join(root, "packages/workflows")],
      });
      await loader.reload();
      assert.ok(loader.getSkills().skills.some((skill) => skill.name === "impeccable"));
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test("bundles complete upstream inventories, provenance, licenses, and supporting resources", () => {
    assertFiles(join(subagentSkills, "playwright-cli"), [
      "LICENSE", "UPSTREAM.md", "references/element-attributes.md", "references/playwright-tests.md",
      "references/request-mocking.md", "references/running-code.md", "references/session-management.md",
      "references/storage-state.md", "references/test-generation.md", "references/tracing.md", "references/video-recording.md",
    ]);
    assertFiles(join(subagentSkills, "liteparse"), ["LICENSE", "UPSTREAM.md", "scripts/search.py"]);
    assertFiles(join(workflowSkills, "impeccable"), [
      "LICENSE", "UPSTREAM.md", "agents/openai.yaml", "reference/live.md", "reference/hooks.md",
      "scripts/command-metadata.json", "scripts/lib/provider.mjs", "scripts/detector/cli/main.mjs",
      "scripts/live/browser-script-parts.mjs", "scripts/modern-screenshot.umd.js",
    ]);
    assert.match(readFileSync(join(subagentSkills, "playwright-cli/UPSTREAM.md"), "utf8"), /793cfb32572733cbcb401e6f28d05a7a914ce408/);
    assert.match(readFileSync(join(subagentSkills, "liteparse/UPSTREAM.md"), "utf8"), /2dcef7c62417bd2ec4671fce4621bb1e8cce48d0/);
    assert.match(readFileSync(join(workflowSkills, "impeccable/UPSTREAM.md"), "utf8"), /630fc2682a5bd39b25a8e61f74b6b3f14f2b1e21/);
    assertCompleteTree(join(subagentSkills, "playwright-cli"));
    assertCompleteTree(join(subagentSkills, "liteparse"));
    assertCompleteTree(join(workflowSkills, "impeccable"));
    assertPacked(join(root, "packages/subagents"), [
      "skills/playwright-cli/UPSTREAM_FILES.json", "skills/liteparse/scripts/search.py",
    ]);
    assertPacked(join(root, "packages/workflows"), [
      "skills/impeccable/UPSTREAM_FILES.json", "skills/impeccable/scripts/lib/provider.mjs",
    ]);
  });

  test("contains no accidental symlinks", () => {
    assertRegularTree(join(subagentSkills, "playwright-cli"));
    assertRegularTree(join(subagentSkills, "liteparse"));
    assertRegularTree(join(workflowSkills, "impeccable"));
  });

  test("does not execute shell substitutions from Impeccable project paths", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atomic-impeccable-generated-"));
    const marker = join(cwd, "command-injection-marker");
    const crafted = join(cwd, `page-$(touch command-injection-marker).html`);
    try {
      assert.equal(Bun.spawnSync(["git", "init", "--quiet"], { cwd }).exitCode, 0);
      writeFileSync(crafted, "<main>source</main>\n");
      const modulePath = join(workflowSkills, "impeccable/scripts/lib/is-generated.mjs");
      const module = await import(modulePath) as { isGeneratedFile(path: string, options: { cwd: string }): boolean };
      assert.equal(module.isGeneratedFile(crafted, { cwd }), false);
      assert.equal(existsSync(marker), false, "project-controlled filename executed shell syntax");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
