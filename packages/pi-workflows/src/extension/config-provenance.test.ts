/**
 * Focused regression tests for config provenance (RFC: config-provenance worker).
 *
 * Covers:
 *   1. loadWorkflowConfig — globalConfig/projectConfig provenance fields in ConfigLoadResult
 *   2. Global workflow path ./workflows/foo.ts resolves under <homeDir>/.pi/agent
 *   3. Project workflow key overrides global key; scope changes to settings-project
 *   4. discoverWorkflows distinguishes settings-project vs settings-global source kinds
 */

import { test, expect, describe, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  loadWorkflowConfig,
  toScopedDiscoveryConfig,
} from "./config-loader.js";
import { discoverWorkflows } from "./discovery.js";

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
 * scope "global"   → <base>/.pi/agent/extensions/workflow/config.json
 * scope "project1" → <base>/.pi/extensions/workflow/config.json
 * scope "project2" → <base>/.pi/agent/extensions/workflow/config.json
 */
function writeConfigFile(
  base: string,
  scope: "global" | "project1" | "project2",
  content: object,
): string {
  const paths: Record<string, string[]> = {
    global:    [".pi", "agent", "extensions", "workflow", "config.json"],
    project1:  [".pi", "extensions", "workflow", "config.json"],
    project2:  [".pi", "agent", "extensions", "workflow", "config.json"],
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
    `export default {
  __piWorkflow: true,
  name: ${JSON.stringify(name)},
  normalizedName: ${JSON.stringify(normalizedName)},
  description: "test workflow",
  inputs: {},
  run: async () => ({}),
};\n`,
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

    expect(result.globalConfig).not.toBeNull();
    expect(result.globalConfig?.maxDepth).toBe(3);
    expect(result.projectConfig ?? null).toBeNull();
  });

  test("global config absent → globalConfig null", async () => {
    const home = tempDir("lc-no-global");
    const proj = tempDir("lc-no-global-proj");

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    expect(result.globalConfig ?? null).toBeNull();
    expect(result.projectConfig ?? null).toBeNull();
    expect(result.config).toBeNull();
  });

  test("global config with workflows entry → globalConfig.workflows populated", async () => {
    const home = tempDir("lc-global-wf");
    const proj = tempDir("lc-global-wf-proj");

    writeConfigFile(home, "global", {
      workflows: { foo: { path: "./workflows/foo.ts" } },
    });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    expect(result.globalConfig?.workflows).toEqual({
      foo: { path: "./workflows/foo.ts" },
    });
    expect(result.projectConfig ?? null).toBeNull();
  });
});

describe("loadWorkflowConfig — provenance: projectConfig field", () => {
  test("project config (candidate 1) present → projectConfig populated, globalConfig null", async () => {
    const home = tempDir("lc-proj-only");
    const proj = tempDir("lc-proj-only-base");

    writeConfigFile(proj, "project1", { defaultConcurrency: 8 });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    expect(result.projectConfig).not.toBeNull();
    expect(result.projectConfig?.defaultConcurrency).toBe(8);
    expect(result.globalConfig ?? null).toBeNull();
  });

  test("project config (candidate 2) present → projectConfig populated", async () => {
    const home = tempDir("lc-proj-cand2");
    const proj = tempDir("lc-proj-cand2-base");

    writeConfigFile(proj, "project2", { persistRuns: false });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    expect(result.projectConfig?.persistRuns).toBe(false);
  });

  test("project config with workflows entry → projectConfig.workflows populated", async () => {
    const home = tempDir("lc-proj-wf");
    const proj = tempDir("lc-proj-wf-base");

    writeConfigFile(proj, "project1", {
      workflows: { bar: { path: "./workflows/bar.ts" } },
    });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    expect(result.projectConfig?.workflows).toEqual({
      bar: { path: "./workflows/bar.ts" },
    });
  });
});

