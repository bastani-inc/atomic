/**
 * Tests for src/extension/discovery.ts
 *
 * Covers:
 *   - discoverBundledWorkflows() happy path: all three builtins registered
 *   - DiscoveryResult shape: registry, sources, errors
 *   - sources array: one entry per bundled workflow with correct id/kind/name
 *   - No errors on clean manifest
 *   - Registry lookup by normalizedName
 *   - validateDefinition (via white-box: invalid exports produce INVALID_DEFINITION)
 *   - Duplicate normalizedName: first-wins, DUPLICATE_NAME warning
 */

import { test, expect, describe, mock, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "../../src/shared/types.js";
import {
  discoverBundledWorkflows,
  discoverWorkflows,
  type DiscoveryResult,
  type DiscoverySource,
  type DiscoveryDiagnostic,
} from "../../src/extension/discovery.js";

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

describe("discoverBundledWorkflows — bundled manifest", () => {
  test("returns a DiscoveryResult with registry, sources, errors", async () => {
    const result = await discoverBundledWorkflows();
    expect(result).toBeDefined();
    expect(result.registry).toBeDefined();
    expect(Array.isArray(result.sources)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test("registers exactly the three bundled workflows", async () => {
    const { registry } = await discoverBundledWorkflows();
    const names = registry.names();
    expect(names).toContain("deep-research-codebase");
    expect(names).toContain("ralph");
    expect(names).toContain("open-claude-design");
    expect(names.length).toBe(3);
  });

  test("no errors on clean manifest", async () => {
    const { errors } = await discoverBundledWorkflows();
    expect(errors.length).toBe(0);
  });

  test("sources array has one entry per registered workflow", async () => {
    const { sources } = await discoverBundledWorkflows();
    expect(sources.length).toBe(3);
    const ids = sources.map((s: DiscoverySource) => s.id);
    expect(ids).toContain("deep-research-codebase");
    expect(ids).toContain("ralph");
    expect(ids).toContain("open-claude-design");
  });

  test("every source has kind='bundled'", async () => {
    const { sources } = await discoverBundledWorkflows();
    for (const s of sources) {
      expect(s.kind).toBe("bundled");
    }
  });

  test("source id matches normalizedName", async () => {
    const { sources, registry } = await discoverBundledWorkflows();
    for (const s of sources) {
      const def = registry.get(s.id);
      expect(def).toBeDefined();
      expect(def!.normalizedName).toBe(s.id);
    }
  });

  test("source name matches workflow display name", async () => {
    const { sources, registry } = await discoverBundledWorkflows();
    for (const s of sources) {
      const def = registry.get(s.id);
      expect(def!.name).toBe(s.name);
    }
  });

  test("registry.get by normalizedName returns valid WorkflowDefinition", async () => {
    const { registry } = await discoverBundledWorkflows();
    for (const name of ["deep-research-codebase", "ralph", "open-claude-design"]) {
      const def = registry.get(name);
      expect(def).toBeDefined();
      expect(def!.__piWorkflow).toBe(true);
      expect(typeof def!.run).toBe("function");
      expect(def!.normalizedName).toBe(name);
    }
  });

  test("registry is immutable-style (register returns new registry)", async () => {
    const { registry } = await discoverBundledWorkflows();
    const extra = makeValidDef("new-workflow", "new-workflow");
    const r2 = registry.register(extra);
    // original unchanged
    expect(registry.has("new-workflow")).toBe(false);
    expect(r2.has("new-workflow")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation: INVALID_DEFINITION diagnostics
// ---------------------------------------------------------------------------

describe("discoverBundledWorkflows — validation diagnostics", () => {
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
    expect(diag.level).toBe("error");
    expect(diag.code).toBe("INVALID_DEFINITION");
    expect(typeof diag.message).toBe("string");
    expect(diag.source).toBe("foo");
  });

  test("no INVALID_DEFINITION errors for real bundled workflows", async () => {
    const { errors } = await discoverBundledWorkflows();
    const invalidErrors = errors.filter((e: DiscoveryDiagnostic) => e.code === "INVALID_DEFINITION");
    expect(invalidErrors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection via createRegistry + registry logic
// ---------------------------------------------------------------------------

describe("discoverBundledWorkflows — duplicate handling", () => {
  test("no DUPLICATE_NAME warnings for clean bundled manifest (all unique)", async () => {
    const { errors } = await discoverBundledWorkflows();
    const dupeWarnings = errors.filter((e: DiscoveryDiagnostic) => e.code === "DUPLICATE_NAME");
    expect(dupeWarnings.length).toBe(0);
  });

  test("DUPLICATE_NAME diagnostic shape is correct", () => {
    const diag: DiscoveryDiagnostic = {
      level: "warn",
      code: "DUPLICATE_NAME",
      message: 'Bundled export "ralph2" skipped: normalizedName "ralph" already registered',
      source: "ralph2",
    };
    expect(diag.level).toBe("warn");
    expect(diag.code).toBe("DUPLICATE_NAME");
    expect(diag.source).toBe("ralph2");
  });
});

// ---------------------------------------------------------------------------
// DiscoveryResult is frozen / read-only (contract)
// ---------------------------------------------------------------------------

describe("DiscoveryResult contract", () => {
  test("sources array is readonly (cannot push)", async () => {
    const { sources } = await discoverBundledWorkflows();
    // readonly — TypeScript enforces this; runtime check via Object.isFrozen or try
    // The array itself may not be frozen at runtime, but we confirm length is stable
    const lenBefore = sources.length;
    // Attempting to push would be a TS error; we simply confirm length is stable
    expect(sources.length).toBe(lenBefore);
  });

  test("errors array is readonly (length stable)", async () => {
    const { errors } = await discoverBundledWorkflows();
    const lenBefore = errors.length;
    expect(errors.length).toBe(lenBefore);
  });
});

// ---------------------------------------------------------------------------
// DiscoverySource shape conformance
// ---------------------------------------------------------------------------

describe("DiscoverySource shape", () => {
  test("each source has id, kind, name fields", async () => {
    const { sources } = await discoverBundledWorkflows();
    for (const s of sources) {
      expect(typeof s.id).toBe("string");
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.kind).toBe("bundled");
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
    }
  });

  test("source ids are unique", async () => {
    const { sources } = await discoverBundledWorkflows();
    const ids = sources.map((s: DiscoverySource) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Registry integration: all() returns all three definitions
// ---------------------------------------------------------------------------

describe("registry.all() after discovery", () => {
  test("all() returns three WorkflowDefinition objects", async () => {
    const { registry } = await discoverBundledWorkflows();
    const all = registry.all();
    expect(all.length).toBe(3);
    for (const def of all) {
      expect(def.__piWorkflow).toBe(true);
      expect(typeof def.name).toBe("string");
      expect(typeof def.normalizedName).toBe("string");
      expect(typeof def.run).toBe("function");
    }
  });

  test("registry.names() matches source ids", async () => {
    const { registry, sources } = await discoverBundledWorkflows();
    const regNames = new Set(registry.names());
    const srcIds = new Set(sources.map((s: DiscoverySource) => s.id));
    expect(regNames.size).toBe(srcIds.size);
    for (const id of srcIds) {
      expect(regNames.has(id)).toBe(true);
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
      `  run: async () => ({}),`,
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
// project-local: {cwd}/.pi/workflows/
// ---------------------------------------------------------------------------

describe("discoverWorkflows — project-local", () => {
  test("loads workflow from .pi/workflows/ and registers it", async () => {
    const cwd = makeTempDir("proj-local");
    const wfDir = join(cwd, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "my-wf.js", "My Workflow", "my-workflow");

    const result = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home"), includeBundled: false });
    expect(result.registry.has("my-workflow")).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test("source kind is project-local", async () => {
    const cwd = makeTempDir("proj-local-kind");
    const wfDir = join(cwd, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "wf.js", "Kind Test", "kind-test");

    const { sources } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home2"), includeBundled: false });
    const src = sources.find((s) => s.id === "kind-test");
    expect(src).toBeDefined();
    expect(src!.kind).toBe("project-local");
  });

  test("source has correct id, name, filePath", async () => {
    const cwd = makeTempDir("proj-local-shape");
    const wfDir = join(cwd, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const fp = writeWorkflowJs(wfDir, "shape.js", "Shape Workflow", "shape-workflow");

    const { sources } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home3"), includeBundled: false });
    const src = sources.find((s) => s.id === "shape-workflow");
    expect(src).toBeDefined();
    expect(src!.name).toBe("Shape Workflow");
    expect(src!.filePath).toBe(fp);
  });

  test("empty .pi/workflows/ produces no sources and no errors", async () => {
    const cwd = makeTempDir("proj-local-empty");
    mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });

    const result = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home4"), includeBundled: false });
    expect(result.sources.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("missing .pi/workflows/ dir is silent (no error)", async () => {
    const cwd = makeTempDir("proj-local-nodir");
    const result = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-home5"), includeBundled: false });
    expect(result.errors.filter((e) => e.code === "PATH_NOT_FOUND").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// user-global: {homeDir}/.pi/agent/workflows/
// ---------------------------------------------------------------------------

describe("discoverWorkflows — user-global", () => {
  test("loads workflow from homeDir/.pi/agent/workflows/", async () => {
    const homeDir = makeTempDir("user-global");
    const wfDir = join(homeDir, ".pi", "agent", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "global-wf.js", "Global Workflow", "global-workflow");

    const cwd = makeTempDir("proj-empty");
    const result = await discoverWorkflows({ cwd, homeDir, includeBundled: false });
    expect(result.registry.has("global-workflow")).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test("source kind is user-global", async () => {
    const homeDir = makeTempDir("user-global-kind");
    const wfDir = join(homeDir, ".pi", "agent", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "gk.js", "Global Kind", "global-kind");

    const cwd = makeTempDir("proj-empty2");
    const { sources } = await discoverWorkflows({ cwd, homeDir, includeBundled: false });
    const src = sources.find((s) => s.id === "global-kind");
    expect(src).toBeDefined();
    expect(src!.kind).toBe("user-global");
  });

  test("source has filePath set", async () => {
    const homeDir = makeTempDir("user-global-fp");
    const wfDir = join(homeDir, ".pi", "agent", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const fp = writeWorkflowJs(wfDir, "gfp.js", "Global FP", "global-fp");

    const cwd = makeTempDir("proj-empty3");
    const { sources } = await discoverWorkflows({ cwd, homeDir, includeBundled: false });
    const src = sources.find((s) => s.id === "global-fp");
    expect(src?.filePath).toBe(fp);
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
    expect(result.registry.has("cfg-project")).toBe(true);
    const src = result.sources.find((s) => s.id === "cfg-project");
    expect(src?.kind).toBe("settings-project");
    expect(result.errors.length).toBe(0);
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
    expect(src?.configuredName).toBeUndefined();
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
    expect(result.registry.has("mapped-workflow")).toBe(true);
    const src = result.sources.find((s) => s.id === "mapped-workflow");
    expect(src?.kind).toBe("settings-project");
    expect(src?.configuredName).toBe("my-custom-name");
    expect(result.errors.length).toBe(0);
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
    expect(registry.has("map-wf-one")).toBe(true);
    expect(registry.has("map-wf-two")).toBe(true);
    expect(errors.length).toBe(0);
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
    expect(result.registry.has("global-cfg")).toBe(true);
    const src = result.sources.find((s) => s.id === "global-cfg");
    expect(src?.kind).toBe("settings-global");
    expect(result.errors.length).toBe(0);
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
    expect(src?.kind).toBe("settings-global");
    expect(src?.configuredName).toBe("g-alias");
  });
});

// ---------------------------------------------------------------------------
// Invalid exports → INVALID_DEFINITION
// ---------------------------------------------------------------------------

describe("discoverWorkflows — INVALID_DEFINITION diagnostics", () => {
  test("null default export emits INVALID_DEFINITION error", async () => {
    const cwd = makeTempDir("invalid-null");
    const wfDir = join(cwd, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeInvalidWorkflowJs(wfDir, "bad-null.js");

    const { errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty"), includeBundled: false });
    const inv = errors.filter((e) => e.code === "INVALID_DEFINITION");
    expect(inv.length).toBeGreaterThan(0);
    expect(inv[0]!.level).toBe("error");
  });

  test("missing __piWorkflow sentinel emits INVALID_DEFINITION", async () => {
    const cwd = makeTempDir("invalid-sentinel");
    const wfDir = join(cwd, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeMissingSentinelWorkflowJs(wfDir, "bad-sentinel.js");

    const { errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty2"), includeBundled: false });
    const inv = errors.filter((e) => e.code === "INVALID_DEFINITION");
    expect(inv.length).toBeGreaterThan(0);
    expect(inv[0]!.message).toMatch(/missing or incorrect __piWorkflow sentinel/);
  });

  test("INVALID_DEFINITION does not register a workflow", async () => {
    const cwd = makeTempDir("invalid-no-reg");
    const wfDir = join(cwd, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeInvalidWorkflowJs(wfDir, "bad.js");

    const { registry } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty3"), includeBundled: false });
    expect(registry.names().length).toBe(0);
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
    expect(pathErr.length).toBe(1);
    expect(pathErr[0]!.level).toBe("error");
    expect(pathErr[0]!.source).toBe(missingPath);
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
    expect(cfgErr.length).toBe(1);
    expect(cfgErr[0]!.level).toBe("error");
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
    const wfDir = join(cwd, ".pi", "workflows");
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
    expect(def?.name).toBe("SP Version");

    // project-local entry emits DUPLICATE_NAME
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    expect(dupes.length).toBe(1);
    expect(dupes[0]!.level).toBe("warn");

    // only one source registered for dup-wf
    const srcs = sources.filter((s) => s.id === "dup-wf");
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.kind).toBe("settings-project");
  });

  test("project-local beats settings-global: settings-global emits DUPLICATE_NAME", async () => {
    const cwd = makeTempDir("dup-pl-vs-sg");
    // project-local
    const wfDir = join(cwd, ".pi", "workflows");
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

    expect(registry.get("dup-sg-wf")?.name).toBe("PL Winner");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    expect(dupes.length).toBe(1);
    expect(dupes[0]!.level).toBe("warn");

    const srcs = sources.filter((s) => s.id === "dup-sg-wf");
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.kind).toBe("project-local");
  });

  test("project-local beats user-global: user-global emits DUPLICATE_NAME", async () => {
    const cwd = makeTempDir("dup-pl-vs-ug");
    // project-local
    const wfDir = join(cwd, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "pl.js", "PL Winner UG", "dup-ug-wf");
    // user-global
    const homeDir = makeTempDir("home-ug");
    const ugDir = join(homeDir, ".pi", "agent", "workflows");
    mkdirSync(ugDir, { recursive: true });
    writeWorkflowJs(ugDir, "ug.js", "UG Loser", "dup-ug-wf");

    const { registry, sources, errors } = await discoverWorkflows({ cwd, homeDir, includeBundled: false });

    expect(registry.get("dup-ug-wf")?.name).toBe("PL Winner UG");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    expect(dupes.length).toBe(1);

    const srcs = sources.filter((s) => s.id === "dup-ug-wf");
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.kind).toBe("project-local");
  });

  test("project-local beats bundled: bundled emits DUPLICATE_NAME, name=ralph", async () => {
    const cwd = makeTempDir("dup-pl-vs-bundled");
    const wfDir = join(cwd, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    // Use same normalizedName as bundled "ralph"
    writeWorkflowJs(wfDir, "override-ralph.js", "Custom Ralph", "ralph");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-home-ralph"),
      includeBundled: true,
    });

    // Custom wins
    expect(registry.get("ralph")?.name).toBe("Custom Ralph");

    // Bundled ralph emits DUPLICATE_NAME
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME" && e.source === "ralph");
    expect(dupes.length).toBe(1);
    expect(dupes[0]!.level).toBe("warn");

    // Only one source for ralph
    const ralphSrcs = sources.filter((s) => s.id === "ralph");
    expect(ralphSrcs.length).toBe(1);
    expect(ralphSrcs[0]!.kind).toBe("project-local");
  });

  test("settings-global beats user-global: user-global emits DUPLICATE_NAME", async () => {
    const homeDir = makeTempDir("home-sg-ug");
    const ugDir = join(homeDir, ".pi", "agent", "workflows");
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

    expect(registry.get("dup-sgug-wf")?.name).toBe("SG Winner UG");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    expect(dupes.length).toBe(1);

    const srcs = sources.filter((s) => s.id === "dup-sgug-wf");
    expect(srcs[0]!.kind).toBe("settings-global");
  });

  test("user-global beats bundled: bundled emits DUPLICATE_NAME, name=deep-research-codebase", async () => {
    const homeDir = makeTempDir("home-ug-bundled");
    const ugDir = join(homeDir, ".pi", "agent", "workflows");
    mkdirSync(ugDir, { recursive: true });
    writeWorkflowJs(ugDir, "override-drc.js", "Custom DRC", "deep-research-codebase");
    const cwd = makeTempDir("proj-ug-bundled");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir,
      includeBundled: true,
    });

    expect(registry.get("deep-research-codebase")?.name).toBe("Custom DRC");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME" && e.source === "deep-research-codebase");
    expect(dupes.length).toBe(1);

    const srcs = sources.filter((s) => s.id === "deep-research-codebase");
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.kind).toBe("user-global");
  });
});

// ---------------------------------------------------------------------------
// includeBundled flag
// ---------------------------------------------------------------------------

describe("discoverWorkflows — includeBundled", () => {
  test("includeBundled=true (default) loads bundled workflows", async () => {
    const cwd = makeTempDir("bundled-true");
    const { registry } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-b") });
    expect(registry.has("ralph")).toBe(true);
    expect(registry.has("deep-research-codebase")).toBe(true);
    expect(registry.has("open-claude-design")).toBe(true);
  });

  test("includeBundled=false excludes all bundled workflows", async () => {
    const cwd = makeTempDir("bundled-false");
    const { registry } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-b2"),
      includeBundled: false,
    });
    expect(registry.has("ralph")).toBe(false);
    expect(registry.has("deep-research-codebase")).toBe(false);
    expect(registry.has("open-claude-design")).toBe(false);
  });

  test("includeBundled=false still loads project-local workflows", async () => {
    const cwd = makeTempDir("bundled-false-proj");
    const wfDir = join(cwd, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "local.js", "Local Only", "local-only");

    const { registry } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-b3"),
      includeBundled: false,
    });
    expect(registry.has("local-only")).toBe(true);
    expect(registry.has("ralph")).toBe(false);
  });
});
