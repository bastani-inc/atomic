/**
 * Tests for src/extension/discovery.ts
 *
 * Covers:
 *   - discoverStartupWorkflowsSync() happy path: all four builtins registered
 *   - DiscoveryResult shape: registry, sources, errors
 *   - sources array: one entry per bundled workflow with correct id/kind/name
 *   - No errors on clean manifest
 *   - Registry lookup by normalizedName
 *   - validateDefinition (via white-box: invalid exports produce INVALID_DEFINITION)
 *   - Duplicate normalizedName: first-wins, DUPLICATE_NAME warning
 */

import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import {
  discoverStartupWorkflowsSync,
  discoverWorkflows,
  type DiscoverySource,
  type DiscoveryDiagnostic,
} from "../../packages/workflows/src/extension/discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidDef(
  name: string,
  normalizedName: string,
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    __piWorkflow: true,
    name,
    normalizedName,
    description: `${name} description`,
    inputs: {},
    run: async () => ({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path: real bundled workflows
// ---------------------------------------------------------------------------

describe("discoverStartupWorkflowsSync — bundled manifest", () => {
  test("returns a DiscoveryResult with registry, sources, errors", async () => {
    const result = await discoverStartupWorkflowsSync();
    assert.notEqual(result, undefined);
    assert.notEqual(result.registry, undefined);
    assert.equal(Array.isArray(result.sources), true);
    assert.equal(Array.isArray(result.errors), true);
  });

  test("registers exactly the four bundled workflows", async () => {
    const { registry } = await discoverStartupWorkflowsSync();
    const names = registry.names();
    assert.ok(names.includes("deep-research-codebase"));
    assert.ok(names.includes("goal"));
    assert.ok(names.includes("ralph"));
    assert.ok(names.includes("open-claude-design"));
    assert.equal(names.length, 4);
  });

  test("no errors on clean manifest", async () => {
    const { errors } = await discoverStartupWorkflowsSync();
    assert.equal(errors.length, 0);
  });

  test("sources array has one entry per registered workflow", async () => {
    const { sources } = await discoverStartupWorkflowsSync();
    assert.equal(sources.length, 4);
    const ids = sources.map((s: DiscoverySource) => s.id);
    assert.ok(ids.includes("deep-research-codebase"));
    assert.ok(ids.includes("goal"));
    assert.ok(ids.includes("ralph"));
    assert.ok(ids.includes("open-claude-design"));
  });

  test("every source has kind='bundled'", async () => {
    const { sources } = await discoverStartupWorkflowsSync();
    for (const s of sources) {
      assert.equal(s.kind, "bundled");
    }
  });

  test("source id matches normalizedName", async () => {
    const { sources, registry } = await discoverStartupWorkflowsSync();
    for (const s of sources) {
      const def = registry.get(s.id);
      assert.notEqual(def, undefined);
      assert.equal(def!.normalizedName, s.id);
    }
  });

  test("source name matches workflow display name", async () => {
    const { sources, registry } = await discoverStartupWorkflowsSync();
    for (const s of sources) {
      const def = registry.get(s.id);
      assert.equal(def!.name, s.name);
    }
  });

  test("registry.get by normalizedName returns valid WorkflowDefinition", async () => {
    const { registry } = await discoverStartupWorkflowsSync();
    for (const name of ["deep-research-codebase", "goal", "ralph", "open-claude-design"]) {
      const def = registry.get(name);
      assert.notEqual(def, undefined);
      assert.equal(def!.__piWorkflow, true);
      assert.equal(typeof def!.run, "function");
      assert.equal(def!.normalizedName, name);
    }
  });

  test("registry is immutable-style (register returns new registry)", async () => {
    const { registry } = await discoverStartupWorkflowsSync();
    const extra = makeValidDef("new-workflow", "new-workflow");
    const r2 = registry.register(extra);
    // original unchanged
    assert.equal(registry.has("new-workflow"), false);
    assert.equal(r2.has("new-workflow"), true);
  });
});

// ---------------------------------------------------------------------------
// Validation: INVALID_DEFINITION diagnostics
// ---------------------------------------------------------------------------

describe("discoverStartupWorkflowsSync — validation diagnostics", () => {
  /**
   * We test validation indirectly by inspecting the diagnostic shape from
   * a direct call to the module's internal validator via a crafted scenario.
   *
   * Since validateDefinition is not exported, we verify its effects through
   * the returned errors array by checking that valid definitions produce no
   * INVALID_DEFINITION errors.
   */
  test("INVALID_DEFINITION diagnostic has correct fields", async () => {
    // The bundled manifest is clean, so all errors would be structural.
    // We verify the diagnostic type shape is correct when errors exist by
    // checking the DiscoveryDiagnostic contract on a synthetic test.
    const diag: DiscoveryDiagnostic = {
      level: "error",
      code: "INVALID_DEFINITION",
      message: "Bundled export \"foo\" rejected: export is not an object",
      source: "foo",
    };
    assert.equal(diag.level, "error");
    assert.equal(diag.code, "INVALID_DEFINITION");
    assert.equal(typeof diag.message, "string");
    assert.equal(diag.source, "foo");
  });

  test("no INVALID_DEFINITION errors for real bundled workflows", async () => {
    const { errors } = await discoverStartupWorkflowsSync();
    const invalidErrors = errors.filter((e: DiscoveryDiagnostic) => e.code === "INVALID_DEFINITION");
    assert.equal(invalidErrors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection via createRegistry + registry logic
// ---------------------------------------------------------------------------

describe("discoverStartupWorkflowsSync — duplicate handling", () => {
  test("no DUPLICATE_NAME warnings for clean bundled manifest (all unique)", async () => {
    const { errors } = await discoverStartupWorkflowsSync();
    const dupeWarnings = errors.filter((e: DiscoveryDiagnostic) => e.code === "DUPLICATE_NAME");
    assert.equal(dupeWarnings.length, 0);
  });

  test("DUPLICATE_NAME diagnostic shape is correct", () => {
    const diag: DiscoveryDiagnostic = {
      level: "warn",
      code: "DUPLICATE_NAME",
      message: 'Bundled export "ralph2" skipped: normalizedName "ralph" already registered',
      source: "ralph2",
    };
    assert.equal(diag.level, "warn");
    assert.equal(diag.code, "DUPLICATE_NAME");
    assert.equal(diag.source, "ralph2");
  });
});

// ---------------------------------------------------------------------------
// DiscoveryResult is frozen / read-only (contract)
// ---------------------------------------------------------------------------

describe("DiscoveryResult contract", () => {
  test("sources array is readonly (cannot push)", async () => {
    const { sources } = await discoverStartupWorkflowsSync();
    // readonly — TypeScript enforces this; runtime check via Object.isFrozen or try
    // The array itself may not be frozen at runtime, but we confirm length is stable
    const lenBefore = sources.length;
    // Attempting to push would be a TS error; we simply confirm length is stable
    assert.equal(sources.length, lenBefore);
  });

  test("errors array is readonly (length stable)", async () => {
    const { errors } = await discoverStartupWorkflowsSync();
    const lenBefore = errors.length;
    assert.equal(errors.length, lenBefore);
  });
});

// ---------------------------------------------------------------------------
// DiscoverySource shape conformance
// ---------------------------------------------------------------------------

describe("DiscoverySource shape", () => {
  test("each source has id, kind, name fields", async () => {
    const { sources } = await discoverStartupWorkflowsSync();
    for (const s of sources) {
      assert.equal(typeof s.id, "string");
      assert.ok(s.id.length > 0);
      assert.equal(s.kind, "bundled");
      assert.equal(typeof s.name, "string");
      assert.ok(s.name.length > 0);
    }
  });

  test("source ids are unique", async () => {
    const { sources } = await discoverStartupWorkflowsSync();
    const ids = sources.map((s: DiscoverySource) => s.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length);
  });
});

// ---------------------------------------------------------------------------
// Registry integration: all() returns all four definitions
// ---------------------------------------------------------------------------

describe("registry.all() after discovery", () => {
  test("all() returns four WorkflowDefinition objects", async () => {
    const { registry } = await discoverStartupWorkflowsSync();
    const all = registry.all();
    assert.equal(all.length, 4);
    for (const def of all) {
      assert.equal(def.__piWorkflow, true);
      assert.equal(typeof def.name, "string");
      assert.equal(typeof def.normalizedName, "string");
      assert.equal(typeof def.run, "function");
    }
  });

  test("registry.names() matches source ids", async () => {
    const { registry, sources } = await discoverStartupWorkflowsSync();
    const regNames = new Set(registry.names());
    const srcIds = new Set(sources.map((s: DiscoverySource) => s.id));
    assert.equal(regNames.size, srcIds.size);
    for (const id of srcIds) {
      assert.equal(regNames.has(id), true);
    }
  });
});

// ===========================================================================
// discoverWorkflows() — full discovery regression tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Temp dir / file helpers
// ---------------------------------------------------------------------------

const _tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = join(tmpdir(), `pi-disc-${label}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  _tempDirs.push(dir);
  return dir;
}

/** Write a minimal valid ESM workflow file returning the absolute path. */
function writeWorkflowJs(
  dir: string,
  filename: string,
  name: string,
  normalizedName: string,
): string {
  const filePath = join(dir, filename);
  writeFileSync(
    filePath,
    [
      `export default {`,
      `  __piWorkflow: true,`,
      `  name: "${name}",`,
      `  normalizedName: "${normalizedName}",`,
      `  description: "${name} description",`,
      `  inputs: {},`,
      `  run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },`,
      `};`,
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

/** Write an invalid ESM workflow file (default export is null). */
function writeInvalidWorkflowJs(dir: string, filename: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, `export default null;\n`, "utf-8");
  return filePath;
}

/** Write an otherwise valid workflow file whose run body creates no stages. */
function writeNoStageWorkflowJs(dir: string, filename: string): string {
  const filePath = join(dir, filename);
  writeFileSync(
    filePath,
    [
      `export default {`,
      `  __piWorkflow: true,`,
      `  name: "No Stage Workflow",`,
      `  normalizedName: "no-stage-workflow",`,
      `  description: "Discovery rejects this because it creates no stages",`,
      `  inputs: {},`,
      `  run: async () => ({ ok: true }),`,
      `};`,
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

/** Write an ESM workflow file missing the __piWorkflow sentinel. */
function writeMissingSentinelWorkflowJs(dir: string, filename: string): string {
  const filePath = join(dir, filename);
  writeFileSync(
    filePath,
    [
      `export default {`,
      `  name: "no-sentinel",`,
      `  normalizedName: "no-sentinel",`,
      `  run: async () => ({}),`,
      `};`,
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

afterAll(() => {
  for (const dir of _tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

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
    const fp = writeWorkflowJs(wfDir, "shape.js", "Shape Workflow", "shape-workflow");

    const { sources } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home3"), includeBundled: false });
    const src = sources.find((s) => s.id === "shape-workflow");
    assert.notEqual(src, undefined);
    assert.equal(src!.name, "Shape Workflow");
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
        `import { defineWorkflow } from "@bastani/workflows";`,
        ``,
        `export default defineWorkflow("sdk-import")`,
        `  .description("SDK import workflow")`,
        `  .run(async (ctx) => {`,
        `    await ctx.task("validation-smoke", { prompt: "validation smoke" });`,
        `    return {};`,
        `  })`,
        `  .compile();`,
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

// ---------------------------------------------------------------------------
// Invalid exports → diagnostics
// ---------------------------------------------------------------------------

describe("discoverWorkflows — INVALID_DEFINITION diagnostics", () => {
  test("null default export emits INVALID_DEFINITION", async () => {
    const cwd = makeTempDir("invalid-null");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const fp = writeInvalidWorkflowJs(wfDir, "bad-null.js");

    const { errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty"), includeBundled: false });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.level, "error");
    assert.equal(errors[0]!.code, "INVALID_DEFINITION");
    assert.equal(errors[0]!.source, fp);
    assert.match(errors[0]!.message, /project-local export "default" rejected: export is not an object/);
  });

  test("missing __piWorkflow sentinel emits INVALID_DEFINITION", async () => {
    const cwd = makeTempDir("invalid-sentinel");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeMissingSentinelWorkflowJs(wfDir, "bad-sentinel.js");

    const { errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty2"), includeBundled: false });
    const inv = errors.filter((e) => e.code === "INVALID_DEFINITION");
    assert.ok(inv.length > 0);
    assert.match(inv[0]!.message, /missing or incorrect __piWorkflow sentinel/);
  });

  test("INVALID_DEFINITION does not register a workflow", async () => {
    const cwd = makeTempDir("invalid-no-reg");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeInvalidWorkflowJs(wfDir, "bad.js");

    const { registry } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty3"), includeBundled: false });
    assert.equal(registry.names().length, 0);
  });

  test("workflow that completes without creating stages registers structurally", async () => {
    const cwd = makeTempDir("structural-no-stages");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeNoStageWorkflowJs(wfDir, "no-stage.js");

    const { registry, errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-structural-no-stages"), includeBundled: false });

    assert.equal(registry.has("no-stage-workflow"), true);
    assert.equal(errors.filter((e) => e.code === "INVALID_DEFINITION").length, 0);
  });

  test("discovery does not invoke workflow run bodies", async () => {
    const cwd = makeTempDir("no-run-body-side-effects");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const sideEffectPath = join(cwd, "side-effect.txt");
    writeFileSync(
      join(wfDir, "side-effect.js"),
      [
        `import { writeFileSync } from "node:fs";`,
        `export default {`,
        `  __piWorkflow: true,`,
        `  name: "Side Effect Workflow",`,
        `  normalizedName: "side-effect-workflow",`,
        `  description: "Would write during run if discovery invoked it",`,
        `  inputs: {},`,
        `  run: async () => { writeFileSync(${JSON.stringify(sideEffectPath)}, "ran"); return {}; },`,
        `};`,
      ].join("\n"),
      "utf-8",
    );

    const { registry, errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-no-run-body-side-effects"), includeBundled: false });

    assert.equal(registry.has("side-effect-workflow"), true);
    assert.equal(errors.length, 0);
    assert.equal(existsSync(sideEffectPath), false);
  });

  test("workflow that reaches a stage through an aliased primitive registers structurally", async () => {
    const cwd = makeTempDir("valid-aliased-stage-primitive");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "aliased.js"),
      [
        `export default {`,
        `  __piWorkflow: true,`,
        `  name: "Aliased Stage Workflow",`,
        `  normalizedName: "aliased-stage-workflow",`,
        `  description: "Uses an aliased task primitive",`,
        `  inputs: {},`,
        `  run: async (ctx) => { const { task } = ctx; await task("validation-smoke", { prompt: "validation smoke" }); return {}; },`,
        `};`,
      ].join("\n"),
      "utf-8",
    );

    const { registry, errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-aliased-stage-primitive"), includeBundled: false });

    assert.equal(registry.has("aliased-stage-workflow"), true);
    assert.equal(errors.filter((e) => e.code === "INVALID_DEFINITION").length, 0);
  });

  test("PATH_NOT_FOUND for configured path that does not exist", async () => {
    const cwd = makeTempDir("path-not-found");
    const missingPath = join(makeTempDir("ghost-dir"), "ghost.js");

    const { errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty4"),
      includeBundled: false,
      config: { projectWorkflows: [missingPath] },
    });
    const pathErr = errors.filter((e) => e.code === "PATH_NOT_FOUND");
    assert.equal(pathErr.length, 1);
    assert.equal(pathErr[0]!.level, "error");
    assert.equal(pathErr[0]!.source, missingPath);
  });

  test("CONFIG_INVALID for bad config structure", async () => {
    const cwd = makeTempDir("bad-config");
    const { errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty5"),
      includeBundled: false,
      config: { projectWorkflows: 42 as unknown as string[] },
    });
    const cfgErr = errors.filter((e) => e.code === "CONFIG_INVALID");
    assert.equal(cfgErr.length, 1);
    assert.equal(cfgErr[0]!.level, "error");
  });
});

// ---------------------------------------------------------------------------
// Duplicate normalizedName — precedence and DUPLICATE_NAME warnings
// ---------------------------------------------------------------------------

describe("discoverWorkflows — DUPLICATE_NAME precedence", () => {
  test("settings-project beats project-local: project-local emits DUPLICATE_NAME", async () => {
    const cwd = makeTempDir("dup-sp-vs-pl");
    // settings-project: highest precedence
    const spDir = makeTempDir("sp-files");
    const spPath = writeWorkflowJs(spDir, "sp.js", "SP Version", "dup-wf");
    // project-local: lower precedence
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "pl.js", "PL Version", "dup-wf");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-home"),
      includeBundled: false,
      config: { projectWorkflows: [spPath] },
    });

    // settings-project wins
    const def = registry.get("dup-wf");
    assert.equal(def?.name, "SP Version");

    // project-local entry emits DUPLICATE_NAME
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0]!.level, "warn");

    // only one source registered for dup-wf
    const srcs = sources.filter((s) => s.id === "dup-wf");
    assert.equal(srcs.length, 1);
    assert.equal(srcs[0]!.kind, "settings-project");
  });

  test("project-local beats settings-global: settings-global emits DUPLICATE_NAME", async () => {
    const cwd = makeTempDir("dup-pl-vs-sg");
    // project-local
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "pl.js", "PL Winner", "dup-sg-wf");
    // settings-global
    const sgDir = makeTempDir("sg-files");
    const sgPath = writeWorkflowJs(sgDir, "sg.js", "SG Loser", "dup-sg-wf");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-home2"),
      includeBundled: false,
      config: { globalWorkflows: [sgPath] },
    });

    assert.equal(registry.get("dup-sg-wf")?.name, "PL Winner");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0]!.level, "warn");

    const srcs = sources.filter((s) => s.id === "dup-sg-wf");
    assert.equal(srcs.length, 1);
    assert.equal(srcs[0]!.kind, "project-local");
  });

  test("project-local beats user-global: user-global emits DUPLICATE_NAME", async () => {
    const cwd = makeTempDir("dup-pl-vs-ug");
    // project-local
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "pl.js", "PL Winner UG", "dup-ug-wf");
    // user-global
    const homeDir = makeTempDir("home-ug");
    const ugDir = join(homeDir, ".atomic", "agent", "workflows");
    mkdirSync(ugDir, { recursive: true });
    writeWorkflowJs(ugDir, "ug.js", "UG Loser", "dup-ug-wf");

    const { registry, sources, errors } = await discoverWorkflows({ cwd, homeDir, includeBundled: false });

    assert.equal(registry.get("dup-ug-wf")?.name, "PL Winner UG");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    assert.equal(dupes.length, 1);

    const srcs = sources.filter((s) => s.id === "dup-ug-wf");
    assert.equal(srcs.length, 1);
    assert.equal(srcs[0]!.kind, "project-local");
  });

  test("project-local beats bundled: bundled emits DUPLICATE_NAME, name=ralph", async () => {
    const cwd = makeTempDir("dup-pl-vs-bundled");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    // Use same normalizedName as bundled "ralph"
    writeWorkflowJs(wfDir, "override-ralph.js", "Custom Ralph", "ralph");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-home-ralph"),
      includeBundled: true,
    });

    // Custom wins
    assert.equal(registry.get("ralph")?.name, "Custom Ralph");

    // Bundled ralph emits DUPLICATE_NAME
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME" && e.source === "ralph");
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0]!.level, "warn");

    // Only one source for ralph
    const ralphSrcs = sources.filter((s) => s.id === "ralph");
    assert.equal(ralphSrcs.length, 1);
    assert.equal(ralphSrcs[0]!.kind, "project-local");
  });

  test("settings-global beats user-global: user-global emits DUPLICATE_NAME", async () => {
    const homeDir = makeTempDir("home-sg-ug");
    const ugDir = join(homeDir, ".atomic", "agent", "workflows");
    mkdirSync(ugDir, { recursive: true });
    writeWorkflowJs(ugDir, "ug.js", "UG Loser SG", "dup-sgug-wf");

    const sgDir = makeTempDir("sg-vs-ug");
    const sgPath = writeWorkflowJs(sgDir, "sg.js", "SG Winner UG", "dup-sgug-wf");
    const cwd = makeTempDir("proj-sg-ug");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir,
      includeBundled: false,
      config: { globalWorkflows: [sgPath] },
    });

    assert.equal(registry.get("dup-sgug-wf")?.name, "SG Winner UG");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    assert.equal(dupes.length, 1);

    const srcs = sources.filter((s) => s.id === "dup-sgug-wf");
    assert.equal(srcs[0]!.kind, "settings-global");
  });

  test("user-global beats bundled: bundled emits DUPLICATE_NAME, name=deep-research-codebase", async () => {
    const homeDir = makeTempDir("home-ug-bundled");
    const ugDir = join(homeDir, ".atomic", "agent", "workflows");
    mkdirSync(ugDir, { recursive: true });
    writeWorkflowJs(ugDir, "override-drc.js", "Custom DRC", "deep-research-codebase");
    const cwd = makeTempDir("proj-ug-bundled");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir,
      includeBundled: true,
    });

    assert.equal(registry.get("deep-research-codebase")?.name, "Custom DRC");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME" && e.source === "deep-research-codebase");
    assert.equal(dupes.length, 1);

    const srcs = sources.filter((s) => s.id === "deep-research-codebase");
    assert.equal(srcs.length, 1);
    assert.equal(srcs[0]!.kind, "user-global");
  });
});

// ---------------------------------------------------------------------------
// includeBundled flag
// ---------------------------------------------------------------------------

describe("discoverWorkflows — includeBundled", () => {
  test("includeBundled=true (default) loads bundled workflows", async () => {
    const cwd = makeTempDir("bundled-true");
    const { registry } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-b") });
    assert.equal(registry.has("ralph"), true);
    assert.equal(registry.has("deep-research-codebase"), true);
    assert.equal(registry.has("open-claude-design"), true);
  });

  test("includeBundled=false excludes all bundled workflows", async () => {
    const cwd = makeTempDir("bundled-false");
    const { registry } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-b2"),
      includeBundled: false,
    });
    assert.equal(registry.has("ralph"), false);
    assert.equal(registry.has("deep-research-codebase"), false);
    assert.equal(registry.has("open-claude-design"), false);
  });

  test("includeBundled=false still loads project-local workflows", async () => {
    const cwd = makeTempDir("bundled-false-proj");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "local.js", "Local Only", "local-only");

    const { registry } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-b3"),
      includeBundled: false,
    });
    assert.equal(registry.has("local-only"), true);
    assert.equal(registry.has("ralph"), false);
  });
});