describe("loadWorkflowConfig — provenance: both configs", () => {
  test("both global + project → both provenance fields set", async () => {
    const home = tempDir("lc-both");
    const proj = tempDir("lc-both-proj");

    writeConfigFile(home, "global", { maxDepth: 2 });
    writeConfigFile(proj, "project1", { maxDepth: 6 });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    expect(result.globalConfig?.maxDepth).toBe(2);
    expect(result.projectConfig?.maxDepth).toBe(6);
    // merged config: project overrides global
    expect(result.config?.maxDepth).toBe(6);
  });

  test("both with workflows — project key overrides global key in merged config", async () => {
    const home = tempDir("lc-both-wf");
    const proj = tempDir("lc-both-wf-proj");

    writeConfigFile(home, "global", {
      workflows: {
        shared: { path: "./global-shared.ts" },
        "g-only": { path: "./g-only.ts" },
      },
    });
    writeConfigFile(proj, "project1", {
      workflows: {
        shared: { path: "./project-shared.ts" },
      },
    });

    const result = await loadWorkflowConfig({ homeDir: home, projectRoot: proj });

    // Provenance: raw configs preserved as-is
    expect(result.globalConfig?.workflows?.["shared"]?.path).toBe("./global-shared.ts");
    expect(result.projectConfig?.workflows?.["shared"]?.path).toBe("./project-shared.ts");

    // Merged config: project entry wins
    expect(result.config?.workflows?.["shared"]?.path).toBe("./project-shared.ts");
    // g-only from global still present in merged
    expect(result.config?.workflows?.["g-only"]?.path).toBe("./g-only.ts");
  });
});

// ---------------------------------------------------------------------------
// 2. Global path ./workflows/foo.ts resolves under <homeDir>/.pi/agent
// ---------------------------------------------------------------------------

