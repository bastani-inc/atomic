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


function assertNoScaffolding(base: string): void {
  for (const path of ["LICENSE", "UPSTREAM.md", "UPSTREAM_FILES.json"]) {
    assert.equal(existsSync(join(base, path)), false, `unexpected Atomic scaffolding: ${path}`);
  }
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

describe("synced upstream skill trees", () => {
  test("discovers the renamed subagent skills and removes the old name", () => {
    clearSkillCache();
    const result = resolveSkills(["playwright-cli", "liteparse", "effective-liteparse"], root);
    assert.deepEqual(result.resolved.map((skill) => skill.name).sort(), ["liteparse", "playwright-cli"]);
    assert.deepEqual(result.missing, ["effective-liteparse"]);
    assert.match(readFileSync(join(subagentSkills, "liteparse/SKILL.md"), "utf8"), /^---\r?\nname: liteparse\r?$/m);
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

  test("bundles meaningful upstream skill content without Atomic scaffolding", () => {
    assertFiles(join(subagentSkills, "playwright-cli"), [
      "SKILL.md", "references/element-attributes.md", "references/playwright-tests.md",
      "references/request-mocking.md", "references/running-code.md", "references/session-management.md",
      "references/storage-state.md", "references/test-generation.md", "references/tracing.md", "references/video-recording.md",
    ]);
    assertFiles(join(subagentSkills, "liteparse"), ["SKILL.md", "scripts/search.py"]);
    assertFiles(join(workflowSkills, "impeccable"), [
      "SKILL.md", "agents/openai.yaml", "reference/live.md", "reference/hooks.md",
      "scripts/command-metadata.json", "scripts/lib/provider.mjs", "scripts/detector/cli/main.mjs",
      "scripts/live/browser-script-parts.mjs", "scripts/modern-screenshot.umd.js",
    ]);
    assertNoScaffolding(join(subagentSkills, "playwright-cli"));
    assertNoScaffolding(join(subagentSkills, "liteparse"));
    assertNoScaffolding(join(workflowSkills, "impeccable"));
    assertPacked(join(root, "packages/subagents"), [
      "skills/playwright-cli/references/test-generation.md", "skills/liteparse/scripts/search.py",
    ]);
    assertPacked(join(root, "packages/workflows"), [
      "skills/impeccable/scripts/live/svelte-component.mjs", "skills/impeccable/scripts/lib/provider.mjs",
    ]);
  });

  test("contains no accidental symlinks", () => {
    assertRegularTree(join(subagentSkills, "playwright-cli"));
    assertRegularTree(join(subagentSkills, "liteparse"));
    assertRegularTree(join(workflowSkills, "impeccable"));
  });

  test("keeps synced HTML filtering robust against nested sanitization and permissive closing tags", async () => {
    const svelteModulePath = join(workflowSkills, "impeccable/scripts/live/svelte-component.mjs");
    const svelteModule = await import(svelteModulePath) as {
      parseSvelteComponentFile(content: string): { markup: string };
      svelteMarkupHasVisibleContent(markup: string): boolean;
    };
    assert.equal(
      svelteModule.svelteMarkupHasVisibleContent("<scri<script>x</script>pt>hidden</script>"),
      false,
    );
    assert.equal(svelteModule.svelteMarkupHasVisibleContent("<!<!--- hidden --->>"), false);
    assert.equal(
      svelteModule.parseSvelteComponentFile("<script>const x = 1;</script \t\n data-x>\n<main>visible</main>").markup,
      "<main>visible</main>",
    );

    const pageModulePath = join(workflowSkills, "impeccable/scripts/detector/shared/page.mjs");
    const pageModule = await import(pageModulePath) as { isFullPage(content: string): boolean };
    assert.equal(pageModule.isFullPage("<!<!--- hidden --->><section>partial</section>"), false);
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
