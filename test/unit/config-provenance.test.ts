/**
 * Focused regression tests for config provenance (RFC: config-provenance worker).
 *
 * Covers:
 *   1. loadWorkflowConfig — globalConfig/projectConfig provenance fields in ConfigLoadResult
 *   2. Global workflow path ./workflows/foo.ts resolves under <homeDir>/.atomic/agent
 *   3. Project workflow key overrides global key; scope changes to settings-project
 *   4. discoverWorkflows distinguishes settings-project vs settings-global source kinds
 */

import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  loadWorkflowConfig,
  toScopedDiscoveryConfig,
} from "../../packages/workflows/src/extension/config-loader.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

function tempDir(label: string): string {
  const dir = join(tmpdir(), `pi-provenance-${label}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Write a workflow extension config.json at the canonical path for scope.
 *
 * scope "global"  → <base>/.atomic/agent/extensions/workflow/config.json
 * scope "project" → <base>/.atomic/extensions/workflow/config.json
 */
function writeConfigFile(
  base: string,
  scope: "global" | "project",
  content: object,
): string {
  const paths: Record<string, string[]> = {
    global: [".atomic", "agent", "extensions", "workflow", "config.json"],
    project: [".atomic", "extensions", "workflow", "config.json"],
  };
  const segments = paths[scope];
  const dir = join(base, ...segments.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  const fp = join(base, ...segments);
  writeFileSync(fp, JSON.stringify(content), "utf-8");
  return fp;
}

/**
 * Write a minimal valid workflow .ts file that exports a default WorkflowDefinition.
 */
function writeWorkflowFile(dir: string, name: string, normalizedName: string): string {
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, `${normalizedName}.ts`);
  writeFileSync(
    fp,
    `import { workflow } from "@bastani/workflows";
const definition = workflow({ name: ${JSON.stringify(normalizedName)}, description: ${JSON.stringify(name)} + " test workflow", inputs: {}, outputs: {}, run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
});
if (definition.normalizedName !== ${JSON.stringify(normalizedName)}) throw new Error("unexpected normalized name");
export default definition;\n`,
    "utf-8",
  );
  return fp;
}

// ---------------------------------------------------------------------------
// 1. loadWorkflowConfig — provenance fields
// ---------------------------------------------------------------------------

describe("loadWorkflowConfig — provenance: globalConfig field", () => {
  test("global config file present → globalConfig populated, projectConfig null", async () => {
    const home = tempDir("lc-global-only");
    const proj = tempDir("lc-global-only-proj");

    writeConfigFile(home, "global", { maxDepth: 3 });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    assert.notEqual(result.globalConfig, null);
    assert.equal(result.globalConfig?.maxDepth, 3);
    assert.equal(result.projectConfig ?? null, null);
  });

  test("global config absent → globalConfig null", async () => {
    const home = tempDir("lc-no-global");
    const proj = tempDir("lc-no-global-proj");

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    assert.equal(result.globalConfig ?? null, null);
    assert.equal(result.projectConfig ?? null, null);
    assert.equal(result.config, null);
  });

  test("global config with workflows entry → globalConfig.workflows populated", async () => {
    const home = tempDir("lc-global-wf");
    const proj = tempDir("lc-global-wf-proj");

    writeConfigFile(home, "global", {
      workflows: { foo: { path: "../../packages/workflows/src/extension/workflows/foo.ts" } },
    });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    assert.deepEqual(result.globalConfig?.workflows, {
      foo: { path: "../../packages/workflows/src/extension/workflows/foo.ts" },
    });
    assert.equal(result.projectConfig ?? null, null);
  });
});

describe("loadWorkflowConfig — provenance: projectConfig field", () => {
  test("project config present → projectConfig populated, globalConfig null", async () => {
    const home = tempDir("lc-proj-only");
    const proj = tempDir("lc-proj-only-base");

    writeConfigFile(proj, "project", { defaultConcurrency: 8 });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    assert.notEqual(result.projectConfig, null);
    assert.equal(result.projectConfig?.defaultConcurrency, 8);
    assert.equal(result.globalConfig ?? null, null);
  });

  test("project config with workflows entry → projectConfig.workflows populated", async () => {
    const home = tempDir("lc-proj-wf");
    const proj = tempDir("lc-proj-wf-base");

    writeConfigFile(proj, "project", {
      workflows: { bar: { path: "../../packages/workflows/src/extension/workflows/bar.ts" } },
    });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    assert.deepEqual(result.projectConfig?.workflows, {
      bar: { path: "../../packages/workflows/src/extension/workflows/bar.ts" },
    });
  });
});

describe("loadWorkflowConfig — provenance: both configs", () => {
  test("both global + project → both provenance fields set", async () => {
    const home = tempDir("lc-both");
    const proj = tempDir("lc-both-proj");

    writeConfigFile(home, "global", { maxDepth: 2 });
    writeConfigFile(proj, "project", { maxDepth: 6 });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    assert.equal(result.globalConfig?.maxDepth, 2);
    assert.equal(result.projectConfig?.maxDepth, 6);
    // merged config: project overrides global
    assert.equal(result.config?.maxDepth, 6);
  });

  test("both with workflows — project key overrides global key in merged config", async () => {
    const home = tempDir("lc-both-wf");
    const proj = tempDir("lc-both-wf-proj");

    writeConfigFile(home, "global", {
      workflows: {
        shared: { path: "../../packages/workflows/src/extension/global-shared.ts" },
        "g-only": { path: "../../packages/workflows/src/extension/g-only.ts" },
      },
    });
    writeConfigFile(proj, "project", {
      workflows: {
        shared: { path: "../../packages/workflows/src/extension/project-shared.ts" },
      },
    });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    // Provenance: raw configs preserved as-is
    assert.equal(result.globalConfig?.workflows?.["shared"]?.path, "../../packages/workflows/src/extension/global-shared.ts");
    assert.equal(result.projectConfig?.workflows?.["shared"]?.path, "../../packages/workflows/src/extension/project-shared.ts");

    // Merged config: project entry wins
    assert.equal(result.config?.workflows?.["shared"]?.path, "../../packages/workflows/src/extension/project-shared.ts");
    // g-only from global still present in merged
    assert.equal(result.config?.workflows?.["g-only"]?.path, "../../packages/workflows/src/extension/g-only.ts");
  });
});

// ---------------------------------------------------------------------------
// 2. Global path ./workflows/foo.ts resolves under <homeDir>/.atomic/agent
// ---------------------------------------------------------------------------

describe("toScopedDiscoveryConfig — global path resolution under <homeDir>/.atomic/agent", () => {
  test("relative path in globalConfig.workflows resolves to <homeDir>/.atomic/agent/<path>", () => {
    const homeDir = "/fake/home";
    const globalBase = join(homeDir, ".atomic", "agent");

    const result = toScopedDiscoveryConfig(
      { workflows: { foo: { path: "../../packages/workflows/src/extension/workflows/foo.ts" } } },
      null,
      { homeDir, projectRoot: "/fake/project" },
    );

    assert.deepEqual(result.globalWorkflows, {
      foo: join(globalBase, "../../packages/workflows/src/extension/workflows/foo.ts"),
    });
    assert.equal("projectWorkflows" in result, false);
  });

  test("../../packages/workflows/src/extension/workflows/foo.ts global path resolves relative to <homeDir>/.atomic/agent", () => {
    const homeDir = "/fake/home";
    const globalBase = join(homeDir, ".atomic", "agent");
    const expected = join(globalBase, "../../packages/workflows/src/extension/workflows/foo.ts");

    const result = toScopedDiscoveryConfig(
      { workflows: { foo: { path: "../../packages/workflows/src/extension/workflows/foo.ts" } } },
      null,
      { homeDir, projectRoot: "/fake/project" },
    );

    assert.equal(result.globalWorkflows?.["foo"], expected);
  });

  test("loadWorkflowConfig result fed to toScopedDiscoveryConfig — global relative path uses .atomic/agent base", async () => {
    const home = tempDir("scope-global-resolve");
    const proj = tempDir("scope-global-resolve-proj");

    writeConfigFile(home, "global", {
      workflows: { foo: { path: "../../packages/workflows/src/extension/workflows/foo.ts" } },
    });

    const { globalConfig, projectConfig } = await loadWorkflowConfig({
      homeDir: home,
      projectRoot: proj,
    });

    const dc = toScopedDiscoveryConfig(globalConfig ?? null, projectConfig ?? null, {
      homeDir: home,
      projectRoot: proj,
    });

    const expected = join(home, ".atomic", "agent", "../../packages/workflows/src/extension/workflows/foo.ts");
    assert.equal(dc.globalWorkflows?.["foo"], expected);
    assert.equal("projectWorkflows" in dc, false);
  });
});

// ---------------------------------------------------------------------------
// 3. Project key overrides global key; scope changes to settings-project
// ---------------------------------------------------------------------------

describe("toScopedDiscoveryConfig — project override changes scope", () => {
  test("shared key: project wins → entry in projectWorkflows, absent from globalWorkflows", () => {
    const homeDir = "/fake/home";
    const projectRoot = "/fake/project";

    const result = toScopedDiscoveryConfig(
      { workflows: { shared: { path: "../../packages/workflows/src/extension/global-shared.ts" }, "g-only": { path: "../../packages/workflows/src/extension/g-only.ts" } } },
      { workflows: { shared: { path: "../../packages/workflows/src/extension/project-shared.ts" } } },
      { homeDir, projectRoot },
    );

    // project entry in projectWorkflows
    assert.equal(result.projectWorkflows?.["shared"], join(projectRoot, "../../packages/workflows/src/extension/project-shared.ts"));
    // global entry for same key excluded
    assert.equal(result.globalWorkflows?.["shared"], undefined);
    // global-only key still present
    assert.equal(result.globalWorkflows?.["g-only"], join(homeDir, ".atomic", "agent", "../../packages/workflows/src/extension/g-only.ts"));
  });

  test("loadWorkflowConfig result → toScopedDiscoveryConfig: shared key in projectWorkflows only", async () => {
    const home = tempDir("scope-override");
    const proj = tempDir("scope-override-proj");
    writeConfigFile(home, "global", {
      workflows: { shared: { path: "../../packages/workflows/src/extension/global-shared.ts" } },
    });
    writeConfigFile(proj, "project", {
      workflows: { shared: { path: "../../packages/workflows/src/extension/project-shared.ts" } },
    });
    const { globalConfig, projectConfig } = await loadWorkflowConfig({
      homeDir: home,
      projectRoot: proj,
    });
    const dc = toScopedDiscoveryConfig(globalConfig ?? null, projectConfig ?? null, {
      homeDir: home,
      projectRoot: proj,
    });
    // shared key in projectWorkflows (project wins)
    assert.equal(dc.projectWorkflows?.["shared"], join(proj, "../../packages/workflows/src/extension/project-shared.ts"));
    // shared NOT in globalWorkflows
    assert.equal(dc.globalWorkflows?.["shared"], undefined);
    // globalWorkflows absent (only key was shared, which is overridden)
    assert.equal("globalWorkflows" in dc, false);
  });
});
// ---------------------------------------------------------------------------
// 4. discoverWorkflows distinguishes settings-project vs settings-global
// ---------------------------------------------------------------------------
describe("discoverWorkflows — settings-project vs settings-global source kinds via toScopedDiscoveryConfig", () => {
  test("global workflow only → source kind is settings-global", async () => {
    const home = tempDir("disc-global-kind");
    const proj = tempDir("disc-global-kind-proj");
    // Write actual workflow file at the resolved path
    const globalBase = join(home, ".atomic", "agent");
    const wfDir = join(globalBase, "workflows");
    const wfPath = writeWorkflowFile(wfDir, "Global Workflow", "global-wf-kind-test");
    const dc = toScopedDiscoveryConfig(
      { workflows: { "global-wf-kind-test": { path: wfPath } } },
      null,
      { homeDir: home, projectRoot: proj },
    );
    const result = await discoverWorkflows({
      cwd: proj,
      homeDir: home,
      config: dc,
      includeBundled: false,
    });
    const src = result.sources.find((s) => s.id === "global-wf-kind-test");
    assert.notEqual(src, undefined);
    assert.equal(src?.kind, "settings-global");
    assert.equal(result.errors.filter((e) => e.level === "error").length, 0);
  });
  test("project workflow only → source kind is settings-project", async () => {
    const home = tempDir("disc-project-kind");
    const proj = tempDir("disc-project-kind-proj");
    const wfDir = join(proj, "workflows");
    const wfPath = writeWorkflowFile(wfDir, "Project Workflow", "project-wf-kind-test");
    const dc = toScopedDiscoveryConfig(
      null,
      { workflows: { "project-wf-kind-test": { path: wfPath } } },
      { homeDir: home, projectRoot: proj },
    );
    const result = await discoverWorkflows({
      cwd: proj,
      homeDir: home,
      config: dc,
      includeBundled: false,
    });
    const src = result.sources.find((s) => s.id === "project-wf-kind-test");
    assert.notEqual(src, undefined);
    assert.equal(src?.kind, "settings-project");
    assert.equal(result.errors.filter((e) => e.level === "error").length, 0);
  });
  test("project overrides global key → only settings-project source registered", async () => {
    const home = tempDir("disc-override-kind");
    const proj = tempDir("disc-override-kind-proj");
    // Write two separate workflow files (same normalizedName would clash — use distinct names)
    const globalBase = join(home, ".atomic", "agent");
    const globalWfPath = writeWorkflowFile(
      join(globalBase, "workflows"),
      "Override Workflow (Global)",
      "override-kind-test",
    );
    const projWfPath = writeWorkflowFile(
      join(proj, "workflows"),
      "Override Workflow (Project)",
      "override-kind-test",
    );
    // toScopedDiscoveryConfig: project key "override-kind-test" overrides global
    const dc = toScopedDiscoveryConfig(
      { workflows: { "override-kind-test": { path: globalWfPath } } },
      { workflows: { "override-kind-test": { path: projWfPath } } },
      { homeDir: home, projectRoot: proj },
    );
    // Verify project wins in DiscoveryConfig
    assert.equal(dc.projectWorkflows?.["override-kind-test"], projWfPath);
    assert.equal(dc.globalWorkflows?.["override-kind-test"], undefined);
    const result = await discoverWorkflows({
      cwd: proj,
      homeDir: home,
      config: dc,
      includeBundled: false,
    });
    const sources = result.sources.filter((s) => s.id === "override-kind-test");
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.kind, "settings-project");
    assert.equal(sources[0]!.filePath, projWfPath);
  });
  test("disjoint global + project keys → distinct kinds in sources", async () => {
    const home = tempDir("disc-disjoint-kinds");
    const proj = tempDir("disc-disjoint-kinds-proj");
    const globalWfPath = writeWorkflowFile(
      join(home, ".atomic", "agent", "workflows"),
      "Global Distinct",
      "disjoint-global",
    );
    const projWfPath = writeWorkflowFile(
      join(proj, "workflows"),
      "Project Distinct",
      "disjoint-project",
    );
    const dc = toScopedDiscoveryConfig(
      { workflows: { "disjoint-global": { path: globalWfPath } } },
      { workflows: { "disjoint-project": { path: projWfPath } } },
      { homeDir: home, projectRoot: proj },
    );
    const result = await discoverWorkflows({
      cwd: proj,
      homeDir: home,
      config: dc,
      includeBundled: false,
    });
    const globalSrc = result.sources.find((s) => s.id === "disjoint-global");
    const projectSrc = result.sources.find((s) => s.id === "disjoint-project");
    assert.equal(globalSrc?.kind, "settings-global");
    assert.equal(projectSrc?.kind, "settings-project");
    assert.equal(result.errors.filter((e) => e.level === "error").length, 0);
  });
  test("end-to-end: loadWorkflowConfig + toScopedDiscoveryConfig + discoverWorkflows", async () => {
    const home = tempDir("e2e-provenance");
    const proj = tempDir("e2e-provenance-proj");
    // Write actual workflow files
    const globalWfPath = writeWorkflowFile(
      join(home, ".atomic", "agent", "workflows"),
      "E2E Global",
      "e2e-global-wf",
    );
    const projWfPath = writeWorkflowFile(
      join(proj, "workflows"),
      "E2E Project",
      "e2e-project-wf",
    );
    const overriddenProjPath = writeWorkflowFile(
      join(proj, "workflows"),
      "E2E Overridden (Project)",
      "e2e-shared-wf",
    );
    // Global config: e2e-global-wf (absolute) + e2e-shared-wf (absolute, will be overridden)
    const globalSharedPath = join(home, ".atomic", "agent", "workflows", "e2e-shared-global.ts");
    writeFileSync(
      globalSharedPath,
      `import { workflow } from "@bastani/workflows";
export default workflow({ name: "e2e-shared-wf", description: "will be overridden", inputs: {}, outputs: {}, run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
});\n`,
      "utf-8",
    );
    writeConfigFile(home, "global", {
      workflows: {
        "e2e-global-wf":  { path: globalWfPath },
        "e2e-shared-wf":  { path: globalSharedPath },
      },
    });
    writeConfigFile(proj, "project", {
      workflows: {
        "e2e-project-wf": { path: projWfPath },
        "e2e-shared-wf":  { path: overriddenProjPath },
      },
    });
    // Step 1: load config (provenance)
    const { globalConfig, projectConfig } = await loadWorkflowConfig({
      homeDir: home,
      projectRoot: proj,
    });
    assert.notEqual(globalConfig?.workflows?.["e2e-global-wf"], undefined);
    assert.notEqual(projectConfig?.workflows?.["e2e-project-wf"], undefined);
    // Step 2: build scoped discovery config
    const dc = toScopedDiscoveryConfig(globalConfig ?? null, projectConfig ?? null, {
      homeDir: home,
      projectRoot: proj,
    });
    // e2e-shared-wf override: project wins
    assert.equal(dc.projectWorkflows?.["e2e-shared-wf"], overriddenProjPath);
    assert.equal(dc.globalWorkflows?.["e2e-shared-wf"], undefined);
    // Step 3: discover
    const result = await discoverWorkflows({
      cwd: proj,
      homeDir: home,
      config: dc,
      includeBundled: false,
    });
    const globalSrc  = result.sources.find((s) => s.id === "e2e-global-wf");
    const projectSrc = result.sources.find((s) => s.id === "e2e-project-wf");
    const sharedSrc  = result.sources.find((s) => s.id === "e2e-shared-wf");
    assert.equal(globalSrc?.kind, "settings-global");
    assert.equal(projectSrc?.kind, "settings-project");
    // shared: project wins → settings-project, not settings-global
    assert.equal(sharedSrc?.kind, "settings-project");
    assert.equal(sharedSrc?.filePath, overriddenProjPath);
    assert.equal(result.errors.filter((e) => e.level === "error").length, 0);
  });
});