describe("toScopedDiscoveryConfig — global path resolution under <homeDir>/.pi/agent", () => {
  test("relative path in globalConfig.workflows resolves to <homeDir>/.pi/agent/<path>", () => {
    const homeDir = "/fake/home";
    const globalBase = join(homeDir, ".pi", "agent");

    const result = toScopedDiscoveryConfig(
      { workflows: { foo: { path: "./workflows/foo.ts" } } },
      null,
      { homeDir, projectRoot: "/fake/project" },
    );

    expect(result.globalWorkflows).toEqual({
      foo: join(globalBase, "./workflows/foo.ts"),
    });
    expect("projectWorkflows" in result).toBe(false);
  });

  test("./workflows/foo.ts global path resolves to <homeDir>/.pi/agent/workflows/foo.ts", () => {
    const homeDir = "/fake/home";
    const expected = join(homeDir, ".pi", "agent", "workflows", "foo.ts");

    const result = toScopedDiscoveryConfig(
      { workflows: { foo: { path: "./workflows/foo.ts" } } },
      null,
      { homeDir, projectRoot: "/fake/project" },
    );

    expect(result.globalWorkflows?.["foo"]).toBe(expected);
  });

  test("loadWorkflowConfig result fed to toScopedDiscoveryConfig — global relative path uses homeDir base", async () => {
    const home = tempDir("scope-global-resolve");
    const proj = tempDir("scope-global-resolve-proj");

    writeConfigFile(home, "global", {
      workflows: { foo: { path: "./workflows/foo.ts" } },
    });

    const { globalConfig, projectConfig } = await loadWorkflowConfig({
      homeDir: home,
      projectRoot: proj,
    });

    const dc = toScopedDiscoveryConfig(globalConfig ?? null, projectConfig ?? null, {
      homeDir: home,
      projectRoot: proj,
    });

    const expected = join(home, ".pi", "agent", "workflows", "foo.ts");
    expect(dc.globalWorkflows?.["foo"]).toBe(expected);
    expect("projectWorkflows" in dc).toBe(false);
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
      { workflows: { shared: { path: "./global-shared.ts" }, "g-only": { path: "./g-only.ts" } } },
      { workflows: { shared: { path: "./project-shared.ts" } } },
      { homeDir, projectRoot },
    );

    // project entry in projectWorkflows
    expect(result.projectWorkflows?.["shared"]).toBe(join(projectRoot, "./project-shared.ts"));
    // global entry for same key excluded
    expect(result.globalWorkflows?.["shared"]).toBeUndefined();
    // global-only key still present
    expect(result.globalWorkflows?.["g-only"]).toBe(join(homeDir, ".pi", "agent", "./g-only.ts"));
  });

  test("loadWorkflowConfig result → toScopedDiscoveryConfig: shared key in projectWorkflows only", async () => {
    const home = tempDir("scope-override");
    const proj = tempDir("scope-override-proj");

    writeConfigFile(home, "global", {
      workflows: { shared: { path: "./global-shared.ts" } },
    });
    writeConfigFile(proj, "project1", {
      workflows: { shared: { path: "./project-shared.ts" } },
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
    expect(dc.projectWorkflows?.["shared"]).toBe(join(proj, "./project-shared.ts"));
    // shared NOT in globalWorkflows
    expect(dc.globalWorkflows?.["shared"]).toBeUndefined();
    // globalWorkflows absent (only key was shared, which is overridden)
    expect("globalWorkflows" in dc).toBe(false);
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
    const globalBase = join(home, ".pi", "agent");
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
    expect(src).toBeDefined();
    expect(src?.kind).toBe("settings-global");
    expect(result.errors.filter((e) => e.level === "error")).toHaveLength(0);
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
    expect(src).toBeDefined();
    expect(src?.kind).toBe("settings-project");
    expect(result.errors.filter((e) => e.level === "error")).toHaveLength(0);
  });

  test("project overrides global key → only settings-project source registered", async () => {
    const home = tempDir("disc-override-kind");
    const proj = tempDir("disc-override-kind-proj");

    // Write two separate workflow files (same normalizedName would clash — use distinct names)
    const globalBase = join(home, ".pi", "agent");
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
    expect(dc.projectWorkflows?.["override-kind-test"]).toBe(projWfPath);
    expect(dc.globalWorkflows?.["override-kind-test"]).toBeUndefined();

    const result = await discoverWorkflows({
      cwd: proj,
      homeDir: home,
      config: dc,
      includeBundled: false,
    });

    const sources = result.sources.filter((s) => s.id === "override-kind-test");
    expect(sources).toHaveLength(1);
    expect(sources[0]!.kind).toBe("settings-project");
    expect(sources[0]!.filePath).toBe(projWfPath);
  });

  test("disjoint global + project keys → distinct kinds in sources", async () => {
    const home = tempDir("disc-disjoint-kinds");
    const proj = tempDir("disc-disjoint-kinds-proj");

    const globalWfPath = writeWorkflowFile(
      join(home, ".pi", "agent", "workflows"),
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

    expect(globalSrc?.kind).toBe("settings-global");
    expect(projectSrc?.kind).toBe("settings-project");
    expect(result.errors.filter((e) => e.level === "error")).toHaveLength(0);
  });

  test("end-to-end: loadWorkflowConfig + toScopedDiscoveryConfig + discoverWorkflows", async () => {
    const home = tempDir("e2e-provenance");
    const proj = tempDir("e2e-provenance-proj");

    // Write actual workflow files
    const globalWfPath = writeWorkflowFile(
      join(home, ".pi", "agent", "workflows"),
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
    const globalSharedPath = join(home, ".pi", "agent", "workflows", "e2e-shared-global.ts");
    writeFileSync(
      globalSharedPath,
      `export default {
  __piWorkflow: true,
  name: "E2E Shared (Global)",
  normalizedName: "e2e-shared-wf",
  description: "will be overridden",
  inputs: {},
  run: async () => ({}),
};\n`,
      "utf-8",
    );

    writeConfigFile(home, "global", {
      workflows: {
        "e2e-global-wf":  { path: globalWfPath },
        "e2e-shared-wf":  { path: globalSharedPath },
      },
    });
    writeConfigFile(proj, "project1", {
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
    expect(globalConfig?.workflows?.["e2e-global-wf"]).toBeDefined();
    expect(projectConfig?.workflows?.["e2e-project-wf"]).toBeDefined();

    // Step 2: build scoped discovery config
    const dc = toScopedDiscoveryConfig(globalConfig ?? null, projectConfig ?? null, {
      homeDir: home,
      projectRoot: proj,
    });

    // e2e-shared-wf override: project wins
    expect(dc.projectWorkflows?.["e2e-shared-wf"]).toBe(overriddenProjPath);
    expect(dc.globalWorkflows?.["e2e-shared-wf"]).toBeUndefined();

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

    expect(globalSrc?.kind).toBe("settings-global");
    expect(projectSrc?.kind).toBe("settings-project");
    // shared: project wins → settings-project, not settings-global
    expect(sharedSrc?.kind).toBe("settings-project");
    expect(sharedSrc?.filePath).toBe(overriddenProjPath);

    expect(result.errors.filter((e) => e.level === "error")).toHaveLength(0);
  });
});
