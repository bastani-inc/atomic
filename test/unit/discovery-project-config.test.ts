import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import { cleanupDiscoveryTempDirs, join, makeTempDir, mkdirSync, writeFileSync, writeWorkflowJs } from "./discovery-helpers.js";

afterAll(cleanupDiscoveryTempDirs);


// ---------------------------------------------------------------------------
// project-local: {cwd}/.atomic/workflows/
// ---------------------------------------------------------------------------

describe("discoverWorkflows — project-local", () => {
  test("loads workflow from .atomic/workflows/ and registers it", async () => {
    const cwd = makeTempDir("proj-local");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "my-wf.js", "My Workflow", "my-workflow");

    const result = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home"), includeBundled: false });
    assert.equal(result.registry.has("my-workflow"), true);
    assert.equal(result.errors.length, 0);
  });

  test("source kind is project-local", async () => {
    const cwd = makeTempDir("proj-local-kind");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "wf.js", "Kind Test", "kind-test");

    const { sources } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home2"), includeBundled: false });
    const src = sources.find((s) => s.id === "kind-test");
    assert.notEqual(src, undefined);
    assert.equal(src!.kind, "project-local");
  });

  test("source has correct id, name, filePath", async () => {
    const cwd = makeTempDir("proj-local-shape");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const fp = writeWorkflowJs(wfDir, "shape.js", "shape-workflow", "shape-workflow");

    const { sources } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home3"), includeBundled: false });
    const src = sources.find((s) => s.id === "shape-workflow");
    assert.notEqual(src, undefined);
    assert.equal(src!.name, "shape-workflow");
    assert.equal(src!.filePath, fp);
  });

  test("empty .atomic/workflows/ produces no sources and no errors", async () => {
    const cwd = makeTempDir("proj-local-empty");
    mkdirSync(join(cwd, ".atomic", "workflows"), { recursive: true });

    const result = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home4"), includeBundled: false });
    assert.equal(result.sources.length, 0);
    assert.equal(result.errors.length, 0);
  });

  test("missing .atomic/workflows/ dir is silent (no error)", async () => {
    const cwd = makeTempDir("proj-local-nodir");
    const result = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home5"), includeBundled: false });
    assert.equal(result.errors.filter((e) => e.code === "PATH_NOT_FOUND").length, 0);
  });
});

// ---------------------------------------------------------------------------
// package workflows: package-provided workflow files
// ---------------------------------------------------------------------------

describe("discoverWorkflows — package workflows", () => {
  test("loads workflow files supplied by package resources", async () => {
    const root = makeTempDir("package-workflows");
    const packageDir = join(root, "package-workflows");
    mkdirSync(packageDir, { recursive: true });
    const fp = writeWorkflowJs(packageDir, "packaged.js", "Packaged Workflow", "packaged-workflow");

    const result = await discoverWorkflows({
      cwd: join(root, "cwd"),
      homeDir: join(root, "home"),
      includeBundled: false,
      packageWorkflowPaths: [fp],
    });

    assert.equal(result.registry.has("packaged-workflow"), true);
    assert.equal(result.errors.length, 0);
    const src = result.sources.find((s) => s.id === "packaged-workflow");
    assert.notEqual(src, undefined);
    assert.equal(src!.kind, "package");
    assert.equal(src!.filePath, fp);
  });

  test("loads workflow directories supplied by package resources", async () => {
    const root = makeTempDir("package-workflow-dir");
    const packageDir = join(root, "package-workflows");
    const workflowsDir = join(packageDir, "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    const fp = writeWorkflowJs(workflowsDir, "packaged-dir.js", "Packaged Dir", "packaged-dir");

    const result = await discoverWorkflows({
      cwd: join(root, "cwd"),
      homeDir: join(root, "home"),
      includeBundled: false,
      packageWorkflowPaths: [workflowsDir],
    });

    assert.equal(result.registry.has("packaged-dir"), true);
    assert.equal(result.errors.length, 0);
    const src = result.sources.find((s) => s.id === "packaged-dir");
    assert.notEqual(src, undefined);
    assert.equal(src!.kind, "package");
    assert.equal(src!.filePath, fp);
  });

  test("loads package workflows authored with @bastani/workflows imports", async () => {
    const root = makeTempDir("package-workflow-sdk-import");
    const packageDir = join(root, "package-workflows");
    const workflowsDir = join(packageDir, "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    const fp = join(workflowsDir, "sdk-import.ts");
    writeFileSync(
      fp,
      [
        `import { workflow } from "@bastani/workflows";`,
        ``,
        `export default workflow({`,
        `  name: "sdk-import",`,
        `  description: "SDK import workflow",`,
        `  inputs: {},`,
        `  outputs: {},`,
        `  run: async (ctx) => {`,
        `    await ctx.task("validation-smoke", { prompt: "validation smoke" });`,
        `    return {};`,
        `  },`,
        `});`,
      ].join("\n"),
      "utf-8",
    );

    const result = await discoverWorkflows({
      cwd: join(root, "cwd"),
      homeDir: join(root, "home"),
      includeBundled: false,
      packageWorkflowPaths: [workflowsDir],
    });

    assert.equal(result.registry.has("sdk-import"), true);
    assert.equal(result.errors.length, 0);
    const src = result.sources.find((s) => s.id === "sdk-import");
    assert.notEqual(src, undefined);
    assert.equal(src!.kind, "package");
    assert.equal(src!.filePath, fp);
  });
});

// ---------------------------------------------------------------------------
// user-global: {homeDir}/.atomic/workflows/
// ---------------------------------------------------------------------------

describe("discoverWorkflows — user-global", () => {
  test("loads workflow from homeDir/.atomic/agent/workflows/", async () => {
    const homeDir = makeTempDir("user-global");
    const wfDir = join(homeDir, ".atomic", "agent", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "global-wf.js", "Global Workflow", "global-workflow");

    const cwd = makeTempDir("proj-empty");
    const result = await discoverWorkflows({ cwd, homeDir, includeBundled: false });
    assert.equal(result.registry.has("global-workflow"), true);
    assert.equal(result.errors.length, 0);
  });

  test("source kind is user-global", async () => {
    const homeDir = makeTempDir("user-global-kind");
    const wfDir = join(homeDir, ".atomic", "agent", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "gk.js", "Global Kind", "global-kind");

    const cwd = makeTempDir("proj-empty2");
    const { sources } = await discoverWorkflows({ cwd, homeDir, includeBundled: false });
    const src = sources.find((s) => s.id === "global-kind");
    assert.notEqual(src, undefined);
    assert.equal(src!.kind, "user-global");
  });

  test("source has filePath set", async () => {
    const homeDir = makeTempDir("user-global-fp");
    const wfDir = join(homeDir, ".atomic", "agent", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const fp = writeWorkflowJs(wfDir, "gfp.js", "Global FP", "global-fp");

    const cwd = makeTempDir("proj-empty3");
    const { sources } = await discoverWorkflows({ cwd, homeDir, includeBundled: false });
    const src = sources.find((s) => s.id === "global-fp");
    assert.equal(src?.filePath, fp);
  });
});

// ---------------------------------------------------------------------------
// configured: config.projectWorkflows and config.globalWorkflows
// ---------------------------------------------------------------------------

describe("discoverWorkflows — configured projectWorkflows (string array)", () => {
  test("loads from explicit path, kind=settings-project", async () => {
    const filesDir = makeTempDir("cfg-proj-arr");
    const fp = writeWorkflowJs(filesDir, "cfg-proj.js", "Cfg Project", "cfg-project");
    const cwd = makeTempDir("proj-for-cfg");

    const result = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("home-for-cfg"),
      includeBundled: false,
      config: { projectWorkflows: [fp] },
    });
    assert.equal(result.registry.has("cfg-project"), true);
    const src = result.sources.find((s) => s.id === "cfg-project");
    assert.equal(src?.kind, "settings-project");
    assert.equal(result.errors.length, 0);
  });

  test("no configuredName when using string array", async () => {
    const filesDir = makeTempDir("cfg-proj-arr-noname");
    const fp = writeWorkflowJs(filesDir, "noname.js", "NoName", "cfg-noname");
    const cwd = makeTempDir("proj-for-noname");

    const { sources } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("home-noname"),
      includeBundled: false,
      config: { projectWorkflows: [fp] },
    });
    const src = sources.find((s) => s.id === "cfg-noname");
    assert.equal(src?.configuredName, undefined);
  });
});

describe("discoverWorkflows — configured projectWorkflows (named map)", () => {
  test("loads from named map, kind=settings-project, configuredName set", async () => {
    const filesDir = makeTempDir("cfg-proj-map");
    const fp = writeWorkflowJs(filesDir, "mapped.js", "Mapped Workflow", "mapped-workflow");
    const cwd = makeTempDir("proj-for-map");

    const result = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("home-for-map"),
      includeBundled: false,
      config: { projectWorkflows: { "my-custom-name": fp } },
    });
    assert.equal(result.registry.has("mapped-workflow"), true);
    const src = result.sources.find((s) => s.id === "mapped-workflow");
    assert.equal(src?.kind, "settings-project");
    assert.equal(src?.configuredName, "my-custom-name");
    assert.equal(result.errors.length, 0);
  });

  test("multiple entries in named map all register", async () => {
    const filesDir = makeTempDir("cfg-proj-map2");
    const fp1 = writeWorkflowJs(filesDir, "wf1.js", "Map1", "map-wf-one");
    const fp2 = writeWorkflowJs(filesDir, "wf2.js", "Map2", "map-wf-two");
    const cwd = makeTempDir("proj-map2");

    const { registry, errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("home-map2"),
      includeBundled: false,
      config: { projectWorkflows: { "alias-one": fp1, "alias-two": fp2 } },
    });
    assert.equal(registry.has("map-wf-one"), true);
    assert.equal(registry.has("map-wf-two"), true);
    assert.equal(errors.length, 0);
  });
});

describe("discoverWorkflows — configured globalWorkflows", () => {
  test("loads from globalWorkflows path, kind=settings-global", async () => {
    const filesDir = makeTempDir("cfg-global");
    const fp = writeWorkflowJs(filesDir, "gcfg.js", "Global Cfg", "global-cfg");
    const cwd = makeTempDir("proj-for-gcfg");

    const result = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("home-gcfg"),
      includeBundled: false,
      config: { globalWorkflows: [fp] },
    });
    assert.equal(result.registry.has("global-cfg"), true);
    const src = result.sources.find((s) => s.id === "global-cfg");
    assert.equal(src?.kind, "settings-global");
    assert.equal(result.errors.length, 0);
  });

  test("named map in globalWorkflows sets configuredName", async () => {
    const filesDir = makeTempDir("cfg-global-map");
    const fp = writeWorkflowJs(filesDir, "gmapped.js", "Global Mapped", "global-mapped");
    const cwd = makeTempDir("proj-gmapped");

    const { sources } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("home-gmapped"),
      includeBundled: false,
      config: { globalWorkflows: { "g-alias": fp } },
    });
    const src = sources.find((s) => s.id === "global-mapped");
    assert.equal(src?.kind, "settings-global");
    assert.equal(src?.configuredName, "g-alias");
  });
});
